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

from .config import parse_rg_sizes, rg_size_for
from .engine import Ingester, ShardWriteSet, cascade_block


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
    storage = _make_storage_from_cfg(cfg.storage)
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


def _make_storage_from_cfg(storage_cfg: dict):
    """Construct a pyrmts Storage from a YAML `storage:` mapping (same
    semantics as `ctbk.pyramid_cascade.cli._make_storage`)."""
    import os
    from pyrmts.storage import S3Storage

    typ = storage_cfg['type']
    if typ != 's3':
        raise ValueError(f"unsupported storage.type {typ!r} in worker")
    return S3Storage(
        bucket=storage_cfg['bucket'],
        endpoint_url=(
            os.environ.get('R2_ENDPOINT_URL')
            or (f"https://{os.environ['CLOUDFLARE_ACCOUNT_ID']}.r2.cloudflarestorage.com"
                if 'CLOUDFLARE_ACCOUNT_ID' in os.environ else None)
        ),
        region_name='auto',
        aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID') or os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY') or os.environ.get('AWS_SECRET_ACCESS_KEY'),
    )


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
        workers: process pool size. 1 = synchronous (debuggable).
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
        for bf, bt in blocks:
            ws = cascade_block(
                pyramid, (bf, bt), ingester,
                staging_storage=staging_storage,
                base_tier=base_tier,
                rg_sizes=rg_sizes,
            )
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
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = [
                pool.submit(_block_task, config_yaml, r, ingester_target, staging_uri, base_tier, rg_sizes)
                for r in block_range_isos
            ]
            for fut in as_completed(futures):
                _consume(fut.result())

    # ── Reduce phase ──
    by_key: dict[tuple[str, str], list[str]] = defaultdict(list)
    for tier, period, staging_key in all_partials:
        by_key[(tier, period)].append(staging_key)

    result.partials_written = len(all_partials)

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

    # Clean up staging.
    if staging_uri and staging_uri.startswith('file://'):
        import shutil
        root = staging_uri.removeprefix('file://')
        if Path(root).exists():
            shutil.rmtree(root, ignore_errors=True)

    if emit_manifest:
        _emit_manifest(pyramid, range_)

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
    # Delete the staged partials AFTER successful write.
    for key in staged_keys:
        try:
            if hasattr(storage, 'delete'):
                storage.delete(key)
        except Exception:
            pass
    return buf.getvalue()


def _merge_long(
    cat: pl.DataFrame,
    dim_names: list[str],
    bin_col: str,
    metric_cols: list[str],
) -> pl.DataFrame:
    """Histogram-sum merge across concatenated partials. Each row has
    multiple metric_cols with JSON-string histograms; we melt to long,
    parse, sum per (cell, dt, metric, state), then re-pivot."""
    from .avail_ingester import _sum_hist_jsons  # reuse impl

    long = (
        cat.unpivot(
            on=metric_cols,
            index=dim_names + [bin_col],
            variable_name='metric',
            value_name='hist_json',
        )
        .filter(pl.col('hist_json').is_not_null())
        .group_by(dim_names + [bin_col, 'metric'])
        .agg(pl.col('hist_json').alias('hist_jsons'))
        .with_columns(
            pl.col('hist_jsons').map_elements(
                lambda jsons: json.dumps(_sum_hist_jsons(jsons), separators=(',', ':')),
                return_dtype=pl.Utf8,
            ).alias('hist_json')
        )
        .drop('hist_jsons')
    )

    pivoted = long.pivot(
        on='metric',
        index=dim_names + [bin_col],
        values='hist_json',
    )
    for m in metric_cols:
        if m not in pivoted.columns:
            pivoted = pivoted.with_columns(pl.lit(None, dtype=pl.Utf8).alias(m))
    return pivoted.select(dim_names + [bin_col] + metric_cols)


def _emit_manifest(pyramid: Pyramid, range_: tuple[datetime, datetime]) -> None:
    """Write `<root>/_manifest.json` with the latest written shard per tier.

    Worker reads this on cold start to drive watermark-aware planning.
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
