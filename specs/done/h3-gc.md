# GC the h3-keyed rides pyramids (rides-v1, rides-v2)

**Verdict (2026-08-14):** h3 is unredeemable for exact multi-resolution aggregation — child hexes are neither necessary nor sufficient to cover their parent (every parent/child transition has ~5% boundary-triangle mismatch; see the BT/H13 notes in `~/.claude/CLAUDE.md` abbrevs). rides-v3 (S2, exact lineage) superseded v1/v2 in 2026-06; rides-v5 (station-identity keys) is prod since 2026-08-14, with v3 kept as the rollback path.

## Code GC (this commit)

- `ctbk/rides_v1.py`: v1/v2 variants removed — `VARIANTS=('v3',)`, h3 cellization branch, `(dt, cell)` sort, per-variant tier maps, `-r/--resolution` opt, and the legacy `rides-v1-validate` cmd (h3-res-filtered cross-check vs retired `trips/agg/h1`) all deleted. `import h3` gone; `h3` dropped from `pyproject.toml`. Module/CLI names (`rides_v1.py`, `rides-v1-build`) kept — renaming is churn; docstrings note the history.
- Deleted modules: `ctbk/region_cells.py` (static h3/S2 region-cells assets — FE computes live `minimalCover` since v3), `ctbk/d1_sizing.py` + `ctbk/rides_d1.py` (D1-backend sizing experiments; decision long since made for R2).
- Worker (`gbfs/api/src/rides_v1.ts`, `index.ts`): `VARIANTS=['v3']`, h3 spatial-index fallback and v1 tier ladder removed, `/api/rides-v{1,2}[/cells]` routes retired (regex now `v[35]`), `serveRidesV{1,2}*` exports deleted. Tests re-fixtured to `start_s2_cell`.
- FE (`www/`): `Pyramid = 'v3' | 'v5'`; static region-cells fetch path (`useRegionCellsH3`) deleted; `public/assets/region-cells{,-s2}.json` deleted; Home's pyramid toggle now `[v3, v5]`.

## Data GC (done 2026-08-15, user-confirmed)

R2 `ctbk` bucket — no D1 registry rows exist for either (they predate `pyramid_shards`):

| prefix | objects | size |
|---|---|---|
| `rides-v1/` | 1,436 | 9.79 GB |
| `rides-v2/` | 536 | 7.73 GB |

Deleted via `ctbk gbfs r2 rm -p rides-v1/ rides-v2/` (prefix mode added to the CLI for this; will recur for the rides-v3 GC). Both prefixes verified empty after.

## Follow-up

- rides-v3 GC after v5 burn-in (repeat of this shape: `VARIANTS`, `/api/rides-v3`, FE toggle, `rides-v3/` prefix, plus `rides_v1.py` wholesale).
