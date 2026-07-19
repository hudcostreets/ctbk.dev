"""pyrmts-engine validation driver (`specs/pyrmts-engine-validation.md`).

Rebuilds the avail pyramid with `pyrmts_engine.build_local` into a
scratch R2 prefix (`avail-v4-engine-check/` by default), sourcing the
already-materialized `/1m` rung via `WideShardSource`, then compares
every written shard against the Lambda fan-out build's shard at the
same key suffix — parsed-content equality (`wide_to_long` + sort), not
byte equality (hist-JSON key order and parquet row-group sizing differ
across writers).

Two pyramids share one `S3Storage`: the SOURCE pyramid keeps the real
config keyTemplate (reads `/1m` shards in place), the TARGET pyramid
rewrites the key prefix so engine output can never touch serving keys.
Registration goes to a local JSONL manifest — D1 is never involved.
"""
from __future__ import annotations

import resource
import sys
from datetime import datetime, timezone
from functools import partial
from io import BytesIO
from pathlib import Path

from pyrmts import parse_pyramid_yaml, pyramid_from_config, shard_periods_covering

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
        raise ValueError(f"keyTemplate {key!r} has no literal leading prefix")
    return prefix


def load_pyramids(config_name: str, scratch_prefix: str):
    """(source_pyramid, target_pyramid): full ladder (`lambda_shards`
    merged — the fan-out build materialized extension rungs too), same
    storage, target keyed under `scratch_prefix`."""
    config_yaml = (CONFIG_DIR / f'{config_name}.yaml').read_text()
    merged = merge_lambda_shards(config_yaml)
    prefix = config_prefix(merged)
    cfg = parse_pyramid_yaml(merged)
    storage = storage_from_cfg(cfg.storage)
    src = pyramid_from_config(cfg, storage)
    scratch_cfg = parse_pyramid_yaml(
        merged.replace(f'{prefix}/{{tier}}', f'{scratch_prefix}/{{tier}}'))
    tgt = pyramid_from_config(scratch_cfg, storage)
    return src, tgt


def aligned_range(
    dur: str,
    n: int,
    genesis: datetime = AVAIL_GENESIS,
) -> tuple[datetime, datetime]:
    """First `dur`-aligned boundary ≥ `genesis`, spanning `n` periods —
    a fully-aligned interior range (no genesis clip), so smoke-run
    shards are directly comparable to the full build's tiles."""
    periods = shard_periods_covering(genesis, datetime.now(timezone.utc), dur)
    if periods[0].start < genesis:
        periods = periods[1:]
    if len(periods) < n:
        raise ValueError(f"only {len(periods)} full {dur} periods since genesis; wanted {n}")
    return periods[0].start, periods[n - 1].end


def run_build(
    config_name: str,
    time_range: tuple[datetime, datetime],
    *,
    scratch_prefix: str,
    manifest: str,
    source_tier: str = '1m',
    source_shard: str = '2d',
    window: str = '12h',
    verbose: bool = False,
):
    from pyrmts_engine import JsonlShardIndex, WideShardSource, build_local
    src, tgt = load_pyramids(config_name, scratch_prefix)
    source = WideShardSource(src, tier_name=source_tier, shard_dur=source_shard)
    result = build_local(
        tgt,
        time_range,
        source,
        pyramid_name=scratch_prefix,
        shard_index=JsonlShardIndex(manifest),
        window=window,
        sort=['s2_cell', 'dt'],
        verbose=verbose,
    )
    rss_gb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9
    err(f"peak RSS: {rss_gb:.2f} GB")
    return result


def canonical_long(blob: bytes, pyramid):
    """Parse a wide shard to sorted long form — the comparison basis.
    Hist-JSON string bytes differ across writers (key order); parsed
    (dims, dt, metric, state, count) rows must not."""
    import polars as pl
    import pyarrow.parquet as pq
    from pyrmts_engine import wide_to_long
    wide = pl.from_arrow(pq.read_table(BytesIO(blob)))
    return wide_to_long(wide, pyramid).sort(by=pl.all())


def _covering_real_shard(src, tier: str, shard_dur: str, start_ms: int, end_ms: int):
    """(key, blob) of a coarser-rung fan-out shard at `tier` whose period
    contains [start_ms, end_ms) — shard content is per-bin, so its rows
    restricted to that window must equal the engine shard's exactly."""
    from datetime import datetime, timezone
    from pyrmts import substitute_key
    tier_obj = src.tier(tier)
    start = datetime.fromtimestamp(start_ms / 1000, timezone.utc)
    end = datetime.fromtimestamp(end_ms / 1000, timezone.utc)
    durs = [d for d in tier_obj.shards if d != shard_dur]
    for dur in durs:
        periods = shard_periods_covering(start, end, dur)
        if len(periods) != 1:
            continue
        key = substitute_key(
            src.keyTemplate,
            {'tier': tier, 'shard': dur, 'period': periods[0].label},
        )
        blob = src.storage.get(key)
        if blob is not None:
            return key, blob
    return None, None


def compare_shards(
    config_name: str,
    *,
    scratch_prefix: str,
    manifest: str,
    limit: int | None = None,
    detail: bool = False,
) -> dict[str, list[str]]:
    """For every manifest key: fetch engine + fan-out shards, require
    canonical-long equality. When no fan-out shard exists at the exact
    key (short smoke ranges produce sub-tile covers), fall back to a
    coarser real shard covering the period, filtered to it. Buckets:
    equal / equal_via_cover / diff / missing / empty_both."""
    import json
    import polars as pl
    src, tgt = load_pyramids(config_name, scratch_prefix)
    storage = src.storage
    prefix = config_prefix(merge_lambda_shards((CONFIG_DIR / f'{config_name}.yaml').read_text()))
    entries = []
    seen = set()
    for line in Path(manifest).read_text().splitlines():
        rec = json.loads(line)
        if rec['key'] not in seen:
            seen.add(rec['key'])
            entries.append(rec)
    if limit is not None:
        entries = entries[:limit]
    buckets: dict[str, list[str]] = {
        'equal': [], 'equal_via_cover': [], 'diff': [], 'missing': [], 'empty_both': [],
    }
    for i, rec in enumerate(entries):
        key = rec['key']
        real_key = key.replace(f'{scratch_prefix}/', f'{prefix}/', 1)
        eng_blob = storage.get(key)
        real_blob = storage.get(real_key)
        if eng_blob is None:
            raise RuntimeError(f"manifest key missing from R2: {key}")
        via_cover = False
        if real_blob is None:
            real_key, real_blob = _covering_real_shard(
                src, rec['tier'], rec['shard_dur'], rec['period_start'], rec['period_end'])
            via_cover = real_blob is not None
        if real_blob is None:
            buckets['missing'].append(key)
            if detail:
                err(f"  MISSING {key} (no exact or covering fan-out shard)")
            continue
        eng = canonical_long(eng_blob, tgt)
        real = canonical_long(real_blob, src)
        if via_cover:
            bin_col = src.binCol
            real = real.filter(
                (pl.col(bin_col) >= rec['period_start']) & (pl.col(bin_col) < rec['period_end'])
            ).sort(by=pl.all())
        if eng.height == 0 and real.height == 0:
            buckets['empty_both'].append(real_key)
        elif eng.equals(real):
            buckets['equal_via_cover' if via_cover else 'equal'].append(real_key)
            if detail and via_cover:
                err(f"  EQUAL {key} vs {real_key} (filtered)")
        else:
            buckets['diff'].append(real_key)
            if detail:
                extra = eng.join(real, on=eng.columns, how='anti').height
                short = real.join(eng, on=eng.columns, how='anti').height
                err(f"  DIFF {key} vs {real_key}: engine {eng.height:,} vs real {real.height:,} rows; "
                    f"{extra:,} engine-only, {short:,} real-only")
        if (i + 1) % 25 == 0:
            err(f"  … {i + 1}/{len(entries)}: "
                + ', '.join(f'{k}={len(v)}' for k, v in buckets.items() if v))
    return buckets
