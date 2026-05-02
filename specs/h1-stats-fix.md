# Spec: h1 raw shards lack `station_id` min/max stats — fix compactor + regen

Status: **open** (2026-05-02).

## Background

After d25397ae was reverted (1102) and replaced by `4c34aa01` (range-read
parquet w/ `columnChunkAggregation`) + `398acc60` (pin hyparquet fork dist),
the worker `/api/totals` raw-tier path is **still 1102** for any window that
hits the **h1 fallback** (current day + most-recent closed day before the
GHA daily compaction cron runs).

Repro (with the new `gbfs/api/ctbk-api` CLI added in `6ced98e9`):

```
$ cd gbfs/api
$ ./ctbk-api totals -S hoboken-terminal-hudson-st-hudson-pl \
    -f 2026-04-29T00:00:00Z -t 2026-04-30T00:00:00Z -b 5m -m all
HTTP 200  0.33s  165,378B  cache=MISS    # ← /day raw bundle path (has stats)

$ ./ctbk-api totals -S hoboken-terminal-hudson-st-hudson-pl \
    -f 2026-05-01T00:00:00Z -t 2026-05-02T00:00:00Z -b 5m -m all
HTTP 503  9.50s   4,696B  cache=MISS     # ← h1 fallback (no stats → 1102)
```

Both queries are single-station, sub-hour-bin avail-totals. The first hits
`gbfs/avail/raw/day/2026-04-29.parquet` (~17 MB, 201 row groups, ~14k
rows/rg, **`has_min_max: true`** for `station_id`). The second hits
`gbfs/avail/h1/2026-05-01/<HH>.parquet` × 24 (~5 MB each, **2407 row
groups, 60 rows/rg, `has_min_max: false`**).

## Root cause

`gbfs/compactor/src/index.ts:181` writes h1 shards via:

```ts
return parquetWriteBuffer({ columnData, rowGroupSize: 60 });
```

The comment on line 178 claims:
> codec defaults to 'SNAPPY'; statistics on by default → free index on
> station_id.

But the actual on-disk parquet has `is_stats_set: true` while every
`station_id` rg's `statistics` block is `{has_min_max: false, min: null,
max: null, ...}`. Verify with:

```
$ AWS_PROFILE=cf aws s3 cp s3://ctbk/gbfs/avail/h1/2026-04-30/12.parquet /tmp/h1.parquet
$ pqm /tmp/h1.parquet | jq '.row_groups[0].columns[] | select(.path_in_schema=="station_id") | .statistics'
{
  "has_min_max": false,
  "min": null,
  "max": null,
  ...
}
```

That breaks `readR2ParquetStationPruned` (`gbfs/api/src/index.ts:564`):

```ts
const inRange =
    min === undefined ||
    max === undefined ||
    ids.some(...);   // ← fall-through: ALL rgs marked in-range
```

For a single-station query against an h1 shard, every one of the 2407 rgs
gets read & decoded — that's the 1102.

## Fix (option A)

Make the h1 compactor emit real `min_value` / `max_value` for the
`station_id` column. Two sub-questions:

1. **Why is `hyparquet-writer` dropping STRING stats?**
   - Plausible: pinned to an old version that doesn't write BYTE_ARRAY
     min/max even with stats enabled. The repo just pinned `hyparquet`
     (read-side) to `runsascoded/hyparquet@fae8d22` for
     `columnChunkAggregation`; `hyparquet-writer` may be on an older
     upstream.
   - Check `gbfs/compactor/package.json` → `hyparquet-writer` version,
     and the upstream changelog for STRING-stats handling.
   - If the writer is the bug, fork & pin (parallel to the read-side
     fork) or upgrade.
2. **Are 60-row rgs the right target?**
   - With proper stats, 60-row rgs should be ~optimal (one rg ≈ one
     station × one hour ≈ ~5 KB on the wire). Keep `rowGroupSize: 60`.
   - If the writer fork is intractable, an interim is `rowGroupSize: ~14000`
     (~1 rg/file) — but then station-filtered queries decode all rows,
     which only works because the file is 5 MB and `metric=all` projects
     a few cols. Prefer the proper-stats fix.

### Acceptance

- Newly-written h1 shards have `has_min_max: true` for `station_id`,
  `min`/`max` matching the actual sorted range of the rg.
- After regenerating historical h1 shards (`gbfs/avail/h1/<date>/<HH>.parquet`),
  `./ctbk-api smoke -S hoboken-terminal-hudson-st-hudson-pl` shows OK
  and < 2s for **every** matrix cell — including the `1d × 5m (raw)` cell
  that currently uses h1 fallback.
- `4/29-4/30` ( /day raw bundle) latency unchanged (~0.3s).

### Regen

The historical h1 shards live at `s3://ctbk/gbfs/avail/h1/<date>/<HH>.parquet`,
2026-04-20+ per the existing comment. Either:
- Re-trigger the compactor's hourly cron to overwrite each shard, OR
- A one-shot script that reads the source minute JSONs (`gbfs/status/<...>`)
  and re-pivots through the same `buildColumnData` + (fixed)
  `parquetWriteBuffer`.

Idempotency: re-runs are safe (same key, same content modulo stats).

## Out of scope (rejected)

- **B.** Bump `rowGroupSize` to ~14k and skip pruning. Fewer rgs but
  full-decode for station-filtered → only OK because files are small.
  Doesn't help the *general* case (e.g. multi-day fallback ranges).
  Real fix is stats; rg-size tuning is independent.
- **C.** Worker-side hack: read the dictionary page of the first column
  chunk to recover bounds. Adds CPU + complexity for a workaround;
  upstream stats are the right place to fix this.

## Why this matters

Without this fix, the new `/api/totals`-only FE (`f0333dac` + `bf0c159a`,
local-only at present) cannot ship: any sub-hour avail chart that
includes today or yesterday's window will 1102. Holding the FE push on
`h main` + `h main:www` until acceptance criteria above are met.
