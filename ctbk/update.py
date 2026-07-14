"""Full pipeline update for a given month.

Runs all stages in order: normalize → consolidate → meta-hists → aggregations →
station-modes → station-pair-jsons → station-urls JSON.

Equivalent to the old `update.sh`, but as a proper CLI command with DVC integration.
"""
from os.path import exists

from click import argument, option
from utz import err, run
from utz.cli import flag

from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd


@ctbk.command('update')
@git_dvc_cmd
@flag('-S', '--no-station-harmonize', help="Skip station-harmonize (requires all consolidated parquets)")
@flag('-W', '--no-www', help="Skip www asset updates (station-urls)")
@argument('ym')
def update(
    ym: str,
    dry_run: bool,
    no_station_harmonize: bool,
    no_www: bool,
) -> str | None:
    """Run full pipeline for a month: normalize through www asset generation."""
    def ctbk_run(*args):
        run('ctbk', *args, dry_run=dry_run)

    # Per-month pipeline stages
    err(f"=== Processing month {ym} ===")

    err(f"--- Normalize ---")
    ctbk_run('norm', 'create', ym)

    err(f"--- Consolidate ---")
    ctbk_run('cons', 'create', ym)

    err(f"--- Station meta-hists ---")
    ctbk_run('smh', 'create', '-gil', ym)
    ctbk_run('smh', 'create', '-gin', ym)

    if not no_station_harmonize:
        err(f"--- Station harmonize ---")
        ctbk_run('station-harmonize', 'create')

    err(f"--- Aggregations ---")
    ctbk_run('agg', 'create', '-ge', '-ac', ym)
    ctbk_run('agg', 'create', '-gse', '-ac', ym)
    ctbk_run('agg', 'create', '-g', 'ymrgtb', '-acd', ym)
    ctbk_run('agg', 'create', '-g', 'ymrgtbs', '-acd', ym)
    ctbk_run('agg', 'create', '-g', 'ymrgtbe', '-acd', ym)

    err(f"--- Station modes ---")
    ctbk_run('sm', 'create', ym)

    err(f"--- Station pair JSONs ---")
    ctbk_run('spj', 'create', ym)

    # Per-station monthly trips JSONs (og cards + StationDetail trips
    # panel read these via `ymdgtb-index.json`). Whole-artifact rebuild
    # from the ymrgtb{s,e} aggregates just produced above; without this
    # step the artifact silently freezes at its last manual build
    # (2026-04..07: stuck at 2026-03). Retires with rides-v3 LUC (#109).
    err(f"--- Station trips JSONs ---")
    ctbk_run('station-trips-json', '-a', '-d')

    # Rebuild rides pyramids (v1/v2/v3) that back /api/rides-{v1,v2,v3}.
    # Range = prev-month → current: rebuilding prev month's /1h start-anchored
    # shard picks up rides that started in prev but ended in current (dropped
    # previously because the current month's normalized parquet didn't exist).
    # Derived tiers span multi-month or all-time, so `-O` (overwrite) is
    # required to fold in the new /1h data.
    err(f"--- Rides pyramids (v1/v2/v3) ---")
    yyyy, mm = ym[:4], ym[4:]
    ym_new = f"{yyyy}-{mm}"
    if mm == '01':
        ym_prev = f"{int(yyyy) - 1}-12"
    else:
        ym_prev = f"{yyyy}-{int(mm) - 1:02d}"
    for v in ('v1', 'v2', 'v3'):
        ctbk_run('rides-v1-build', '-v', v, '-f', ym_prev, '-T', ym_new)
        for t in ('3h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo', '3mo', '1y'):
            ctbk_run('rides-v1-build', '-v', v, '-f', ym_prev, '-T', ym_new, '-t', t, '-O')

    if not no_www:
        err(f"--- WWW assets ---")
        run('node', 'www/scripts/gen-station-urls.js', dry_run=dry_run)

    return f'Process month {ym}'
