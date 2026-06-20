# avail-v3 cascade: single-pass over 1m source

## Goal

Cut the avail-v3 full-rebuild wall time from ~35 min → ~5–10 min by
having **one streaming pass over the 1m source** emit *all 17 derived
tiers* in one go.

## Insight

Every derived tier in the avail-v3 pyramid is a histogram-monoid roll-up
of 1m rows under some `_bin_floor(tier, dt)` function. The bin function
is fixed-width for {2m..7d} and calendar-grouped for {1mo, 3mo, 1y} —
but in both cases each output row's contents are an additive sum of 1m
histograms. So the *cascade graph* — which tier derives from which —
is a code-arbitrary choice, not a property of the data. Every tier is
*directly* derivable from 1m.

The original `cascade_tiers(tier, ...)` walked the `derive_from` chain
recursively, reading each level's output as input to the next. That
means:

- 1m hourly source is read 6× (once per direct descendant — 2m, 3m,
  5m, 10m, 15m, 30m)
- 30m daily output is read 5× (once per 1h..12h descendant)
- 1h monthly output is read 3× (once per 1d, 3d, 7d)
- 1d yearly output is read 3× (once per 1mo, 3mo, 1y)

Net: ~10.7k redundant R2 GETs + decompresses per full rebuild on top of
the actual unique reads.

## Design

`cascade_from_1m(date_from, date_to, ...)` (in `ctbk/avail_v3.py`)
walks the 1m source in chronological order via a thread-pool prefetch
buffer, and maintains a per-`(tier, output_period)` accumulator. As
each source 1m hourly shard arrives:

1. For each derived tier `T`, compute `output_period =
   shard_period(T.shard, source_start)`.
2. If `T` already had a different period open, **flush** it: pivot the
   accumulator into a `pa.Table`, write the parquet shard to R2, clear
   the accumulator entry. This is what makes the streaming pass
   memory-bounded.
3. Re-bin each source row by `_bin_floor(T, dt_in)` and merge its
   histogram into the accumulator under
   `(cell, dt_out, metric) → {state: count}`.

The same code path covers both bin-derived ({2m..7d}, 14 tiers) and
calendar ({1mo, 3mo, 1y}, 3 tiers) — `_bin_floor` dispatches on
`TIER_SPECS[T].bin_sec is None`.

### Memory model

Peak open accumulators at any one moment:

| group | shard | open at peak |
|---|---|---|
| `{2m, 3m}`      | `1h`  | none persists (closes after each source hour) |
| `{5m..30m}`     | `1d`  | 4 tiers × 1 day each   |
| `{1h..12h}`     | `1mo` | 5 tiers × 1 month each |
| `{1d, 3d, 7d}`  | `1y`  | 3 tiers × 1 year each  |
| `{1mo, 3mo}`    | `1y`  | 2 tiers × 1 year each  |
| `{1y}`          | `all` | 1 tier (whole build window — tiny) |

Empirically ~750 MB peak at full pyramid scope (~2400 cells × ~5 metrics
× sparse histograms). Fits comfortably on a single process.

### Concurrency

The bottleneck is R2 latency, not CPU. A `ThreadPoolExecutor` of size
`-c CONC` prefetches source shards in submission order; the main loop
consumes futures **in order** so the period-rollover-flush invariant is
preserved. CPU work (JSON parse, dict merge) overlaps with the next
R2 fetch.

`ProcessPool` over source shards isn't useful here: every worker would
have to merge into the same global accumulator state, which would
require either inter-process IPC of partial deltas or per-worker
duplicated state. Single-process + thread-pool I/O is the sweet spot
at our cell + bin counts.

## Tradeoffs

| approach | wall | code | R2 GETs (full pyramid) |
|---|---|---|---|
| sequential per-tier | ~75 min | status-quo `cascade_tiers` | unique × 4 (input re-reads) |
| sibling-parallel script | ~35 min | `scripts/avail-v3-cascade.sh` (Bash) | same as above |
| **single-pass `cascade_from_1m`** | **~5–10 min** | one function, one CLI | **unique sources only** |

The script is now a one-liner: `ctbk avail-v3-cascade-from-1m -f $FROM -T $TO -c $NPROC`.

## Migration

1. **[laptop]** Add `cascade_from_1m` to `ctbk/avail_v3.py`. Done in
   this PR.
2. **[laptop]** Test: `test_cascade_from_1m_matches_per_level_cascade`
   asserts byte-equivalent rowsets vs the per-level `build_cascade_shard`
   path on a synthetic 1-day window across all 17 derived tiers.
3. **[laptop]** Add CLI `ctbk avail-v3-cascade-from-1m`. Done.
4. **[laptop]** Smoke test against real R2 data on a 1-day slice; confirm
   17 tier outputs land and probe latency through the worker. Done.
5. **[`e`]** Replace `scripts/avail-v3-cascade.sh` invocation with a
   single `ctbk avail-v3-cascade-from-1m -f $FROM -T $TO -c $NPROC`.
   Full-pyramid rebuild target: ~5–10 min.
6. **[`e`]** Re-run rebuild with the new code + cell-first parquet sort
   (`s2_cell, dt`) from `ctbk/avail_v3.py:write_table_to_r2`. The
   resulting shards unlock the FE flip — single-cell queries at any
   tier+window combination drop from CPU-cap (CF 1102) to <1 s.

## Out of scope (later)

- `cascade_tiers` left in place for single-tier refresh use cases (e.g.
  rebuilding just `1h` after a station-luc update). Could retire later
  if nothing depends on it.
- Per-tier RG-prune behaviour is set by the writer (`sort=['s2_cell',
  'dt']` in `write_table_to_r2`) and is shared between `cascade_from_1m`
  and `cascade_tiers`.
