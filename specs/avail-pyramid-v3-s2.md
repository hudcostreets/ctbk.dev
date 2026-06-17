# `avail-v3`: S2-keyed avail pyramid (parallel to `rides-v3`)

## Goal

Rebuild the GBFS availability pyramid (`avail-v2` → `avail-v3`) keyed on
**S2** instead of **H3**, mirroring the `rides-v3` move done in
`specs/done/rides-pyramid-v3.md`. The S2 work for rides is live and fast
(50-100x speedup post-`outputCells` fix); this spec ports the same
treatment to the histogram-monoid avail pyramid.

## Motivation

1. **H3 multi-level coverings are broken**. `cellToParent` is non-exact
   for points in any of the 6 boundary-triangle (BT) slivers along each
   parent's edges (~5% of parent area, ~7-8% of stations land in a BT
   per level transition). For exact lineage-based queries (station-set
   covers, `minimalCover` against H3) this means we'd need BT-aware
   bookkeeping the H3 library doesn't provide. S2 has perfect 4-way
   tiling — no BT artifacts.

2. **Align with `rides-v3`**. Rides already uses S2 + `pyrmts-geo`'s
   `s2Index`. Once avail moves to S2 too:
   - FE uses **one** `SpatialIndex` (`s2Index`) for both pyramids.
   - Station-set → cover computation (`minimalCover`) runs once per
     selection, feeds both `/api/rides-v3` and `/api/avail-v3` via the
     `cells=` param the BE already accepts (commit `a1098c31`).
   - Region/bbox/station-cell plumbing is shared; no H3-vs-S2 branching
     in the FE.

3. **`pickResolution` works correctly** on S2 — uniform branching factor
   4, no BTs, `RegionCoverer` produces optimal covers. Already validated
   for rides.

4. **No users yet**. Avail-v2 has shipped via `/api/avail-v2[/cells]`
   but no FE consumer was switched on top of it (`useStationAvailV2`
   never wired up). Free to overwrite/delete without back-compat.

## Schema

Per-shard parquet layout (unchanged shape, cell column renamed/recoded):

```
s2_cell  : STRING        S2 cell token, e.g. '89c25b1' (was h3_cell)
dt       : INT64         bucket-start unix ms
bikes    : STRING        JSON {state_str: observations}
ebikes   : STRING        JSON
docks    : STRING        JSON
disabled : STRING        JSON
pending  : STRING        JSON
```

R2 layout:
```
avail-v3/<tier>/<period>.parquet
```

Tier ladder unchanged from v2 (`TIER_SPECS` in `ctbk/avail_v2.py`):
`1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d, 3d, 7d, 1mo,
3mo, 1y`. Cascade graph (`derive_from`) is spatial-index-agnostic, so
copies verbatim — `1m → 30m → 1h → 1d → 1mo → 1y` chain etc.

Row sort order unchanged from v2 §7: `(dt, s2_cell)` for read-time RG
pruning by `dt` predicate.

## S2 levels to materialize

H3 v2 materialized **[9, 7, 5]** (finest → coarsest). Equivalent areas:

| index   | level | avg area     | "feel"                              |
|---------|-------|--------------|-------------------------------------|
| H3 r9   |       | 0.105 km²    | ~1 station/cell                     |
| H3 r7   |       | 5.16 km²     | neighborhood                        |
| H3 r5   |       | 252 km²      | borough/region                      |
| S2 L15  | 15    | ~0.08 km²    | ~1 station/cell                     |
| S2 L14  | 14    | ~0.32 km²    | 1-2 stations/cell                   |
| S2 L13  | 13    | ~1.27 km²    | small cluster                       |
| S2 L12  | 12    | ~5.08 km²    | subway-line section                 |
| S2 L11  | 11    | ~20.3 km²    | neighborhood                        |
| S2 L10  | 10    | ~81.3 km²    | borough/region                      |
| S2 L8   | 8     | ~1300 km²    | metro                               |

For consistency with `rides-v3` (which materializes L10-15), this spec
proposes:

**Levels [10, 11, 12, 13, 14, 15] (5 levels, finest-first)**

Tradeoff vs v2's 3 levels:
- +pro: matches rides-v3 exactly → `pickResolution` picks the same level
  for the same bbox; FE covers are reusable byte-for-byte across both
  pyramids.
- +pro: finer granularity for `pickResolution` (no 4-level gaps).
- –con: ~5x rows per shard vs single-level → ~1.7x vs H3's 3 levels.
  Per-shard size goes from ~few-MB to maybe ~10-20MB at the 1m tier.
  Within CFW heap (~80MB conservative on 128MB).

Alternate: **[8, 11, 14]** (3 levels, matches H3 v2 area-wise; cheaper
storage). Loses rides-v3 cover sharing, but the FE can still convert by
walking the S2 lineage (cheap; S2's `cellToParent` is exact).

**Locked: [10, 11, 12, 13, 14, 15]** — storage cost is tiny in absolute
terms; cover-reuse with rides is a real ergonomic win.

## Build path

### File layout

Write `ctbk/avail_v3.py` from scratch (mostly a clone of `avail_v2.py`
with: S2 binding in place of `h3.latlng_to_cell`, level list bumped,
`DST_PREFIX = 'avail-v3'`, cell column renamed `s2_cell`). Do **not**
parameterize `avail_v2.py` — avail-v2 is being deleted (see Cleanup
below), no need to maintain two configurable paths transiently.

### S2 Python binding

`s2cell` (PyPI), already used by `ctbk/rides_v1.py` for the v3 rides
build (`s2cell.lat_lon_to_token(lat, lng, level)`). Token format is
the standard S2 hex token, verified compatible with `pyrmts-geo`'s
`s2js` (`cellid.toToken` / `fromToken`). No new dep.

### Backfill plan

Source data: `s3://ctbk/gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`
(per-station rows, no cell column) — these stay as-is; the H3 → S2
choice only happens at the 1m@1h shard build (`build_1m_hour_table`).

**Actual scale** (much smaller than initial estimate):

- WAL parquet coverage: **2026-04-07 → today (~72 days × 24 = ~1728
  hour-shards)**. Older raw WAL JSONs were never compacted to parquet.
- Source size: ~9.5 GB across 101k objects.
- Smoke shard size: ~5 MB/hour at L10-15 (6 levels). Full 1m backfill
  ≈ **~9 GB**. Cascade adds ~30%; total v3 storage ≈ **~12 GB**
  (vs current avail-v2 5 GB at 3 H3 levels; net +7 GB after v2
  deletion).
- Per-shard CPU: ~10-30s reading 60 minute-parquets + S2 cellization
  + histogram pivot + write.

**Run on EC2 (`e`)**:

- 16-core ARM64, 61 GB RAM (`hostname=ip-172-31-66-206`). 1m backfill
  ~5 min wall (16 workers); cascade <5 min.
- R2 egress to CF-adjacent compute is free; throughput is real.
- Laptop alternative is ~15-30 min wall on 12 cores but pins the
  machine; user prefers `e`.

### Build steps (run on `e` in tmux)

```bash
cd ~/ctbk
git fetch && grhh   # align WT to pushed HEAD

# Verify smoke shard from laptop is present (one hour written 2026-05-22T00)
aws s3 ls s3://ctbk/avail-v3/1m/2026-05-22/ \
  --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --profile cf

# Optional: re-run pytest as a smoke check that v3 is wired
pytest ctbk/tests/test_avail_v3_cascade.py -v

# 1. Backfill 1m tier (the long pole). Dry-run first.
ctbk avail-v3-build -t 1m -f 2026-04-07 -T 2026-06-18 -n | head
# Real run, 16 workers, ~5 min wall.
ctbk avail-v3-build -t 1m -f 2026-04-07 -T 2026-06-18 -c 16 \
  2>&1 | tee tmp/avail-v3-1m.log

# 2. Cascade up in dependency order. Each reads its predecessor.
#    Shorter tiers first since later ones depend on them transitively.
for tier in 2m 3m 5m 10m 15m 30m; do
  ctbk avail-v3-build -t $tier -f 2026-04-07 -T 2026-06-18 -c 16 \
    2>&1 | tee tmp/avail-v3-$tier.log
done
# 1h+ tiers derive from 30m. 1d+ tiers derive from 1h.
for tier in 1h 2h 3h 6h 12h; do
  ctbk avail-v3-build -t $tier -f 2026-04-07 -T 2026-06-18 -c 16 \
    2>&1 | tee tmp/avail-v3-$tier.log
done
for tier in 1d 3d 7d; do
  ctbk avail-v3-build -t $tier -f 2026-04-07 -T 2026-06-18 -c 16 \
    2>&1 | tee tmp/avail-v3-$tier.log
done
for tier in 1mo 3mo 1y; do
  ctbk avail-v3-build -t $tier -f 2026-04-07 -T 2026-06-18 -c 16 \
    2>&1 | tee tmp/avail-v3-$tier.log
done

# 3. Verify counts vs v2 (rollup over same bbox should agree
#    bit-for-bit since both pyramids see the same per-station data).
#    Spec follow-up: write `ctbk avail-v3-parity-check` CLI to automate
#    this; until then, spot-check via curl against dev worker.
```

Bake numbers expected on `e`: 1m wall ~5 min @ ~5MB/shard write; cascade
tiers each <2 min (input row count shrinks fast as bucket granularity
coarsens). Total ~15 min end-to-end.

## API

Add `/api/avail-v3[/cells]` mirroring `/api/avail-v2`:
- Same query params (`bbox`, `bin_budget`, `cell_budget`, `cells=`,
  `cells.exclude=`, `from`, `to`, `reducer`).
- Same response shape — just `s2_cell` in place of `h3_cell` in
  per-cell breakdowns.
- Implementation: parameterize `serveGeoReduced` / `serveGeoCells` in
  `gbfs/api/src/avail_geo.ts` with `pyramid` (already done; just add a
  new `availV3Pyramid` factory wiring `s2Index` + the v3 R2 prefix +
  the level list).

After parity check + FE cutover (see below), delete the v2 endpoints
(see Cleanup).

## FE migration

Three call sites today use avail:

1. `useStationAvailability` (`/api/avail-v2`) — read on station-detail
   page. Swap to `useStationAvailV3` → `/api/avail-v3`.
2. Anything calling `/api/avail-geo[/cells]` (PoC) — already
   double-implemented; should already point at v2 by now; if not,
   route to v3.
3. (Future) Home unification (#71): the Home rides plot will route via
   pyrmts-geo; if/when an avail panel lands on Home, it consumes v3.

FE flips are one-line: URL + cell-index ref. Once verified, delete the
v2 hooks/components.

## Cleanup (post-v3 cutover)

After `/api/avail-v3` is live + verified + FE swapped:

**Delete code**:
- `ctbk/avail_v2.py`, `ctbk/avail_v2_probe.py`, `ctbk/avail_v2_validate.py`
- `ctbk/avail_geo.py`, `ctbk/avail_geo_backfill.py`, `ctbk/avail_geo_probe.py` (PoC)
- `ctbk/avail_agg.py`, `ctbk/avail_raw_day.py` (legacy daily-build path)
- Drop the legacy `Build /h1`, `Build /day`, `Build /d1`, `Build /mo1`
  steps from `.github/workflows/gbfs-compact.yml`. Keep only:
  - `Compact WAL → parquet` (poll-snapshot → daily compacted parquet,
    feeds the 1m@1m source)
  - new step: `Build avail-v3/1m for the day` (one hour-shard sweep
    for `<date>` then cascade-on-close)
- TS: collapse `gbfs/api/src/avail_geo.ts` to a single `avail_v3.ts`
  (or rename in place). Delete v2 + PoC route handlers and exports in
  `gbfs/api/src/index.ts`.

**Delete R2 prefixes** (one-shot):
- `s3://ctbk/avail-v2/`
- `s3://ctbk/avail-geo/`
- `s3://ctbk/avail/agg/` (legacy)
- `s3://ctbk/gbfs/avail/raw/day/` (only consumed by deprecated paths)

**Keep**:
- `s3://ctbk/gbfs/avail/agg=1m/cons=1m/` (source 1m@1m shards, feeds
  every pyramid)
- `s3://ctbk/gbfs/info/` (daily station info, feeds station-geo lookup)

Track cleanup separately from the build to land them as distinct
commits.

## Optional: parallel `rides-v1`/`v2` cleanup

The `rides-v1.ts` `Variant` machinery still handles `v1` and `v2`
pyramids (H3-keyed). Since `v3` is the default and nothing routes to
`v1`/`v2` from the FE anymore, the same cleanup pattern applies:

- Delete the `v1` / `v2` branches in `cellCol`, `resolutions`,
  `TIERS_BY_VARIANT`, the `serveRidesV1*` / `serveRidesV2*` exports.
- Rename `rides_v1.ts` → `rides.ts` (no more variants) and `Variant`
  type → just `Anchor`.
- Drop `/api/rides-v1`, `/api/rides-v2` routes from `index.ts`.
- Delete R2 prefixes: `s3://ctbk/rides-v1/`, `s3://ctbk/rides-v2/`.

Done after avail-v3 lands so all the cleanup is one focused PR/commit
range.

## Locked decisions

1. **S2 levels**: [10, 11, 12, 13, 14, 15] — match `rides-v3` for FE
   cover-reuse. Storage tax (~5x rows/shard) is tiny in absolute terms.
2. **Parallel v3 + delete v2 after cutover** — no overwrite-in-place,
   keep v2 live until the FE flips and parity-check passes.
3. **S2 binding**: `s2cell` (PyPI), same one `ctbk/rides_v1.py` already
   uses for the v3 rides build.

## Integration test

`ctbk/tests/test_avail_v3_cascade.py` (5 tests, ~1.5s):

1. `test_build_1m_hour_table_schema_and_levels` — 1m build materializes
   every (station × level) row; schema is `[s2_cell, dt, *AVAIL_METRICS]`.
2. `test_build_1m_hour_table_histograms_byte_exact` — L15 (~1 station
   per cell) histograms are `{<value>: 1}`.
3. `test_build_1m_hour_table_coarsest_multi_station_histogram` — L10
   (3 stations share one cell) histogram is `{s1_value: 1, s2_value: 1,
   s3_value: 1}` — multi-station merge correct.
4. `test_cascade_30m_from_1m_matches_manual_sum` — at one (cell, dt_30m),
   the cascaded histogram == manual sum over the 30 underlying 1m
   histograms (catches `dt_floor_ms_fixed` bugs + histogram-merge bugs).
5. `test_cascade_1h_from_30m_matches_manual_sum` — chains through 30m
   → 1h.

Uses synthetic in-memory source data; no R2 credentials needed; CI-safe.

Follow-up: a real-R2 variant invoked via `ctbk avail-v3-parity-check
--date 2026-05-22` that compares v3 rollups vs v2 over the same bbox.
Both pyramids see identical per-station observations so the rollup
counts must agree bit-for-bit. Will land alongside the v3 endpoint.

## Done criteria

- [ ] `ctbk avail-v3-build` CLI implemented + tested on one day
- [ ] Backfill `2024-01-01 → today` on `e`, all 18 tiers populated
- [ ] `/api/avail-v3[/cells]` returns parity-checked data vs `/api/avail-v2`
- [ ] FE swapped (`useStationAvailV3`); v2 hook + endpoint deleted
- [ ] R2 cleanup committed (delete v1/v2/PoC prefixes)
- [ ] Code cleanup committed (delete v1/v2/PoC Python + TS code)
