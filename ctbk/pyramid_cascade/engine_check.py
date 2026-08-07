"""pyrmts-engine validation driver (`specs/pyrmts-engine-validation.md`)
— comparison harness moved upstream to `pyrmts_engine.validate`
(ops-adoption phase 3: pyrmts `specs/pyrmts-ops-adoption.md`). ctbk
residue: config/scratch-prefix plumbing (two pyramids share one
`S3Storage`; the target rewrites the key prefix so engine output can
never touch serving keys), the avail genesis, and the `run_build`
dial defaults.
"""
from __future__ import annotations

import re
import resource
import sys
from datetime import datetime, timezone
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
    """The keyTemplate's full literal head before `/{tier}` — single
    segment for avail (`avail-v4`), multi-segment for rides
    (`rides-v5/start`)."""
    cfg = parse_pyramid_yaml(config_yaml)
    head, sep, _ = cfg.keyTemplate.partition('/{tier}')
    if not sep or '{' in head:
        raise ValueError(f"keyTemplate {cfg.keyTemplate!r} has no literal head before '/{{tier}}'")
    return head


def merged_yaml(config_name: str) -> str:
    """Full-ladder config YAML (`lambda_shards` merged — the fan-out
    build materialized extension rungs too)."""
    return merge_lambda_shards((CONFIG_DIR / f'{config_name}.yaml').read_text())


def scratch_yaml(config_name: str, scratch_prefix: str) -> str:
    """Merged-ladder YAML re-keyed under `scratch_prefix` — the config a
    scratch build (local `run_build` or a Batch submit) consumes. Refuses
    the real prefix so a scratch config can never point at serving keys.

    The whole literal head before `/{tier}` is replaced (may be
    multi-segment — `rides-v5/start`), and the replacement is verified to
    have happened: a silent no-op here would point a "scratch" build at
    serving keys."""
    merged = merged_yaml(config_name)
    head = config_prefix(merged)
    if scratch_prefix == head:
        raise ValueError(f"scratch prefix {scratch_prefix!r} is the real serving prefix — refusing")
    out = merged.replace(f'{head}/{{tier}}', f'{scratch_prefix}/{{tier}}')
    if out == merged:
        raise ValueError(f"scratch re-key of {head!r} did not change the config — refusing")
    return out


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


def _rides_anchor(config_name: str) -> str | None:
    """`rides-v5-start` → 'start', `rides-v5-end` → 'end'; None for
    avail configs (`specs/rides-v5.md`)."""
    m = re.fullmatch(r'rides-v5-(start|end)', config_name)
    return m.group(1) if m else None


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
    rides_anchor = _rides_anchor(config_name)
    if raw and rides_anchor:
        from .rides_assets import rides_source_kwargs
        from .rides_source import MonthlyRidesSource
        source = MonthlyRidesSource(src, rides_anchor, **rides_source_kwargs())
        sort = ['cell', 'dt', 'gender', 'user_type', 'bike_type']
    elif raw:
        from .lambda_exec import _chains, parse_chains_mode, set_chains_mode
        from .lite import r2_client
        from .raw_source import DailyStatusSource
        set_chains_mode(parse_chains_mode(merged_yaml(config_name)))
        source = DailyStatusSource(src, _chains(r2_client()))
        sort = ['s2_cell', 'dt']
    else:
        source = WideShardSource(src, tier_name=source_tier, shard_dur=source_shard)
        sort = ['s2_cell', 'dt']
    rg_sizes = parse_rg_sizes((CONFIG_DIR / f'{config_name}.yaml').read_text())
    result = build_local(
        tgt,
        time_range,
        source,
        pyramid_name=scratch_prefix,
        shard_index=JsonlShardIndex(manifest),
        window=window,
        sort=sort,
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


def rides_compare_month(
    config_name: str,
    ym: str,
    *,
    scratch_prefix: str | None = None,
) -> dict[str, object]:
    """`specs/rides-v5.md` acceptance #1: v5 `s:<short_name>` rows must
    equal rides-v3's LUC-cell rows for the same month, joined via the
    station registry's short_name ↔ LUC-cell map. Reads the v5 build's
    1h tier from `scratch_prefix` (or the real prefix when None) and the
    v3 month shard `rides-v3/<anchor>/1h/<YYYY-MM>.parquet`.

    Dim normalization: v3's pandas builder stringified null dims to
    'nan' (`astype(str)`); v5 uses 'unknown'. Normalized before compare.
    """
    import json
    from io import BytesIO

    import polars as pl

    from .lite import r2_client
    from .rides_assets import STATION_LUC_PATH

    anchor = _rides_anchor(config_name)
    if not anchor:
        raise ValueError(f'not a rides config: {config_name!r}')
    src, tgt = (
        load_pyramids(config_name, scratch_prefix)
        if scratch_prefix else (load_pyramid(config_name),) * 2
    )
    start = datetime.strptime(ym, '%Y%m').replace(tzinfo=timezone.utc)
    end = start.replace(year=start.year + (start.month == 12), month=start.month % 12 + 1)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    # v5 1h rows for the month: LIST the scratch 1h tier, read shards
    # whose period could intersect, filter dt to the month.
    storage = tgt.storage
    head = tgt.keyTemplate.partition('/{tier}')[0]
    keys = [k for k in storage.list(f'{head}/1h/')]
    frames = []
    for k in keys:
        blob = storage.get(k)
        df = pl.read_parquet(BytesIO(blob))
        frames.append(df.filter((pl.col('dt') >= start_ms) & (pl.col('dt') < end_ms)))
    v5 = pl.concat(frames)
    v5s = (
        v5.filter(pl.col('cell').str.starts_with('s:'))
        .with_columns(pl.col('cell').str.strip_prefix('s:').alias('short_name'))
    )

    luc = json.loads(STATION_LUC_PATH.read_text())
    sn_to_cell = {sn: e['cell'] for sn, e in luc['by_short_name'].items()}
    luc_cells = frozenset(sn_to_cell.values())

    cli = r2_client()
    v3_key = f'rides-v3/{anchor}/1h/{ym[:4]}-{ym[4:6]}.parquet'
    obj = cli.get_object(Bucket='ctbk', Key=v3_key)
    v3 = pl.read_parquet(BytesIO(obj['Body'].read()))
    cell_col = f'{anchor}_s2_cell'
    v3l = v3.filter(pl.col(cell_col).is_in(list(luc_cells)))

    monoids = ['count_n', 'count_sum', 'count_sumsq', 'duration_n', 'duration_sum', 'duration_sumsq']
    dims = ['gender', 'user_type', 'bike_type']

    def norm(df: pl.DataFrame, cell: str) -> pl.DataFrame:
        return (
            df
            .with_columns([
                pl.col(d).replace({'nan': 'unknown', 'None': 'unknown'}) for d in dims
            ])
            .group_by([cell, 'dt', *dims])
            .agg([pl.col(m).sum() for m in monoids])
            .sort([cell, 'dt', *dims])
            .rename({cell: 'cell'})
            .with_columns([pl.col(m).cast(pl.Float64) for m in monoids])
        )

    a = norm(
        v5s.with_columns(pl.col('short_name').replace_strict(sn_to_cell, default=None).alias('luc'))
           .drop('cell', 'short_name'),
        'luc',
    )
    b = norm(v3l, cell_col)
    eq = a.equals(b)
    out = {
        'month': ym,
        'anchor': anchor,
        'v5_rows': a.height,
        'v3_rows': b.height,
        'v5_rides': float(a['count_n'].sum()),
        'v3_rides': float(b['count_n'].sum()),
        'equal': eq,
    }
    if not eq and a.height and b.height:
        d = a.join(b, on=['cell', 'dt', *dims], how='full', suffix='_v3')
        mism = d.filter(
            pl.any_horizontal([
                (pl.col(m) != pl.col(f'{m}_v3')).fill_null(True) for m in monoids
            ])
        )
        out['mismatched_rows'] = mism.height
        out['sample'] = mism.head(5).to_dicts()
    return out
