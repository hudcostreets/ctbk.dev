# pyrmts re-pin: H3 removal (−195 KB per worker bundle), dead `pyrmts_geo` dep, two stale bits

Source: pyrmts session, 2026-08-16, from an audit of what's still blocking pyrmts specs on ctbk adoption. Five independent items, roughly in descending order of value. Nothing here is urgent; items 1 and 2 want doing on your next pin bump.

## 1. H3 is gone from `pyrmts-geo`'s shipped surface — ~195 KB off every worker bundle

You already retired the H3-keyed pyramids (`rides-v1`/`rides-v2`, code `48e3d22b` + data `71bf8126`). The library was still making you pay for H3 anyway.

`getSpatialIndex` lived in `h3-index.ts` and ended in `?? h3Index`. Since that's the resolver every consumer calls, `h3Index` stayed reachable from the package index — and `h3-js` declares no `sideEffects`, so no bundler could ever drop it. Measured with esbuild against the real package (minified):

```
before: 631 KB, h3-js present
after:  431 KB, h3-js absent
```

That's ~195 KB minified in `gbfs/api`, `gbfs/cascade`, and `www` that was never executing anything.

**Behavior changes to check on re-pin** (all three are BIC, all three you already satisfy — verified against your checkout today, so I expect a clean bump):

- **`getSpatialIndex` throws when `geo.index` is unset** instead of defaulting to H3. You pass `index: s2Index` explicitly at `avail_geo.ts:176`, `rides_v1.ts:142` and `rides_v1.ts:699`, so `rides_v1.ts:332`'s `getSpatialIndex(pyramid)` resolves fine.
- **`filterCellsAndRes`'s trailing `index` argument is now required** (it defaulted to `h3Index`). You pass it at `avail_geo.ts:689` and both `rides_v1.ts:430`/`431`.
- **The standalone `bboxToCells(bbox, level)` export is deleted** — it was an H3-only wrapper. No ctbk caller; backends expose `bboxToCells` on the `SpatialIndex` itself (`s2Index.bboxToCells(...)`), which is what you already use.

`h3Index` is no longer exported from the package index and `h3-js` is now a devDependency. The module survives inside pyrmts as a **test-only** second `SpatialIndex` implementation — the conformance suite runs one contract against both it and `s2Index`, which is the only thing keeping the interface from collapsing into "whatever S2 does" now that H13/T4 are deferred indefinitely. A new `index.test.ts` pins the exact public export list so a stray re-export can't silently re-add the 195 KB.

## 2. `pyrmts_geo` (Python) is a dead dependency — please drop it

`pyproject.toml:28` requires `pyrmts_geo`, and `:42` pins it. Nothing in ctbk imports it — no `from pyrmts_geo`, no `import pyrmts_geo`, no `materialize_resolutions`. You compute cells with `s2cell` directly.

That's correct on your side, because the package **cannot** serve an S2 pyramid: its entire content is `materialize_resolutions`, hardcoded to `h3.latlng_to_cell` with no S2 path at all. It's a 63-line H3-era artifact.

Ask: drop both lines on your next pin bump. Once ctbk stops declaring it, pyrmts deletes the package (it has no other consumer, and re-adding an S2 materializer later would be a rewrite, not a revival — nothing worth preserving).

## 3. `gbfs/cascade` has a split pyrmts pin

```
gbfs/cascade/package.json:35  pyrmts      #69de58b
gbfs/cascade/package.json:36  pyrmts-cfw  #69de58b
gbfs/cascade/package.json:37  pyrmts-geo  #c3caaf88   ← stale
```

`gbfs/api` and `www` have all three at `69de58b`. Probably just a missed line in a `pds gh` sweep — worth aligning, since `pyrmts-geo` and `pyrmts` share types across that boundary and a version skew there fails in confusing ways.

## 4. `minimalCover` handles mixed-level systems now — the CellsDebug blocker is gone

`www/src/pages/CellsDebug.tsx:55` still says:

> pyrmts-geo's `minimalCover` currently requires a uniform-[level system]

That's been false since 2026-08-14 (pyrmts `specs/minimal-cover-mixed-levels.md`), and `www` already pins a `dist` containing the fix — `buildTree` was rewritten as a level-stratified deepest-first walk, fixing both the count-propagation bug that returned empty covers for LUC-cell systems and the premature stall-exit.

You did adopt the other half of that follow-up — `CellsDebug.tsx:327`'s note that `maxLevel` is a dead `MinimalCoverOpts` field and `coarsestLevel` is the real cap (`db95f1e5`). The remaining piece is switching the cover *system* from `s2Index.latLngToCell(lat, lng, FINEST_LEVEL)` (line 321) to per-station LUC cells from `station-luc.json`, keeping `coarsestLevel: 10`, and deduping the `_`-alias stations (`5308.04_` etc.) whose fallback cells nest real LUC cells.

Until that lands, the uniform-L15 system stays lossy in the way that motivated the spec: ~1100 of 2340 stations have LUC level ≥16, so they share an L15 cell with a neighbor and a cover for station A silently also covers unselected neighbor B (the pinned example: JC081 "Brunswick & 6th" yields an L14 cell also containing JC075 "Monmouth & 6th"; both live in L15 `89c2574b4`).

That switch is also the acceptance evidence pyrmts is holding `specs/minimal-cover-mixed-levels.md` open for — no pyrmts-side fixture can demonstrate mixed-level covers on real station data.

## 5. `geo.resolutions` now accepts S2 levels 16-30 (was capped at H3's 15)

Both YAML parsers rejected any declared level above 15 — H3's maximum resolution, left in a validator that only ever sees S2 pyramids now. Raised to `MAX_GEO_LEVEL = 30` (S2's max) in `yaml.ts` and `yaml.py`.

Nothing of yours was broken by it — every live config declares `[15, 14, 13, 12, 11, 10]` — but it was a wall directly in front of the LUC work: per-station LUC cells reach **level 20**, and no pyramid config could have declared them. If the CellsDebug LUC switch (item 4) ever grows into a materialized LUC-level tier, that's the constraint that would have stopped it.

Included in the same `main`/`dist` as items 1-2.

## Re-pin refs

pyrmts `main` = **`cf10456`** (Python pins — uv source rev), `dist` = **`5f22b1d` (`5f22b1da73930adc23fd6f8fed2136261c0c4132`)** ("dist: pyrmts + pyrmts-cfw + pyrmts-geo + pyrmts-react @ cf10456"). Build-dist CI green (run 31979777825). JS 509 tests / Python 205+17+7 / `tsc -b --force` clean.

```json
"pyrmts":      "https://github.com/runsascoded/pyrmts#5f22b1da73930adc23fd6f8fed2136261c0c4132&path:/js/packages/pyrmts",
"pyrmts-cfw":  "https://github.com/runsascoded/pyrmts#5f22b1da73930adc23fd6f8fed2136261c0c4132&path:/js/packages/pyrmts-cfw",
"pyrmts-geo":  "https://github.com/runsascoded/pyrmts#5f22b1da73930adc23fd6f8fed2136261c0c4132&path:/js/packages/pyrmts-geo"
```

That `dist` also carries `pyrmts-react` (`specs/react-health-components.md` over there), which is unrelated to this spec and still unadopted by anyone — mentioned only so the extra package in the dist commit message is not a surprise.


## Status: adopted 2026-08-16

All five items landed.

| Item | Commit | Note |
|---|---|---|
| 2 — drop Python `pyrmts_geo` | `6fb6c8d4` | Confirmed zero importers. pyrmts is clear to delete the package. |
| 1, 3, 5 — JS re-pin to `5f22b1d` | `c3c6c361` | All three BIC changes verified against our call sites first; `gbfs/api` 207 tests, `gbfs/cascade` 113, `www` tc+build green. `wrangler deploy --dry-run` confirms **zero** `h3` references in the worker bundle. Fixed the split `gbfs/cascade` `pyrmts-geo` pin in the same sweep. |
| 4 — CellsDebug LUC switch | **not adopted** (`db8c86a3`, reverted) | See below. |

### Item 4: declined, and the spec's premise is stale

The spec says "The right system is LUC cells." It isn't, for ctbk — we moved off LUC deliberately, and the switch was reverted after a day.

**LUC is relational.** A station's LUC cell is defined against every *other* station, so adding one churns existing anchors — 166 moved in the 2026-07 re-key without physically moving, invalidating materialized history each time. That is the entire motivation for `specs/done/drop-luc-station-keys.md`, which replaced LUC anchoring with fixed coarse cells + `s:<short_name>` identity keys. That spec's own words: *"No `station-luc.json` denorm anywhere."*

**And an exact LUC cover is unservable.** LUC levels reach 20; the pyramids materialize `[15..10]`. `coarsestLevel` caps the rollup but nothing caps depth, so a LUC-based cover contains cells no tier can answer — strictly worse than a lossy one.

**The leak the spec cites doesn't exist in the served path.** JC081 is served as `s:JC081`, an identity key; nothing drags in JC075. The over-coverage lives only in the page's raw-S2 row.

**And that row isn't a hypothetical either**, which is what finally settled it. It runs the same uniform-L15 `minimalCover` that `useRegionCoversV3` (`www/src/query/ridesV1.ts`) runs to build the covers the Home chart sends as `cells=`. Its value is showing what the FE actually emits, so it should track that code, not improve on it.

The L15 lossiness is real but absorbed: `v5UserCover` (`rides_v1.ts:705`) uses the raw cover only as a point-in-set test over the station vocabulary, then re-derives the served terms via `vocabCover`. Extra stations picked up by a fat L15 cell are co-located neighbors — same region as the intended one. A region boundary splitting an L15 cell is the one latent edge case, and it's not one LUC would be the right fix for.

**For pyrmts**: `minimal-cover-mixed-levels` can't take ctbk's cover system as its acceptance evidence — no ctbk cover system is going to be mixed-level, because the two candidates for depth (LUC cells, per-station leaves) are both churny or unservable. The mixed-level `buildTree` fix is still used here, just via `vocabCover`: `station-vocab.json` spans levels 10-16, so the vocab graph is mixed-level and every served cover exercises it. That's better evidence than the raw-S2 row would have been.

## Not in scope

- Any change to how you compute or store S2 cells.
- `engine-min-cover-source` — separate, still open: your `ctbk gbfs engine build -s/--source` defaults to `1m@2d`, so the engine's min-cover source default is unexercised. Not asking you to change it here; noting why that pyrmts spec hasn't moved to `done/`.
