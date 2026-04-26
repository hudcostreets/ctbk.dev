# Spec: GBFS Availability — R2-Only Serving (Drop D1 Hot-Cache)

## Problem

The current GBFS availability pipeline writes ~2,360 station rows / minute into D1
day-tables (`availability_YYYYMMDD`). Per `gbfs/loader/src/index.ts` + `gbfs/worker/wrangler.toml`'s
`* * * * *` cron:

- 2,360 stations × 1,440 polls/day = ~102MM logical inserts/day-month
- Observed: 149.5MM rows-written / month on the CF bill (Mar 22 - Apr 21, 2026)
- Cost: $1/MM beyond the 50MM free tier ≈ **$100/month**, climbing as Citi Bike adds stations

The 1.47x multiplier between logical and billed rows comes from:
- `INSERT OR REPLACE` re-writes when GBFS `last_updated` (= our `ts` PK component) repeats across adjacent polls (the GBFS feed only updates ~every 60-90s, so ~30-50% of our 60s polls pull a duplicate top-level `last_updated`).
- D1 charging for auto-generated PRIMARY KEY index updates per row.

D1 buys ≤7 days of low-latency SQL availability queries (`HOT_DAYS_RETAIN=7`) for $100/mo. The
same data is already in R2 as per-minute WAL JSONs; we just don't have a fast-enough read path
for "today" without D1.

## Goal

Eliminate the D1 ingest path; serve the entire availability time series from R2 at zero recurring
cost, while preserving the live-refresh UX in `specs/done/live-minute-refresh.md`.

## Target architecture

```
                       ┌─────────────────────────────────────┐
                       │   gbfs/worker (CFW, cron `* * * * *`)│
                       │   POST /api/totals/avail.json        │
                       └─────────────────┬───────────────────┘
                                         │ R2 PUT
                                         ▼
                        gbfs/status/YYYY-MM-DD/HH-MM.json     (n0, ~580 KB / file)

                       ┌─────────────────────────────────────┐
                       │   gbfs/compactor (CFW, cron `5 * * * *`)
                       │   reads last hour's 60 JSONs         │
                       └─────────────────┬───────────────────┘
                                         │ R2 PUT
                                         ▼
                        gbfs/avail/h1/YYYY-MM-DD/HH.parquet   (h1, ~0.5-1 MB / hour)

                       ┌─────────────────────────────────────┐
                       │   GHA gbfs-compact.yml (existing)    │
                       │   cron `15 0 * * *`                  │
                       └─────────────────┬───────────────────┘
                                         │ R2 PUT
                                         ▼
                        gbfs/avail/d1/YYYY-MM-DD.parquet      (d1, ~12-18 MB / day)
                        gbfs/stations/<gbfs_uuid>/<YYYY-MM>.parquet  (per-station, existing)
```

(`d1` here = "day-1" pyramid tier, _not_ Cloudflare D1.)

### Tier semantics

Aligns with `specs/multiscale-timeseries-backend.md`:

| Tier | Source | Cadence | Layout |
|------|--------|---------|--------|
| n0   | GBFS poll | 1/min | `gbfs/status/YYYY-MM-DD/HH-MM.json` (existing) |
| h1   | hourly Worker | 1/hour | `gbfs/avail/h1/YYYY-MM-DD/HH.parquet` (new) |
| d1   | daily GHA | 1/day | `gbfs/avail/d1/YYYY-MM-DD.parquet` |
| station-month | daily GHA | 1/day | `gbfs/stations/<uuid>/<YYYY-MM>.parquet` (existing) |

The `h1` shard is the new piece that closes the gap: it makes "today's" availability queryable
without D1 by giving the API a small, fast parquet to read instead of N WAL JSONs.

### API serving "today's live data"

For `/api/stations/:id/today` and `/api/stations/:id/range` over recent windows:

1. Read the latest `gbfs/avail/h1/<today>/HH.parquet` shard(s) covering the window.
2. For minutes since the last hourly compaction boundary (≤59 unfreshed WAL JSONs), read the
   per-minute JSONs in parallel and concat.
3. Return rows for the requested station, filtered to `[from, to]`.

Worst case (request right before `:05` next hour): 59 small parallel R2 GETs + 1 parquet read.
Typical (steady-state): 1-30 JSON reads + 1 parquet read. All under R2 free tier.

For older windows, existing per-station monthly parquets continue to serve.

### Live-refresh UX preserved

`specs/done/live-minute-refresh.md`'s `useSmartPolling` pattern still works. The client
`since=<polled_at>` filter moves from a D1 `WHERE polled_at > ?` to a Worker-side
parquet/JSON filter. Latency profile unchanged (parquet reads are <100ms; JSON
fan-out is parallel + small).

## Cost (post-migration, monthly)

| Item | Before | After |
|------|--------|-------|
| D1 rows-written | ~150MM ($100) | 0 ($0) |
| R2 Class A writes | ~43k (free) | ~44k (free)¹ |
| R2 Class B reads | low (free) | low-medium (free)² |
| GHA compaction minutes | ~2 min/day | ~2 min/day |

¹ +720 hourly writes/mo for h1 shards, +30 daily writes for d1 shards. Well under 1MM Class A free tier.
² Per-request reads scale with traffic. R2 Class B free tier is 10MM/mo.

**Net savings: ~$100/month**, plus a unified availability data path that aligns with the
multiscale TSDB spec.

## Implementation

### Phase 1 — Hourly compactor Worker

New CFW at `gbfs/compactor/`:

- Cron: `5 * * * *` (5 minutes after the top of each hour, to allow trailing :59 polls to land)
- Reads `gbfs/status/<yesterday-or-today>/<HH-MM>.json` for `MM=00..59` of the just-finished hour
- Concats slim station rows + a `polled_at` / `ts` column
- Writes `gbfs/avail/h1/YYYY-MM-DD/HH.parquet` via hyparquet-writer
- Memory: 60 × ~580KB = ~35MB. Comfortable under CF Worker's 128MB limit.
- On the hour boundary at midnight UTC, write to the previous day's prefix.
- Idempotent: re-run safely overwrites the same key.

Open question: hyparquet-writer hit OOM on the historical "daily merge in Worker" attempt
(per `specs/done/gbfs-scraper.md`). Hourly is 1/24 of that — should be fine, but worth a
load-test before relying on it. Fallback: do hourly compaction in GHA (cron `5 * * * *`),
which is heavier-weight but guaranteed to have headroom.

### Phase 2 — API: serve from R2 instead of D1

Modify `gbfs/api/src/index.ts`:

- `getStationToday`, `getStationRange`: replace D1 query with
  `(latest h1 shards) ∪ (post-h1-boundary minute JSONs)`.
- Keep R2-parquet code path for older dates (already there).
- Drop the D1 `availability_*` table reads. Keep `stations` table (still useful for the
  short-name → gbfs UUID join — that's a metadata table, not the per-minute volume).

### Phase 3 — Decommission the loader + day-tables

- Stop deploying `gbfs/loader` (remove from `.github/workflows/gbfs.yml` matrix).
- Delete the R2 → queue notification config (the queue itself can stay until cleaned up).
- Run a one-shot job to `DROP TABLE` all `availability_YYYYMMDD` and the `day_tables`
  registry entries.
- Remove the daily `dropOldTables` cron in `gbfs/api`.

### Phase 4 — Backfill (optional)

Existing per-station monthly parquets cover the historical window. For the gap between
"latest per-station monthly" and "now", the per-minute WAL JSONs are still on R2 (60+ day
retention per `specs/done/gbfs-scraper.md`); we can batch-compact them into h1 shards
retroactively if any window misses.

## Risks / open questions

- **hyparquet-writer Worker OOM**: uncertain whether 60-JSON hourly compaction fits.
  Mitigation: prototype + load-test; fall back to GHA-side hourly if it doesn't.
- **Cold-start latency for "today"**: 30-60 R2 GETs at end of hour vs ~1 D1 SELECT.
  Current `/api/stations/:id/today` p50 latency is <100ms; new path is bounded by
  CF's R2 GET fan-out, plausibly 100-300ms p50. Acceptable, but worth measuring.
- **Live-refresh precision**: `useSmartPolling` expects `polled_at`-since incremental
  fetches. Worker now does that filter on parquet/JSON in-memory rather than D1 SQL.
  Functionally equivalent.
- **`/api/totals` availability path**: currently 501. Once h1 shards exist with a
  histogram-shaped agg schema, this can be implemented in lockstep with the trips path.
  Spec'd separately under `specs/multiscale-timeseries-backend.md`.

## Out of scope

- Migrating `stations` / metadata tables out of D1 (low row count, low write rate).
- Migrating the `/api/rides` (trips) path — that already reads R2 parquet directly.
