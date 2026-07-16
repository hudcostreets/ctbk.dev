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


def _hr_bytes(n: int) -> str:
    """Format byte count as SI (kB/MB/GB, base-1000). 3 sig figs."""
    if n < 1000:
        return f"{n}B"
    units = ('kB', 'MB', 'GB', 'TB')
    v = float(n) / 1000
    for u in units:
        if v < 1000:
            return f"{v:.2f}{u}" if v < 10 else f"{v:.1f}{u}" if v < 100 else f"{v:.0f}{u}"
        v /= 1000
    return f"{v:.0f}PB"


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


def list_existing_with_mtime(
    pyramid: Pyramid,
    storage,
) -> dict[str, datetime | None]:
    """Like `list_existing_keys` but `{key: LastModified}`.

    Uses the S3/R2 paginator directly when the backend exposes one
    (pyrmts `S3Storage`); other backends (e.g. `MemStorage` in tests)
    fall back to `list()` with `None` mtimes (treated as fresh).
    """
    template = pyramid.keyTemplate
    prefix = template.split('{')[0]
    client = getattr(storage, '_client', None)
    bucket = getattr(storage, 'bucket', None)
    if client is None or bucket is None:
        return {key: None for key in storage.list(prefix)}
    out: dict[str, datetime | None] = {}
    paginator = client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            out[obj['Key']] = obj['LastModified']
    return out


def split_stale(
    existing: dict[str, datetime | None],
    stale_before: datetime | None,
) -> tuple[set[str], set[str]]:
    """Partition `{key: mtime}` into `(fresh_keys, stale_keys)`.

    A key is stale iff `stale_before` is set and its mtime is known and
    `< stale_before`. Unknown mtimes (`None`) are treated as fresh —
    backends that can't report mtimes shouldn't trigger rebuilds.
    """
    if stale_before is None:
        return set(existing), set()
    fresh: set[str] = set()
    stale: set[str] = set()
    for key, mtime in existing.items():
        if mtime is not None and mtime < stale_before:
            stale.add(key)
        else:
            fresh.add(key)
    return fresh, stale


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
    stale_before: datetime | None = None,
) -> tuple[list[ExpectedShard], set[str], dict[str, list[ExpectedShard]]]:
    """End-to-end discovery: enumerate expected → list R2 → diff → sort.

    Returns `(gaps_in_fill_order, existing_key_set, expected_by_tier)`.
    - `gaps_in_fill_order`: missing shards, sorted for tier-by-tier fill.
    - `existing_key_set`: R2 snapshot at discovery time; the fill loop
      extends it as each shard is written so downstream source lookups
      see fresh inputs without new HEAD round trips.
    - `expected_by_tier`: outer-cover expected shards grouped by tier
      name. Threaded through the fill loop → `source_long_for_gap` so
      each target-tier gap's source picks are drawn from tier N-1's
      outer expected set intersecting eff_gap (rather than a fresh
      eff_gap-only cover, which can request shards that weren't part
      of the outer fill).

    `stale_before`: existing shards last-modified before this UTC
    timestamp are treated as missing — the fill loop rebuilds them in
    place (same key, overwrite on put). Content-invalidation knob for
    "an upstream input changed; everything built before T is stale"
    (e.g. a station-luc denorm re-key).
    """
    err(f"fsck: discovering gaps in {pyramid.keyTemplate.split('{')[0]} "
        f"over [{time_range[0].date()}, {time_range[1].date()})...")
    expected = list_expected_shards(pyramid, time_range, filter=filter)
    err(f"  expected: {len(expected)} shards declared by the ladder")
    existing_mtimes = list_existing_with_mtime(pyramid, pyramid.storage)
    existing, stale = split_stale(existing_mtimes, stale_before)
    err(f"  existing: {len(existing_mtimes)} keys on storage"
        + (f" ({len(stale)} stale, modified before {stale_before.isoformat()})"
           if stale_before is not None else ""))
    missing = diff_with_existing(expected, existing)
    err(f"  missing:  {len(missing)} shards to fill")
    expected_by_tier: dict[str, list[ExpectedShard]] = {}
    for e in expected:
        expected_by_tier.setdefault(e.tier, []).append(e)
    return sort_by_dependency(pyramid, missing), existing, expected_by_tier


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


# ─── Phase B: fill driver ────────────────────────────────────────────


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


def fill_gaps(
    pyramid: Pyramid,
    gaps: list[ExpectedShard],
    *,
    pyramid_name: str = 'avail',
    d1_sql_path: str = 'tmp/fsck-d1-record.sql',
    limit: int | None = None,
    skip_existing: bool = True,
    existing_keys: set[str] | None = None,
    expected_by_tier: dict[str, list[ExpectedShard]] | None = None,
    max_workers: int = 3,
) -> list:
    """Materialize gaps in dependency order. Shards within a tier
    layer fan out to a `max_workers`-sized threadpool (bounded by the
    per-shard memory footprint — /2m@2d peaked at ~17 GB, so 3 workers
    × 20 GB ≈ 60 GB RAM ceiling).

    `existing_keys` is a snapshot of R2 keys from discovery; the fill
    loop extends it as each shard is written so downstream prev-rung
    lookups see fresh inputs without new HEAD round trips.

    Returns a list of `MaterializeResult` for the driver to summarize /
    emit D1 SQL from.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from threading import Lock
    from .materialize import emit_d1_insert_sql, materialize_shard
    from ctbk.avail_v3 import r2_client
    r2 = r2_client()
    key_set: set[str] = set(existing_keys) if existing_keys is not None else set()
    key_set_lock = Lock()
    results: list = []
    by_status: dict[str, int] = {}
    processed = 0

    def process(gap: ExpectedShard):
        return materialize_shard(
            r2, pyramid, gap,
            skip_existing=skip_existing,
            key_set=key_set,
            expected_by_tier=expected_by_tier,
        )

    from pathlib import Path
    Path(d1_sql_path).parent.mkdir(parents=True, exist_ok=True)

    tier_batches = _group_by_tier(gaps)
    for tier, batch in tier_batches:
        if limit is not None and processed >= limit:
            err(f"  hit --limit {limit}; stopping after {processed} gaps")
            break
        batch_slice = batch
        if limit is not None:
            batch_slice = batch[:max(0, limit - processed)]
        n_par = min(max_workers, len(batch_slice))
        with ThreadPoolExecutor(max_workers=n_par) as pool:
            futs = {pool.submit(process, g): g for g in batch_slice}
            for fut in as_completed(futs):
                gap = futs[fut]
                res = fut.result()
                results.append(res)
                by_status[res.status] = by_status.get(res.status, 0) + 1
                processed += 1
                if res.status == 'wrote':
                    with key_set_lock:
                        key_set.add(gap.key)
                if res.status == 'error':
                    err(f"  ERR /{gap.tier}@{gap.shard_dur} {gap.period_start.date()}: {res.error}")
                else:
                    tag = f" ({res.source_desc}, {res.rows:,}r, {_hr_bytes(res.bytes_written)})" if res.status == 'wrote' \
                        else f" ({res.source_desc})" if res.source_desc else ""
                    err(f"  [{processed}/{len(gaps)}] /{gap.tier}@{gap.shard_dur} "
                        f"{gap.period_start.date()} → {res.status}{tag}")
        # Checkpoint D1 SQL after each tier layer — safe to kill fill any time.
        if any(r.status == 'wrote' for r in results):
            emit_d1_insert_sql(pyramid_name, results, d1_sql_path)
    err(f"fill summary: " + ", ".join(f"{k}={v}" for k, v in sorted(by_status.items())))

    return results
