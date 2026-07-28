"""CLI: `ctbk pyramid-cascade -c CONFIG -r RANGE --fsck` — gap census.

The block/streaming build engines this command once fronted were deleted
(ops-adoption: pyrmts `specs/pyrmts-ops-adoption.md`): bulk builds run
on Batch via `pyrmts_engine.build_local` (`ctbk gbfs engine submit`),
incremental fills in the Lambda tick. What remains is the local
discovery report."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from click import BadParameter, option
from pyrmts import parse_pyramid_yaml, pyramid_from_config
from utz import err

from ctbk.cli.base import ctbk
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


@ctbk.command('pyramid-cascade', help="Report missing (tier, shard_dur, period) pyramid shards vs the YAML ladder (discovery only; fills run via `ctbk gbfs engine submit -f` or the Lambda tick).")
@option('-B', '--stale-before', 'stale_before', default=None, help='Treat existing shards last-modified before this UTC timestamp (ISO 8601) as missing (content-invalidation view, e.g. after a denorm re-key).')
@option('-c', '--config', 'config_path', required=True, help='Path to pyramid YAML config.')
@option('-D', '--shard-dur', 'shard_dur_filter', multiple=True, help='Only consider gaps in this shard duration (e.g. `1d`, `32d`). Repeatable.')
@option('-M', '--merged-ladder', 'merged_ladder', is_flag=True, help='Merge each tier\'s `lambda_shards` extension rungs into its `shards` ladder (the Lambda-executor / GC view).')
@option('-r', '--range', 'range_', required=True, help='UTC range `YYYY-MM-DD/YYYY-MM-DD` (half-open).')
@option('-T', '--tier', 'tier_filter', multiple=True, help='Only consider gaps in this tier (e.g. `1m`, `3d`). Repeatable.')
def pyramid_cascade_cmd(
    config_path: str,
    stale_before: str | None,
    shard_dur_filter: tuple[str, ...],
    merged_ladder: bool,
    range_: str,
    tier_filter: tuple[str, ...],
):
    from .fsck import discover_gaps, report_gaps

    stale_before_dt = None
    if stale_before is not None:
        stale_before_dt = datetime.fromisoformat(stale_before.replace('Z', '+00:00'))
        if stale_before_dt.tzinfo is None:
            stale_before_dt = stale_before_dt.replace(tzinfo=timezone.utc)
    config_yaml = Path(config_path).read_text()
    if merged_ladder:
        from .lambda_exec import merge_lambda_shards
        config_yaml = merge_lambda_shards(config_yaml)
    cfg = parse_pyramid_yaml(config_yaml)
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    range_tuple = _parse_range(range_)

    err(f"pyramid-cascade --fsck")
    err(f"  config:    {config_path}" + (" (merged ladder)" if merged_ladder else ""))
    err(f"  range:     {range_tuple[0].isoformat()} → {range_tuple[1].isoformat()}")
    err(f"  tiers:     {len(pyramid.tiers)}: {[t.name for t in pyramid.tiers]}")
    if stale_before_dt is not None:
        err(f"  stale-before: {stale_before_dt.isoformat()} (older shards reported as missing)")
    missing, _existing, _expected = discover_gaps(
        pyramid, range_tuple, stale_before=stale_before_dt,
    )
    if tier_filter or shard_dur_filter:
        tf = set(tier_filter)
        sf = set(shard_dur_filter)
        before = len(missing)
        missing = [g for g in missing
                   if (not tf or g.tier in tf)
                   and (not sf or g.shard_dur in sf)]
        err(f"  filtered:  {before} → {len(missing)} gaps after --tier/--shard-dur")
    report_gaps(missing)
