# Spec: `ctbk trips-agg` — Multi-Scale Trips Aggregation Pipeline

> **Owner**: spec rewritten 2026-04-30 to align with `multiscale-timeseries-v2.md`.
> Implementation handoff to `e`.

## Goal

Build the trips-side analog of `ctbk avail-agg` (in `ctbk/avail_agg.py`). Produces
multi-tier sum-monoid aggregates of trip counts and durations on R2, calendar-
aligned with v2's tier-period sizing, sorted+row-group-pruned by station for
fast per-station decode.

This unblocks:
- Bin-configurable rides plots: bin granularity from 1 minute to 1 month, on
  any window from a single day to all-history.
- Single-station fine-bin queries (down to per-minute) served from the existing
  per-station rides parquets (`trips/n0/stations/<short_name>.parquet`); this
  spec covers the **multi-station / region / all-bikes** agg tiers (h1 / d1 /
  mo1) that complete v2's Phase 5.
- Cleanly retiring the fallback chain in `gbfs/api/src/index.ts`
  (`tripsTotalsFallbackPaths`).
- Region-level trips totals (currently `scope=regions` returns zero rows because
  per-region rides files don't carry a `region` column).

## Architecture (v2-aligned)

Tier ladder mirrors `avail/agg/*` (per `multiscale-timeseries-v2.md`):

```
ConsolidatedMonth (existing source — one row per ride)
            ↓
trips/agg/h1/<YYYY-MM>.parquet     # 1h bins, 1 monthly file
            ↓
trips/agg/d1/<YYYY>.parquet        # 1d bins, 1 yearly file
            ↓
trips/agg/mo1/<DECADE>.parquet     # 1mo bins, 1 decade file
                                    # decade = floor(year/10)*10
                                    # e.g. 2010.parquet covers 2010-2019
                                    #      2020.parquet covers 2020-2029
```

Calendar-aligned shard windows. Coarser tiers fold finer ones (h1 → d1 → mo1)
so the raw layer is read at most once per pyramid build. Sum-monoid combiner:
groupby + sum on the dim keys.

Sort + row-group strategy (matches v2 avail-agg): each parquet sorted by
`(short_name, dt, side, region, gender, user_type, rideable_type)`. Row group
size dimensioned so each station's slice of one file lands in one row group —
per-station queries decode 1 row group of ~few KB instead of the whole file.

| Tier | bins/file | dims/bin (≈) | rg size |
|---|---|---|---|
| h1 (1mo file) | 720 hours | ~50 | ~36000 |
| d1 (1y file) | 365 days | ~50 | ~18000 |
| mo1 (10y file) | 120 months | ~50 | ~6000 |

Compactor measures actual per-(station × period) row count and writes
deterministic `row_group_size` to keep pruning exact.

## Schema (long format)

Sum-monoid columns expanded per v2 §"Variance/percentile reducers" so the
worker can derive mean, stddev, etc. across any binning:

```
dt              int64    bucket start, unix-s (UTC)
short_name      string   canonical station short_name
side            string   'start' | 'end'
region          string   'NYC' | 'JC' | 'HB' | 'NWK' | …
gender          int16    0 (unknown) | 1 (male) | 2 (female)
user_type       string   'Subscriber' | 'Customer' | …
rideable_type   string   'classic_bike' | 'electric_bike' | 'docked_bike' | …
count           int64    # trips contributing
duration_s      int64    sum(duration_seconds)
duration_s_sq   int64    sum(duration_seconds²)   ← NEW (for stddev)
```

`duration_s_sq` is bounded — single trip ≤ 86400s → s² ≤ ~7.5e9 → fits int64
for any plausible Σ.

The `dims` allowlist in `gbfs/api/src/totals.ts:TRIPS_DIM_COLUMNS` is already
`['side', 'gender', 'user_type', 'rideable_type', 'region', 'short_name']` —
keep schema in sync. Sparse: omit dim combinations with zero rows.

`side='start'` and `side='end'` rows are emitted from the same raw record (one
trip contributes to both); per-station agg therefore double-counts at the
trip level. Consumers `groupby().sum()` over `side` if they want unique trips,
or filter `side='start'` for trip-level counts.

## Stages

Match `avail-agg` naming + `MonthTask` integration patterns (`ctbk/avail_agg.py`):

| Stage class                  | CLI alias        | Output                                  | Bucket | File period |
|------------------------------|------------------|-----------------------------------------|--------|-------------|
| `TripsAggH1Month(ym)`        | `trips-agg h1`   | `trips/agg/h1/<YYYY-MM>.parquet`        | 1 hour | 1 month     |
| `TripsAggD1Year(year)`       | `trips-agg d1`   | `trips/agg/d1/<YYYY>.parquet`           | 1 day  | 1 year      |
| `TripsAggMo1Decade(decade)`  | `trips-agg mo1`  | `trips/agg/mo1/<DECADE>.parquet`        | 1 mo   | 1 decade    |

Each stage:
- Reads its predecessor (or the consolidated monthlies for h1).
- groupby `(dt_bucket, ...all_dims)` → sum `(count, duration_s, duration_s_sq)`.
- Writes long-format parquet sorted by `(short_name, dt, side, region, gender,
  user_type, rideable_type)`.
- Snappy compression, per-station row-group sizing.
- Idempotent re-runs (download → recompute → upload, byte-identical).

### `h1` — hourly buckets, monthly file

Source: existing consolidated month parquets (`s3/ctbk/normalized/<YM>.parquet`,
one row per ride).

For each trip row in `cons[ym]` and `cons[ym+1]` (cross-month tail; see
"Gotchas" below), emit two contributions:
- `side='start'`: dt = floor(starttime, hour), short_name = start station's
  canonical short_name, region = start station's region, …,
  count=1, duration_s=duration, duration_s_sq=duration²
- `side='end'`: dt = floor(stoptime, hour), short_name = end station's
  canonical short_name, region = end station's region, …,
  count=1, duration_s=duration, duration_s_sq=duration²

groupby + sum over `(dt_h, short_name, side, region, gender, user_type,
rideable_type)`. Filter to rows with `dt` in [ym_start, ym_start + 1mo).
Write one file `trips/agg/h1/<YYYY-MM>.parquet`.

### `d1` — daily buckets, yearly file

Read all 12 monthly h1 files for the year, rebucket `dt` to floor(day),
groupby + sum. Write one file `trips/agg/d1/<YYYY>.parquet`.

### `mo1` — monthly buckets, decade file

Read all 10 yearly d1 files for the decade, rebucket `dt` to floor(month,
calendar-aligned UTC), groupby + sum. Write one file
`trips/agg/mo1/<DECADE>.parquet`. Decade = `floor(year/10)*10`. Two
decade files cover the historical data: `2010.parquet` (2010-2019, sparse
rows for 2010-01..2013-05 — system genesis is 2013-06) and `2020.parquet`
(2020-2029).

## Wire-up touches

1. **`gbfs/api/src/totals.ts`**:
   - `tripsAggKeys(tier, fromS, toS)` — update to v2 file-period mapping:
     - `mo1` → `trips/agg/mo1/<decade>.parquet` (one or two files for any
       window short of all-history)
     - `d1`  → `trips/agg/d1/<YYYY>.parquet`
     - `h1`  → `trips/agg/h1/<YYYY-MM>.parquet`
   - `pickTripsAggTier(spanS, binS)` — adopt v2's `(spanS, binS)`-aware
     signature (mirroring `pickAvailAggTier`):
     ```
     binS >= 1mo  → mo1
     binS >= 1d   → d1
     binS >= 1h   → h1
     else (binS < 1h, multi-station)
       → not served by this spec; FE / worker routes
         single-station queries to `trips/n0/stations/<sn>.parquet`
     ```
   - Add `duration_s_sq` to `TRIPS_TOTAL_METRICS` (alongside `count` /
     `duration_s`) so `aggregateTotals` sums it.
   - Once `trips/agg/<tier>` files exist on R2, the **fallback branch can
     be deleted** (the `tripsTotalsFallbackPaths` call site has a comment
     marking this).

2. **`gbfs/api/src/index.ts`** — add row-group pruning by `short_name` for
   per-station queries (mirror `readH1ShardForStation`). Decoded body for a
   per-station 1-month h1 query should be ~few KB, not the full file.

3. **`gbfs/api/src/planQuery.ts`** — currently routes trips/region binned
   queries to `trips/region/<r>/<tier>/<window>.parquet`. Decide if station-
   mode binned trips queries should also route to `trips/agg/<tier>` (yes,
   after trips-agg lands).

4. (optional) Frontend `useRollupQuery` / chart code to consume bin-configurable
   trips data with the new tier.

## Validation

Cross-tier sum invariant (mirrors avail-agg's "tier-stitch zero-error" check):

```
Σ count for h1 across <YYYY-MM>     == Σ count for d1 cells in that <YYYY-MM>
Σ count for d1 across <YYYY>        == Σ count for mo1 cells in that <YYYY>
Σ duration_s_sq similarly                                                       (sum monoid)
```

Per-month spot-check: total `count` (filtered to `side='start'`) in
`trips/agg/mo1/<DECADE>.parquet` for a given `(YYYY-MM, region)` cell should
equal the `Count` row for that month/region in the legacy `ymrgtb_cd.json`.

**Note on duration**: the legacy `ymrgtb_cd_*.parquet` aggregator has a latent
bug — `aggregated.py:152` uses `.dt.seconds` (drops the days component for
trips ≥ 24h) where it should use `.dt.total_seconds()`. The trips-agg pipeline
uses `.dt.total_seconds()` correctly, so the new aggregates will produce
slightly higher `duration_s` totals than the legacy JSON. Counts will match
exactly.

Add ≥10 vitest cases to `gbfs/api/src/totals.test.ts` covering:
- New tier file-period mapping (`tripsAggKeys` returns yearly/decade keys)
- New `pickTripsAggTier(spanS, binS)` signature
- `aggregateTotals` summing `duration_s_sq`
- mean/stddev derivation from sum monoid columns
- Parameterized fallback (deletion-pending)

## Out of scope (deferred)

- **Streaming aggregation in worker** for scope=all / scope=regions over
  the new agg tier. Without streaming, full-decode of a year-period d1 file
  (~65 MB compressed → ~750 MB heap) OOMs the 128 MB worker. As shipped,
  the worker only routes through the new agg tier when `filter.short_name`
  is set (rg-pruning brings decode to ~few KB/station). scope=all/regions
  fall through to the existing per-region rolled rides fallback. Adding
  `aggregateTotalsFold` + `aggregateTotalsFinalize` (mirroring `availFold`/
  `availFinalize` in `gbfs/api/src/totals.ts`) lets the worker iterate row
  groups one at a time and retire the fallback entirely.
- **Region-canonicalization**: trips data uses `'NYC'`/`'JC'`/`'HB'` (legacy
  uppercase + `HB` for Hoboken); avail data + worker `ALL_REGIONS` uses
  `'nyc'`/`'jc'`/`'hob'`. Filter.region against trips agg requires either
  case+alias coercion in the worker or canonicalizing in `_expand_month_to_sides`
  (latter requires re-backfill).
- **Sub-hour multi-station agg tier**: v2 punts this for avail (`/day raw`
  bundle). Trips analog would be `trips/n0/day/<YYYY-MM-DD>.parquet`
  (one row per ride, all stations, sorted by `(short_name, ts)` for rg-
  pruning). **Not built here**; flagged as v2 follow-up.
- **Single-station fine-bin**: served from existing
  `trips/n0/stations/<short_name>.parquet` (already 1 row/ride with second-
  precision `dt`, no aggregation needed). Worker / FE bins client-side.
- **Modifying the existing per-region h1 trips files**
  (`trips/region/<r>/h1/<year>.parquet`).
- **FE wire-up of bin-configurable rides plots** (separate, follow-up).

## Gotchas

- **Cross-month tail**: a trip starting on 2025-03-31 ending on 2025-04-01
  appears as a single row in `cons[202504]` (the consolidated parquet keyed
  by *ending* month). To capture its `start='2025-03-31 ...'` contribution
  in `trips/agg/h1/2025-03.parquet`, `TripsAggH1Month(2025-03)` reads BOTH
  `cons[202503]` and `cons[202504]`, then filters output rows to `dt` in
  the target month. (Same pattern as `trips_region_rollup.py`.)
- **Wrangler stale-bundle**: `wrangler deploy` may use a stale build artifact;
  `rm -rf dist` first or migrate to a cleaner build setup.
- **R2 sync robustness**: lean on the avail-agg pattern of `_r2_sync_in(remote, local_dir)`
  for download-once-then-process.
- **Idempotency**: reruns must produce byte-identical outputs (sort columns
  deterministically; use stable groupby; deterministic rg sizing).
- **`duration_s_sq` overflow**: bounded analysis above shows int64 is safe for
  all plausible windows. No saturation handling needed.

## Likely commit shape

1. `spec: trips-agg v2 (calendar-aligned big files, sum-monoid + duration²)`
2. `ctbk trips-agg: h1 stage (monthly file, station-sorted, rg-pruned)`
3. `ctbk trips-agg: d1 + mo1 folding stages (yearly + decade files)`
4. `ctbk trips-agg: backfill 2013-06 to current (decade-2 files: 2010, 2020)`
5. `gbfs/api: route /api/totals?kind=trips through new agg tier`
6. `gbfs/api: retire trips fallback paths now that trips/agg/<tier> exists`
