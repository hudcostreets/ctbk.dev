# Spec: rides → pyrmts-geo (`rides-v1`)

> Status: **draft** (2026-05-27). First-checkpoint port of ctbk's rides
> data onto pyrmts + pyrmts-geo. Parallel structure to
> `specs/avail-pyramid-v2.md`; ports the second of ctbk's two big
> aggregation trees onto pyrmts-native h3-keyed shards.
>
> Why now: the avail v2 pyramid is live (`/api/avail-v2[/cells]`,
> 2026-05-26) but unused by the FE. The natural FE consumer is a
> "region detail" page that needs *both* avail and rides cumulatively
> over a cell set. Avail is done; rides is the missing half. Per
> conversation with user: better to do rides → pyrmts-geo directly
> than to do a non-geo intermediate port that hardcodes 4 region dims
> and rips them out shortly after.
>
> Why "v1" (not "v2" like avail): unlike avail, rides has *no* prior
> pyrmts port to supersede. The existing `trips/{agg,region,stations}`
> tree is the only predecessor.

## Where we are

Existing rides aggregations on R2:

| Path | Shape | Built by |
|---|---|---|
| `trips/agg/{h1,d1,mo1}/<period>.parquet` | dims `[y,m,r,g,t,b]`, metric `count` | `trips_agg` |
| `trips/region/{hob,jc,nyc}/...` | per-region rollups | `trips_region_rollup` |
| `trips/stations/<short_name>.parquet` | per-station ride counts | `trips_per_station` |

These three trees collapse into one pyrmts-geo pyramid: dense h3-keyed
shards at multiple resolutions, with the existing `[y,m,r,g,t,b]` dims
preserved.

## Pyramid shape

Build **two sibling pyramids**, identical in every respect except the
h3 anchor:

| Pyramid | `cellCol` | `keyTemplate` |
|---|---|---|
| `rides-v1-start` | `start_h3_cell` | `rides-v1/start/{tier}/{period}.parquet` |
| `rides-v1-end`   | `end_h3_cell`   | `rides-v1/end/{tier}/{period}.parquet` |

Both share the rest of the shape:

```yaml
axis: time
binCol: dt                       # int64 unix ms

dims:                            # carried inline, post-fetch filter
  - { name: gender,    type: string }
  - { name: user_type, type: string }
  - { name: bike_type, type: string }

metrics:                         # sum monoid (n / sum / sumsq)
  - { name: count,    monoid: sum }   # ride count (sum of 1s)
  - { name: duration, monoid: sum }   # ride duration in seconds (sum)

geo:
  resolutions: [9, 7, 5]          # same as avail-v2

tiers:    # finest → coarsest; rides don't need sub-hour granularity
  - { name: '1h',   bin: 1h,   shard: 1mo }   # 720 bins/mo
  - { name: '6h',   bin: 6h,   shard: 1mo }   # 120 bins/mo
  - { name: '1d',   bin: 1d,   shard: 1y  }   # 365 bins/y
  - { name: '7d',   bin: 7d,   shard: 1y  }   # 52 bins/y
  - { name: '1mo',  bin: 1mo,  shard: 1y  }   # 12 bins/y
  - { name: '3mo',  bin: 3mo,  shard: 1y  }   # 4 bins/y
  - { name: '1y',   bin: 1y,   shard: all }   # full history
```

**Why two pyramids, not one shared schema with both cell cols**:
pyrmts-geo materializes one cellCol's hierarchy per row at the chosen
resolutions. A two-cellCol row would have to materialize both
hierarchies, breaking the geo pyramid invariant (one cell per row at
each resolution). Two pyramids keeps each side clean; storage roughly
doubles (estimates in §6 reflect that).

**Why both, not just `start`**: the user wants to toggle start vs end
in the FE (e.g. station-detail asking "rides ending here" is more
natural than "rides starting here"; region-detail likely wants both
flavors stackable on one chart). Build both up-front so FE work isn't
gated on a second backfill.

**Read-side consumption** (preview, fleshed out in §3 + §5):
- "Rides starting in X" → `rides-v1-start` pyramid
- "Rides ending in X" → `rides-v1-end` pyramid
- Stacked start+end on the same chart → two parallel queries, one
  per pyramid, FE composes the series. Since the chart already
  supports stacking by `[r,g,t,b]` dims (homepage histogram), adding
  `anchor` as a stackable axis is purely a FE concern.

**Monoid choice**: `sum` (not histogram). For `count`, `histogram`
would be over-precise (the state is just "1 ride happened"). `sum`
gives n / sum / sumsq, supporting mean/min/max/stddev. For `duration`,
same shape — sum of seconds aggregates additively.

**Dims** `gender / user_type / bike_type` carried inline. Post-fetch
filtered by `?gender=female`, `?user_type=member`, etc. — same shape
as the existing `/api/totals?kind=trips` filter set. Region dim is
*not* carried; regions are derived FE-side from `start_h3_cell` via a
static `region_name → cells[]` lookup table.

## Source

`s3://ctbk/normalized/<YYYYMM>.parquet` — per-ride records (since
2013-06; ~150 monthly files, ~few-hundred-MB each, ~400M rides total).

Schema (relevant cols):
- `Start Time` / `Stop Time` — datetime
- `Start Station ID` / `End Station ID` — station UUIDs
- `Bike ID`, `User Type`, `Gender`, `Region` — categorical
- `bike_type` (classic/electric) — derived from `Bike ID` ranges OR
  explicit column (post-2021); harmonize per existing
  `ctbk/stations/harmonize.py` logic

For h3-materialization, each ride needs *both* start and end station
`(lat, lng)` pairs. Source of truth: the avail v2 station-geo table
(built by `load_station_geo_for_date()` in `avail_v2.py`). Reuse that
loader; look up both `start_station_id` and `end_station_id` per ride.

## 1. Pyrmts python deps (do first)

ctbk currently has `pyrmts @ git+...c8de71f` in `pyproject.toml`. Add
`pyrmts_geo` (same repo, different subdirectory):

```toml
[tool.uv.sources]
pyrmts = { git = "https://github.com/runsascoded/pyrmts.git", rev = "<SHA>", subdirectory = "python/pyrmts" }
pyrmts_geo = { git = "https://github.com/runsascoded/pyrmts.git", rev = "<SHA>", subdirectory = "python/pyrmts_geo" }
```

(Bump `<SHA>` to whatever the latest pyrmts main is at time of build.)

Verify imports:
```py
from pyrmts import write_tier_parquet, cascade_tiers
from pyrmts_geo import materialize_resolutions
```

## 2. Builder module: `ctbk/rides_v1.py`

Mirrors `ctbk/avail_v2.py`'s structure. Builds **both** anchors in one
pass over the source (cheaper than reading the normalized file twice).

### `build_1h_month_tables(year_month, station_geo, resolutions) -> (start_table, end_table)`

Build the finest tier (`1h`) for one calendar month, returning two
tables (one per anchor):
1. Read `normalized/<YYYYMM>.parquet`.
2. For each ride: look up *both* start and end stations' `(lat, lng)`;
   drop a ride from the corresponding pyramid if its station is missing
   (track drop counts per anchor).
3. h3-materialize separately for each anchor:
   ```py
   start_rows = materialize_resolutions(rides, geo,
       lat_lng=lambda r: station_geo.get(r['start_station_id']))
   end_rows = materialize_resolutions(rides, geo,
       lat_lng=lambda r: station_geo.get(r['end_station_id']))
   ```
4. Group each: `(<anchor>_h3_cell, dt_hour, gender, user_type, bike_type)`,
   aggregate `count = len(group)`, `duration = sum(durations)`.
5. Output two `pa.Table`s with cols
   `[<anchor>_h3_cell, dt, gender, user_type, bike_type, count_n,
   count_sum, count_sumsq, duration_n, duration_sum, duration_sumsq]`.

### `build_cascade_shard(anchor, tier, period, derive_from)`

`anchor: Literal['start', 'end']` picks which sibling pyramid to
cascade. Otherwise mirrors `avail_v2.build_cascade_shard`. Reuse
`pyrmts.cascade_tiers` if it fits the (sum-monoid, dim-carrying)
shape; otherwise inline.

### Write step

```py
from pyrmts import write_tier_parquet
write_tier_parquet(start_table, out=start_buf, sort=['dt', 'start_h3_cell'])
write_tier_parquet(end_table,   out=end_buf,   sort=['dt', 'end_h3_cell'])
```

(Same helper that avail-v2 now uses. Default `row_group_size` works.)

### CLI

```bash
# Build both anchors in one invocation (default), or pick one with --anchor.
ctbk rides-v1-build --tier 1h --year 2013-2026 [--anchor start|end|both] [--force]
ctbk rides-v1-build --tier 6h --derive-from 1h ...
# ... cascade up the ladder
ctbk rides-v1-probe [-s 1]                     # per-tier per-anchor shard stats
ctbk rides-v1-validate -d 2024-05,2024-06     # cross-check vs trips/agg/h1
```

`--anchor both` (default) writes both sibling pyramids per month. Use
`--anchor start` / `--anchor end` only to rebuild one side.

## 3. CFW endpoints: `gbfs/api/src/rides_v1.ts`

Mirror of `avail_geo.ts`, with an `?anchor=start|end` query param
selecting which sibling pyramid to read. Default `anchor=start` (FE
must opt-in to `end`).

- `GET /api/rides-v1?anchor=start|end&from=&to=&bbox=&dims=&bin_budget=&cell_budget=`
  — rollup over bbox; `dims=[]` so `stitch` collapses cells.
- `GET /api/rides-v1/cells?anchor=start|end&...`
  — per-cell breakdown; `dims=['<anchor>_h3_cell']`.

Implementation: factor a `makeRidesPyramid({ bucket, keyTemplate,
cellCol })` shared by both anchors (parallel to avail-v2's
`makeBaseProps`).

Reducer dispatch: `?reducer=mean|sum|count|min|max|...`. Default
`?reducer=sum` (since the metric *is* a sum-monoid; mean / stddev
are derived from n / sum / sumsq).

`filter.gender=...` / `filter.user_type=...` / `filter.bike_type=...`
plumbed as RG-prune filters (pyrmts §2; same primitive avail shadow
uses for station_id).

**Stacked start+end queries**: FE issues two parallel requests
(`?anchor=start` and `?anchor=end`) and composes the series. No
special endpoint needed — chart-level concern.

## 4. Validation

```bash
# Shard stats
ctbk rides-v1-probe -s 1

# Cross-check vs existing trips/agg/h1 for a representative date range.
# Expected: total counts match exactly (sum monoid + same source data);
# per-h3-cell breakdowns are new in v1 (no analogue in legacy agg).
ctbk rides-v1-validate -d 2024-05,2024-06

# Hit endpoint with the same query the FE would issue (3-region rollup
# for the homepage's NYC/JC/HOB picker):
curl ".../api/rides-v1?from=2024-01-01&to=2025-01-01&bbox=40.6,-74.1,40.9,-73.8&bin_budget=12&cell_budget=200"
```

## 5. FE region picker (separate work, post-build)

This spec only covers the BE build. FE consumption — region picker
dropdown, polygon-draw, multi-station detail page — lands in a
follow-up after the pyramid is live. Sketch of how regions work
FE-side:

```ts
// www/src/regions.ts (new)
import { latLngToCell } from 'h3-js'
// Static lookup, built from existing station_geo + region polygons.
export const REGION_CELLS: Record<string, string[]> = {
  nyc: [/* h3 cells covering NYC stations at res 7 */],
  jc:  [...],
  hob: [...],
}
```

Region-picker selects → FE passes `cells=...` to
`/api/rides-v1` (and `/api/avail-v2`, which also speaks cells). Polygon-
draw uses `polygonToCells(...)` to compute the cell set client-side.

## 6. Storage / runtime estimates

- ~400M rides × 3 h3 resolutions × **2 anchors** = ~2.4B cell-row
  materializations before aggregation.
- After (cell, dt, dims)-grouping: dominated by 1h tier. Estimated
  ~50K cell-hours/month × 144 dim combos × 13 years × 12 months ≈
  ~1B rows per anchor. Optimistic compression: 5-10 GB per anchor.
- Coarser tiers shrink harmonically; total pyramid (both anchors)
  likely 30-60 GB.
- EC2 build runtime: ~2× avail-v2 (~1.5-2 hours for both anchors at
  1h@1mo + cascade — single read of the source per month feeds both).
  Embarrassingly parallel per `(year-month, tier)`.

If estimates are off by >2× when running, surface and revisit shard
sizing.

## 7. Out of scope (followups)

- **Station-pair pyramid** (joint start-cell × end-cell distribution).
  Currently served by `trips/stations/<id>.parquet`. Different shape
  (pair-keyed, not cell-keyed); separate pyramid. The sibling
  start/end pyramids in this spec cover marginal queries but not
  joint pair queries.
- **Dropping legacy `trips/agg/`, `trips/region/`, `trips/stations/`**.
  After FE has migrated.
- **`/api/totals?kind=trips` migration**. The legacy totals path
  still serves `trips/agg/<tier>`. Once `/api/rides-v1` is feature-
  equivalent, redirect there (or unify under `/api/totals`).

## 8. EC2 runbook (mirror of avail v2 §0 + §3a + §3b)

```bash
cd ~/c/hccs/ctbk
direnv allow
uv sync                          # picks up pyrmts/pyrmts_geo

# Build finest tier (1h@1mo) for BOTH anchors — embarrassingly parallel per month.
# Single source read per month feeds both start + end pyramids.
ctbk rides-v1-build --tier 1h --year 2013-2026 --anchor both

# Cascade up — each tier builds both anchors unless --anchor narrows it.
ctbk rides-v1-build --tier 6h  --derive-from 1h  --anchor both --force
ctbk rides-v1-build --tier 1d  --derive-from 6h  --anchor both --force
ctbk rides-v1-build --tier 7d  --derive-from 1d  --anchor both --force
ctbk rides-v1-build --tier 1mo --derive-from 1d  --anchor both --force
ctbk rides-v1-build --tier 3mo --derive-from 1mo --anchor both --force
ctbk rides-v1-build --tier 1y  --derive-from 1mo --anchor both --force

# Probe + validate
ctbk rides-v1-probe -s 1
ctbk rides-v1-validate -d 2024-05,2024-06

# Commit + push to e:main (laptop handles h:main + deploys)
git add ctbk/rides_v1.py specs/rides-pyramid-v1.md
git commit -m "rides-v1: …"
git push e main
```

## 9. Local prototyping note

While the full backfill belongs on EC2, the design can be prototyped
locally on a single month (e.g. `--year 2024-05`) to:
- Validate the schema + monoid choice via cross-check against
  `trips/agg/h1/2024-05-*.parquet`.
- Smoke-test pyrmts_geo's `materialize_resolutions` against the
  station_geo loader.
- Tune `row_group_size` / sort order before committing to a full
  rebuild.

Recommended: spend 30 min running the 1h build for a single month
locally before kicking off the full EC2 backfill. Catches schema
bugs cheap.

## References

- `~/c/hccs/ctbk/specs/avail-pyramid-v2.md` — parent pattern, already
  shipped
- `~/c/hccs/ctbk/ctbk/avail_v2.py` — closest existing analogue
- `~/c/hccs/ctbk/ctbk/trips_agg.py` + `trips_per_station.py` +
  `trips_region_rollup.py` — legacy aggregators (will be retired)
- `~/c/pyrmts/python/pyrmts_geo/src/pyrmts_geo/materialize.py` — h3
  materialization helper
- `~/c/pyrmts/specs/done/cascade-tiers-and-geo-materializer.md` —
  pyrmts-side shipped helpers
- `~/c/pyrmts/specs/done/writer-helper-and-arbitrary-col-rg-prune.md`
  — writer helper + arbitrary-col RG pruning (for dim filters)
