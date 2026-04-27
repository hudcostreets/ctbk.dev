# Spec: `ctbk trips-agg` — Multi-Scale Trips Aggregation Pipeline

> **Owner**: spec written 2026-04-27. Implementation TBD on `e`.

## Goal

Build the trips-side analog of `ctbk avail-agg` (in `ctbk/avail_agg.py`). Produces
multi-tier sum-monoid aggregates of trip counts and durations on R2, so the
`/api/totals?kind=trips` endpoint can stitch tiers and serve any-window queries
without falling back to per-station/per-region rides files.

This unblocks:
- Bin-configurable rides plots on the homepage (currently locked to monthly via
  the static `ymrgtb_cd.json`).
- Cleanly retiring the fallback chain in `gbfs/api/src/index.ts` (`tripsTotalsFallbackPaths`).
- Region-level trips totals (currently `scope=regions` returns zero rows because
  per-region rides files don't carry a `region` column — see e's note from
  2026-04-27).

## Architecture (mirrors `avail-agg`)

```
trips/n0/stations/<short_name>.parquet              # raw; existing
              ↓
trips/agg/h1/<YYYY-MM-DD>.parquet                   # 1h buckets
              ↓
trips/agg/d1/<YYYY-MM>.parquet                      # 1d buckets
              ↓
trips/agg/mo1/<YYYY>.parquet                        # 1mo buckets
```

Calendar-aligned shard windows. Coarser tiers fold finer ones (h1 → d1 → mo1)
so the raw layer is read at most once per pyramid build. Sum-monoid combiner:
groupby + sum on the dim keys.

## Schema (long format)

```
dt              int64    bucket start, unix-s (UTC)
short_name      string   canonical station short_name
side            string   'start' | 'end'
region          string   'NYC' | 'JC' | 'NWK' | 'BX' | …
gender          int16    0 (unknown) | 1 (male) | 2 (female)
user_type       string   'Subscriber' | 'Customer' | …
rideable_type   string   'classic_bike' | 'electric_bike' | 'docked_bike' | …
count           int64    # trips
duration_s      int64    sum(duration_seconds)
```

The `dims` allowlist in `gbfs/api/src/totals.ts:TRIPS_DIM_COLUMNS` is already
`['side', 'gender', 'user_type', 'rideable_type', 'region', 'short_name']` —
keep schema in sync. Sparse: omit dim combinations with zero rows.

`side='start'` and `side='end'` rows are emitted from the same raw record (one
trip contributes to both); per-station agg therefore double-counts at the
trip level. Consumers `groupby().sum()` over `side` if they want unique trips,
or filter `side='start'` for trip-level counts.

## Stages

Match `avail-agg` naming + `MonthTask` integration patterns (`ctbk/avail_agg.py`):

| Stage class                | CLI alias           | Output                                  | Bucket size |
|----------------------------|---------------------|-----------------------------------------|-------------|
| `TripsAggH1Day(date)`      | `trips-agg h1`      | `trips/agg/h1/<YYYY-MM-DD>.parquet`     | 1 hour      |
| `TripsAggD1Month(ym)`      | `trips-agg d1`      | `trips/agg/d1/<YYYY-MM>.parquet`        | 1 day       |
| `TripsAggMo1Year(year)`    | `trips-agg mo1`     | `trips/agg/mo1/<YYYY>.parquet`          | 1 month     |

Each stage:
- Reads its predecessor (or the raw normalized monthlies for h1).
- groupby `(dt_bucket, ...all_dims)` → sum `(count, duration_s)`.
- Writes long-format parquet sorted by `(dt, short_name, side)` for cheap
  row-group min/max stats.
- Snappy compression, default rowGroupSize.
- Idempotent re-runs (download → recompute → upload).

### `h1` — hourly buckets

Source: existing normalized monthly trips parquets (`s3/ctbk/normalized/<ym>.parquet`
or wherever the canonical "all trips ending in month X" file lives — mirror
`ctbk/avail_agg.py`'s pattern of pulling from R2 to a local mirror).

For each trip row in the source, emit two contributions:
- `side='start'`: dt = floor(starttime, hour), short_name = start_station_id_canonical,
  region = start station's region, …, count=1, duration_s=duration_seconds
- `side='end'`: dt = floor(stoptime, hour), short_name = end_station_id_canonical,
  region = end station's region, …, count=1, duration_s=duration_seconds

groupby + sum produces the hourly aggregates. Write one shard per UTC date.

Cross-month-tail behaviour: a trip starting on day D and ending on day D+1
contributes a `start` row to D's shard and an `end` row to D+1's shard. Both
shards are correct in isolation. (See `bd050425` for the related n1 caveat —
same logic applies here.)

### `d1` / `mo1` — coarser folds

Read finer tier(s) for the window, groupby `(floor(dt, day-or-month), ...dims)`,
sum `(count, duration_s)`, write.

## Wire-up touches

1. `gbfs/api/src/totals.ts` — already supports `kind=trips` with the `tripsAggKeys`
   path generator + agg-tier fallback chain. Once `trips/agg/<tier>` files exist
   on R2, the **fallback branch can be deleted** (the `tripsTotalsFallbackPaths`
   call site has a comment marking this).
2. `gbfs/api/src/planQuery.ts` — currently routes trips/region binned queries to
   `trips/region/<r>/<tier>/<window>.parquet`. Decide if station-mode binned
   trips queries should also route to `trips/agg/<tier>` (probably yes, after
   trips-agg lands).
3. (optional) Frontend `useRollupQuery` to consume bin-configurable trips data.

## Validation

Cross-tier sum invariant (mirrors avail-agg's "tier-stitch zero-error" check):

```
sum(count for h1 across <YYYY-MM-DD>) == sum(count for d1 cell on <YYYY-MM-DD>)
sum(count for d1 across <YYYY-MM>)    == sum(count for mo1 cell on <YYYY-MM>)
```

Per-month spot-check: total `count` in `trips/agg/mo1/<YYYY>.parquet` for a
given `(YYYY-MM, region)` cell should equal the `count` row for that month/region
in the legacy `ymrgtb_cd.json`.

Add ≥10 vitest cases to `gbfs/api/src/totals.test.ts` covering trips agg-tier
reads (when shards exist), parameterized fallback (deletion-pending).

## Out of scope

- Modifying the existing per-region h1 trips files (`trips/region/<r>/h1/<year>.parquet`).
- FE wire-up of bin-configurable rides plots (separate, follow-up). The pipeline
  + endpoint capability lands here; FE work in a separate spec.
- Migrating the trips raw layer to a different layout. The existing normalized
  monthly parquets (or equivalent) are the source.

## Gotchas (from e's avail-agg notes)

- **Wrangler stale-bundle**: `wrangler deploy` may use a stale build artifact;
  `rm -rf dist` first or migrate to a cleaner build setup.
- **R2 sync robustness**: lean on the avail-agg pattern of `_r2_sync_in(remote, local_dir)`
  for download-once-then-process.
- **Idempotency**: reruns must produce byte-identical outputs (sort columns
  deterministically; use stable groupby).

## Likely commit shape

1. `ctbk trips-agg: h1 stage + tests`
2. `ctbk trips-agg: d1 + mo1 folding stages`
3. `ctbk trips-agg: backfill + commit pyramid for 2013-2026`
4. `gbfs/api: retire trips fallback paths now that trips/agg/<tier> exists`
