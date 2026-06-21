"""Multi-process orchestrator for cascading-pyramid builds.

Splits the build range into N blocks aligned at `task_size`, fans out
to a process pool, then runs a reduce phase to merge partial shards
into final outputs and emit a watermark manifest.

  pyramid_cascade(pyramid, range, ingester, ...)
    1. Enumerate blocks aligned to task_size
    2. ProcessPool: cascade_block per block; writes fully-owned shards
       to pyramid.storage directly, partials to staging
    3. Reduce: for each (tier, period) with N partials, concat +
       group_by(*dims, bin_col, metric, state).sum(count) + write final;
       delete partials
    4. Emit manifest at <root>/_manifest.json with latest period per tier
"""
from __future__ import annotations

import io
import json
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Iterable

import polars as pl
import pyarrow.parquet as pq
from pyrmts import (
    Pyramid,
    parse_duration,
    substitute_key,
)
from pyrmts.axis import add_span, floor_to_span
from pyrmts.storage import FsStorage, MemStorage
from utz import err

from ._hist import build_hist_json_lazy as _build_hist_json
from .config import parse_rg_sizes, rg_size_for
from .engine import Ingester, ShardWriteSet, cascade_block
from .storage import storage_from_cfg


# Top-level functions for ProcessPool pickling.
def _block_task(
    config_yaml: str,
    block_range_iso: tuple[str, str],
    ingester_target: str,  # "module.path:fn_name" — must be importable
    staging_root_uri: str | None,
    base_tier: str | None,
    rg_sizes: dict[str, int] | None,
) -> ShardWriteSet:
    """ProcessPool worker. Reconstructs Pyramid + ingester from serializable
    args so we don't pickle boto3 clients or other unpicklable objects.

    `config_yaml`: raw YAML text of the pyramid config.
    `ingester_target`: dotted `module:fn_name` (e.g.
        'ctbk.pyramid_cascade.avail_ingester:avail_ingest_1m').
    `staging_root_uri`: 'file:///path' or 'mem://'.
    """
    import importlib
    from pyrmts import parse_pyramid_yaml, pyramid_from_config

    # Reimport here so the boto3 client is constructed in-process.
    cfg = parse_pyramid_yaml(config_yaml)
    storage = storage_from_cfg(cfg.storage)
    pyramid = pyramid_from_config(cfg, storage)

    mod_path, fn_name = ingester_target.split(':', 1)
    mod = importlib.import_module(mod_path)
    ingester = getattr(mod, fn_name)

    block_from = datetime.fromisoformat(block_range_iso[0])
    block_to = datetime.fromisoformat(block_range_iso[1])
    staging_storage = _resolve_staging(staging_root_uri)
    return cascade_block(
        pyramid,
        (block_from, block_to),
        ingester,
        staging_storage=staging_storage,
        base_tier=base_tier,
        rg_sizes=rg_sizes,
    )


def _reduce_task(
    config_yaml: str,
    tier_name: str,
    period_label: str,
    staged_keys: list[str],
    staging_root_uri: str | None,
    rg_sizes: dict[str, int] | None,
) -> tuple[str, str, int, int] | None:
    """ProcessPool worker for the reduce phase. Reconstructs the Pyramid +
    staging-storage handle in-process, runs one `(tier, period)` merge,
    writes the final shard, returns `(tier, period, n_partials, n_bytes)`.

    Returns None if all staged partials were missing/empty.
    """
    from pyrmts import parse_pyramid_yaml, pyramid_from_config

    cfg = parse_pyramid_yaml(config_yaml)
    storage = storage_from_cfg(cfg.storage)
    pyramid = pyramid_from_config(cfg, storage)
    tier = pyramid.tier(tier_name)
    staging_storage = _resolve_staging(staging_root_uri)

    final_key = substitute_key(
        pyramid.keyTemplate,
        {'tier': tier_name, 'period': period_label},
    )
    merged_blob = _merge_partials(
        staging_storage, staged_keys, pyramid, tier,
        rg_size=rg_size_for(rg_sizes, tier_name),
    )
    if merged_blob is None:
        return None
    pyramid.storage.put(final_key, merged_blob)
    return (tier_name, period_label, len(staged_keys), len(merged_blob))


def _resolve_staging(uri: str | None):
    """Map a `file:///tmp/...` or `mem://` URI to a Storage instance."""
    if uri is None:
        return None
    if uri.startswith('file://'):
        return FsStorage(uri.removeprefix('file://'))
    if uri == 'mem://':
        return MemStorage()
    raise ValueError(f"unsupported staging URI: {uri!r}")


@dataclass
class CascadeRunResult:
    blocks: int = 0
    finals: int = 0
    partials_written: int = 0
    finals_via_reduce: int = 0
    bytes_written: int = 0
    wall_seconds: float = 0.0

    def __str__(self) -> str:
        return (
            f"cascade: {self.blocks} blocks, {self.finals} block-owned finals, "
            f"{self.partials_written} partials → {self.finals_via_reduce} reduced finals, "
            f"{self.bytes_written:,} bytes written, "
            f"wall {self.wall_seconds:.1f}s"
        )


def pyramid_cascade(
    pyramid: Pyramid,
    range_: tuple[datetime, datetime],
    ingester: Ingester,
    *,
    task_size: str = '1d',
    workers: int = 1,
    reduce_workers: int | None = None,
    staging_uri: str | None = None,
    base_tier: str | None = None,
    emit_manifest: bool = True,
    config_yaml: str | None = None,
    ingester_target: str | None = None,
) -> CascadeRunResult:
    """Build all derived tiers of `pyramid` over `range_`.

    Splits the range into blocks of size `task_size` (a pyrmts Duration
    string like '1d' or '1mo'), processes each block in a worker via
    `cascade_block`, then runs the reduce phase over staging.

    Args:
        pyramid: configured Pyramid with storage wired.
        range_: half-open (from, to) UTC range.
        ingester: callable `(block_from, block_to) → pl.LazyFrame`.
        task_size: block duration (pyrmts Duration string).
        workers: ProcessPool size for the block phase. 1 = synchronous
            (debuggable).
        reduce_workers: ProcessPool size for the reduce phase. Defaults
            to `workers`. Set independently if the reduce phase needs
            more (it operates on much smaller data per worker than the
            block phase, so it's safe to fan out wider).
        staging_uri: where to write partial shards. Defaults to
            `file:///tmp/pyramid-cascade-<pid>/`.
        base_tier: which tier the ingester populates. Defaults to
            pyramid.tiers[0].
        emit_manifest: write `<root>/_manifest.json` at end of run.
    """
    t0 = time.time()
    range_from, range_to = range_

    staging_uri = staging_uri or f"file:///tmp/pyramid-cascade-{int(t0)}/"
    staging_storage = _resolve_staging(staging_uri)

    blocks = _enumerate_blocks(range_from, range_to, task_size)
    n_blocks = len(blocks)

    # Per-tier RG sizes (from YAML `defaults.rg_size` + per-tier `rg_size`).
    rg_sizes = parse_rg_sizes(config_yaml) if config_yaml else None

    result = CascadeRunResult(blocks=n_blocks)

    all_partials: list[tuple[str, str, str]] = []

    def _consume(write_set: ShardWriteSet):
        for key in write_set.finals:
            blob = pyramid.storage.head(key)
            result.finals += 1
            if blob:
                result.bytes_written += blob['size']
        all_partials.extend(write_set.partials)

    block_range_isos = [(bf.isoformat(), bt.isoformat()) for bf, bt in blocks]

    if workers <= 1:
        # Sync path: share the orchestrator's staging_storage instance with
        # cascade_block directly, so MemStorage (which doesn't share state
        # across processes/instances) works for tests.
        for i, (bf, bt) in enumerate(blocks):
            t_blk = time.time()
            err(f"block {i+1}/{n_blocks}: {bf.isoformat()} → {bt.isoformat()}")
            ws = cascade_block(
                pyramid, (bf, bt), ingester,
                staging_storage=staging_storage,
                base_tier=base_tier,
                rg_sizes=rg_sizes,
            )
            err(f"block {i+1}/{n_blocks}: done in {time.time() - t_blk:.1f}s — "
                f"{len(ws.finals)} finals, {len(ws.partials)} partials")
            _consume(ws)
    else:
        # Parallel path: each worker re-constructs Pyramid (with its own
        # boto3 client) and re-imports the ingester to avoid pickling
        # unpicklable objects. Caller MUST pass `config_yaml` and
        # `ingester_target`.
        if config_yaml is None or ingester_target is None:
            raise ValueError(
                "pyramid_cascade(workers>1) needs `config_yaml=` (YAML text) "
                "and `ingester_target=` (dotted 'module:fn_name' import path)"
            )
        err(f"dispatching {n_blocks} blocks across {workers} workers")
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [
                pool.submit(_block_task, config_yaml, r, ingester_target, staging_uri, base_tier, rg_sizes)
                for r in block_range_isos
            ]
            done = 0
            for fut in as_completed(futures):
                ws = fut.result()
                done += 1
                err(f"block done ({done}/{n_blocks}): "
                    f"{len(ws.finals)} finals, {len(ws.partials)} partials")
                _consume(ws)

    # ── Reduce phase ──
    by_key: dict[tuple[str, str], list[str]] = defaultdict(list)
    for tier, period, staging_key in all_partials:
        by_key[(tier, period)].append(staging_key)

    result.partials_written = len(all_partials)

    n_reduce_workers = reduce_workers if reduce_workers is not None else workers
    if by_key:
        err(f"reduce: {len(by_key)} (tier, period) groups from {len(all_partials)} partials "
            f"across {n_reduce_workers} workers")
    t_reduce = time.time()

    if n_reduce_workers <= 1 or len(by_key) <= 1:
        # Sync path: works without `config_yaml` (e.g. in tests with
        # MemStorage).
        for (tier_name, period_label), staged_keys in by_key.items():
            tier = pyramid.tier(tier_name)
            final_key = substitute_key(
                pyramid.keyTemplate,
                {'tier': tier_name, 'period': period_label},
            )
            merged_blob = _merge_partials(
                staging_storage, staged_keys, pyramid, tier,
                rg_size=rg_size_for(rg_sizes, tier_name),
            )
            if merged_blob is None:
                continue
            pyramid.storage.put(final_key, merged_blob)
            result.finals_via_reduce += 1
            result.bytes_written += len(merged_blob)
    else:
        # Parallel path: ProcessPool over (tier, period) merge groups.
        # Workers re-construct Pyramid + storage from `config_yaml` in
        # their own process (boto3 client isn't pickleable).
        if config_yaml is None:
            raise ValueError(
                "pyramid_cascade(reduce_workers>1) needs `config_yaml=` "
                "(YAML text) to reconstruct storage/pyramid per worker"
            )
        with ProcessPoolExecutor(max_workers=n_reduce_workers) as pool:
            futures = [
                pool.submit(
                    _reduce_task,
                    config_yaml, tier_name, period_label,
                    staged_keys, staging_uri, rg_sizes,
                )
                for (tier_name, period_label), staged_keys in by_key.items()
            ]
            done = 0
            for fut in as_completed(futures):
                res = fut.result()
                done += 1
                if res is None:
                    continue
                tier_name, period_label, n_parts, n_bytes = res
                result.finals_via_reduce += 1
                result.bytes_written += n_bytes
                err(f"reduce {done}/{len(by_key)}: {tier_name:4s} {period_label} "
                    f"({n_parts} partials → {n_bytes/1024:.0f} KiB)")

    if by_key:
        err(f"reduce: wrote {result.finals_via_reduce} finals in {time.time() - t_reduce:.1f}s")

    # Clean up staging.
    if staging_uri and staging_uri.startswith('file://'):
        import shutil
        root = staging_uri.removeprefix('file://')
        if Path(root).exists():
            shutil.rmtree(root, ignore_errors=True)

    if emit_manifest:
        _emit_manifest(pyramid)

    result.wall_seconds = time.time() - t0
    return result


def _enumerate_blocks(
    from_: datetime,
    to: datetime,
    task_size: str,
) -> list[tuple[datetime, datetime]]:
    """Split [from_, to) into blocks of `task_size`, aligned at the start."""
    span = parse_duration(task_size)
    out: list[tuple[datetime, datetime]] = []
    cursor = from_
    while cursor < to:
        nxt = add_span(cursor, span)
        out.append((cursor, min(nxt, to)))
        cursor = nxt
    return out


def _merge_partials(
    storage,
    staged_keys: list[str],
    pyramid: Pyramid,
    tier,
    *,
    rg_size: int = 2048,
) -> bytes | None:
    """Read partial parquets, concat + group_by + histogram-sum, return
    serialized final parquet bytes."""
    dim_names = [d.name for d in pyramid.dims]
    bin_col = pyramid.binCol
    metric_cols = [m.name for m in pyramid.metrics]

    partials: list[pl.DataFrame] = []
    for key in staged_keys:
        blob = storage.get(key)
        if blob is None:
            continue
        tab = pq.read_table(io.BytesIO(blob))
        partials.append(pl.from_arrow(tab))

    if not partials:
        return None

    # If only 1 partial, no merge needed — just rewrite (it's already
    # the right schema + sorted).
    if len(partials) == 1:
        merged = partials[0]
    else:
        # Concat + unpivot metrics to long + parse JSON + groupby+sum +
        # re-pivot. Reusing the same long-form machinery from engine.
        cat = pl.concat(partials, how='vertical_relaxed')
        merged = _merge_long(cat, dim_names, bin_col, metric_cols)

    # Sort cell-first for RG-prune-friendly layout.
    sort_cols = [c for c in dim_names + [bin_col] if c in merged.columns]
    merged = merged.sort(sort_cols)

    buf = io.BytesIO()
    table = merged.to_arrow()
    pq.write_table(table, buf, row_group_size=rg_size, compression='snappy')
    data = buf.getvalue()

    # Delete the staged partials AFTER serializing the final blob. We log
    # on failure rather than silently swallowing — important for R2-staging
    # runs where leaked partials would accumulate.
    for key in staged_keys:
        if not hasattr(storage, 'delete'):
            break  # Storage backend doesn't support delete (e.g. MemStorage in tests).
        try:
            storage.delete(key)
        except Exception as e:
            import sys
            print(f"[pyramid-cascade] WARN: failed to delete staged partial {key!r}: {e}",
                  file=sys.stderr)
    return data


def _merge_long(
    cat: pl.DataFrame,
    dim_names: list[str],
    bin_col: str,
    metric_cols: list[str],
) -> pl.DataFrame:
    """Histogram-sum merge across concatenated partials. Each input row
    has multiple metric_cols with JSON-string histograms (shape
    `{"state":count,...}`); we melt to long, parse natively (NO
    map_elements), sum per (cell, dt, metric, state), then re-pivot.

    The JSON object has dynamic keys (state values vary), so
    `str.json_decode` with a static dtype won't work. Instead we strip
    the braces, split on `,`, explode, then split each `"state":count`
    pair on `:` and cast.
    """
    long = (
        cat.unpivot(
            on=metric_cols,
            index=dim_names + [bin_col],
            variable_name='metric',
            value_name='hist_json',
        )
        .filter(pl.col('hist_json').is_not_null() & (pl.col('hist_json').str.len_chars() > 2))
        .with_columns(
            pl.col('hist_json')
              .str.strip_chars('{}')
              .str.split(',')
              .alias('pairs')
        )
        .drop('hist_json')
        .explode('pairs')
        .with_columns(pl.col('pairs').str.split(':').alias('kv'))
        .with_columns([
            pl.col('kv').list.get(0).str.strip_chars('"').cast(pl.Int64).alias('state'),
            pl.col('kv').list.get(1).cast(pl.Int64).alias('count'),
        ])
        .drop('pairs', 'kv')
        .group_by(dim_names + [bin_col, 'metric', 'state'])
        .agg(pl.col('count').sum())
    )

    # Chunk by hash of the leading dim — same strategy as
    # `engine._build_tier_shard`. The "<100 MB per group" assumption that
    # let us drop chunking only held at smoke scale; at full-rebuild scale
    # the largest merges (tier 30m × shard 1mo with 24+ partials) explode
    # the unpivot+explode+pivot transient past per-worker memory and OOM.
    from .engine import PIVOT_CHUNKS
    chunk_col = dim_names[0] if dim_names else None
    if chunk_col is None:
        per_metric = _build_hist_json(
            long, group_keys=dim_names + [bin_col, 'metric'],
            state_col='state', count_col='count',
        )
        pivoted = per_metric.pivot(
            on='metric', index=dim_names + [bin_col], values='hist_json',
        )
    else:
        long = long.with_columns(
            (pl.col(chunk_col).hash(seed=0) % PIVOT_CHUNKS).alias('_chunk')
        )
        out_chunks: list[pl.DataFrame] = []
        for chunk in long.partition_by('_chunk', maintain_order=False):
            chunk = chunk.drop('_chunk')
            per_metric = _build_hist_json(
                chunk, group_keys=dim_names + [bin_col, 'metric'],
                state_col='state', count_col='count',
            )
            out_chunks.append(per_metric.pivot(
                on='metric', index=dim_names + [bin_col], values='hist_json',
            ))
        pivoted = pl.concat(out_chunks, how='diagonal_relaxed')

    for m in metric_cols:
        if m not in pivoted.columns:
            pivoted = pivoted.with_columns(pl.lit(None, dtype=pl.Utf8).alias(m))
    return pivoted.select(dim_names + [bin_col] + metric_cols)


def _emit_manifest(pyramid: Pyramid) -> None:
    """Write `<root>/_manifest.json` with the latest written shard per tier.

    Worker reads this on cold start to drive watermark-aware planning.

    Note: we LIST each tier prefix and take the lexically-greatest key
    (period labels are lex-sortable by construction). That captures the
    real on-storage state, including shards written by prior runs — not
    just this run's window. The manifest is a per-tier watermark, not a
    per-run summary.

    Edge case: if a prior run wrote shards past this run's `to` (e.g.
    built through 2027, then re-ran only 2026), the manifest still
    reflects the 2027 latest. The worker treats the manifest as
    authoritative-up-to-that-period; if you delete prior shards and
    don't rebuild, downstream queries can fall through to a stale
    watermark. In practice we rebuild forward-only, so this is benign.
    """
    manifest: dict[str, dict] = {'tiers': {}}
    for tier in pyramid.tiers:
        # Latest period per tier = the period whose end is closest to range_to
        # for which a shard exists.
        latest_period = _latest_period_in_storage(pyramid, tier)
        if latest_period:
            manifest['tiers'][tier.name] = {'latest_period': latest_period}

    manifest_key = pyramid.keyTemplate.replace('{tier}/{period}.parquet', '_manifest.json')
    pyramid.storage.put(manifest_key, json.dumps(manifest, indent=2).encode('utf-8'))


def _latest_period_in_storage(pyramid: Pyramid, tier) -> str | None:
    """Find the lexically-greatest period for a tier by LISTing keys."""
    prefix = pyramid.keyTemplate.split('{tier}')[0] + tier.name + '/'
    try:
        keys = list(pyramid.storage.list(prefix))
    except Exception:
        return None
    if not keys:
        return None
    # Period is the segment between the tier dir and '.parquet'.
    latest = max(keys)  # lex-sorted
    period = latest.removeprefix(prefix).removesuffix('.parquet')
    return period
