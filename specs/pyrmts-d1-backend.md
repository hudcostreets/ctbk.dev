# Spec: pyrmts D1 (SQLite) storage backend + ctbk hybrid serving

> **Status**: draft (2026-06-06). Supersedes the latency-driven goals in
> `multiscale-timeseries-v2.md` and motivates the unification of Home + StationDetail
> monthly-trips charts (currently both served via static `ymrgtb_cd.json` and
> per-station JSON respectively). Does NOT supersede `rides-pyramid-v{1,2,3}.md`
> — the S2 pivot work (mixed-level minimalCover) remains load-bearing; this spec
> proposes an additional storage backend, not a replacement for the pyramid model.
>
> **Phase 0** (empirical sizing) is for an `e` session to execute and report back
> on; remaining phases are for laptop sessions once Phase 0's numbers tell us
> which tiers actually fit D1.

## Motivation

### Latency target

The `/v2` parity homepage (powered by `/api/rides-v3`) is ~5-9 s cold for the
load-bearing case (13y monthly chart, 3 regions stacked). That's 42 R2 GETs
(3 regions × 14 monthly shards) hitting the worker, each with cold parse +
RG-prune + row-level cover filter. Closed-window edge cache helps warm
latency (~100 ms) but the cold path is the user-visible UX cost on every
fresh viewport.

Targets:
- **Home / StationDetail monthly chart**: <300 ms cold, <50 ms warm.
- **Time-of-day fold** (planned, e.g. avail 00:00–24:00 averaged over 7d/1mo/1y):
  <300 ms cold.
- **Arbitrary station-set ("neighborhood") queries**: <500 ms cold for sets
  up to ~200 stations.

### Why SQL is the natural fit at this scale

This data is "tiny potatoes" by DB standards. The load-bearing queries are
`WHERE cell IN (...) AND dt BETWEEN ? AND ? GROUP BY <bin>, <dims>` returning
~1-10K rows. That's exactly what indexed SQL is optimized for. The current
parquet+hyparquet stack does:

1. ~14 R2 GETs (per region per tier) at 30-100 ms each cold.
2. Row-group lex-prune on `cellCol IN ...` — RANGE-OVERLAP, not row-level
   equality (we hit this bug recently with mixed S2 covers).
3. Row-level filter in the worker for exact membership.
4. Stitch + sum across shards.

The first step alone dominates everything else. D1 (Cloudflare's SQLite),
colocated with the worker, gives single-digit-ms warm and ~100 ms cold for
the equivalent query. **Estimated 1-2 orders of magnitude faster** for the
common case.

### Why not just D1 — why hybrid

Parquet stays the right tool for:
- **Fine-bin tiers** (1m, 5m, 15m, 1h) — row counts cross billions even
  sparsely; D1's 10 GB/db limit gets uncomfortable.
- **Histogram-monoid avail data** — fat per-row payload (JSON state-count
  maps), more compact in parquet than serialized in SQLite.
- **Cross-project reuse** — pyrmts already serves awair / apvd, both of which
  may stay on parquet long-term.

So: per-tier choice. Coarse tiers in D1, fine tiers in parquet, optionally
both available for the same tier during bake-offs.

## Architecture

### Pyrmts: storage backend interface

Today `fetchSegmentRows(storage, segment)` in pyrmts assumes parquet on R2.
Lift the storage to a pluggable interface:

```ts
interface StorageBackend<R> {
  readonly name: string  // 'r2-parquet' | 'd1' | future

  // The planner picks segments; the backend turns them into rows.
  // For r2-parquet: fetch parquet, RG-prune, decode.
  // For d1: build SQL from segment + dimFilters + cellFilters, execute.
  fetchSegmentRows(
    segment: PlannedSegment,
    filters: { cells?: SpatialSet<string>; dims?: DimFilter; range: [number, number] },
  ): Promise<R[]>
}
```

Pyramid spec extends to declare per-tier backends:

```yaml
tiers:
  - name: '1mo'
    bin: '1mo'
    shard: 'all'
    storage:
      r2-parquet: { keyTemplate: 'rides-v3/start/1mo/all.parquet' }
      d1: { binding: 'RIDES_V3', table: 'rides_start_1mo' }
```

A tier MAY declare multiple backends. The query API picks via
`?backend=r2|d1` (default = first declared, or pyramid-level default).
This enables A/B bake-offs without touching the build pipeline — same
data on R2 + in D1, query picks.

### ctbk: D1 schema

One table per `(variant, anchor, tier)`. Naming: `rides_{anchor}_{tier}`
(variant scoped by D1 binding). Columns mirror parquet schema:

```sql
CREATE TABLE rides_start_1mo (
  dt          INTEGER NOT NULL,  -- unix ms (bucket start)
  cell        TEXT    NOT NULL,  -- S2 token, level-encoded
  gender      INTEGER NOT NULL,  -- 0/1/2 (matches JSON Gender)
  user_type   INTEGER NOT NULL,  -- 0=Annual, 1=Daily
  bike_type   INTEGER NOT NULL,  -- 0=classic, 1=electric, 2=docked
  count_n     INTEGER NOT NULL,
  count_sum   INTEGER NOT NULL,
  count_sumsq INTEGER NOT NULL,
  duration_n     INTEGER NOT NULL,
  duration_sum   INTEGER NOT NULL,
  duration_sumsq INTEGER NOT NULL,
  PRIMARY KEY (cell, dt, gender, user_type, bike_type)
) WITHOUT ROWID;
CREATE INDEX rides_start_1mo_dt ON rides_start_1mo (dt);
```

Notes:
- `WITHOUT ROWID` saves ~12 B/row; PK becomes the clustered index.
- Dim columns INT-encoded (vs strings): ~3-byte saving × 5 dim cols × many
  rows = significant. Encoding deferred to schema notes in Phase 0 results.
- `(cell, dt, ...)` order aligns with the load-bearing query pattern
  (cell-set IN + time range). Index on `(dt)` alone for the rare
  "all-cells time range" query.

### Variant + tier sharding

D1 has a 10 GB hard limit per DB. Sharding strategy:
- **D1 #1**: `RIDES_V3_COARSE` — `1mo`, `3mo`, `1y`, `6mo`, `12h`, `7d`, `14d`.
  All "shard = all" tiers + the few coarse-shard ones.
- **D1 #2**: `RIDES_V3_MID` — `1h`, `3h`, `6h` IF they fit. Phase 0 decides.

If sparsity is worse than expected, split further by anchor (× 2 D1s)
or by S2 level (× 6 D1s). The interface above doesn't care — each
backend declaration names its binding + table.

## Phase 0 — empirical sizing on `e`

**Goal**: For each (variant, anchor, tier, level) of the rides-v1 / v2 / v3
pyramids, measure:
1. On-R2 parquet size (bytes).
2. Decompressed row count.
3. Sum of dim cardinalities (proxy for sparsity).
4. Estimated SQLite size — load a representative shard into a local SQLite
   DB and measure. Empirical SQLite-to-parquet ratio (expected 4-10×, but
   varies a lot with row width + repetition).

### Tasks for `e`

```bash
# Inventory shards
ctbk pyramid-stats --variant v1 --output tmp/v1-stats.json
ctbk pyramid-stats --variant v2 --output tmp/v2-stats.json
ctbk pyramid-stats --variant v3 --output tmp/v3-stats.json

# Per-shard: parquet bytes, row count, distinct (cell, dt, dim*) cardinality
# Output: jsonl, one row per (variant, anchor, tier, level, shard) with
#   { bytes, rows, distinct_cells, distinct_dts, distinct_dim_combos }

# Load a few representative shards into sqlite + measure
ctbk d1-size-probe --variant v3 --tiers 1mo,3mo,1y --output tmp/v3-d1-sizes.json
# Should:
#   - Read parquet → pandas
#   - Write to sqlite using the schema above (WITHOUT ROWID + INT dims)
#   - vacuum
#   - Report sqlite file size, parquet:sqlite ratio
```

`pyramid-stats` and `d1-size-probe` are NEW subcommands. Schema for outputs:

```jsonl
# v3-stats.jsonl
{"variant":"v3","anchor":"start","tier":"1mo","level":13,"shard":"all","bytes":12345678,"rows":1234,"distinct_cells":987,"distinct_dts":155,"distinct_dim_combos":18}
…
```

```jsonl
# v3-d1-sizes.jsonl
{"variant":"v3","anchor":"start","tier":"1mo","level":13,"parquet_bytes":12345678,"sqlite_bytes":98765432,"ratio":8.0,"rows":1234567}
…
```

### Deliverable from `e`

A new spec section (or PR-comment) here that fills in this table for the
v3 ladder (and v1/v2 for comparison):

| Tier | Anchor | Levels | Total parquet (MB) | Total rows (M) | Est. SQLite (MB) | Fits 10 GB D1? |
|---|---|---|---|---|---|---|
| 1mo | start | 10-15 | ? | ? | ? | ? |
| 1mo | end | 10-15 | ? | ? | ? | ? |
| 3mo | both | 10-15 | ? | ? | ? | ? |
| 1y | both | 10-15 | ? | ? | ? | ? |
| 1d | both | 10-15 | ? | ? | ? | ? |
| 7d | both | 10-15 | ? | ? | ? | ? |
| 14d | both | 10-15 | ? | ? | ? | ? |
| 12h | both | 10-15 | ? | ? | ? | ? |
| 6h | both | 10-15 | ? | ? | ? | ? |
| 3h | both | 10-15 | ? | ? | ? | ? |
| 1h | both | 10-15 | ? | ? | ? | ? |

Plus a written conclusion: **which tiers are D1-feasible** under the
single-DB limit, and where the splits should go.

### Open questions for `e` to settle empirically

1. **WITHOUT ROWID vs. ROWID**: SQLite docs claim WITHOUT ROWID is 5-15%
   smaller for narrow tables and faster for PK-range queries. Verify on
   the 1mo tier.
2. **Dim encoding**: INT-encoded dims (0/1/2) vs. TEXT (`"classic_bike"`).
   Expected ~3-4× compression on dim cols. Measure.
3. **Compression**: SQLite has no native compression. If sparsity is worse
   than expected, consider `sqlite-zstd` extension (or just stay on
   parquet for that tier).
4. **Sparsity vs. cardinality**: We assume ~5K cells × 18 dim combos at
   1mo gives ~14M rows over 155 months. True sparsity = rows / (theoretical
   max). If true sparsity is ≥50%, sizing is well-modeled; if <10%, the
   actual row count is much smaller than predicted and D1 fits more tiers.

## Phase 1 — pyrmts `D1Storage`

Once Phase 0 says which tiers fit, build the backend interface.

1. Refactor pyrmts `fetchSegmentRows` to dispatch on `tier.storage`.
2. New `D1Storage` impl in `pyrmts-cfw` (since D1 is a CFW binding).
   Lives alongside existing R2-parquet storage.
3. SQL builder: takes the planned segment + filter spec, emits a single
   `SELECT … WHERE cell IN (?,?,...) AND dt BETWEEN ? AND ? GROUP BY ...`.
4. Reducer logic stays unchanged — D1 returns rows in the same monoid
   shape (n / sum / sumsq).

## Phase 2 — ctbk D1 builder

ctbk's pyrmts pyramid builder gets a `--storage` mode.

```bash
ctbk rides build --variant v3 --anchor start --tier 1mo --storage d1
# Writes to a D1 table (or .sql dump for `wrangler d1 execute`)
```

Implementation:
- Existing flow: pandas → parquet on R2.
- New flow: pandas → SQLite file → `wrangler d1 import` (or batched
  `INSERT OR REPLACE`).
- For the bake-off case (parquet + D1 both): just run both writers.

Initial scope: 1mo tier only. Validate the path end-to-end before
expanding.

## Phase 3 — worker dual-read shadow

For at least the 1mo tier:
- Add `?backend=r2|d1` query param to `/api/rides-v3`.
- Default to current parquet path.
- Hidden `?backend=both` mode that runs both, compares byte-for-byte at
  the reducer output, logs the delta.
- Run for 1-2 weeks; compare warm/cold latencies in production traffic.

## Phase 4 — cutover

When D1 is verified at parity + faster:
- Default `?backend=d1` for the tiers that have it.
- Keep parquet readable for the bake-off + as a fallback.
- Remove the dual-read code once confidence is high.

## Phase 5 — extend tier coverage

Repeat phases 2-4 for `3mo`, `1y`, `1d`, etc., per Phase 0's sizing
verdict.

## Out of scope (separate roadmap items)

These are mentioned to clarify scope, not to expand it here:

- **Unified Home + StationDetail**: separate FE work. The D1 backend
  unblocks it (single API for both pages, filter by cell set). Specs:
  `rides-pyramid-v1.md` Phase 1c (`#71`).
- **Neighborhoods**: pure FE; URL-state via `use-prms` + a static
  `neighborhoods.json` + `@turf/turf` polygon-to-stations. Independent
  of this spec.
- **Avail time-of-day fold**: SQL one-liner over the avail equivalent of
  this work. Will write a sibling spec once avail's D1 tier sizes are
  measured.
- **Dev FE (`dev.ctbk.dev`)**: separate, ~half-hour change; should land
  before Phase 3 so we can shadow-deploy.
- **Pyrmts upstream PR for `StorageBackend`**: the interface refactor
  needs to land upstream first (then ctbk picks up via dist-branch pin).
  Tracked under the pyrmts repo, not here.

## Risks

- **D1 latency tail**: D1 is generally fast but has a long tail on cold
  queries against multi-GB tables. If p99 cold exceeds the parquet path,
  the bake-off invalidates the design and we revisit. Phase 3 catches
  this.
- **SQLite size blowup**: if Phase 0 shows >10× ratio (vs. expected 4-10×),
  some tiers we hoped to D1 stay on parquet. Plan adapts.
- **D1 query limits**: 100 K rows max per response. Cell-set queries return
  ~10 K rows worst case → fine. Worth verifying in Phase 1.
- **Per-tier choice complicates the API surface**: `?backend=` is the only
  user-facing knob (rare). Internal complexity is contained to the
  storage interface.
