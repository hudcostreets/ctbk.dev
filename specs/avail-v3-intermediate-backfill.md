# avail-v3: intermediate-shard-size historical backfill (split-from-largest)

Phase P7 of `specs/avail-v3-ladder-migration.md`. For every
`(tier, shard_dur)` in the unified ladder where `shard_dur` is NOT
the largest, fill in the historical tiling
`[2026-04-08, 2026-06-29)` by splitting the existing largest-size
shard into N sub-shards.

This is approach (b) from `~/c/pyrmts/specs/unified-shard-ladder.md`
§"Backfill of intermediate shard sizes" — cheaper than approach (a)
because we don't re-fetch raw inputs or re-bin; output is row-
identical to what the live promoter would have produced.

## Why this matters

The planner's cursor-aware-largest-first walk picks the largest shard
covering each cursor position. With ONLY largest-size shards present
historically, narrow time-window queries on old data scan the full
largest-size shard (e.g. a single-day query on /15m scans a 15-day
shard = 15× the data of a 1-day shard). The intermediate-size
backfill lets the planner pick `/15m/1d/<date>` for single-day
queries — proportional read cost.

Correctness is unaffected (per the pyrmts spec note: "queries fall to
the largest shard — correct, but defeats the perf benefit of the
ladder").

## Inputs

Pre-conditions:
- P1 ran: `avail-v3/1m/1d/<date>.parquet` × 82 days exists.
- P5 ran: every other tier's largest-size shard sits at
  `avail-v3/<tier>/<largest_dur>/<period>.parquet`.
- D1 `pyramid_shards` keyed by (pyramid, tier, shard_dur, period).

## Algorithm

For each `(tier T, shard_dur D)` pair where `D < T.shards[-1]`:

1. List all existing `(T, T.shards[-1], P_parent)` shards via D1.
2. For each `P_parent`, compute the N = `D_parent / D` sub-periods
   `[P_child_0, ..., P_child_{N-1}]` that tile `P_parent`.
3. Read the parent parquet. Filter row groups (or rows) by `binCol`
   range matching each sub-period.
4. For each sub-period, write a child parquet to
   `avail-v3/<T>/<D>/<P_child>.parquet`.
5. Record each child in D1 `pyramid_shards`.

Concrete: `/15m` ladder = `[30min, 1h, 3h, 12h, 1d, 15d]`. Take the
existing `avail-v3/15m/15d/2026-06-16.parquet` (covering 06-16..06-30).
- Split into 15× `15m/1d/<date>.parquet` (06-16, 06-17, ...)
- Each 1d further splits into 2× `15m/12h/<date>T<HH>.parquet`
- Each 12h splits into 4× `15m/3h/<date>T<HH>.parquet`
- Each 3h splits into 3× `15m/1h/<date>T<HH>.parquet`
- Each 1h splits into 2× `15m/30min/<date>T<HH-MM>.parquet`

Alternatively (simpler), split DIRECTLY from largest to each
intermediate size in parallel (no cascade):
- `15d → 1d` (15 children per parent)
- `15d → 12h` (30 children per parent)
- ...
- `15d → 30min` (720 children per parent)

The CASCADED approach is more I/O-efficient (each shard read once)
but harder to parallelize; the DIRECT approach reads each largest
shard N_levels times (small overhead) but trivially parallel. Pick
direct for simplicity — at ctbk scale the read overhead is
negligible.

## Implementation

`scripts/avail-v3-intermediate-backfill.py` — uv-shebang script.
CLI:

```
avail-v3-intermediate-backfill.py [-c configs/pyramids/avail.yaml]
                                  [-t T]            # restrict to one tier
                                  [-d D]            # restrict to one target dur
                                  [-j N]            # ProcessPool workers (default 8)
                                  [--dry-run]
```

Python sketch:

```python
import polars as pl
from concurrent.futures import ProcessPoolExecutor

config = load_pyramid_config('configs/pyramids/avail.yaml')

def split_parent(tier, parent_dur, parent_period, child_dur):
    parent_key = f'avail-v3/{tier}/{parent_dur}/{parent_period.label}.parquet'
    df = pl.read_parquet(r2_url(parent_key))
    children = []
    for child_period in subdivide(parent_period, child_dur):
        bin_col = config.binCol
        from_ms, to_ms = child_period.start_ms, child_period.end_ms
        child_df = df.filter(pl.col(bin_col).is_between(from_ms, to_ms, closed='left'))
        if child_df.is_empty():
            continue
        child_key = f'avail-v3/{tier}/{child_dur}/{child_period.label}.parquet'
        write_parquet(child_key, child_df, rg_size=tier.rg_size)
        children.append(child_key)
    return children

tasks = []
for tier in config.tiers:
    largest = tier.shards[-1]
    intermediates = [d for d in tier.shards if d < largest]
    parents = list_d1_shards(tier=tier.name, shard_dur=largest)
    for parent_period in parents:
        for child_dur in intermediates:
            tasks.append((tier.name, largest, parent_period, child_dur))

with ProcessPoolExecutor(max_workers=workers) as pool:
    for children in pool.map(lambda t: split_parent(*t), tasks):
        for child in children:
            record_in_d1(pyramid='avail', **parse_key(child))
```

## Run

```bash
# Dry-run: enumerate all (tier, dur, parent) tuples, print counts
scripts/avail-v3-intermediate-backfill.py --dry-run \
  | tee tmp/intermediate-plan.txt
# Expect O(15 tiers × 5-7 intermediate sizes × ~5-30 parents) ≈ 500-3000 tasks

# Per-tier smoke first (verify byte-stability with a live-promoted shard, if any)
scripts/avail-v3-intermediate-backfill.py -t 1m -d 1h -j 1 \
  2>&1 | tee tmp/intermediate-1m-1h.log

# Full run on e
time scripts/avail-v3-intermediate-backfill.py -j 16 \
  2>&1 | tee tmp/intermediate-full.log
```

Wall estimate: each split = parquet read + filter + N writes. At ctbk
scale (each largest shard ~20-200 MB, N child sizes 6-7), ~30-60s
per parent at `-j 1`; ~3-5 min at `-j 16` for the whole pyramid.
Bounded by R2 read bandwidth.

## Byte-stability with live-write path

P4's CFW writes intermediate-size shards going forward. Their bytes
should be IDENTICAL to the bytes produced by P7's split (same rows,
same sort, same RG size, same parquet/snappy settings). To verify,
diff a CFW-written shard with the corresponding split-from-parent
shard for an overlap day after both have run:

```bash
# Once P7 wrote `avail-v3/1m/5min/2026-06-28T<HH-MM>.parquet` (from
# splitting the 2026-06-28 1d-shard) AND P4 also produced the same
# file (live), compare:
md5sum tmp/from-split.parquet tmp/from-live.parquet
# Expect: identical.
```

Per pinned pandas/pyarrow versions in `pyproject.toml`, output is
byte-stable. Discrepancy = bug to investigate (sort order? RG split
boundary? schema field order?).

## Storage delta

Per pyrmts spec keep-all retention recommendation: keep all sizes
post-backfill. Storage cost: each intermediate size has same total
byte count as the largest (it's the same data re-partitioned). N
intermediate sizes per tier ≈ N× storage. For ctbk (15 tiers × ~6
intermediate sizes per tier × ~5-10 GB per tier), additional storage
~10-50 GB. R2 storage cost trivial.

If concerned, switch to LSM-style: declare `retention: lsm` in
`avail.yaml` for selected tiers; the cascade CFW (or a separate
GHA cleanup job) deletes smaller shards once their larger-parent is
sealed + N boundaries past.

## Cross-reference

- `~/c/pyrmts/specs/unified-shard-ladder.md` §"Backfill of intermediate
  shard sizes" — algorithmic spec.
- `specs/avail-v3-ladder-migration.md` — umbrella; P7 lives here.
- `specs/avail-v3-1m-backfill.md` — P1 produces the largest /1m
  shards this script splits.
