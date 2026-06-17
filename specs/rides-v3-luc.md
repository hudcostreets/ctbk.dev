# Rides-v3 LUC-anchored materialization

## Goal

Bring the same LUC + ancestors materialization that avail-v3 just got
(`specs/per-station-luc-v3.md`) to rides-v3, so per-station rides
queries can route through the v3 pyramid instead of the static
`ymdgtb_cd_<short_name>.json` artifacts.

Once done, the migration train started in #108 can finish:
- `useStationTrips` → `/api/rides-v3?cells=<luc>`
- Delete `ctbk/stations/trips_jsons.py` + the `ymdgtb_cd_*` parquet
  build step

## The complication: 13 years of station-ID churn

Avail's LUC change was clean because GBFS WAL writes use today's
station IDs and we have today's snapshot. Rides span 2013-06 to
present and route through **three** distinct ID systems:

1. **GBFS UUID** — opaque, e.g. `7dda8844-60ba-4449-b05c-54c1d14ab5fb`.
   Used by the WAL loader → all `avail-v3` rows. The current
   `station-luc.json` is keyed on UUID.
2. **Historical short_name** — e.g. `116`, `1234.56`. Source of truth
   in rides parquets (`Start Station ID` / `End Station ID`). 3756
   distinct values across history.
3. **Canonical short_name (id0)** — the latest active short_name for
   each station "lineage" per `station-harmonize`. 2609 distinct values.
   `station-id-map.json` maps historical → canonical.

Cross-references:
- `gbfs/info/<date>.json` carries `{station_id (UUID), short_name, lat,
  lng}` for every active station today. Joins UUID ↔ canonical
  short_name (the current short_name *is* the canonical for active
  stations).
- `station-id-map.json` joins historical short_name → canonical
  short_name.

So historical_short_name → canonical → UUID → LUC works via a
two-hop join.

## Architecture choice: canonical short_name as the LUC denorm key

Three options:

| key system | how avail uses it | how rides uses it |
|---|---|---|
| **UUID** (current) | direct (WAL has UUID) | rides → id-map → canonical → GBFS info reverse-lookup → UUID → LUC |
| **canonical short_name** | resolve UUID → short_name at build time (already loaded from `gbfs/info`) | rides → id-map → canonical → LUC |
| dual-keyed JSON | both code paths | both code paths |

The current UUID-keyed denorm needs a backwards UUID lookup for rides,
which is awkward (GBFS info changes shape over time; we don't have a
single source of truth for historical UUIDs).

**Recommend: re-key the LUC denorm on canonical short_name.** Bonus:
short_names are human-readable (URL slugs, debug logs, dashboards) so
this is a usability win independent of LUC. Avail's builder change is
trivial — it already loads `gbfs/info` for `(lat, lng)`; just also
read `short_name` and pass that through. Rides builder uses
station-id-map directly.

## Output schema

```json
{
  "<canonical_short_name>": {
    "lat":   40.7505,
    "lng":  -73.9505,
    "cell":  "89c25901",   // LUC cell token
    "level": 15,           // LUC S2 level
    "uuid":  "00284700-9d22-42ce-8485-113fed9879c1"  // for avail FE convenience
  },
  ...
}
```

`uuid` is included so the worker can join avail rows (UUID-keyed) back
to LUC without a separate lookup. ~200 KB for 2411 active stations.

## Per-month LUC stability

Question: does a station's LUC change across months as other stations
are added or removed?

YES, in principle. If a new station opens near station X in 2018, X's
LUC could go from L14 (alone in a 1.3km² hex) to L16 (only alone in a
~0.02km² hex). For rides queries to find all of X's 2013-present
history at a single cell, we need either:

- (a) **Build with per-month historical LUCs**, write rows at each
  month's LUC + ancestors. Per-station queries fan out across multiple
  LUC cells over time.
- (b) **Build with the CURRENT LUC for every historical month**,
  using `station-harmonize`'s canonical lat/lng (which is a
  weighted-average across history) as the "true" position. All months'
  rows materialize at the same cell, so per-station queries hit one
  cell.

(b) is simpler but only works if station movement stays within an L15
cell (~80m). Empirical check against `station-history.parquet`:

| corner-to-corner drift | # canonicals | % of 2609 |
|---|---|---|
| > 25 m | 170 | 6.5 % |
| > 50 m | 130 | 5.0 % |
| > 100 m | 96 | 3.7 % |
| > 160 m (2 × L15 side) | 90 | **3.5 %** |
| > 320 m (4 × L15 side) | 83 | 3.2 % |

(82 of the >1000m results are sentinel-(0,0) outliers in the data; drop
those before the count. The numbers above filter sentinels out.)

So **~3.5% of stations** have meaningful movement that crosses ≥1 L15
cell boundary. Option (b) would under-report old rides for those —
acceptable as a starting point but visibly wrong on StationDetail for
those 90 stations.

(a) needs per-month LUC tables (~150 months × ~24 KB ≈ 3.6 MB
historical, manageable) and a query-time fan-out for old stations
(`cells=<luc_2018>,<luc_2024>`). (b) is 1 file, 1-cell query but lossy.

**Recommend a hybrid:**

1. Default to (b) — single LUC per canonical, using
   `station-harmonize`'s weighted-avg lat/lng.
2. For the ~90 stations with >160m drift, emit *all* historical L15
   cells they occupied as an additional `luc_history` field per
   denorm entry: `{cell, level, lat, lng, uuid, luc_history?: [
   {cell, level, ym_from, ym_to}, ... ]}`. Builder still writes
   each ride at *its own* lat/lng's L10..LUC, but for these moved
   stations the worker query expands to OR over their historical LUC
   cells. Adds ~90 entries × ~3 cells × ~50B = ~14 KB to the denorm.
3. FE per-station query for a moved station sends
   `?cells=<current_luc>,<old_luc_1>,<old_luc_2>` — multi-cell IN
   query, identical worker code path.

For the 96.5% of stations with no meaningful drift, the per-station
query is exactly one cell as in option (b).

## Build path

### Step 1: Re-key the LUC denorm

`ctbk station-luc-build` (current) → key on canonical short_name + add
`uuid`. The data is the same; just remap.

For decommissioned stations (in rides but not in `gbfs/info` today):
read their canonical lat/lng from `station-history.parquet` (the
weighted-average column), compute LUC against the union of
{current GBFS active stations} ∪ {historical canonical stations}.
Output entries for them too.

`station-luc.json` grows from ~2.4k entries → ~2.6k entries (includes
decommissioned canonicals). Still <300 KB.

### Step 2: Rides v3 builder

`ctbk/rides_v1.py:build_1h_month_table` (v3 variant) currently iterates
`for res in (10..15)` and emits at every level. Replace with:

```python
luc_by_canonical = load_station_luc()       # {short_name: {cell, level, ...}}
id_map = load_id_map()                       # {historical_short_name: canonical_short_name}
# Map each ride's station_id to canonical, then to LUC.
canonical = df['Start Station ID'].astype(str).map(id_map).fillna(df['Start Station ID'].astype(str))
luc_level = canonical.map(lambda c: luc_by_canonical.get(c, {}).get('level'))
luc_cell  = canonical.map(lambda c: luc_by_canonical.get(c, {}).get('cell'))
# Drop rides whose station has no LUC entry (orphaned historical short_name
# with no canonical match — should be rare; warn count).
mask = luc_level.notna()
...
# Emit each ride at L10..L<LUC>: ancestors via s2cell.lat_lon_to_token,
# LUC cell from the denorm directly.
```

Same pattern as the avail builder change in `ctbk/avail_v3.py`. End
result: each ride materializes at L10..L<its station's LUC>, sparser
than the prior universal L10-L15 (saves rows for sub-L15-LUC stations)
and richer past L15 (~32% of stations get exact precision past L15).

### Step 3: Worker reads short_name-keyed denorm

`gbfs/api/src/rides_v1.ts` already accepts `cells=` straight through.
No worker code change required — the FE encodes per-station queries as
`?cells=<luc>` after looking up the canonical short_name's LUC.

The FE just needs to fetch `station-luc.json` once (already a TSQ
infinite-stale fetch for the avail migration) and look up by short_name
when displaying station data.

## Migration steps

Labels match `specs/per-station-luc-v3.md` convention.

### Phase A: re-key avail's LUC denorm [laptop]

1. **[laptop]** Bump `ctbk/station_luc.py:compute_luc` to read
   `short_name` from `gbfs/info` and key the output dict on canonical
   short_name (with `uuid` as a value).
2. **[laptop]** Bump `ctbk/avail_v3.py:build_1m_hour_table` to resolve
   `station_id` (UUID, from WAL rows) → short_name (via `gbfs/info` or
   the denorm's reverse map) before LUC lookup.
3. **[laptop]** Update tests. Run. Commit.

### Phase B: avail rebuild [`e`]

4. **[`e`]** Re-run `ctbk station-luc-build` → new short_name-keyed
   `station-luc.json`.
5. **[`e`]** Re-run avail-v3 backfill (`-O`). ~10 min total.

### Phase C: rides LUC build [laptop + `e`]

6. **[laptop]** Add decommissioned-station handling to
   `ctbk station-luc-build`: pull `station-history.parquet`, include
   canonicals with no current GBFS entry, compute LUC against the
   merged set. Re-run.
7. **[laptop]** Bump `ctbk/rides_v1.py:build_1h_month_table` (v3 path)
   per the sketch above.
8. **[laptop]** Add unit tests mirroring `test_avail_v3_cascade.py`.
9. **[laptop]** Commit + push.
10. **[`e`]** Rebuild rides-v3 — per-month, all months (2013-06 →
    today), `-O` overwrite. ~30 min on 16 cores.

### Phase D: FE migration [laptop]

11. **[laptop]** `useStationTrips` → `/api/rides-v3?cells=<luc>`.
    Delete the static `ymdgtb_cd_<short_name>.json` fetch.
12. **[laptop]** CIC StationDetail trip-history chart against the dev
    worker; verify a few sample stations match the legacy data.

### Phase E: cleanup [laptop]

13. **[laptop]** Delete `ctbk/stations/trips_jsons.py` (the static
    per-station JSON builder).
14. **[laptop]** Drop the `ymdgtb_cd_*` parquet build from
    `ctbk/aggregated.py` and `update.sh`.
15. **[laptop]** Drop the `ymdgtb-cd` step from `update.py` if any.
16. **[laptop or `e`]** Delete R2 prefix
    `s3://ctbk/aggregated/ymdgtb_cd_*.parquet` if those are public
    artifacts. Verify nothing still consumes them.

## Open questions

1. **Lat/lng drift sanity check**: ✅ done — see the table above.
   ~90 stations drift >160m; spec recommends the hybrid (single LUC by
   default, `luc_history` array for the 90 movers).
2. **Orphan historical short_names**: any rides whose
   `Start Station ID` isn't in `station-id-map.json` after the
   harmonize-create run? Expected to be 0 by construction (harmonize
   maps every ride's station_id), but worth confirming with a quick
   count during the build.
3. **`ymdgtb-cd` consumers outside ctbk**: any external consumers of
   the static per-station JSONs? Quick grep.

## Done criteria

- [ ] `station-luc.json` re-keyed on canonical short_name + includes
      decommissioned canonicals
- [ ] avail-v3 rebuild on `e` reading the new denorm
- [ ] rides-v3 builder LUC-anchored
- [ ] rides-v3 rebuild on `e`
- [ ] FE `useStationTrips` migrated
- [ ] `trips_jsons.py` + `ymdgtb_cd_*` build deleted
- [ ] R2 cleanup (legacy static JSONs)
