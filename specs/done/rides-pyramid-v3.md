# Spec: `rides-v3` — S2-keyed pyramid + minimal-cover region cells

> Status: **draft** (2026-05-31, S2 pivot). EC2 build task. Ships alongside
> v1+v2 as a third bakeoff variant (`rides-v3/` R2 prefix,
> `/api/rides-v3` endpoint, FE toggle adds `pyramid=v3`). The macbook
> side handles spec → CFW endpoint wiring + FE toggle + region-cells
> regeneration once v3 shards exist on R2.

## TL;DR

Same cascade + schema as v2, but:

- **Cell column is S2 token, not H3 cell.** `<anchor>_s2_cell : STRING`
  (e.g. `'89c25c'`) — variable-length hex tokens (`s2cell.cell_id_to_token`).
- **Materialize multiple S2 levels per row.** Levels `(10, 11, 12, 13, 14, 15)`
  (6 levels, NYC-scale: r5↔r9-ish coverage).
- **Lex sort by `(s2_cell, dt)`** (same as v2; preserves sibling
  contiguity per-level for RG-prune push-down).
- **R2 prefix**: `rides-v3/{start,end}/<tier>/<period>.parquet`.

That's it for the build. The reason for the S2 swap (vs H3 mixed-
resolutions + `compactCells`) is below.

## Why S2 (not H3 mixed-resolution)

Earlier v3 drafts proposed H3 with all-resolutions-materialized, so
`compactCells` could fold groups of 7 children into parents. That ran
into H3's well-known **resolution-rotation property**: the 7 children
of a hex parent do *not* exactly tile the parent (~1/14 of parent area
falls into 6 "boundary triangle" slivers shared with sibling parents).
For point-membership queries on a single resolution this is fine
(`latLngToCell` then `cellToParent` is bit-shift exact), but for
arbitrary mixed-resolution `cellInSet` checks across the hierarchy it
isn't: `cellToParent(latLngToCell(p, finer), coarser)` is *not* always
the same cell as `latLngToCell(p, coarser)`. Boundary points walk to
the wrong parent.

For aggregation correctness we need a system where:
1. Every parent is *exactly* tiled by its children, at every level.
2. `cellToParent` walks are bit-shifts on the cell ID (no geometry).

S2 satisfies both: the unit sphere is projected onto a cube; each cube
face is a quadtree (branching factor 4); each level is a perfect bisection
along both axes. There's no "rotation" between levels, so:

- `cellToParent(latLngToCell(p, finer), coarser) === latLngToCell(p, coarser)`
  for every `p`, every level pair — verified by the pyrmts conformance
  suite (`spatial-backend`, 4000-pt property test).
- `compactCells` over any set folds cleanly: 4 siblings → parent;
  recursively.
- Mixed-resolution `minimalCover` is exact + lineage-disjoint by
  construction.

The JS side of all this (pluggable `SpatialIndex`, `h3Index`/`s2Index`,
`minimalCover` DP, `filterCellsByCover` reader) shipped in
[`pyrmts@spatial-backend`][pyrmts-spatial-backend] (phases 1-4, 7e78c2f).
The Python side just emits S2-keyed rows; pyrmts-geo *Python*
doesn't yet have an `s2Index` (Phase 5 follow-up), so the build calls
`s2cell` directly.

[pyrmts-spatial-backend]: https://github.com/runsascoded/pyrmts/tree/spatial-backend

## Level pick: S2 (10..15)

Match H3 r5-r9 (NYC-useful range) by area at lat ≈ 40°:

| Index level | Area (km²) | H3 analogue |
|---|---|---|
| S2 9  | ~320  | H3 r5 (~250) |
| S2 10 | ~80   | H3 r6 (~36) |
| S2 11 | ~20   | H3 r7 (~5) |
| S2 12 | ~5    | H3 r7-r8 |
| S2 13 | ~1.3  | H3 r8 (~0.7) |
| S2 14 | ~0.32 | H3 r9 (~0.1) |
| S2 15 | ~0.08 | H3 r9-r10 |

**Pick `(10, 11, 12, 13, 14, 15)` — 6 levels.** Lower bound L10 (~80 km²)
covers full NYC region in handful of cells; upper L15 (~0.08 km²) =
station-scale. Skips the coarsest end (L4-L9) since NYC at L9 ≈ 320 km²
is already region-scale, and we have only 3 named regions.

Row inflation: 6× (same as `len(resolutions)` for v2's H3 levels,
modulo +3 levels). Storage estimate (mirroring spec § Storage / build
cost): ~16 GB total (vs v2's 8 GB at 3 H3 levels).

## Layout (R2)

```
rides-v3/{start,end}/<tier>/<period>.parquet
```

Same schema as v2/v1 except cell column:

```
<anchor>_s2_cell : STRING       e.g. '89c25c' (S2 hex token, variable-length)
dt               : INT64        bucket-start unix ms
gender           : STRING       'unknown' | 'male' | 'female'
user_type        : STRING       'Subscriber' | 'Customer' | ...
bike_type        : STRING       'classic_bike' | 'electric_bike' | ...
count_n          : INT64
count_sum        : INT64
count_sumsq      : INT64
duration_n       : INT64
duration_sum     : INT64
duration_sumsq   : INT64
```

Sort: `(s2_cell, dt)` — same as v2. S2 token lex sort over a *single*
level is sibling-contiguous (tokens are derived from `S2CellID` by
stripping trailing zero hex digits — within one level, all tokens are
the same length and sort numerically); across mixed levels, parent
tokens are *prefixes* of one of their descendants' tokens, so they
cluster near their lineage in lex order. Good enough for RG-prune
push-down by token range.

## Cascade

Same as v2 (consolidated cascade — `~1000 bins per shard`):

| Tier | shard | derive from |
|---|---|---|
| 1h | 1mo | source |
| 3h | 3mo | 1h |
| 6h | 6mo | 1h |
| 12h | 1y | 6h |
| 1d | all | 1h |
| 3d | all | 1d |
| 7d | all | 1d |
| 14d | all | 7d |
| 1mo | all | 1d |
| 3mo | all | 1mo |
| 1y | all | 1mo |

Reuse `V2_TIER_SPECS` verbatim for `V3_TIER_SPECS`.

## Code changes (`ctbk/rides_v1.py`)

1. **Extend `Variant`**:

   ```python
   Variant = Literal['v1', 'v2', 'v3']
   VARIANTS: tuple[Variant, ...] = ('v1', 'v2', 'v3')
   ```

2. **`V3_TIER_SPECS = V2_TIER_SPECS`** (alias — same cascade) and add to
   `TIER_SPECS_BY_VARIANT`.

3. **Cell column per anchor**: for v3, anchor config uses
   `start_s2_cell` / `end_s2_cell` (vs v1/v2's `*_h3_cell`).

   Simplest: lift `cell_col` selection out of `ANCHOR_CONFIG` into a
   function that takes `(anchor, variant)`:

   ```python
   def cell_col(anchor: Anchor, variant: Variant) -> str:
       idx = 's2' if variant == 'v3' else 'h3'
       return f'{anchor}_{idx}_cell'
   ```

   Then replace every `cfg['cell_col']` / `ANCHOR_CONFIG[a]['cell_col']`
   with `cell_col(a, variant)`. Same for the schema `pa.field` names.

4. **Resolutions per variant**:

   ```python
   DEFAULT_RESOLUTIONS_BY_VARIANT: dict[Variant, tuple[int, ...]] = {
       'v1': (9, 7, 5),
       'v2': (9, 7, 5),
       'v3': (10, 11, 12, 13, 14, 15),  # S2 levels
   }
   ```

   And resolve at build time: `resolutions =
   DEFAULT_RESOLUTIONS_BY_VARIANT[variant]`.

5. **Cell-ization**: in `build_1h_month_table`, branch on `variant`:

   ```python
   if variant == 'v3':
       import s2cell
       for lvl in resolutions:
           cells = [s2cell.lat_lon_to_token(la, ln, lvl)
                    for la, ln in zip(lat, lng)]
           # ... rest of inflation
   else:
       for res in resolutions:
           cells = [h3.latlng_to_cell(la, ln, res) for la, ln in zip(lat, lng)]
           # ...
   ```

   `s2cell` is a pure-Python, single-file optimized port of just the
   cell/token/latlng path. Add to `pyproject.toml`/`requirements.txt`:
   `s2cell>=1.8.0`. Verified API: `lat_lon_to_token(lat, lon, level) → str`,
   `token_to_level(token) → int`, `token_to_parent_token(token, level)`.

6. **Sort cols**: `sort_cols('v3', cell_col)` returns the v2 form
   `[cell_col, 'dt']` — extend the function:

   ```python
   if variant in ('v2', 'v3'):
       return [cell_col, 'dt']
   ```

7. **`materialize_resolutions` helper assertion**: the v1 build's
   `_materialize_resolutions` (around line 778) asserts cell-resolution
   via `h3.get_resolution(cell)` — skip it (or extend) for v3, since
   `s2cell.token_to_level(token)` is the equivalent. Lightweight check;
   doesn't gate correctness.

Estimated: ~80 LOC of touch across `rides_v1.py`, mostly mechanical
`cell_col` plumbing.

## Build CLI

Same shape as v1/v2:

```bash
ctbk rides-v1-build --variant v3 -a both -t 1h -f 201306 -T 202604
# ...cascade through tiers...
ctbk rides-v1-build --variant v3 -a both -t 1y -f 201306 -T 202604 -O
```

(The CLI command name is `rides-v1-build` for legacy reasons; it dispatches
on `--variant`.)

## Verification

Same as v2: per-tier byte-equivalent sums of `count_n` / `duration_sum` /
`duration_sumsq` over any (window, dim filter, anchor) must match v2's
totals exactly. Only the cell-key column differs.

`ctbk rides-v1-validate --variant v3 …` for the validator (extend
existing `rides-v1-validate` if it's pinned to h3).

## Out of scope (macbook side; logged here for plan continuity)

After v3 builds land on R2:

1. **`gbfs/api/package.json`**: bump `pyrmts` / `pyrmts-geo` to
   `spatial-backend` head (currently `7e78c2f`).
2. **CFW endpoint** (`gbfs/api/src/rides_v1.ts`): extend
   `TIERS_BY_VARIANT` with `'v3'`, add `serveRidesV3{,Cells}` aliases
   pointing at the v3 R2 prefix. The v3 path imports `s2Index` from
   `pyrmts-geo` and sets `pyramid.geo.index = s2Index` — uses
   lineage-aware `filterCellsByCover` for the row-filter step.
3. **Region cells**: `ctbk region-cells` (Python) currently hardcodes
   "the H3 r9 cell containing each station." For v3, compute
   `s2_minimalCover(station_cells, system_cells, levels=(10..15))` per
   region (NYC/JC/HOB) and write include+exclude to
   `www/public/assets/region-cells.json`.

   Open question: do this on the Python side (port `minimalCover` DP),
   or compute once on the FE in TS using `s2Index.minimalCover()` and
   cache it? FE has the advantage of using the same lib that's already
   tested. The whole region-cells.json is `O(few hundred bytes)` once
   computed.
4. **FE toggle**: extend `pyramid=v1|v2` to `pyramid=v1|v2|v3` in the
   `/v2` controls (`www/src/pages/HomeV2.tsx`).

## Acceptance

1. `aws --profile cf s3 ls s3://ctbk/rides-v3/start/` shows the v3
   cascade.
2. **Per-tier byte-equivalent count totals** match v2 for any (window,
   dim filter, anchor) — verified via `ctbk rides-v1-validate
   --variant v3`.
3. **Region parity** at 2024-06: NYC + JC + HOB counts (computed via
   `s2Index.minimalCover()` covers) match `ymrgtb_cd.json` to the
   ride. Mixed-res + lineage-aware filtering must reproduce ground
   truth exactly — partial-cover bleed (HOB 35% off at r7-from-stations
   in v2) is gone.
4. **Perf**: `/v2?api=dev&pyramid=v3` cold (all 3 regions) wall < 500ms.
   Worker reads < 5 MB total. Reqs < 50.

## References

- `specs/done/rides-pyramid-v2.md` — v2 cascade + sort baseline.
- pyrmts `spatial-backend` branch — `s2Index`, `minimalCover`,
  `filterCellsByCover`, `SpatialIndex` interface.
- `specs/done/pluggable-spatial-backend.md` (in pyrmts repo) — design
  doc for the S2 pivot.

## After done

`mv specs/rides-pyramid-v3.md specs/done/` and commit alongside the
build outputs / any spec edits made during implementation.
