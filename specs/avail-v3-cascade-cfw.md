# avail-v3 cascading sub-shards CFW (ctbk #130)

## Goal

Close the freshness gap for avail-v3 from "canonical-shard-cadence stale"
(today: rebuilt by `pyramid-cascade` on `e`, multi-minute lag at best;
`1d`/`3d`/`7d` tiers rebuild much less often) to "last GBFS scrape +
~1 minute." A CFW cron at `*/5 * * * *` consumes per-minute raw availability
parquets and emits avail-v3-schema **partial sub-shards** at the cadences
declared in `configs/pyramids/avail.yaml` (`partials: [5min, 10min,
30min, 1h, 3h, 12h, 1d, 3d, 7d]`), recording per-`(tier, cadence)`
watermarks in D1 via `D1ShardIndex.recordShard`. Query plans (`avail_geo.ts`)
fall through finer-cadence partials before walking finer tiers, per
pyrmts `specs/done/partial-shards.md`.

## Pre-existing state (does NOT need to change)

- `gbfs/worker` (per-minute cron): writes GBFS poll JSONs to
  `gbfs/status/<date>/<HH-MM>.json` and `station_information.json` to
  `gbfs/info/<date>.json`. Untouched.
- `gbfs/loader` (R2-event queue consumer): reads each
  `gbfs/status/<date>/<HH-MM>.json` and writes a per-station per-minute
  parquet to `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`. Schema
  is raw n/sum/sum_sq monoid (`station_id`, `dt`, `bikes_n`,
  `bikes_sum`, `bikes_sum_sq`, …, `pending_sum_sq`). Untouched.
- `gbfs/cascade` (per-minute cron): does the **legacy** monoid cascade
  for `gbfs/avail/agg=*/cons=*` (cons-only at `agg=1m`, agg-self, cons
  at higher aggs). Untouched. avail-v3 work lives alongside it (see
  next section).

## Architecture

Add the avail-v3 cascade to the existing `gbfs/cascade` worker as a
parallel pipeline. Same cron, same R2 binding, new D1 binding for
watermark recording. Output paths are entirely disjoint
(`avail-v3/{tier}/...` vs. `gbfs/avail/agg=*/cons=*/...`), so the two
pipelines don't interfere.

Why not a new worker? Two cron-firing workers writing to the same R2
bucket from the same source data is more boilerplate (two wrangler
configs, two deploy chains, two cold paths) for no isolation benefit
(they share R2 binding limits anyway).

New file layout:

```
gbfs/cascade/src/
  index.ts              # existing: legacy cascade scheduled() + fetch()
  avail3/
    index.ts            # avail-v3 cron entry — driven from existing
                        # scheduled() one step after the legacy cascade
    transform.ts        # raw → LUC-expanded histogram monoid
    cascade.ts          # (tier × cadence) iteration + write
    luc.ts              # station_id → S2 ancestor lookup
```

Per-tick (cron at `*` not `*/5`):
1. Existing legacy cascade chains (steps 1-3 in `cronTick`).
2. **NEW**: avail-v3 cascade. Skip unless `tickMin % 5 == 0` (the /5m
   constraint comes from cadence ladder; the cron stays `*` so the
   legacy cascade still gets every tick).

Why share the `*` cron: the legacy cascade needs every minute. Adding a
`*/5` gate on the avail-v3 path inside the shared handler is one `if`,
vs. a whole second worker.

## Per-/5m-tick algorithm

At tick `T` (a UTC minute, divisible by 5):

```
1. Determine which CADENCES just closed at T:
   for c in [5min, 10min, 30min, 1h, 3h, 12h, 1d, 3d, 7d]:
     if (T - tier1m_boundary_offset) % c_minutes == 0:
       just_closed.append(c)
   // 5min always closes; 10min every other tick; 30min every 6; etc.

2. For each cadence c that just closed:
   for tier t in TIERS where t.bin <= c and c < t.canonical_shard
                       and c.minutes % t.bin.minutes == 0:
     # Read t-tier rows covering the [T-c, T) window from the
     # next-finer cadence partials (or the base 1m raw input
     # for /1m tier or when no finer partial exists).
     rows = readWindow(t, c, T)
     # Aggregate by (s2_cell, dt) summing histograms.
     out = aggregate(rows, t.bin)
     # Write partial:  avail-v3/{t.name}/p{c}/{period}.parquet
     writePartial(t, c, T, out)
     # Record watermark in D1.
     shardIndex.recordShard({pyramidName: 'avail', tier: t.name,
                             cadence: c, periodStart: T-c, periodEnd: T,
                             key})

3. CANONICAL PROMOTION. For each tier t where T mod t.canonical_shard == 0:
   # Concat the t.canonical_shard / t.canonical_partial_cadence many
   # partials into the canonical shard.
   # Example: /1m tier (shard=1d). When T is midnight UTC, concat the
   # 24× /1m@1h partials (or 48× /1m@30min, etc. — pick the coarsest
   # available cadence) into avail-v3/1m/<date>.parquet.
   writeCanonical(t, T)
   shardIndex.recordShard({pyramidName: 'avail', tier: t.name,
                           cadence: null, ...})
```

### Input: where does t=/1m read from?

For tier `/1m`, the source is the loader's per-minute parquets at
`gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`. Per /5m tick:
read the 5 most recent minute parquets, transform each.

Transform per row of raw input:
1. Compute `value = sum / n` for each metric (n=1, so value=sum cast to int).
2. Look up `station_id` → S2 ancestors `[L10, L11, L12, L13, L14, L15]`
   via station-luc.json (loaded once per isolate from R2).
3. For each `(s2_cell, dt, metric)`, output a 1-vote histogram `{value: 1}`.

Aggregate across all 5 minutes by `(s2_cell, dt, metric)` — but each
`dt` is distinct (per minute), so the aggregation is really just a
GROUP BY `(s2_cell, dt, metric)` summing votes. For the same minute,
multiple stations resolving to the same L10 cell collapse (their values
all get added to that cell's histogram for that minute).

### Input: tiers /2m and coarser

For tier `t > /1m`, the source is the next-finer cadence's partial
shard. Example: `/5m@10min` reads `/2m@5min` (if it exists and t=/2m can
serve, etc.) — actually no, simpler:

**Rule: each `(t, c)` partial reads from `(t, c_prev)` where `c_prev`
is the next-finer cadence in the ladder.** For c=5min (finest cadence),
read from `(t_finer, 5min)` where `t_finer` is the next-finer tier.

For tier `/1m`, the finest cadence's source is the raw /1m@1m parquets
(special case).

This gives a tier-major, cadence-minor DAG:

```
1m@5m  ← raw 1m@1m × 5
1m@10m ← 1m@5m × 2
1m@30m ← 1m@10m × 3
... etc up to /1m's canonical /1d.

2m@10m ← 1m@5m × 2  (concat then re-bin to /2m)
2m@30m ← 2m@10m × 3
... etc.
```

Re-binning: when reading from a finer tier, the bin column needs to be
floor-aligned to the coarser tier's bin. This is the same monoid sum
the legacy cascade does, but on histograms instead of n/sum/sum_sq.

## Histogram monoid

A histogram column value is a JSON object `{value: count}` where
`value` is the metric integer (e.g. 7 bikes) and `count` is how many
votes for that value. Monoid sum: `merge(a, b) = { k: (a[k]||0) +
(b[k]||0) for k in union(keys(a), keys(b)) }`.

Serialization in parquet: STRING column with JSON.stringify output.

## Watermark recording

Per write, call `D1ShardIndex.recordShard({pyramidName: 'avail', tier,
cadence, periodStart, periodEnd, key})`. `cadence` is `null` for
canonical shards, otherwise the duration string (e.g. `'5min'`,
`'10min'`).

The pyramid-cascade reduce-from-staging path (running on `e`) ALSO
records canonical watermarks — that's fine, `recordShard` is upsert.

## station-luc loading

`www/public/assets/station-luc.json` is the source of truth. The CFW
needs an R2 copy. Approach:

1. Copy `www/public/assets/station-luc.json` →
   `gbfs/station-luc.json` (R2) as a one-off; rerun any time the
   denorm changes (new stations, station relocations).
2. CFW loads it lazily per isolate (module-level `let _luc: Map<string,
   string[]> | null = null` cache). 10s TTL or no expiry — the file
   doesn't change inside one cron isolate's lifetime.

If a station_id isn't in the LUC denorm (new station added since the
last LUC refresh), skip it with a `console.warn` and continue. Worst
case: that station's data lags one LUC refresh; not catastrophic.

## /1m TIERS restoration

`avail_geo.ts` currently omits `/1m` from `TIERS` (added comment
explains why). Once #130's `/1m` canonical writes land at
`avail-v3/1m/<date>.parquet` and D1 has /1m watermarks, restore:

```typescript
{ name: '1m', bin: '1min', shard: '1d' },  // shard matches yaml
```

Do this as part of the deploy commit, not the implementation commit.

## Dev/test plan

1. **Local unit tests.** Histogram merge, LUC expansion, tier/cadence
   applicability — pure functions, easy to spec.
2. **Dev worker against prod R2.** Deploy to `ctbk-gbfs-cascade-dev`,
   bound to prod R2 + a separate D1 (or same D1 — writes go to disjoint
   pyramid_watermarks rows since pyramidName='avail-v3-dev' or similar
   namespace). Trigger cron manually via `wrangler dev --remote --test-scheduled`.
3. **Verify writes land at empty paths.** `avail-v3/{tier}/p{cadence}/...`
   are empty today; new writes don't collide with anything live.
4. **Query parity.** `/api/avail-v3?...&latest=7d` against dev should
   return rows up to ~tickMin-5, while prod returns rows up to last
   canonical-shard end. Same shape, fresher data.
5. **CIC.** Open `localhost:3456/s/<station>` against dev API, confirm
   the "current" availability indicator shows the latest minute, not
   "X minutes ago."

## Risks

- **R2 read amplification at /5m.** Each tick reads up to 5 raw 1m
  parquets + N partials. ~5 × 60kB raw + transforms. Should fit in
  CFW 128MB easily.
- **CPU budget.** Histogram aggregation + JSON serialization across
  thousands of `(cell, dt, metric)` keys per tier per cadence per
  tick. Budget concern, not crash concern — CFW has 30s CPU but the
  cron is 5min between ticks. Profile if needed.
- **D1 write rate.** Per tick: up to ~50 watermark upserts (9 cadences
  × ~6 applicable tiers average). D1 handles 1k/s easily. Cron at /5m
  = 10/s peak. Fine.
- **Schema drift in raw input.** If the loader adds/removes metrics
  (currently fixed: bikes, ebikes, docks, disabled, pending), the
  transform breaks. Mitigation: hardcode the metric list in the
  transform and explicitly validate column presence; warn on extras.
- **station-luc staleness.** New stations get LUC-expanded only after a
  manual `gbfs/station-luc.json` refresh. Frequency: weekly or
  on-demand should be fine — Citi Bike adds stations rarely.

## Out of scope

- Backfilling historical sub-shards. The /5m cron only ever fills
  forward. Older partials would be redundant anyway (canonical shards
  exist for older periods). Treat backfill as YAGNI; revisit if a
  freshness ceiling becomes operationally annoying for a past window.
- Retiring the legacy gbfs/cascade pipeline. That writes /api/totals'
  backing data and the legacy avail JSON. Independent retirement
  decision, tracked under #108.
- Cron coordination with the prod pyramid-cascade rebuilds. The cascade
  rebuild may write a canonical /1d shard at midnight that the CFW's
  partial promotion already wrote 5s earlier. `recordShard` is upsert,
  so the second write wins; bytes should be ≈ identical (same input
  source data). Race is benign.
