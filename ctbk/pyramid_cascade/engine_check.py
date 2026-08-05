"""pyrmts-engine validation driver (`specs/pyrmts-engine-validation.md`)
— comparison harness moved upstream to `pyrmts_engine.validate`
(ops-adoption phase 3: pyrmts `specs/pyrmts-ops-adoption.md`). ctbk
residue: config/scratch-prefix plumbing (two pyramids share one
`S3Storage`; the target rewrites the key prefix so engine output can
never touch serving keys), the avail genesis, and the `run_build`
dial defaults.
"""
from __future__ import annotations

import resource
import sys
from datetime import datetime
from functools import partial
from pathlib import Path

from pyrmts import parse_pyramid_yaml, pyramid_from_config
from pyrmts_engine.validate import (  # noqa: F401  (re-exports)
    canonical_long,
    compare_streaming as _compare_streaming,
    covering_shard,
)
from pyrmts_engine.validate import aligned_range as _aligned_range
from pyrmts_engine.validate import compare_manifest

from .lambda_exec import merge_lambda_shards
from .lite import AVAIL_GENESIS
from .storage import storage_from_cfg

err = partial(print, file=sys.stderr)

CONFIG_DIR = Path(__file__).parents[2] / 'configs' / 'pyramids'
DEFAULT_MANIFEST = 'tmp/engine-check-manifest.jsonl'


def config_prefix(config_yaml: str) -> str:
    """The keyTemplate's leading path segment (e.g. `avail-v4`)."""
    cfg = parse_pyramid_yaml(config_yaml)
    prefix, _, _ = cfg.keyTemplate.partition('/')
    if '{' in prefix:
        raise ValueError(f"keyTemplate {cfg.keyTemplate!r} has no literal leading prefix")
    return prefix


def merged_yaml(config_name: str) -> str:
    """Full-ladder config YAML (`lambda_shards` merged — the fan-out
    build materialized extension rungs too)."""
    return merge_lambda_shards((CONFIG_DIR / f'{config_name}.yaml').read_text())


def scratch_yaml(config_name: str, scratch_prefix: str) -> str:
    """Merged-ladder YAML re-keyed under `scratch_prefix` — the config a
    scratch build (local `run_build` or a Batch submit) consumes. Refuses
    the real prefix so a scratch config can never point at serving keys."""
    merged = merged_yaml(config_name)
    prefix = config_prefix(merged)
    if scratch_prefix == prefix:
        raise ValueError(f"scratch prefix {scratch_prefix!r} is the real serving prefix — refusing")
    return merged.replace(f'{prefix}/{{tier}}', f'{scratch_prefix}/{{tier}}')


def load_pyramid(config_name: str):
    """The full merged-ladder pyramid at its real serving prefix."""
    cfg = parse_pyramid_yaml(merged_yaml(config_name))
    return pyramid_from_config(cfg, storage_from_cfg(cfg.storage))


def load_pyramids(config_name: str, scratch_prefix: str):
    """(source_pyramid, target_pyramid): full merged ladder, same
    storage, target keyed under `scratch_prefix`."""
    cfg = parse_pyramid_yaml(merged_yaml(config_name))
    storage = storage_from_cfg(cfg.storage)
    src = pyramid_from_config(cfg, storage)
    scratch_cfg = parse_pyramid_yaml(scratch_yaml(config_name, scratch_prefix))
    tgt = pyramid_from_config(scratch_cfg, storage)
    return src, tgt


def aligned_range(dur: str, n: int, genesis: datetime = AVAIL_GENESIS) -> tuple[datetime, datetime]:
    return _aligned_range(dur, n, genesis)


def run_build(
    config_name: str,
    time_range: tuple[datetime, datetime],
    *,
    scratch_prefix: str,
    manifest: str,
    source_tier: str = '1m',
    source_shard: str = '2d',
    raw: bool = False,
    window: str = '12h',
    verbose: bool = False,
):
    from pyrmts_engine import JsonlShardIndex, WideShardSource, build_local
    from .config import parse_rg_sizes
    src, tgt = load_pyramids(config_name, scratch_prefix)
    if raw:
        from .lambda_exec import _chains, parse_chains_mode, set_chains_mode
        from .lite import r2_client
        from .raw_source import DailyStatusSource
        set_chains_mode(parse_chains_mode(merged_yaml(config_name)))
        source = DailyStatusSource(src, _chains(r2_client()))
    else:
        source = WideShardSource(src, tier_name=source_tier, shard_dur=source_shard)
    rg_sizes = parse_rg_sizes((CONFIG_DIR / f'{config_name}.yaml').read_text())
    result = build_local(
        tgt,
        time_range,
        source,
        pyramid_name=scratch_prefix,
        shard_index=JsonlShardIndex(manifest),
        window=window,
        sort=['s2_cell', 'dt'],
        row_group_size=rg_sizes,
        spill_dir='tmp/engine-spill',
        verbose=verbose,
    )
    rss_gb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9
    err(f"peak RSS: {rss_gb:.2f} GB")
    return result


def compare_shards(
    config_name: str,
    *,
    scratch_prefix: str,
    manifest: str,
    limit: int | None = None,
    detail: bool = False,
) -> dict[str, list[str]]:
    """Manifest-driven scratch-vs-fan-out compare — see
    `pyrmts_engine.validate.compare_manifest` (the scratch→real key
    mapping is the `key_map`)."""
    src, tgt = load_pyramids(config_name, scratch_prefix)
    prefix = config_prefix(merged_yaml(config_name))
    return compare_manifest(
        manifest, tgt, src,
        key_map=lambda k: k.replace(f'{scratch_prefix}/', f'{prefix}/', 1),
        limit=limit,
        detail=detail,
    )
