"""Fan-out bulk rebuilds — thin wrapper over `pyrmts_ops.run_rebuild`
(moved upstream, ops-adoption phase 3: pyrmts `specs/pyrmts-ops-adoption.md`;
originally `specs/done/avail-v3-lambda-rebuild.md`). ctbk residue: the
function names, the `gbfs/build-progress/` prefix, the avail genesis, and
the measured 2026-07 cost model (which upstream also carries as defaults).
"""
from __future__ import annotations

from datetime import datetime

from pyrmts import Pyramid
from pyrmts.types import Tier
from pyrmts_ops import FanoutConfig
from pyrmts_ops import run_rebuild as _run_rebuild
from pyrmts_ops.rebuild import expand_scaffolds as _expand_scaffolds
from pyrmts_ops.rebuild import fill_safe_rung as _fill_safe_rung

from .lite import AVAIL_GENESIS

REBUILD_FUNC = 'ctbk-avail-rebuild'
TICK_FUNC = 'ctbk-avail-cascade'
SOURCE_BIN_BUDGET = 720
PROGRESS_PREFIX = 'gbfs/build-progress/'


def _fanout_config(function_name: str = REBUILD_FUNC) -> FanoutConfig:
    return FanoutConfig(
        function_name=function_name,
        tick_function=TICK_FUNC,
        progress_prefix=PROGRESS_PREFIX,
        source_bin_budget=SOURCE_BIN_BUDGET,
    )


def fill_safe_rung(pyramid: Pyramid, tier: Tier) -> str:
    return _fill_safe_rung(pyramid, tier, source_bin_budget=SOURCE_BIN_BUDGET)


def expand_scaffolds(pyramid: Pyramid, layers: list) -> list:
    return _expand_scaffolds(
        pyramid, layers,
        genesis=AVAIL_GENESIS, source_bin_budget=SOURCE_BIN_BUDGET,
    )


def run_rebuild(
    config_yaml: str,
    *,
    stale_before: datetime | None = None,
    touch_tick: bool = False,
    concurrency: int = 16,
    function_name: str = REBUILD_FUNC,
    dry_run: bool = False,
    limit: int | None = None,
    keep_scaffolds: bool = False,
    config_name: str = 'avail',
    dot_path: str | None = None,
) -> dict[str, int]:
    from pyrmts import merge_lambda_shards, parse_pyramid_yaml, pyramid_from_config
    from .storage import storage_from_cfg

    cfg = merge_lambda_shards(parse_pyramid_yaml(config_yaml))
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    return _run_rebuild(
        pyramid,
        genesis=AVAIL_GENESIS,
        pyramid_name=config_name,
        cfg=_fanout_config(function_name),
        stale_before=stale_before,
        touch_tick=touch_tick,
        concurrency=concurrency,
        dry_run=dry_run,
        limit=limit,
        keep_scaffolds=keep_scaffolds,
        dot_path=dot_path,
    )
