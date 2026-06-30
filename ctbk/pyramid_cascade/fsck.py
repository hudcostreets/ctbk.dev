"""fsck: discover + report (and eventually fill) missing pyramid shards.

Phase A: discovery only. Enumerates expected (tier, shard_dur,
period) tuples via pyrmts's `list_expected_shards` + lists existing
R2 keys + reports the gap.

Phase B (TODO): per-gap materialization loop. Reads source, builds
the shard, writes parquet + records in ShardIndex. Materialization
mirrors `gbfs/cascade/src/avail3/cascade.ts`'s `writeShard` but in
Python.

See `specs/avail-v3-fsck-backfill.md`.
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable

from pyrmts import ExpectedShard, Pyramid, list_expected_shards
from utz import err


def list_existing_keys(
    pyramid: Pyramid,
    storage,
) -> set[str]:
    """List every key currently in the pyramid's storage prefix.

    The pyramid's `keyTemplate` is split on the first `{` to derive the
    listing prefix; for ctbk's `avail-v3/{tier}/{shard}/{period}.parquet`
    that's `avail-v3/`.

    R2 listing is paginated — handled by the storage backend's `list()`
    iterator. For ~few-thousand-shards pyramids (current ctbk avail-v3
    scale: 1466 objects observed) this is a couple of LIST page calls.
    """
    template = pyramid.keyTemplate
    prefix = template.split('{')[0]   # everything before first {…} substitution
    keys: set[str] = set()
    for key in storage.list(prefix):
        keys.add(key)
    return keys


def diff_with_existing(
    expected: list[ExpectedShard],
    existing_keys: set[str],
) -> list[ExpectedShard]:
    """Filter `expected` down to entries whose `key` isn't in `existing_keys`.

    Storage-driven (not index-driven). pyrmts's JS `list_missing_shards`
    is index-driven (diffs against `ShardIndex`); pyrmts Python doesn't
    have a `ShardIndex` port (per `specs/done/python-unified-ladder.md`).
    The two diverge only when a shard is on R2 but missing from D1 —
    storage-driven counts that as "present"; index-driven counts it
    as "missing." For backfill purposes the storage-driven view is the
    pragmatic one ("don't re-write what's there")."""
    return [e for e in expected if e.key not in existing_keys]


def sort_by_dependency(
    pyramid: Pyramid,
    shards: list[ExpectedShard],
) -> list[ExpectedShard]:
    """Sort missing shards by fill order:

      1. tier index (base /1m first — its shards source from raw and
         coarser tiers source from /1m's shards)
      2. shard_dur ascending within tier (smallest rung first — coarser
         rungs source from the smaller-rung shards just written)
      3. period_start ascending — earlier periods first

    Within (tier, shard_dur), period_start ordering is just for
    determinism; periods at the same rung are independent."""
    tier_idx = {t.name: i for i, t in enumerate(pyramid.tiers)}
    from pyrmts.axis import parse_duration
    unit_min = {'min': 1, 'h': 60, 'd': 1440, 'mo': 1440 * 30, 'y': 1440 * 365}
    def dur_min(d: str) -> int:
        p = parse_duration(d)
        return p.count * unit_min[p.unit]
    return sorted(
        shards,
        key=lambda s: (tier_idx.get(s.tier, 99), dur_min(s.shard_dur), s.period_start),
    )


def group_by_tier_rung(
    shards: list[ExpectedShard],
) -> list[tuple[str, str, list[ExpectedShard]]]:
    """Group by (tier, shard_dur) — useful for the per-rung-batch report.

    Returns ordered list of `(tier, shard_dur, [periods])` preserving
    input order."""
    out: list[tuple[str, str, list[ExpectedShard]]] = []
    cur_key: tuple[str, str] | None = None
    cur_list: list[ExpectedShard] = []
    for s in shards:
        key = (s.tier, s.shard_dur)
        if key != cur_key:
            if cur_key is not None:
                out.append((*cur_key, cur_list))
            cur_key = key
            cur_list = []
        cur_list.append(s)
    if cur_key is not None:
        out.append((*cur_key, cur_list))
    return out


# ─── Discovery driver ────────────────────────────────────────────────


def discover_gaps(
    pyramid: Pyramid,
    time_range: tuple[datetime, datetime],
    filter: dict | None = None,
) -> list[ExpectedShard]:
    """End-to-end discovery: enumerate expected → list R2 → diff → sort.

    Returns the gap list in dependency-fill order. Caller decides
    whether to dry-run-print or materialize."""
    err(f"fsck: discovering gaps in {pyramid.keyTemplate.split('{')[0]} "
        f"over [{time_range[0].date()}, {time_range[1].date()})...")
    expected = list_expected_shards(pyramid, time_range, filter=filter)
    err(f"  expected: {len(expected)} shards declared by the ladder")
    existing = list_existing_keys(pyramid, pyramid.storage)
    err(f"  existing: {len(existing)} keys on storage")
    missing = diff_with_existing(expected, existing)
    err(f"  missing:  {len(missing)} shards to fill")
    return sort_by_dependency(pyramid, missing)


def report_gaps(missing: list[ExpectedShard], limit_per_rung: int = 3) -> None:
    """Print a per-(tier, shard_dur) summary of missing shards. First N
    periods per rung listed verbatim; rest counted."""
    if not missing:
        print("no gaps — pyramid is fully tiled per the ladder")
        return
    print(f"\n=== missing shards: {len(missing)} total ===")
    print(f"{'tier':<5} {'shard':<8} {'count':>6}  earliest..latest (sample)")
    for tier, shard_dur, periods in group_by_tier_rung(missing):
        sample = ", ".join(p.period_start.strftime('%Y-%m-%d') for p in periods[:limit_per_rung])
        more = f" +{len(periods) - limit_per_rung} more" if len(periods) > limit_per_rung else ""
        print(f"  {tier:<5} {shard_dur:<8} {len(periods):>6}  {sample}{more}")
