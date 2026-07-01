# fsck: Recursive intermediate materialization

Follow-on to `specs/done/avail-v3-fsck-backfill.md`. Fixes the pathological
`/1m` fallback cost for historical max-shard fills.

## Problem

For a fsck-discovered gap like `/1h@60d 2026-03-08` covering
`[2026-03-08, 2026-05-07)`, the current impl walks `enumerate_source_candidates`:

    /1h@30d × 2   0/2   ← neither exists on R2
    /1h@10d × 6   0/6
    /1h@2d  × 30  0/30
    /30m@30d × 2  0/2
    /30m@15d × 4  0/4
    ...
    /1m@1d  × 60  30/60 ← falls back here

The `/1h@30d × 2` shards don't exist because the minimal-cover semantics only
emit **max-shards** for closed historical periods (see
`~/pyrmts/specs/unified-shard-ladder.md`). Smaller rungs of a tier only exist
in the trailing window near `now`.

`/30m@30d 2026-04-07` — the shard that WAS filled by this fill (early in the
run) — could reduce the source read to just 1 shard for half the period.
But my current impl requires all `N` inputs at the same rung, so it can't
compose `/1h@30d 2026-04-07` (from `/30m@30d × 1`) with `/1h@30d 2026-03-08`
(from `/1m@1d × 30` mostly-empty).

Empirical hit: `/1h@60d 2026-03-08` took **1h47m** (60 slow `/1m@1d` reads
+ downstream group-by/pivot). With recursive intermediates it would be:

- Materialize `/1h@30d 2026-04-07` from `/30m@30d × 1` — ~1 min
- Materialize `/1h@30d 2026-03-08` from `/1m@1d × 30` (all 404 for pre-data
  days) — ~5 min (mostly HEAD/404s)
- Combine `/1h@60d = /1h@30d × 2` — ~1 min

Estimated ~7 min instead of 1h47m — **~15× speedup** for this shard type.

## Design

When `source_long_for_gap` finds no fully-populated candidate, try
**recursive materialization** of the smallest-N candidate before falling
back to `/1m`. Each missing sub-shard's build is a recursive call to
`materialize_shard`, which may itself recurse.

    def source_long_for_gap(r2, pyramid, gap, *, key_set, recursion_depth=0, sub_results=None):
        if gap.tier == '1m': ...  # raw-ingester path

        candidates = enumerate_source_candidates(pyramid, gap)
        candidates = [c for c in candidates if c.n_inputs <= MAX_CANDIDATE_INPUTS]

        # Try existing candidates first
        for cand in candidates:
            if _all_keys_exist(r2, cand.keys, key_set=key_set)[0]:
                chosen = cand
                break
        else:
            chosen = None

        # No existing candidate — recursively materialize the top one
        if chosen is None and recursion_depth < MAX_RECURSION_DEPTH:
            for cand in candidates:
                for key, start in zip(cand.keys, cand.source_starts):
                    if key in key_set: continue
                    sub_gap = ExpectedShard(
                        tier=cand.tier, shard_dur=cand.shard_dur,
                        period_start=start,
                        period_end=start + timedelta(minutes=cand.shard_dur_min),
                        key=key,
                    )
                    sub_result = materialize_shard(
                        r2, pyramid, sub_gap,
                        key_set=key_set,
                        recursion_depth=recursion_depth + 1,
                        sub_results=sub_results,
                    )
                    if sub_results is not None:
                        sub_results.append(sub_result)
                    if sub_result.status in ('wrote', 'exists', 'empty', 'no_inputs'):
                        # Mark handled — parent read loop tolerates missing keys.
                        key_set.add(key)
                # After materializing, check if candidate is now usable
                if _all_keys_exist(r2, cand.keys, key_set=key_set)[0]:
                    chosen = cand
                    break

        # Fall back to /1m root if still nothing
        if chosen is None: ...  # existing /1m fallback code

`key_set` is a shared mutable set (thread-safe on individual adds thanks to
the GIL). Recursion is bounded by:

1. **`MAX_RECURSION_DEPTH`** (default 15) — safety cap. Practical depth for
   the 15-tier avail-v3 ladder ≤ 8.
2. **Strictly-smaller shards each level** — no cycles possible.
3. **`MAX_CANDIDATE_INPUTS = 60`** — same cap as top-level candidate
   selection.

## Handling `empty` / `no_inputs` intermediates

Pre-data periods produce `no_inputs` at leaf recursion (all `/1m@1d` are
404). The intermediate itself becomes `no_inputs` (or `empty` if some
inputs existed but produced no rows) — **not written to R2**. Adding its
key to `key_set` anyway signals "handled, don't recurse again"; the parent's
read loop tolerates missing keys (`shard_to_long` returns `None` → skipped).

If intermediate materialization fails entirely (e.g., raises), don't add
to `key_set` and try the next candidate.

## Intermediate persistence in D1

Recursive intermediates written to R2 must also be recorded in D1 so the
api-worker's cursor walk sees them. They're not part of the minimal cover
per se, but they're correct shards at their (tier, shard_dur, period) —
the planner's "largest-first" walk will still prefer the max-shard.

`sub_results` accumulates recursive `MaterializeResult`s so
`emit_d1_insert_sql` picks them up alongside the top-level fills.

## Incremental D1 emit

Second, smaller improvement: `fill_gaps` currently writes the D1 SQL file
only at the very end. Kill mid-run and we lose the emit for every shard
already written. Move `emit_d1_insert_sql` inside the rung-batch loop so
the file is refreshed after each rung — same idempotent
`INSERT OR REPLACE` statements, just checkpointed.

## Concurrency

Rung-level `ThreadPoolExecutor` (max_workers=3) drives fill. Recursive
calls run **synchronously in the parent thread** — no additional threads
spawned, total concurrency stays bounded.

Two workers in the same rung batch may occasionally try to materialize the
same intermediate (e.g., overlapping period source shards for two different
parent gaps). Accept the small duplicate-work risk: R2 `put_object` is
atomic (last-write-wins with identical output), and both workers' subsequent
reads see the same key on retry. If it becomes a hotspot, add an in-flight
`dict[str, threading.Event]` guard.

## Success criteria

Re-run fsck on a range that includes `/1h@60d 2026-03-08` (any historical
max-shard). Expected:

- No `/1m@1d × 60`-style entries in the log except for base-tier /1m fills.
- `/1h@60d 2026-03-08` completes in ≤ 10 minutes.
- Downstream tiers (`/2h@60d`, etc.) still cascade off it as they do today.
- D1 SQL file is populated even if fill is killed mid-run.
