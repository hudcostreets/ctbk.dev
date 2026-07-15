# Rides-v3 LUC-anchored materialization

Status 2026-07-14: Phases A/B were completed earlier (denorm is
short_name-keyed; avail-v3 rebuilt against it). Phase C laptop work is
DONE — see "Resolved decisions" below for deltas vs the original
recommendations (canonical-position keying chosen over the
`luc_history` hybrid; same-dock L20 merge policy added). Phase C `e`
rebuild is DONE and acceptance-verified — see "Phase C acceptance
(2026-07-14)", which also surfaced two pre-existing prod bugs in
coarse-tier serving (stale D1 + a shard-naming mismatch; fixes in
flight). Next: finish D1 reload, then D/E + the denorm/www/worker
flip train.

## Resolved decisions (2026-07-14)

1. **Canonical-position keying, no `luc_history`** (option (b), the
   hybrid dropped). Measurement that settled it: JC115's
   2023-01..2024-07 months undercount -3%..-16% under coordinate
   keying (392,941 vs 396,760 all-time) — *small-jitter* boundary
   crossings, nothing near the 160 m "mover" threshold the hybrid
   gated on. Per-ride-coordinate keying can't be made exact without
   tracking every cell a station ever occupied; keying by station
   identity at the canonical position is exact by construction. Cost:
   pre-move rides of the ~90 >160 m movers materialize at the new
   location — a polygon-boundary rollup effect only, accepted.
2. **Historical union source**: `station-history.parquet` (id0-keyed
   eras; prefer the `id == id0` row, else latest `first`). Measured:
   2,420 active + 278 historical-only canonicals.
3. **Same-dock merge**: 9 clusters (18 stations) share an L20 cell
   (~10 m) — renamed/renumbered docks `station-id-map` never joined
   (`3660`→`4651.02`, `3477`→`3501.01`, `3197`→`JC104`, …). Each
   cluster collapses into its active member (else lexically-max);
   denorm gains a `merged: {loser: survivor}` map, applied after
   id-map during canonicalization. A surviving station's history
   includes its prior-id era (intentional; its counts exceed the
   legacy artifact's, which kept the ids separate).
4. **Unmapped-sid fallback**: coordinate chain L10..L15 minus the set
   of ALL LUC cells, so fallback rows can never leak into a
   per-station query; count + `err()` per month. Null-coord rides are
   now kept when their sid maps (identity keying needs no coords) —
   previously dropped.
5. **Active-LUC churn: 166 stations move** under joint uniqueness ⇒
   avail-v3 re-key rebuild on `e` is REQUIRED before the v2 denorm
   ships. Sequencing: build denorm v2 on `e` → rides-v3 full rebuild →
   avail-v3 rebuild → denorm + www + worker deploy together (the
   deployed FE keeps the old denorm until then).
6. **Acceptance**: JC115 monthly `rides-v3?cells=89c250b24` == legacy
   `ymdgtb` for every month incl. the drift window; one merged-dock
   station asserts legacy_A + legacy_H == v3; Home/region totals
   unchanged vs pre-rebuild.

## Phase C acceptance (2026-07-14)

`e` rebuilt the full pyramid (1h all months + every cascade tier,
`-O`); wrinkles: one OOM at `-c 16` on the 1h tier (redone `-c 8`),
and 202605/202606 normalized parquets initially not `dvc pull`ed
(empty shards; fixed + all-tier fixup). Denorm regen on `e`: 2,745
canonicals = 2,475 active + 270 historical, 6 same-dock merges, 166
active-LUC churn. Deltas vs the numbers above are snapshot drift
between the spec-time dev run and `e`'s regen (+55 active; 3 merges
evaporated — e.g. `3660`'s canonical position moved ~6 km off
`4651.02`'s dock in the newer window-union, so they no longer share an
L20 cell). The rebuilt pyramid + `e` denorm are self-consistent, which
is what matters; the committed Phase-A.1 denorm is a strict subset
(all 2,420 entries present, +325 new, 166 cell changes).

Acceptance ran via `scripts/rides-v3-acceptance.py` (new; legacy
`ymdgtb` JSON vs `/api/rides-v3?cells=<LUC>`, monthly bins, both
anchors, `SURVIVOR+LOSER` syntax for merged docks):

- **JC115**: drift-window undercount GONE. Totals 882,678 (v3) vs
  882,628 (legacy), +0.006%. Every residual spot-checked against the
  normalized parquet ground truth resolved in v3's favor: legacy
  mis-months a ride at some boundaries (adjacent-month ±1 cancel
  pairs), and misses sid-mapped rides 2016-09..2017-01 (2016-09 GT
  5,157 = v3; legacy 5,148). PASS.
- **Merged dock `3501.01+3477`**: Σ exactly equal (41,904); residuals
  are the same legacy cancel-pair class. PASS.
- **Region totals**: D1 (= pre-rebuild snapshot) vs parquet agree
  where both serve; see bugs below for the two backends' failure
  modes. Effective PASS via per-station + JC/HOB parity.

### Prod bugs surfaced (pre-existing, masked until now)

1. **Coarse-tier shard-name mismatch**: worker Tiers (since
   `fab241bb`) declare coarse shards as `120y` → pyrmts plans
   `{tier}/1920.parquet` (120y calendar floor of 2013 = 1920); the
   ctbk build has always written `all.parquet`. Pure-parquet coarse
   reads 500'd in prod for BOTH v2 and v3 — masked on v3 by the D1
   hybrid default, unnoticed on v2 (nothing queries v2 coarse).
   Fixed: `ctbk/rides_v1.py:shard_period` now emits `1920` for
   `'all'` shards; the 14 v3 coarse R2 objects were server-side
   copied to `1920.parquet` and the `all.parquet` originals deleted
   (new `ctbk gbfs r2 cp` / `rm` subcommands).
2. **Stale D1 `RIDES_V3_COARSE`**: the hybrid's D1 side was a
   one-time bakeoff load (2026-06-07) with no refresh pipeline —
   prod monthly views were serving pre-LUC (drift-era) data and ZERO
   for 2026-05/06. Decision (closes the #105 question): KEEP the
   hybrid — pure-parquet coarse 503s at NYC-region covers (237
   cells × 158 months; the CPU wall that motivated D1) — and reload
   D1 blue/green from the rebuilt shards (`ctbk rides-d1-build` →
   new DB `ctbk-rides-v3-coarse-luc` → binding flip). Follow-up:
   wire a monthly D1 refresh into the update flow.

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
