# LUC-anchored materialization: per-station queries on the v3 stack

## Goal

Make the v3 pyramids (avail + rides) sufficient for **both** wide rollups
*and* per-station queries, by anchoring each station's contribution at its
**LUC** (Lowest-resolution Uniquely-containing Cell) + ancestors.

Once shipped, we can retire:
- `/api/totals?kind=availability` worker code
- `ctbk/avail_agg.py`, `ctbk/avail_raw_day.py`
- The legacy `Build /h1`/`Build /day`/`Build /d1`/`Build /mo1` steps in
  `.github/workflows/gbfs-compact.yml`
- R2 prefixes `avail/agg/`, `gbfs/avail/raw/day/`
- The `ymdgtb_cd` per-station static JSON build path (for rides)

…leaving exactly one geo-keyed storage layout per metric domain.

## Motivation

Today the v3 pyramids materialize **every station at every L10-L15 level**
(6 rows per station per dt). That's correct for wide-rollup queries
(`/api/{avail,rides}-v3?bbox=…` or `?cells=<minimalCover-output>`), but
provides only ~80m² spatial precision — at L15, 32% of stations share a
cell with at least one other.

For per-station UI (StationDetail's avail chart, station-detail trip
history), we currently route around the pyramid:
- Avail: `/api/totals?kind=availability&filter.station_id=…` reads the
  *legacy* `avail/agg/{h1,d1,mo1}` shards (built by daily GHA from
  per-minute WAL JSONs), which keep `station_id` as a row dimension.
- Rides: `useStationTrips` fetches a static per-station JSON
  (`ymdgtb_cd_<station>.json`) built once at processing time.

Two parallel pipelines duplicate the v3 work. We want one.

## The LUC architecture

### Definitions

- **LUC** = Lowest-resolution Uniquely-containing Cell. For station X,
  the *coarsest* S2 level where X's cell contains no other station.
- Computed empirically from the current `gbfs/info` snapshot. For our
  2411 stations on 2026-06-16:

  | LUC | n stations | pct |
  |---|---|---|
  | L11 | 3 | 0.1% |
  | L12 | 1 | 0.0% |
  | L13 | 14 | 0.6% |
  | L14 | 173 | 7.2% |
  | L15 | 1453 | 60.3% |
  | L16 | 705 | 29.2% |
  | L17 | 58 | 2.4% |
  | L18 | 2 | 0.1% |
  | L19 | 2 | 0.1% |

### Storage invariant

Each station materializes at **LUC + ancestors up to L10**. Nothing finer
than LUC, nothing coarser than L10.

For station X with LUC = L*L*, X contributes to rows at levels
{L10, L11, …, L*L*}, so *L* − 10 + 1 rows per (dt, metric).

### Why this is exact (no L14/L15 row needed for LUC=L13 stations)

`minimalCover` walks **up** from input cells and emits the coarsest
pure-include subtree root for each. For station X with LUC = L*L*, X's
L*L* cell has `excludeCount = 0` by definition (X is alone), so the DP
terminates at L*L* and never recurses to finer levels. So:

> For any cell `c` minimalCover emits at level L, every station in `c`
> has LUC ≥ L.

Therefore every materialized row at level L sums exactly the stations in
`c` that have LUC ≥ L — and every such station has a materialized row at
L (it's an ancestor of its LUC). The query is exact.

(Proof + impl walk-through in the session log; see commit message of the
implementation PR.)

### Storage delta

| model | rows per dt | Δ vs current |
|---|---|---|
| Current (universal L10-L15) | 14,466 | 0 |
| **LUC + ancestors** | **15,085** | **+4.3%** |

The +4.3% comes from extra L16-L19 rows for the 767 stations with
LUC > L15; mostly offset by the 191 stations with LUC ≤ L14 skipping
L14/L15 rows.

In absolute terms: ~5 MB → ~5.2 MB per 1m hour-shard; ~12 GB → ~12.5 GB
total v3 avail storage. Negligible.

## The station-LUC denorm

```json
{
  "<gbfs_station_id>": {
    "lat": 40.7505,
    "lng": -73.9505,
    "cell": "89c25901",   // LUC cell token
    "level": 15           // LUC level
  },
  ...
}
```

~150 KB JSON for 2411 stations. Powers:

1. **bbox/polygon point-in-region** (FE-side, O(n_stations) scan with
   pre-filter by polygon bbox).
2. **station_id → LUC lookup** for per-station queries (O(1) hash).

Distribute as `www/public/assets/station-luc.json`, fetched once by the
FE (TSQ-cached, `staleTime: Infinity`). Worker reads via R2 (mirror at
`s3://ctbk/station-luc.json`).

Built by a new `ctbk station-luc-build` CLI subcommand:
- Pull current `gbfs/info/<date>.json`
- For each station: enumerate cells at L10..L19, find the lowest level
  where occupancy = 1, emit that as LUC.
- Write JSON to local dir + DVC + R2.
- Re-run on station-set churn (new stations added/removed). Cron weekly
  is probably plenty.

## Builder change

`ctbk/avail_v3.py:build_1m_hour_table` and `ctbk/rides_v1.py`'s
`v3` build path currently iterate `for res in DEFAULT_RESOLUTIONS` and
write all 6 levels per station. Replace with:

```python
luc_per_station = load_station_luc()  # {sid: {cell, level}}
for sid in stations_in_minute:
    luc = luc_per_station.get(sid)
    if luc is None:
        # Unknown station (race vs station-luc rebuild) — skip and warn.
        missing_sids.add(sid)
        continue
    luc_level = luc['level']
    # Materialize at LUC + all ancestors up to L10.
    for level in range(10, luc_level + 1):
        cell = (luc['cell'] if level == luc_level
                else s2cell.lat_lon_to_token(lat, lng, level))
        accum[(cell, dt_sec, metric)][state_str] += 1
```

The cascade tier builders (`build_cascade_shard`) need no change — they
just sum histograms per `(cell, dt_out, metric)`. The set of cells
varies per shard naturally.

## Query path

Three modes, all on the v3 pyramid:

### 1. Polygon/bbox rollup (Home, region selection)

FE computes the cover:

```ts
const stations = stationLuc.filter((s) => pointInPolygon(s, polygon))
const includeAtLUC = stations.map((s) => s.cell)  // mixed levels
const cover = s2Index.minimalCover(includeAtLUC, system, {
  coarsestLevel: 10,
})
fetch(`/api/avail-v3?cells=${cover.include.join(',')}&cells.exclude=${cover.exclude.join(',')}&...`)
```

Worker queries the pyramid with the mixed-level `cells=` predicate. The
existing `outputCells` planner path (from `specs/done/plan-geo-query-precomputed-cover.md`)
handles mixed-level covers via `filterCellsByCover`.

### 2. Per-station detail (StationDetail page)

```ts
const { cell, level } = stationLuc[stationId]
fetch(`/api/avail-v3?cells=${cell}&...`)
```

One cell, one row per dt. Histograms reflect exactly that station's
observations.

### 3. N-station bag (multi-select)

```ts
const cells = stationIds.map((id) => stationLuc[id].cell)
fetch(`/api/avail-v3?cells=${cells.join(',')}&...`)
```

Mixed-level `cells=` IN-list. Worker returns one row per dt per cell;
stitch sums.

The worker doesn't need a new endpoint mode — the existing `cells=`
param already supports all three. The FE encodes the intent in the cell
list it sends.

## Migration

### Phase 1: build LUC denorm + rebuild v3 pyramids on `e`

1. `ctbk station-luc-build` → produce `station-luc.json`, upload to R2
   + commit to repo for FE fetch.
2. Bump `ctbk/avail_v3.py` and `ctbk/rides_v1.py` builders to read LUC
   and emit only LUC + ancestors.
3. Rebuild avail-v3 from scratch on `e`: ~5 min wall (1m tier) +
   cascade. Overwrite `s3://ctbk/avail-v3/`.
4. Rebuild rides-v3 incrementally — re-emit all months, similar wall
   time per month, overwrite `s3://ctbk/rides-v3/`.

### Phase 2: FE migration

5. `useStationAvailability` → fetch `station-luc.json` once;
   `useStationAvailability(stationId)` looks up LUC and calls
   `/api/avail-v3?cells=<luc>` with the right `bin` + `from`/`to`.
   Delete the `/api/totals` call path.
6. `useAvailabilityOverview` (the percentile/aggregate per-station hook)
   → same swap.
7. `useStationTrips` → `/api/rides-v3?cells=<luc>` with `anchor` +
   `dims`. Delete the static `ymdgtb_cd_<station>.json` fetch.

### Phase 3: backend cleanup

8. Delete `executeAvailTotalsQuery` + the `availability` branch of
   `/api/totals` in `gbfs/api/src/index.ts`. If `/api/totals?kind=trips`
   has no consumers (probably true), delete the whole route.
9. Delete `ctbk/avail_agg.py`, `ctbk/avail_raw_day.py`.
10. Drop the legacy `Build /h1`/`Build /day`/`Build /d1`/`Build /mo1`
    steps from `.github/workflows/gbfs-compact.yml` — keep only
    `Compact WAL → parquet` (still needed; it feeds the 1m@1m source).
11. Delete R2 prefixes `s3://ctbk/avail/agg/`,
    `s3://ctbk/gbfs/avail/raw/day/`.
12. Delete `ctbk/stations/trips_jsons.py` + the `spj` / per-station JSON
    static build (if `useStationTrips` is the only consumer; verify).
13. Drop `ymdgtb_cd_*` parquet build from the aggregation pipeline
    (`ctbk/aggregated.py` and update.sh).

## Open questions

1. **Station churn during a shard**: per-minute WAL records the
   station_id; the LUC denorm is per-snapshot. If a station is added
   mid-shard, its rows would be missing from earlier minutes (no LUC
   entry). Mitigation: build the LUC denorm from the *union* of stations
   seen over the backfill window, not just today's snapshot. For going
   forward, the cron rebuilds the denorm regularly + the builder skips
   unknown station_ids with an `err()` warning.
2. **station_id changes** (renames, re-IDs across years): rides data
   spans 2013-present; station IDs have changed. Need to follow the
   canonicalization path already used by `station-harmonize`. The denorm
   should key on the *canonical* short_name, with the FE/worker mapping
   raw `gbfs_station_id` → canonical at query time.
3. **Coarser-than-L10 covers**: `coarsestLevel = 10` matches the
   builder's coarsest materialized level. If we ever need an
   all-NYC-and-Hoboken-and-JC megaquery, we'd hit ~12 L10 cells — fine.
   No need for L≤9.
4. **rides `start_s2_cell` vs `end_s2_cell`**: rides has two cell
   columns (one per anchor). LUC-anchored materialization applies
   independently to each. The `anchor=start|end` query param selects
   which the worker uses. No change needed to that machinery.

## Done criteria

- [ ] `ctbk station-luc-build` ships `station-luc.json` to R2 + repo
- [ ] avail-v3 + rides-v3 builders emit LUC + ancestors only
- [ ] Backfill complete on `e`; both pyramids regenerated
- [ ] FE: `useStationAvailability` / `useAvailabilityOverview` /
      `useStationTrips` use the v3 pyramids
- [ ] `/api/totals` removed from worker; legacy avail-build steps
      removed from `gbfs-compact.yml`
- [ ] R2 cleanup committed (`avail/agg/`, `gbfs/avail/raw/day/`,
      `ymdgtb_cd_*` if unused)
- [ ] Code cleanup committed (`avail_agg.py`, `avail_raw_day.py`,
      `trips_jsons.py` if unused, `executeAvailTotalsQuery`)
