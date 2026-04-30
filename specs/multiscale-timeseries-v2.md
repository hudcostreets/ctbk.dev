# Spec: Multi-scale time-series backend v2

Status: design, implementation in progress (2026-04-30).

Refines `multiscale-timeseries-backend.md` (v1) with concrete sizing decisions
and a /day raw bundle tier, after a design pass on file-count vs. row-decode
tradeoffs and a brief detour through Fenwick / dyadic interval trees that
ultimately wasn't justified for our query patterns.

## What's changing from v1

1. **Resize agg tier file periods**: `h1` 1d → 1mo, `d1` 1mo → 1y, `mo1` 1y →
   10y. Each file holds many more natural-bin units, so typical queries hit ≤2
   files instead of 7-30.
2. **Sort agg parquets by `(station_id, dt, metric, state)`** with small row
   groups (~250–500 rows). Per-station queries decode 1 row group of ~few KB
   instead of the whole file.
3. **Add `/day raw` bundle tier** (`gbfs/avail/raw/day/<date>.parquet`). The
   existing `/h1` raw shards (`gbfs/avail/h1/<date>/<HH>.parquet`) keep their
   current role (in-progress-day reads, since /day raw is built post-day);
   `/day raw` is the canonical sub-hour-binned bundle for closed days.
4. **Trips agg pipeline** (separate spec, `specs/trips-agg.md`) writes
   `(n, sum_count, sum_dur, sum_dur_sq)` sum monoid. Same file-period sizing.
5. **Smoothing as query parameter**, applied in the Worker as a rolling-window
   pass over the binned response. No separate cumsum index in v2.
6. **Histogram monoid for availability is unchanged from v1** — just resized
   files and re-sorted contents.

Deferred (not blocking v2):
- **Cumsum sidecar** for arbitrary-K sliding-window smoothing where K dominates
  D/B. Niche.
- **H3 geo pyramid** — same `(geo_key, time)` machinery, layered on top.
- **Fenwick / dyadic decomposition** — deliberately punted. EM showed it doesn't
  beat linear-tier for typical chart workloads (D ≤ 1mo, B ≥ 1h), and complicates
  the storage layer for marginal benefit. Notes preserved in design history.

## Why linear-tier with calendar-aligned big files

The bound that matters for user-perceived latency is **R2 GETs per query**, not
total bytes decoded. A query reading 1 file of 5 MB (with rg-pruning to extract
~5 KB for one station) is faster than 24 files × 60 rows each, because R2 GET
latency (~30-100ms cold) dominates.

Calendar-aligned big files give us:

- **≤2 files for most queries** (one if window stays inside one calendar period;
  two when it straddles a boundary).
- **Trivial immutability** — closed calendar periods never change, so
  long-`Cache-Control` headers + edge cache work cleanly.
- **No append-rewrite churn** for historical data.
- **Row-group pruning** makes "big file" cheap per-station: each file sorted by
  `station_id` first, with ~1 row group per (station, dt-block), so a per-station
  query decodes one row group ~few KB.

EM for the realistic worst cases:

| Query (window × bin) | Tier | Files | Decode/station |
|---|---|---|---|
| 1d × 1min | /day raw (closed days) + /h1 raw (today) | 1–2 | ~5 MB JS heap |
| 7d × 10min | /day raw × 7 | 7 | ~5 MB × 7 |
| 7d × 1h | /h1 (1mo file) | 1 | ~5 MB |
| 1mo × 1h | /h1 (1mo file) | 1–2 | ~5 MB |
| 1y × 1d | /d1 (1y file) | 1–2 | ~2 MB |
| 10y × 1mo | /mo1 (10y file) | 1 | ~1 MB |

Cold path on the slowest case (7d × 10min): 7 R2 GETs in parallel ≈ 100–200 ms.
Warm via edge cache: ≈ 10ms. Worst pathological "1000 sub-hour bins on 21d"
case: 21 /day raw files in parallel ≈ 300-500ms cold.

## Storage layout

```
gbfs/avail/raw/min/<yyyy-mm-dd>/<HH>/<MM>.json   # per-min snapshot, archival
gbfs/avail/raw/h1/<yyyy-mm-dd>/<HH>.parquet      # per-hour bundle, current day
gbfs/avail/raw/day/<yyyy-mm-dd>.parquet          # per-day bundle, closed days *(new)*

gbfs/avail/agg/h1/<yyyy-mm>.parquet              # 1-hour bins, monthly file *(resized)*
gbfs/avail/agg/d1/<yyyy>.parquet                 # 1-day bins, yearly file *(resized)*
gbfs/avail/agg/mo1/<decade>.parquet              # 1-month bins, decade file *(resized)*
                                                  # decade = floor(year/10)*10, e.g. "2020"

trips/agg/<tier>/<window>.parquet                # per trips-agg spec
trips/n0/stations/<short_name>.parquet           # raw rides per station
```

### Schemas

`gbfs/avail/raw/{h1,day}/...` (raw availability per minute):
```
dt                   int64    unix-s, minute-aligned
station_id           string   GBFS UUID
ts                   int64    actual poll timestamp (== dt for compacted-min path)
polled_at            int64
num_bikes_available  int16
num_ebikes_available int16
num_docks_available  int16
num_bikes_disabled   int16
num_docks_disabled   int16
is_installed         int8
is_renting           int8
is_returning         int8
last_reported        int64
```

Sort: `(station_id, ts)`. Row group size: 60 rows (1 row group ≈ 1 station ×
1 hour for /h1, 1 station × 1 day for /day). Compactor sets `rowGroupSize=60`
for /h1 (current); /day raw bundle uses `rowGroupSize=1440` (1 station × 1
full day per row group).

`gbfs/avail/agg/{h1,d1,mo1}/...` (histogram monoid):
```
dt           int64    bucket start (hour/day/month)
station_id   string   GBFS UUID
metric       string   "bikes" | "ebikes" | "docks" | "disabled" | "pending"
state        int16    value of the metric
minutes      int32    time spent in that state during this bucket
```

Sort: `(station_id, dt, metric, state)`. Row group size sized so each
(station × file-bucket-count) lands in 1 row group:

| Tier | bins/file | metrics × states/bin | rg size |
|---|---|---|---|
| h1 (1mo file) | 720 hours | 5 × ~10 | ~36000 |
| d1 (1y file) | 365 days | 5 × ~10 | ~18000 |
| mo1 (10y file) | 120 months | 5 × ~10 | ~6000 |

Each (station_id) occupies one row group; pruning by station_id min/max stats
per row group is exact. Set rg size to the rounded actual per-station row count
during compaction (compactor measures and writes deterministically).

### Smoothing

Worker query API takes optional `smoothing_K_seconds`. After computing the
binned response, apply a centered or trailing rolling window of width K:

```
smoothed[i] = combine_monoid(
  rows[i - K/(2*B)] ⊕ ... ⊕ rows[i + K/(2*B)]
) / window_size
```

For histogram monoid: combine = sum on `(state, minutes)` keys, then take
mean / stddev / percentiles per the request's `agg=` parameter.

For sum monoid: combine = (n_total, sum_total, sum_sq_total), then derive
stats per request.

K must be ≥ B (smoothing window at least one bin); otherwise no-op. K ≫ D
clamps to D.

Compute is O(N · K/B) naive, O(N) with running sum. CFW handles trivially —
this is a few hundred float ops on the response array, dominated by the
preceding R2 reads.

### Variance/percentile reducers

`agg=` query parameter:

| `agg` | Histogram monoid | Sum monoid |
|---|---|---|
| `mean` | `Σ(state · minutes) / Σ minutes` | `sum / n` |
| `stddev` | `sqrt(Σ(state² · minutes)/Σ minutes - mean²)` | `sqrt(sum_sq/n - mean²)` |
| `min` | `min(state with minutes > 0)` | not supported (would need sum monoid extension) |
| `max` | `max(state with minutes > 0)` | not supported |
| `p05`, `p25`, `p50`, `p75`, `p95` | linear interp on cum-weight curve | not supported |
| `mode` | `argmax(minutes)` over states | not supported |
| `hist` | raw merged histogram | not supported |

Sum monoid intentionally narrower (no per-bin distribution preserved). If
trips needs percentiles or topK, extend its row schema to `{n, sum, sum_sq,
topk, botk}` — defer.

## Pipeline

### Compactor stages (Python, GHA-driven)

1. **Per-minute write** (existing CFW cron): JSON snapshot to `gbfs/avail/raw/min/.../MM.json`.
2. **Per-hour bundle** (existing CFW or hourly compactor): per-min JSONs in the
   just-closed hour → `gbfs/avail/raw/h1/<date>/<HH>.parquet`. Sorted by
   `(station_id, ts)`, rg=60.
3. **Per-day bundle** *(new)*: per-hour parquets in the just-closed day →
   `gbfs/avail/raw/day/<date>.parquet`. Sorted same. rg=1440 (one row group
   per station × day).
4. **avail-agg/h1** *(resized)*: builds `gbfs/avail/agg/h1/<yyyy-mm>.parquet`
   from the closed month's /day raw files. Aggregates to 1-hour bins, histogram
   monoid. Sorted by `(station_id, dt, metric, state)`, rg ≈ 36000.
5. **avail-agg/d1** *(resized)*: builds `gbfs/avail/agg/d1/<yyyy>.parquet` from
   the closed year's /h1 agg files. Aggregates to 1-day bins. rg ≈ 18000.
6. **avail-agg/mo1** *(resized)*: builds `gbfs/avail/agg/mo1/<decade>.parquet`
   from the closed decade's /d1 files (or from older /d1 files if mid-decade,
   to be regenerated each year-end). Aggregates to 1-month bins. rg ≈ 6000.

### Run cadence

| Stage | Trigger |
|---|---|
| Per-min JSON | CFW cron `* * * * *` |
| /h1 bundle | hourly compactor (post-hour-close) |
| /day bundle | daily compactor (post-day-close, ~03:55 UTC) |
| /h1 agg (monthly) | monthly compactor (post-month-close) |
| /d1 agg (yearly) | yearly compactor (post-year-close) |
| /mo1 agg (decade) | yearly compactor on top of /d1 (last decade only) |

The /h1, /d1, /mo1 agg files are fully rewritten when their period closes.
Mid-period queries fall back to a finer tier (e.g. mid-month at h1 reads
/day raw bundles + /h1 raw for the still-open day).

## Worker query routing

Routing logic in `pickAvailAggTier(fromS, toS, binS)`:

```
spanS = toS - fromS
binS = requested bin in seconds (>= 60)

if spanS <= 24h and binS < 1h:        → /h1 raw + per-min JSONs (existing path)
elif binS >= 1mo:                      → /mo1
elif binS >= 1d:                       → /d1
elif binS >= 1h:                       → /h1
else (binS < 1h, spanS > 24h):         → /day raw (NEW)
```

`/day raw` is the canonical "sub-hour-binned bundle" for closed days. Adds a
new tier the API knows about, alongside the existing agg tiers.

For each tier, the Worker reads `availAggKeys(tier, from, to)` files in
parallel, applies row-group pruning by `filter.station_id`, folds histogram
groups, finalizes per `agg=`, optionally applies smoothing, returns binned
rows.

## Phase plan

### Phase 1 — stopgap perf fix
- [ ] Re-sort existing `/h1`, `/d1`, `/mo1` files by `(station_id, dt, metric, state)`
- [ ] Set row group sizes per the table above
- [ ] Update `executeAvailTotalsQuery` in `gbfs/api/src/index.ts` to use rg-pruning
      (mirror `readH1ShardForStation`)
- [ ] Re-run the avail-agg pipeline on existing data to regenerate sorted files

Goal: drop per-station chart cold path from ~7s to ~300ms without changing
file periods. Lands first; everything else builds on it.

### Phase 2 — file period resize
- [ ] Update `AvailAggH1Day` → `AvailAggH1Month` in `ctbk/avail_agg.py`
      (yyyy-mm filename, builds from full-month /day raw)
- [ ] Update `AvailAggD1Month` → `AvailAggD1Year` (yyyy filename)
- [ ] Update `AvailAggMo1Year` → `AvailAggMo1Decade`
- [ ] Update `availAggKeys()` in `gbfs/api/src/totals.ts` to map to new keys
- [ ] One-shot batch rebuild of historical data into new files

### Phase 3 — /day raw bundle
- [ ] Add daily compactor stage that reads the closed day's /h1 raw files →
      writes `gbfs/avail/raw/day/<date>.parquet`
- [ ] Update `pickAvailAggTier` + add `/day raw` reader path
- [ ] Lifecycle: existing /h1 raw shards stay for in-progress-day reads; older
      ones can be GC'd post-/day-bundle (separate sweep job)

### Phase 4 — smoothing query param
- [ ] Add `smoothing_K_seconds` to /api/totals?kind=availability
- [ ] CFW post-processing: rolling window over response, recompute via monoid
- [ ] FE chart: opt-in smoothing toggle + K selector

### Phase 5 — trips agg
- [ ] Per `specs/trips-agg.md` (already drafted; aligned with this spec's
      tier sizing and sort order)

### Phase 6+ (deferred)
- H3 geo pyramid (`(h3_cell_at_resolution_r, time_period)` keys)
- Cumsum sidecar for arbitrary-K smoothing where K is large relative to D/B
- Sum-monoid extensions for trips (topk, etc) if percentile/distribution
  queries become user-facing

## Migration / cutover

- The Worker reads from BOTH old and new key formats during the cutover.
  `availAggKeys()` returns the legacy daily/monthly keys until the regenerated
  monthly/yearly files exist; then we switch.
- Old files are deleted only after the new layout has served traffic for a
  week and edge cache has populated.

## Open questions / followups

1. **`/day raw` row group size**: 1440 = 1 station × 1 day. Could be smaller
   (per-hour) for finer pruning. Probably overkill — most queries want a
   full day's data for one station.
2. **Mid-period agg files**: do we want a "live" /h1 agg file that gets
   appended to during the in-progress month? V2 says no (Worker falls back
   to finer tier). Reconsider if mid-month perf matters.
3. **Sum monoid extensions for trips**: trips current schema is `(n, sum)`;
   adding `sum_sq` for stddev is cheap and pairs well with chart smoothing.
   Add now or defer?

## Related specs

- `specs/multiscale-timeseries-backend.md` — v1, this supersedes the storage
  layout / tier ladder sections.
- `specs/trips-agg.md` — the trips path, separate compaction pipeline.
- `specs/gbfs-r2-only.md` — R2-native architecture (D1 retired).
