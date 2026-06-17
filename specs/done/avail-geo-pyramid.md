# Spec: avail-geo pyramid (pyrmts-geo serving)

> Status: **PoC live** (2026-05-25). Two h1 shards built + uploaded
> + served via `/api/avail-geo`. Real plan-fetch-stitch verified
> against R2.

## Overview

H3-cell-keyed avail shards at multiple materialized resolutions, served
via `pyrmts-geo.serveGeoQuery`. Replaces the per-station legacy avail
serving (which has no geo rollup; "this neighborhood" queries fan-out
to all stations).

## Today's state

**Built** (`ctbk avail-geo-build`):
- h1: `avail-geo/h1/2026-05-22.parquet`, `2026-05-23.parquet`
  (~1.6 MB each, 43,900 rows, 3 resolutions × 25 hour-buckets)
- d1: `avail-geo/d1/2026-04.parquet` (~10 MB, 41,873 rows × 24 daily-buckets)
- 3 materialized resolutions (9 / 7 / 5) → 1,675 / 75 / 6 unique h3 cells
- Wide-JSON schema: `(h3_cell, dt[ms], bikes, ebikes, docks, disabled, pending)`
- Histograms as JSON-string columns (parsed by pyrmts on read)
- Sorted by `(h3_cell, dt)` — cell IDs cluster by resolution naturally

**Served** (`gbfs/api/src/avail_geo.ts` + `/api/avail-geo` endpoint):
- `serveGeoQuery({ pyramid, request })` — pyrmts-geo handles everything
- Query params: `from`, `to`, `bbox=minLat,minLng,maxLat,maxLng`,
  `bin_budget`, `cell_budget`
- Verified — four queries:
  - rollup `/api/avail-geo`, 1-day window, wide bbox: `outputTier=h1, outputRes=5` (7 cells), 24 rows
  - rollup `/api/avail-geo`, 1-day window, narrow bbox: `outputTier=h1, outputRes=9` (141 cells), 24 rows
  - rollup `/api/avail-geo`, 1-month window, wide bbox: `outputTier=d1, outputRes=5`, 24 daily rows
  - per-cell `/api/avail-geo/cells`, 1-day window, narrow bbox: 24 × 96 = 2,304 rows (one per cell per bucket)

## Open design decisions

### `dims: []` vs `dims: ['h3_cell']` — **resolved (both shipped)**

Two endpoints, same underlying shards:
- `/api/avail-geo` — `dims: []`, system rollup over bbox per bucket
- `/api/avail-geo/cells` — `dims: ['h3_cell']`, per-cell breakdown preserved (heatmap shape)

### Histogram column encoding

Currently plain `STRING` columns containing JSON. pyrmts's `histogram`
monoid parses on first touch. Alternative: use parquet `LogicalType=JSON`
(via pyarrow `pa.json` extension type if available, or metadata-tagged
string). Hyparquet then decodes directly. Minor; defer.

### h3 resolution choice

`[9, 7, 5]` is arbitrary. Tradeoffs:
- More resolutions = bigger shards + more cells per row to skip at
  read time. Diminishing returns past ~3 levels per "decade" of
  zoom-out.
- Resolution gaps (4–6 levels apart) let bbox→cells produce a usable
  count at every zoom. `[9, 7, 5]` covers 174m / 1.2km / 8.5km cell
  edges — good for "station" / "neighborhood" / "borough" semantics.
- Add res 3 (60km) later if needed for "northeast US" zoom.

## Next steps

### Soon

1. ~~**Add `h3_cell` dim**~~ — done (`/api/avail-geo/cells`).

2. **Backfill driver**: shell wrapper that loops over all existing
   `avail/agg/h1/<date>.parquet` shards + runs `ctbk avail-geo-build`
   for each. Or extend the Python CLI to take a date range. Easy.

3. **d1 / mo1 builders**: same `build_geo_shard()` function works for
   any input shard. Add `ctbk avail-geo-build-d1` / `mo1` variants
   that read the corresponding tall shards + write to
   `avail-geo/d1/<ym>.parquet` / `avail-geo/mo1/<y>.parquet`. Or
   parameterize the existing CLI by tier name.

4. **Watermarks / build automation**: hook into the existing
   `update.sh` pipeline so each new month rolls a new geo shard.

5. **FE consumer**: pyrmts-geo's `usePyramidGeo` React hook. Wire into
   the Stations page (heatmap overlay?) or a new "system trends over
   bbox" chart on the homepage.

### Later

6. **Trips geo pyramid**: similar structure, different metrics. Each
   ride has `start_lat/lng` + `end_lat/lng` → encode at each
   resolution. Dims: `(side, gender, user_type, rideable_type)` × h3
   resolution. Metrics: `count` + `duration_s` (sum monoid). New
   Python builder reads raw normalized rides shards. Bigger lift than
   avail because there's no existing histogram source.

7. **Cell labels / lookup**: nice-to-have to map h3 cells back to
   human-readable names ("Williamsburg", "Hoboken"). Could be a
   separate static lookup file or computed live from a polygon dataset.

## Schema decisions (locked in for v0)

| Choice | Value | Rationale |
|---|---|---|
| Time unit | unix milliseconds | pyrmts time-axis convention |
| Compression | snappy | hyparquet doesn't decode zstd |
| Resolutions | finest-first `[9, 7, 5]` | pyrmts-geo planner convention |
| Histogram encoding | JSON-string column per metric | hyparquet decode + pyrmts `histogram` monoid happy |
| Sort | `(h3_cell, dt)` | h3 cell IDs encode resolution in high bits → resolution-then-spatial clusters |
| Key template | `avail-geo/{tier}/{period}.parquet` | matches legacy `avail/agg/{tier}/{period}` shape |
| `dims` | `[]` (v0) | system-rollup-over-bbox shape; per-cell is a future endpoint |

## References

- `~/c/pyrmts/SPEC.md` — full pyrmts design
- `~/c/pyrmts/js/packages/pyrmts-geo/` — TS impl (~1.1K LoC + tests)
- `ctbk/avail_geo.py` — builder
- `gbfs/api/src/avail_geo.ts` — CFW glue
- Task #61 — tracker
