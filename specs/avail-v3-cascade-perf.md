# avail-v3 cascade perf: single-pass over 1m source

## Goal

Cut the avail-v3 full-rebuild wall time by ~50% by having a single pass
over each 1m hourly shard emit **all** six descendant tiers
({2m, 3m, 5m, 10m, 15m, 30m}) in one read.

Current state (per [scripts/avail-v3-cascade.sh](../scripts/avail-v3-cascade.sh))
already parallelizes siblings within each level — that alone cuts ~75 min
→ ~35 min. The remaining cost is dominated by reading each 1m hourly
shard 6 separate times. This spec proposes reading them once.

## Today

`TIER_SPECS` in `ctbk/avail_v3.py` declares each output tier's
`derive_from` source. `cascade_tiers` (and the per-tier
`build_cascade_shard`) iterates `shard_starts(tier_shard, …)` and for
each output shard reads every source shard in its window via
`read_v3_shard`.

For 1m→2m: 1728 source reads → 1728 output writes (both hourly).
For 1m→5m: 1728 source reads → 72 output writes (daily output).
Net: **the 1m@1h shards are read 6 times** across the level — 6 × 1728 =
10,368 R2 GETs + decompressions for what is conceptually a single linear
pass.

Per-shard cost is dominated by R2 GET + parquet decompress + pyarrow
table allocation; the histogram-sum is cheap. So a 6x reduction in
source reads ≈ 6x speed-up for the level.

Same shape (smaller win) applies to:
- 30m → {1h, 2h, 3h, 6h, 12h}: 5x redundant reads of 30m daily shards
- 1h → {1d, 3d, 7d}: 3x
- 1d → {1mo, 3mo, 1y}: 3x

Total redundant reads in a full rebuild: 6×1728 + 5×72 + 3×3 + 3×3 = ~10.7k
extra reads. Single-pass eliminates all of them.

## Design

### Concept

Replace the per-tier `cascade_tiers(tier, …)` entry point with a
per-source-tier entry point: `cascade_from(source_tier, …)` that reads
each source shard once and emits all of its descendants.

For 1m as source, the descendants are {2m, 3m, 5m, 10m, 15m, 30m}.
Their output shard granularities differ:

| descendant | bin_sec | output shard |
|---|---|---|
| 2m, 3m | 120, 180 | 1h (same as source) |
| 5m..30m | 300, 600, 900, 1800 | 1d (24 hour-shards per output) |

### Sketch

```python
def cascade_from(source_tier: str, date_from: Date, date_to: Date, ...):
    """One pass over `source_tier`'s shards, emitting all descendants."""
    descendants = [t for t in TIER_SPECS.values() if t.derive_from == source_tier]
    # Group by output shard granularity.
    by_shard: dict[str, list[TierSpec]] = defaultdict(list)
    for d in descendants:
        by_shard[d.shard].append(d)

    # For each output shard granularity, maintain a per-tier accumulator
    # that flushes at the granularity boundary.
    accumulators: dict[(str, str), pa.Table] = {}  # (tier, shard_period) → accum

    for source_start in shard_starts(TIER_SPECS[source_tier].shard, date_from, date_to):
        src = read_v3_shard(cli, source_tier, source_start)
        for desc in descendants:
            period = shard_period(desc.shard, source_start)
            accumulators[(desc.name, period)] = (
                merge_into(accumulators.get((desc.name, period)),
                           rebin(src, desc.bin_sec))
            )
        # Flush any output shards whose period just closed.
        for (tier, period), tab in list(accumulators.items()):
            if period_closed(tier, period, source_start):
                write_v3_shard(cli, tier, period, tab)
                del accumulators[(tier, period)]
    # Final flush.
    for (tier, period), tab in accumulators.items():
        write_v3_shard(cli, tier, period, tab)
```

The hot loop reads each source shard once and dispatches to all 6
output tiers' accumulators.

### Concurrency model

The current per-shard ProcessPool parallelism (`-c 16`) parallelizes
*output* shards. For single-pass, parallelism should run over *source*
shards: each worker reads one source shard, returns 6 partial
accumulator deltas, and the main process merges them into the
shard-period accumulators.

Implementation note: keep the source-side parallel; main process owns
the global accumulator state (or per-source-shard partials get merged in
the main process). 16 workers × ~1728 source shards = ~108 work units
per worker; reasonable.

### Resume / idempotency

Per-tier outputs are stable filenames (`avail-v3/<tier>/<period>.parquet`).
Resume = skip any source shard whose **descendants are all already
written and have correct content** for the source's contribution.

Simplification: ignore resume in v1 — `--overwrite` flag, full rerun.
Resume is a v2 add-on (probably not worth the bookkeeping at our shard
counts).

### Calendar tiers (1mo, 3mo, 1y)

These don't have a `bin_sec` (calendar-grouping). The current cascade
handles them with their own derive logic. Out of scope here; this spec
covers `bin_sec`-tiers only.

## Tradeoffs

| approach | rebuild wall time | code change |
|---|---|---|
| Sequential per-tier (status quo before scripts/) | ~75 min | 0 |
| **scripts/avail-v3-cascade.sh sibling parallelism** | **~35 min** | **+1 shell script** |
| Single-pass cascade_from (this spec) | ~10 min | refactor `cascade_tiers` |
| Single-pass + parallelism on source shards | ~5 min | + ProcessPool over source |

The status-quo + scripts already covers the easy win. This spec is
worth pursuing when rebuild cadence is high enough that 30 minutes per
rebuild × N rebuilds adds up — e.g. after every station-luc denorm
change.

## Migration

1. **[laptop]** Add `cascade_from(source_tier, …)` next to
   `cascade_tiers(tier, …)` in `ctbk/avail_v3.py`. Don't remove
   `cascade_tiers` — keep as the per-tier code path for single-tier
   refresh use cases.
2. **[laptop]** New CLI: `ctbk avail-v3-cascade-from -s <source_tier>
   -f ... -T ...` (or extend `ctbk avail-v3-build`).
3. **[laptop]** Update tests: add a `cascade_from` round-trip vs the
   per-tier `cascade_tiers` output (byte-identical assertion).
4. **[laptop]** `scripts/avail-v3-cascade.sh`: replace the
   per-level-parallel block for `1m`/`30m`/`1h`/`1d` sources with one
   `cascade_from` invocation per source-tier.
5. **[`e`]** Re-run rebuild with the new script. Should hit ~10 min
   vs ~35 min.

## Open questions

1. **Memory footprint**: with 6 descendants × {hourly or daily-shard}
   accumulators in memory, what's the peak working set? Each daily-shard
   accumulator at L10-L19 + LUC layout is ~5 MB → ×4 daily descendants
   × ~24 in-flight hours = ~480 MB during the daily-shard-flush boundary
   crossing. Fits comfortably; not a concern at our scale.
2. **Single-pass over higher levels**: 30m → {1h..12h} is 5x reads on 72
   daily 30m shards = 360 redundant reads. Smaller win (~3 min off the
   cascade), but the same refactor handles it. Recommend yes.
3. **Worker-shard partials**: should each ProcessPool worker return the
   pre-aggregated partial (one row per (cell, dt_out_bucket)), and the
   main process do final merge? Lower IPC than passing back raw tables.
   YES; that's the design above.
