"""CLI: `ctbk pyramid-cascade -c CONFIG -r RANGE [-j N] [--task-size DUR]`.

Loads a pyramid YAML config, wires storage (R2/S3), invokes the
orchestrator. Per `specs/pyramid-cascade.md`."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import click
import yaml
from click import BadParameter, option
from pyrmts import parse_pyramid_yaml, pyramid_from_config
from utz import err

from ctbk.cli.base import ctbk
from .orchestrator import pyramid_cascade
from .storage import storage_from_cfg


def _override_key_prefix(config_yaml: str, prefix: str) -> str:
    """Rewrite `storage.key` so everything before `{tier}` becomes `<prefix>/`.

    Used to redirect output to a sibling prefix (e.g. `avail-v3-test`)
    without maintaining a second YAML. Round-trips via PyYAML, so
    comments are stripped — workers re-parse and don't depend on them.
    """
    data = yaml.safe_load(config_yaml)
    if not isinstance(data, dict):
        raise BadParameter(f"can't override --prefix: top-level YAML isn't a mapping")
    storage = data.get('storage')
    if not isinstance(storage, dict) or 'key' not in storage:
        raise BadParameter(f"can't override --prefix: YAML has no `storage.key`")
    key = storage['key']
    if '{tier}' not in key:
        raise BadParameter(f"can't override --prefix: `storage.key` ({key!r}) has no `{{tier}}` placeholder")
    suffix = key.split('{tier}', 1)[1]
    storage['key'] = f"{prefix.rstrip('/')}/{{tier}}{suffix}"
    return yaml.safe_dump(data, sort_keys=False)


def _parse_range(s: str) -> tuple[datetime, datetime]:
    """Parse `YYYY-MM-DD/YYYY-MM-DD` (half-open UTC range)."""
    try:
        a, b = s.split('/', 1)
    except ValueError:
        raise BadParameter(f"range must be `YYYY-MM-DD/YYYY-MM-DD`, got {s!r}")
    try:
        from_ = datetime.fromisoformat(a).replace(tzinfo=timezone.utc)
        to    = datetime.fromisoformat(b).replace(tzinfo=timezone.utc)
    except ValueError as e:
        raise BadParameter(f"bad ISO date in range {s!r}: {e}")
    if to <= from_:
        raise BadParameter(f"range end must be after start ({a} → {b})")
    return from_, to


# Built-in ingester registry. Each entry maps a name to an importable
# `(callable, base_tier_name)`. CTBK-specific; pyrmts itself stays
# pyramid-agnostic.
_INGESTERS: dict[str, tuple[str, str]] = {
    'avail': ('ctbk.pyramid_cascade.avail_ingester:avail_ingest_1m', '1m'),
}

# Streaming-source registry: name → (callable, base_tier_name). Used by
# the streaming engine. Callables are generators yielding (dt_ms, pa.Table)
# in chronological order (see `engine_streaming.cascade_streaming`).
_STREAM_SOURCES: dict[str, tuple[str, str]] = {
    'avail': ('ctbk.pyramid_cascade.avail_streaming_ingester:avail_stream_1m', '1m'),
}


def _resolve_ingester(name: str) -> tuple:
    """Look up the named ingester. Returns `(callable, base_tier)`."""
    if name not in _INGESTERS:
        raise BadParameter(
            f"unknown ingester {name!r}; known: {sorted(_INGESTERS)}"
        )
    target, base_tier = _INGESTERS[name]
    mod_path, fn_name = target.split(':', 1)
    import importlib
    mod = importlib.import_module(mod_path)
    return getattr(mod, fn_name), base_tier


def _resolve_stream_source(name: str) -> tuple:
    """Look up the named streaming source. Returns `(callable, base_tier)`."""
    if name not in _STREAM_SOURCES:
        raise BadParameter(
            f"unknown streaming source {name!r}; known: {sorted(_STREAM_SOURCES)}"
        )
    target, base_tier = _STREAM_SOURCES[name]
    mod_path, fn_name = target.split(':', 1)
    import importlib
    mod = importlib.import_module(mod_path)
    return getattr(mod, fn_name), base_tier


@ctbk.command('pyramid-cascade', help="Build a cascading pyramid: read base-tier source, emit all derived tiers.")
@option('-c', '--config', 'config_path', required=True, help='Path to pyramid YAML config.')
@option('-E', '--engine', 'engine_name', type=click.Choice(['block', 'streaming']), default='block', show_default=True, help='Cascade engine. `block` = ProcessPool over time-aligned blocks (vectorized Polars per block). `streaming` = single-process source iterator + per-(tier,period) dict accumulators (matches the prior `cascade-from-1m` design).')
@option('-i', '--ingester', default=None, help='Built-in ingester / source name (e.g. `avail`). Required unless --fsck.')
@option('-j', '--workers', type=int, default=1, show_default=True, help='ProcessPool worker count. Ignored for `--engine streaming` (single-process by design).')
@option('-n', '--dry-run', is_flag=True, help='Print plan (blocks, tiers, periods) and exit.')
@option('-P', '--partial-cover', 'partial_cover', type=click.Choice(['error', 'overwrite', 'merge']), default='error', show_default=True, help='Behavior when a shard\'s period extends outside --range. `error` (default): refuse, list affected shards. `overwrite`: write the partial as-is (data outside --range is LOST). `merge`: fetch the existing R2 shard and merge with this run\'s partials via histogram-sum.')
@option('-p', '--prefix', default=None, help='Override the YAML `storage.key` prefix (everything before `{tier}`). Use to redirect output, e.g. `-p avail-v3-test` for a staging build that shares the prod YAML.')
@option('-r', '--range', 'range_', required=True, help='UTC range `YYYY-MM-DD/YYYY-MM-DD` (half-open).')
@option('-s', '--staging', 'staging_uri', default=None, help='Staging URI for partial shards (default: `file:///tmp/pyramid-cascade-<pid>/`). Block engine only.')
@option('-t', '--task-size', 'task_size', default='1d', show_default=True, help='Block duration (pyrmts Duration, e.g. `1d`, `1mo`). Block engine only.')
@option('-f', '--fsck', is_flag=True, help='Discover + report missing (tier, shard_dur, period) gaps vs the YAML ladder. Add --fill to materialize the gaps (Phase B).')
@option('-F', '--fill', is_flag=True, help='With --fsck: materialize each missing shard. Idempotent (HEAD-skip), writes D1 INSERT SQL batch to tmp/fsck-d1-record.sql for the api worker to ingest.')
@option('-L', '--fill-limit', type=int, default=None, help='With --fill: stop after this many gaps (for staged smoke tests).')
def pyramid_cascade_cmd(
    config_path: str,
    engine_name: str,
    ingester: str | None,
    workers: int,
    dry_run: bool,
    partial_cover: str,
    prefix: str | None,
    range_: str,
    staging_uri: str | None,
    task_size: str,
    fsck: bool,
    fill: bool,
    fill_limit: int | None,
):
    if not fsck and not ingester:
        raise BadParameter("--ingester is required unless --fsck is set")
    if fill and not fsck:
        raise BadParameter("--fill requires --fsck")
    config_yaml = Path(config_path).read_text()
    if prefix is not None:
        config_yaml = _override_key_prefix(config_yaml, prefix)
    cfg = parse_pyramid_yaml(config_yaml)
    storage = storage_from_cfg(cfg.storage)
    pyramid = pyramid_from_config(cfg, storage)

    range_tuple = _parse_range(range_)

    if fsck:
        from .fsck import discover_gaps, fill_gaps, report_gaps
        err(f"pyramid-cascade --fsck" + (" --fill" if fill else ""))
        err(f"  config:    {config_path}")
        err(f"  range:     {range_tuple[0].isoformat()} → {range_tuple[1].isoformat()}")
        err(f"  tiers:     {len(pyramid.tiers)}: {[t.name for t in pyramid.tiers]}")
        if fill_limit is not None:
            err(f"  limit:     {fill_limit} gaps")
        missing = discover_gaps(pyramid, range_tuple)
        report_gaps(missing)
        if fill and missing:
            err("")
            fill_gaps(pyramid, missing, limit=fill_limit)
        return

    err(f"pyramid-cascade")
    err(f"  config:    {config_path}")
    if prefix is not None:
        err(f"  prefix:    {prefix}  (override; effective key: {cfg.keyTemplate})")
    err(f"  engine:    {engine_name}")
    err(f"  ingester:  {ingester}")
    err(f"  range:     {range_tuple[0].isoformat()} → {range_tuple[1].isoformat()}")
    if engine_name == 'block':
        err(f"  task_size: {task_size}")
        err(f"  workers:   {workers}")
        err(f"  staging:   {staging_uri or '<default tmp>'}")
    err(f"  partial:   {partial_cover}")
    err(f"  tiers:     {len(pyramid.tiers)}: {[t.name for t in pyramid.tiers]}")

    if dry_run:
        if engine_name == 'block':
            from .orchestrator import _enumerate_blocks
            blocks = _enumerate_blocks(range_tuple[0], range_tuple[1], task_size)
            err(f"  → {len(blocks)} blocks of size {task_size}:")
            for bf, bt in blocks[:5]:
                err(f"    {bf.isoformat()} → {bt.isoformat()}")
            if len(blocks) > 5:
                err(f"    ... and {len(blocks) - 5} more")
        else:
            err(f"  → streaming: single pass over source")
        return

    from .config import parse_rg_sizes
    rg_sizes = parse_rg_sizes(config_yaml)

    if engine_name == 'streaming':
        from .engine_streaming import cascade_streaming
        from .orchestrator import _emit_manifest, _log_partial_cover, _partial_cover_shards
        source_fn, base_tier = _resolve_stream_source(ingester)
        # Same guard rail as the block engine. Streaming engine doesn't
        # support merge mode (it writes incrementally as periods complete,
        # with no reduce phase to merge an existing R2 shard into); error
        # out if the user asked for it.
        pcs = _partial_cover_shards(pyramid, range_tuple, base_tier)
        if pcs:
            _log_partial_cover(pcs, partial_cover)
            if partial_cover == 'error':
                raise click.UsageError(
                    f"partial-cover: {len(pcs)} shards extend outside --range. "
                    f"Re-run with --partial-cover overwrite (loses outside-range data) "
                    f"or switch to --engine block + --partial-cover merge."
                )
            if partial_cover == 'merge':
                raise click.UsageError(
                    "--partial-cover merge isn't supported by --engine streaming "
                    "(no reduce phase to merge existing shards into). "
                    "Use --engine block."
                )
        result = cascade_streaming(
            pyramid,
            range_tuple,
            source_fn,
            base_tier_name=base_tier,
            rg_sizes=rg_sizes,
        )
        _emit_manifest(pyramid)
        err(str(result))
        return

    ingester_fn, base_tier = _resolve_ingester(ingester)
    ingester_target = _INGESTERS[ingester][0]
    result = pyramid_cascade(
        pyramid,
        range_tuple,
        ingester_fn,
        task_size=task_size,
        workers=workers,
        staging_uri=staging_uri,
        base_tier=base_tier,
        emit_manifest=True,
        config_yaml=config_yaml,
        ingester_target=ingester_target,
        partial_cover=partial_cover,
    )

    err(str(result))
