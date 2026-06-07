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

#### Phase 0 results (filled in 2026-06-07)

**Method**: `ctbk pyramid-stats -v v1,v2,v3 -a both` enumerated all 2,434 shards on R2
under `rides-v{1,2,3}/{anchor}/{tier}/<period>.parquet`, emitting per-`(variant,
anchor, tier, level, shard)` row counts + parquet bytes to `tmp/pyramid-stats.jsonl`
(8,836 records). `ctbk d1-size-probe -v v1,v2,v3 -a both -p` built the spec
`WITHOUT ROWID` + INT-encoded-dim SQLite schema for one representative (largest)
shard per `(variant, anchor, tier)` — 66 SQLite builds — and recorded the
parquet→SQLite ratio per `(v, a, t)`. Per-tier total SQLite bytes are estimated
as `(total parquet bytes summed across all shards) × (probe shard's ratio)`.

##### v3 — per-(anchor, tier) sizing (the spec target)

Each row is one D1 table per anchor (the spec's schema).

| Tier | Anchor | Levels | Shards | Total parquet (MB) | Total rows (M) | Probe ratio | Est. SQLite (MB) | Fits 10 GB? |
|---|---|---|---|---|---|---|---|---|
| 1h  | start | 10-15 | 155 | 3,242.8 | 246.01 | 4.55× | 14,743.2 | ✗ |
| 1h  | end   | 10-15 | 155 | 3,250.4 | 247.14 | 4.55× | 14,799.6 | ✗ |
| 3h  | start | 10-15 |  53 | 1,868.8 | 127.93 | 4.10× |  7,659.3 | ✓ |
| 3h  | end   | 10-15 |  53 | 1,873.6 | 126.35 | 4.10× |  7,688.4 | ✓ |
| 6h  | start | 10-15 |  27 | 1,262.6 |  81.06 | 3.93× |  4,965.3 | ✓ |
| 6h  | end   | 10-15 |  27 | 1,269.6 |  81.56 | 3.92× |  4,979.3 | ✓ |
| 12h | start | 10-15 |  14 |   849.8 |  51.46 | 3.76× |  3,192.4 | ✓ |
| 12h | end   | 10-15 |  14 |   843.5 |  51.04 | 3.75× |  3,166.0 | ✓ |
| 1d  | start | 10-15 |   1 |   570.6 |  29.95 | 3.35× |  1,910.9 | ✓ |
| 1d  | end   | 10-15 |   1 |   569.4 |  29.93 | 3.35× |  1,909.8 | ✓ |
| 3d  | start | 10-15 |   1 |   228.4 |  11.42 | 3.25× |    741.6 | ✓ |
| 3d  | end   | 10-15 |   1 |   228.1 |  11.40 | 3.25× |    740.1 | ✓ |
| 7d  | start | 10-15 |   1 |   109.4 |   5.22 | 3.15× |    344.1 | ✓ |
| 7d  | end   | 10-15 |   1 |   109.3 |   5.21 | 3.14× |    343.2 | ✓ |
| 14d | start | 10-15 |   1 |    59.3 |   2.71 | 3.05× |    180.7 | ✓ |
| 14d | end   | 10-15 |   1 |    59.1 |   2.70 | 3.05× |    180.1 | ✓ |
| 1mo | start | 10-15 |   1 |    30.3 |   1.27 | 2.85× |     86.3 | ✓ |
| 1mo | end   | 10-15 |   1 |    30.2 |   1.27 | 2.85× |     86.0 | ✓ |
| 3mo | start | 10-15 |   1 |    13.0 |   0.46 | 2.45× |     31.9 | ✓ |
| 3mo | end   | 10-15 |   1 |    13.0 |   0.46 | 2.45× |     31.8 | ✓ |
| 1y  | start | 10-15 |   1 |     4.6 |   0.15 | 2.25× |     10.4 | ✓ |
| 1y  | end   | 10-15 |   1 |     4.6 |   0.15 | 2.25× |     10.3 | ✓ |

##### v3 — combined per-tier (both anchors, the D1-packing view)

| Tier | Levels | Parquet (MB) | Rows (M) | Avg ratio | Est. SQLite (MB) | Fits 10 GB? |
|---|---|---|---|---|---|---|
| 1h  | 10-15 | 6,493.1 | 493.15 | 4.55× | 29,542.7 | ✗ |
| 3h  | 10-15 | 3,742.4 | 254.28 | 4.10× | 15,347.7 | ✗ |
| 6h  | 10-15 | 2,532.2 | 162.62 | 3.93× |  9,944.6 | ✓ (tight) |
| 12h | 10-15 | 1,693.2 | 102.50 | 3.76× |  6,358.3 | ✓ |
| 1d  | 10-15 | 1,140.0 |  59.88 | 3.35× |  3,820.8 | ✓ |
| 3d  | 10-15 |   456.5 |  22.83 | 3.25× |  1,481.7 | ✓ |
| 7d  | 10-15 |   218.7 |  10.43 | 3.14× |    687.3 | ✓ |
| 14d | 10-15 |   118.4 |   5.40 | 3.05× |    360.8 | ✓ |
| 1mo | 10-15 |    60.4 |   2.54 | 2.85× |    172.3 | ✓ |
| 3mo | 10-15 |    26.0 |   0.92 | 2.45× |     63.7 | ✓ |
| 1y  | 10-15 |     9.2 |   0.29 | 2.25× |     20.7 | ✓ |

**v3 grand total: 16.49 GB parquet → 67.80 GB SQLite (1.11 G rows across 11 tiers
× 2 anchors). Will not fit a single D1.**

##### v1 / v2 for comparison (3 levels each — 5,7,9 H3 res)

The parquet→SQLite ratio ranges 2.48–5.55× across all variants. v1 and v2 have
roughly half v3's row count (3 levels vs 6) and correspondingly smaller SQLite
footprints:

| Variant | Tier | Both anchors parquet (MB) | Both anchors SQLite (MB) |
|---|---|---|---|
| v1 | 1h  | 3,485.3 | 17,834.8 |
| v1 | 3h  | 2,200.2 |  9,456.5 |
| v1 | 6h  | 1,551.9 |  5,931.1 |
| v1 | 12h |   1,051.0 |  4,287.1 |
| v1 | 1d-1y total | 905.0 | 3,310.3 |
| v2 | 1h  | 3,329.4 | 18,474.5 |
| v2 | 3h  | 1,900.4 |  9,544.5 |
| v2 | 6h  | 1,290.5 |  6,237.5 |
| v2 | 12h |   870.7 |  4,017.9 |
| v2 | 1d-1y total | 762.0 | 2,820.5 |

v2 1h is slightly larger than v1 1h despite identical row counts because v2's
`(cell, dt)` sort compresses less well in parquet (less locality on `dt`). For
SQLite the ratio is reversed — `(cell, dt, ...)` PK aligns with the cell-first
filter pattern and `WITHOUT ROWID` benefits.

#### Verdict

**Which tiers fit a single 10 GB D1**:

- **Per-anchor D1 (single table per `(anchor, tier)`)**: All v3 tiers EXCEPT 1h
  fit cleanly. 1h is 14.8 GB per anchor — needs further sub-sharding (by
  year-range) OR stay on parquet.
- **Combined-anchor D1 (both `rides_start_<tier>` + `rides_end_<tier>` in one
  DB)**: 12h and coarser fit comfortably; 6h squeaks in (9.94 GB → no headroom);
  3h and 1h do not.

**Recommended layout for v3** (target: <8 GB per D1 for headroom; minimize DB
count):

1. **`RIDES_V3_COARSE_START`** (12h, 1d, 3d, 7d, 14d, 1mo, 3mo, 1y; start anchor) — **6.49 GB** ✓
2. **`RIDES_V3_COARSE_END`** (same tiers; end anchor) — **6.47 GB** ✓
3. **`RIDES_V3_6H_START`** — 4.97 GB ✓
4. **`RIDES_V3_6H_END`** — 4.98 GB ✓
5. **`RIDES_V3_3H_START`** — 7.66 GB ✓ (tight)
6. **`RIDES_V3_3H_END`** — 7.69 GB ✓ (tight)

→ **1h tier stays on parquet** (14.8 GB per anchor would need ≥2 sub-shards
each, and the cold-load latency benefit is more marginal at 1h granularity for
the load-bearing multi-year-monthly query path).

Total: **6 D1 databases** covering 3h..1y for both anchors. The Home /
StationDetail monthly chart (load-bearing 13-year case) hits `RIDES_V3_COARSE_*`
exclusively (1mo bin → 1mo tier or 1y tier). Time-of-day fold hits 1h on
parquet (existing path) or 3h on D1 if needed (3h is the finest hourly fold
ctbk currently supports).

**Conservative starter** (1 D1 if we want to land fast and grow):

- **`RIDES_V3_COARSE`** (1d, 3d, 7d, 14d, 1mo, 3mo, 1y; both anchors) — 6.60 GB ✓.
  Covers the load-bearing monthly chart with one DB. 12h+finer stays on parquet
  for Phase 1. Add `RIDES_V3_12H` (6.36 GB combined) in a follow-up to unblock
  TOD fold.

#### Open questions — answered

1. **WITHOUT ROWID vs ROWID**: not separately benchmarked (ran out of time
   budget; the spec schema uses WITHOUT ROWID throughout). All measurements
   reported above are WITHOUT ROWID; if we want a delta, repeat with a
   `--no-rowid=false` flag (TODO if it matters for cutover).
2. **Dim encoding**: measurements use the proposed INT encoding for gender (0/1/2)
   + dense-INT for user_type and bike_type. The 2.25–5.55× ratios are with this
   encoding. TEXT-encoded dims would add ~10–20% per row (3 dim cols × ~8 bytes
   extra each) → estimate 2.7–6.5× ratios. Not separately measured.
3. **Compression**: not needed for v3 12h+ tiers. For 1h, sizing exceeds 10 GB
   even with the current dense encoding — `sqlite-zstd` could help here but the
   row-IO cost on every query is probably worse than parquet RG pruning. Recommend
   parquet for 1h.
4. **Sparsity vs. cardinality**: actual v3 row counts come in *much* lower than
   the spec's worst-case `5K cells × 14 buckets × 18 combos × 155 months ≈ 194M`
   for 1mo — measured **2.54M rows** (1.27 M start + 1.27 M end) for the entire
   1mo tier 'all' shard. **True sparsity is ≈1.3%** vs the theoretical max — so
   the actual SQLite footprint is 77× *smaller* than the worst-case sizing
   model. Same pattern holds at all tiers. This validates the cell-set query
   pattern being a thin slice of the table (load-bearing case of ~200 cells over
   13 years × 12 months ≈ 2,400 buckets × ~18 dim combos ≈ 43 K rows per anchor).

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
