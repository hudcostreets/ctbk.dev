# Spec: `rides-v2` — consolidated cascade + cell-sorted shards (perf A/B vs v1)

> Status: **draft** (2026-05-31). EC2 build task; ships alongside `v1`
> for A/B bakeoff (separate R2 prefix, separate `/api/rides-v2`
> endpoint). FE wiring + measurement are macbook follow-ups, out of
> scope here.

## Why

`/v2` homepage pays a lot per cold page load. Profiling
(`920d8207` + analysis):

- 3 parallel `/api/rides-v1?cells=…` calls (one per HOB/JC/NYC)
- Each fans out to **14 R2 GETs** (one per year-shard at `1mo` tier)
- pyrmts RG-prune is `dt`-only — shards sorted `(dt, cell)`, so every
  RG in every shard gets decoded
- **~5M rows decoded per region × 3 regions ≈ 15M rows decoded total**
  → filtered to ~150 output rows × 3
- Cold wall time: 5-9s; warm (edge cache HIT): <100ms (good)

The 14 shards × `(dt, cell)` sort is a build-time choice. Two cheap
changes flip both axes:

1. **Coarser sharding** (1 shard at `1mo` tier instead of 14): cuts
   42 R2 GETs → 3.
2. **`(cell, dt)` sort**: each RG now has a tight cell range. With
   small cell-filter (HOB=24, JC=69 of ~5000 system r9 cells),
   RG-prune drops ~99% of decodes. NYC (1534 cells) still skips ~70%.

Combined estimate (per `/v2` cold load):
- Current: 42 GETs / ~15M rows decoded / ~500 output rows
- v2: **3 GETs / ~50-500k rows decoded / ~500 output rows**
- Expected speedup: 5-20× cold.

Want to **bake off side-by-side** against `v1`: build under a separate
R2 prefix (`rides-v2/`) and serve under `/api/rides-v2[/cells]`. FE
adds a toggle (URL param), measures real-user latency for a stretch,
then `v1` retires.

## Storage layout (R2)

Two siblings, identical schema/columns/dims/metrics — only sort order
and shard sizing differ:

```
rides-v1/{start,end}/<tier>/<period>.parquet  # status quo
rides-v2/{start,end}/<tier>/<period>.parquet  # this spec
```

## Shard cascade (target: ~1000 bins per shard)

The "shard wide enough that ~1000 bins fit" rule means a viewport
typically reads one (or two) shards regardless of how zoomed-in or
zoomed-out the user is. Concrete v1 → v2:

| Tier | v1 shard | v1 bins/shard | v2 shard | v2 bins/shard | Notes |
|---|---|---|---|---|---|
| 1h  | 1mo | ~720  | 1mo  | ~720  | already close to 1000 |
| 3h  | 1mo | ~240  | 3mo  | ~720  | |
| 6h  | 1mo | ~120  | 6mo  | ~720  | new shard period |
| 12h | 1mo | ~60   | 1y   | ~720  | |
| 1d  | 1y  | ~365  | 3y   | ~1095 | new shard period |
| 3d  | 1y  | ~120  | all  | ~1580 (13y of data) | |
| 7d  | 1y  | ~52   | all  | ~678  | |
| 14d | 1y  | ~26   | all  | ~340  | |
| 1mo | 1y  | 12    | all  | ~156  | **the /v2 win** |
| 3mo | 1y  | 4     | all  | ~52   | |
| 1y  | all | 13    | all  | 13    | unchanged |

Two new shard periods to add (extend `shard_period` /
`shard_starts_in_range`): `'6mo'`, `'3y'`. Or punt and use `'all'` for
6mo+1y+12h and `'all'` for 1d too — simpler, slightly larger files.
Lean toward simpler: `'all'` for **everything from 1d up** (since 13y
of data is well under "1000 bins" at 1d granularity).

Simplified v2 cascade if `'all'`-everywhere above 12h:

| Tier | v2 shard | Notes |
|---|---|---|
| 1h  | 1mo | unchanged |
| 3h  | 3mo | new period |
| 6h  | 6mo | new period |
| 12h | 1y  | reuse existing period |
| 1d / 3d / 7d / 14d / 1mo / 3mo / 1y | all | one shard each |

That adds only `'3mo'` and `'6mo'` as new shard-period values.
Implementer's call which form to take — both are fine.

## Sort order

Switch `write_table_to_r2` / `write_table_to_local` from:

```python
write_tier_parquet(table, out=buf, sort=['dt', cell_col])
```

to:

```python
write_tier_parquet(table, out=buf, sort=[cell_col, 'dt'])
```

…for `rides-v2/` only. `v1` stays sorted `(dt, cell)`.

Tradeoff: time-window queries on `v2` (e.g. "last 7 days, all cells")
lose `dt`-based RG-prune. But:
- finer tiers (1h, 3h) already shard narrowly in time, so dt-skip
  within a shard is bounded
- the *use case* driving `/v2` is region-filter (h3-cell) queries over
  long time windows — opposite of what `(dt, cell)` optimizes for

Station-detail pages (single-station-id) would also benefit from
`(cell, dt)` since they're "one cell, time window."

## Build CLI

`ctbk rides-v1-build` already takes `--tier`, `--ym-from`, `--ym-to`,
`--anchor`, `--overwrite`, etc. To produce `v2`, add a `--variant`
flag (default `v1`) that controls:

- output prefix: `rides-v1/...` vs `rides-v2/...`
- TIER_SPECS dispatch: pick v1 or v2 shard map
- sort order passed to `write_tier_parquet`

Or, equivalently, just add a parallel command `ctbk rides-v2-build`
that hardcodes the v2 choices. **Implementer's call**; whatever is
simpler. The build is fully derived from the consolidated monthly
parquets (`s3/ctbk/normalized/YYYYMM.parquet`), so it doesn't reuse
v1's output — both pyramids build from the same source.

## Build commands (parallels v1's cascade order)

```bash
# 1h tier — produces monthly shards from consolidated/normalized.
# Same as v1; only the sort order differs.
ctbk rides-v2-build -t 1h -f 201306 -T 202604

# Cascade up. Each tier reads from a finer tier in the v2 pyramid
# (NOT from v1) — keeps the variants independent.
for t in 3h 6h 12h 1d 3d 7d 14d 1mo 3mo 1y; do
  ctbk rides-v2-build -t "$t" -f 201306 -T 202604 -O
done
```

## Acceptance

- `aws --profile cf s3 ls s3://ctbk/rides-v2/start/` + `…/end/` shows
  shards per the v2 cascade table above.
- **Per-tier byte-equivalent sums**: for a chosen month (e.g.
  2026-04), the total `count` summed across all cells/dim-tuples at
  each tier matches v1's total to the ride. Easy probe:
  ```bash
  for tier in 1h 3h 6h 12h 1d 3d 7d 14d 1mo 3mo 1y; do
    python -c "import pyarrow.parquet as pq
                v1 = pq.read_table(f's3/ctbk/rides-v1/start/$tier/...').to_pandas()
                v2 = pq.read_table(f's3/ctbk/rides-v2/start/$tier/...').to_pandas()
                # Same total count over the same window:
                assert v1[v1.dt.between(...)]['count_sum'].sum() == v2[same]['count_sum'].sum(), f'$tier mismatch'"
  done
  ```
- Each v2 shard is sorted by `(cell_col, dt)` (verify via parquet
  metadata or RG stats).

## Out of scope (macbook follow-ups)

- **CFW endpoint**: `gbfs/api/src/rides_v2.ts` (parameterize on the
  current `rides_v1.ts` — only `keyTemplate` prefix differs).
- **FE toggle**: `/v2?pyramid=v2` URL param flips
  `${API_BASE}/api/rides-v1` → `/api/rides-v2` in the `useRidesV1`
  hook. (Default `v1` so existing users don't see surprise behavior.)
- **Latency probe**: parity script that times cold + warm both
  endpoints for HOB/JC/NYC region queries.
- **Decision + cutover**: if v2 wins by ≥ a few-x on cold without
  regressing any other query pattern, swap defaults; eventually
  retire v1 shards.

## After done

`mv specs/rides-pyramid-v2.md specs/done/` and commit alongside the
build outputs / any spec edits made during implementation.
