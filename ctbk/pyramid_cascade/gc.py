"""Pyramid GC — thin wrapper over `pyrmts_ops.gc_sweep` (moved upstream,
ops-adoption phase 3: pyrmts `specs/pyrmts-ops-adoption.md`). ctbk residue:
the merged-ladder pyramid construction, the `gbfs/` raw-WAL prefix, the
avail genesis, and D1 database-id defaulting via `.d1_http`.

`pyramid_name` is required (no `'avail'` default): the expected cover MUST
match the registry rows being swept, or the sweep deletes the *other*
pyramid's rows as "not in cover" — the 2026-07-28 cross-pyramid deletion
bug.
"""
from __future__ import annotations

from datetime import datetime

from pyrmts import merge_lambda_shards, parse_pyramid_yaml, pyramid_from_config
from pyrmts_ops import gc_sweep as _gc_sweep
from pyrmts_ops.gc import D1GcRegistry, GcReport  # noqa: F401  (re-export)

from .d1_http import _db
from .lite import AVAIL_GENESIS

RAW_PREFIX = 'gbfs/'   # raw WAL + friends: never GC-eligible (rebuild backstop)


def gc_sweep(
    config_yaml: str,
    *,
    pyramid_name: str,
    now: datetime | None = None,
    dry_run: bool = False,
    max_deletes: int | None = 5000,
) -> GcReport:
    from .storage import storage_from_cfg

    cfg = merge_lambda_shards(parse_pyramid_yaml(config_yaml))
    pyramid = pyramid_from_config(cfg, storage_from_cfg(cfg.storage))
    return _gc_sweep(
        pyramid,
        genesis=AVAIL_GENESIS,
        registry=D1GcRegistry(database_id=_db(None)),
        pyramid_name=pyramid_name,
        raw_prefixes=(RAW_PREFIX,),
        now=now,
        dry_run=dry_run,
        max_deletes=max_deletes,
    )
