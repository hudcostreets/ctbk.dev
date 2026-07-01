# fsck: Heterogeneous-rung source composition

Follow-on to `specs/avail-v3-fsck-recursive-intermediates.md`. Fixes the
pathological cost of max-shards straddling pre-data + real-data periods
(e.g. `/7d@140d 2025-12-18` covers 110 days pre-data + 30 days real data,
but sources ALL 140 days from `/1m@1d`).

## Problem

`enumerate_source_candidates` produces homogeneous candidates: N shards
at the SAME `(tier, shard_dur)`. That works when a coarser-tier max-shard
covers the whole gap period uniformly, but fails when different sub-periods
have different "best" available sources.

Concrete example: `/7d@140d 2025-12-18` needs to read
`[2025-12-18, 2026-05-07)` = 140 days.

- Pre-data half `[2025-12-18, 2026-04-07)` = 110 days: nothing on R2. All
  candidate sources would return `no_inputs`.
- Real-data half `[2026-04-07, 2026-05-07)` = 30 days: `/30m@30d 2026-04-07`
  EXISTS (written by an earlier gap in the same fill run). This shard has
  the exact data we need for those 30 days.

The homogeneous cover forces a single rung across the whole 140 days:
`/1m@1d × 140`. The pre-data half is fine (140 fast 404s); the real-data
half burns ~2h reading 30 × 5.4M-row `/1m@1d` shards that WERE already
aggregated into `/30m@30d 2026-04-07`.

## Design

Replace `pick candidate` → "N shards at one rung" with `plan cover` →
"heterogeneous list of shards at possibly-different rungs, exactly
tiling the gap period."

    # Pseudocode
    def plan_source_cover(pyramid, gap, key_set):
        """Walk the gap period largest-rung-first, using existing shards
        where possible. Falls back to /1m for uncovered sub-periods."""
        segments = [(gap.period_start, gap.period_end)]
        chosen = []
        for tier in _priority_tiers(pyramid, gap):
            for rung in reversed(tier.shards):
                new_segments = []
                for (seg_from, seg_to) in segments:
                    picks, leftover = _fit_rung(tier, rung, seg_from, seg_to, key_set)
                    chosen.extend(picks)
                    new_segments.extend(leftover)
                segments = new_segments
                if not segments:
                    break
            if not segments:
                break
        # Whatever's left, fall back to /1m
        for (seg_from, seg_to) in segments:
            chosen.extend(_1m_fallback(pyramid, seg_from, seg_to))
        return chosen

    def _fit_rung(tier, rung, seg_from, seg_to, key_set):
        """Tile as much of [seg_from, seg_to) as possible with `rung`-sized
        shards of `tier`, using only those present in key_set. Return
        (picks, leftover_segments)."""
        span = parse_duration(rung)
        picks = []
        leftover = []
        cur = seg_from
        # Align cur to rung boundary
        aligned = floor_to_span(cur, span)
        if aligned != cur:
            leftover.append((cur, min(seg_to, aligned + span)))
            cur = aligned + span
        while cur < seg_to:
            nxt = add_span(cur, span)
            if nxt > seg_to:
                leftover.append((cur, seg_to))
                break
            key = _shard_key(pyramid, tier.name, rung, cur)
            if key in key_set:
                picks.append((tier.name, rung, cur, key))
            else:
                leftover.append((cur, nxt))
            cur = nxt
        return picks, leftover

`plan_source_cover` for `/7d@140d 2025-12-18`, given `/30m@30d 2026-04-07`
in `key_set`, produces:

    [
      ('30m', '30d', 2026-04-07, 'avail-v3/30m/30d/2026-04-07.parquet'),  # 30 days real data
      ('1m',  '1d',  2025-12-18, 'avail-v3/1m/1d/2025-12-18.parquet'),   # 110 × /1m@1d
      ('1m',  '1d',  2025-12-19, ...),
      ...
      ('1m',  '1d',  2026-04-06, ...),
    ]

The single `/30m@30d 2026-04-07` read replaces 30 slow `/1m@1d` reads —
massive win when the real-data half was already aggregated.

## Reading heterogeneous sources

`source_long_for_gap` currently reads each source at ONE rung via
`shard_to_long` + pre-aggregate to target bin. Heterogeneous just means:
- For each pick's `(tier, rung, start, key)`, read that shard.
- Pre-aggregate each read to the target tier's bin (already handled).
- Concat all reads.

`/1m` picks still use the raw ingester (for `/1m` gaps at max rung) OR
`shard_to_long` (for `/1m@X` intermediate reads).

## Interaction with recursive materialization

Heterogeneous cover subsumes homogeneous cover: any homogeneous candidate
becomes a special case of the heterogeneous planner. Recursive intermediate
materialization (from the sibling spec) is still useful when a gap's
segment doesn't have ANY existing coarser-tier shard, but is DIVISIBLE by
a coarser tier's rung — we'd recursively build that shard, then re-run
the planner.

Order of operations:

    plan cover → identify uncovered segments → recurse (if feasible) →
    re-plan cover → read + build → write

## Success criteria

Re-fill `/7d@140d 2025-12-18` under this impl:

- Cover plan includes `/30m@30d 2026-04-07` for the real-data half.
- `/1m@1d × 110` fallback covers the pre-data half (all 404, fast).
- Total time ≤ 15 minutes (vs current 2 hours).

Broader: any max-shard whose period overlaps pre-data + real-data cutoff
should complete in "pre-data-half 404 count × HEAD latency" + "real-data-half
coarse-shard read time" — no more /1m-per-day for regions covered by
larger existing shards.
