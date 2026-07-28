"""fsck: pyramid-shard gap discovery — re-exported from
`pyrmts_engine.discovery` (moved upstream, ops-adoption phase 2: pyrmts
`specs/pyrmts-ops-adoption.md`).

The local fill driver (`fill_gaps` over ctbk's `materialize`) was
deleted with the block/streaming engines: bulk fills run on Batch via
`pyrmts_engine.build_local --fill` (`ctbk gbfs engine submit -f`),
incremental fills in the Lambda tick (`consolidate.run_extension_fill`).

See `specs/done/avail-v3-fsck-backfill.md`.
"""
from __future__ import annotations

from pyrmts import ExpectedShard
from pyrmts_engine.discovery import (  # noqa: F401  (re-exports)
    diff_with_existing,
    discover_gaps,
    group_by_tier_rung,
    list_existing_keys,
    list_existing_with_mtime,
    report_gaps,
    sort_by_dependency,
    split_stale,
)


def _group_by_tier(
    gaps: list[ExpectedShard],
) -> list[tuple[str, list[ExpectedShard]]]:
    """Consecutive-run grouping by tier. Since `gaps` is already
    dependency-sorted (tier index, shard_dur asc, period), consecutive
    entries with the same tier form a layer batch. All shards within a
    tier are independent — the strict cascade sources ONLY from tier
    N-1, never same-tier — so the whole layer can fan out in parallel.
    (Grouping by (tier, shard_dur) here would serialize the common
    coarse-tier tail of 1-2 shards per rung.)"""
    out: list[tuple[str, list[ExpectedShard]]] = []
    for g in gaps:
        if out and out[-1][0] == g.tier:
            out[-1][1].append(g)
        else:
            out.append((g.tier, [g]))
    return out
