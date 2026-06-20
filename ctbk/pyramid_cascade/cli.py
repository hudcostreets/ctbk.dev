"""CLI: `ctbk pyramid-cascade -c CONFIG -r RANGE [-j N] [--task-size DUR]`.

Loads a pyramid YAML config, wires storage (R2/S3), invokes the
orchestrator. Per `specs/pyramid-cascade.md`."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from click import BadParameter, option
from pyrmts import parse_pyramid_yaml, pyramid_from_config
from utz import err

from ctbk.cli.base import ctbk
from .orchestrator import pyramid_cascade
from .storage import storage_from_cfg


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


@ctbk.command('pyramid-cascade', help="Build a cascading pyramid: read base-tier source, emit all derived tiers.")
@option('-c', '--config', 'config_path', required=True, help='Path to pyramid YAML config.')
@option('-i', '--ingester', required=True, help='Built-in ingester name (e.g. `avail`).')
@option('-j', '--workers', type=int, default=1, show_default=True, help='ProcessPool worker count.')
@option('-n', '--dry-run', is_flag=True, help='Print plan (blocks, tiers, periods) and exit.')
@option('-r', '--range', 'range_', required=True, help='UTC range `YYYY-MM-DD/YYYY-MM-DD` (half-open).')
@option('-s', '--staging', 'staging_uri', default=None, help='Staging URI for partial shards (default: `file:///tmp/pyramid-cascade-<pid>/`).')
@option('-t', '--task-size', 'task_size', default='1d', show_default=True, help='Block duration (pyrmts Duration, e.g. `1d`, `1mo`).')
def pyramid_cascade_cmd(
    config_path: str,
    ingester: str,
    workers: int,
    dry_run: bool,
    range_: str,
    staging_uri: str | None,
    task_size: str,
):
    config_yaml = Path(config_path).read_text()
    cfg = parse_pyramid_yaml(config_yaml)
    storage = storage_from_cfg(cfg.storage)
    pyramid = pyramid_from_config(cfg, storage)

    range_tuple = _parse_range(range_)
    ingester_fn, base_tier = _resolve_ingester(ingester)
    ingester_target = _INGESTERS[ingester][0]

    err(f"pyramid-cascade")
    err(f"  config:    {config_path}")
    err(f"  ingester:  {ingester} (base={base_tier})")
    err(f"  range:     {range_tuple[0].isoformat()} → {range_tuple[1].isoformat()}")
    err(f"  task_size: {task_size}")
    err(f"  workers:   {workers}")
    err(f"  staging:   {staging_uri or '<default tmp>'}")
    err(f"  tiers:     {len(pyramid.tiers)}: {[t.name for t in pyramid.tiers]}")

    if dry_run:
        from .orchestrator import _enumerate_blocks
        blocks = _enumerate_blocks(range_tuple[0], range_tuple[1], task_size)
        err(f"  → {len(blocks)} blocks of size {task_size}:")
        for bf, bt in blocks[:5]:
            err(f"    {bf.isoformat()} → {bt.isoformat()}")
        if len(blocks) > 5:
            err(f"    ... and {len(blocks) - 5} more")
        return

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
    )

    err(str(result))
