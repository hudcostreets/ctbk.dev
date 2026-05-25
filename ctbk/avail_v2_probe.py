"""Probe the v2 pyramid: per-tier shard counts, byte sizes, row counts.

Inspects `avail-v2/<tier>/...` on R2 directly (LIST + sample HEAD/GET).
Useful as a sanity check while the build is in flight, and for spotting
under-/over-sized tiers (a sign the bin/shard choice needs adjustment).

  ctbk avail-v2-probe                   # all tiers, default sample
  ctbk avail-v2-probe -t 1m -t 30m     # subset
  ctbk avail-v2-probe -s 3             # sample 3 shards per tier for row counts
"""
from __future__ import annotations

import io
from collections import defaultdict
from dataclasses import dataclass

import pyarrow.parquet as pq
from click import option
from utz import err

from ctbk.avail_v2 import DST_PREFIX, R2_BUCKET, TIER_SPECS, r2_client
from ctbk.cli.base import ctbk


@dataclass
class TierStats:
    tier: str
    n_shards: int
    total_bytes: int
    first_period: str | None
    last_period: str | None
    min_bytes: int | None
    max_bytes: int | None
    sample_row_counts: list[int]  # row counts of sampled shards


def list_tier_objects(cli, tier: str) -> list[dict]:
    """LIST all `avail-v2/<tier>/...` objects with their byte sizes."""
    objs: list[dict] = []
    paginator = cli.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=f'{DST_PREFIX}/{tier}/'):
        for obj in page.get('Contents', []) or []:
            objs.append({'key': obj['Key'], 'size': obj['Size']})
    return objs


def period_from_key(key: str, tier: str) -> str:
    """Strip `avail-v2/<tier>/` prefix and `.parquet` suffix → period string."""
    prefix = f'{DST_PREFIX}/{tier}/'
    if not key.startswith(prefix) or not key.endswith('.parquet'):
        return key
    return key[len(prefix):-len('.parquet')]


def sample_row_counts(cli, objs: list[dict], n_sample: int) -> list[int]:
    """GET up to n_sample shards (evenly spaced); return their row counts."""
    if not objs or n_sample <= 0:
        return []
    n = min(n_sample, len(objs))
    if n == 1:
        idxs = [len(objs) // 2]
    else:
        step = (len(objs) - 1) / (n - 1)
        idxs = sorted({int(round(i * step)) for i in range(n)})
    rows: list[int] = []
    for i in idxs:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=objs[i]['key'])
        tab = pq.read_table(io.BytesIO(obj['Body'].read()))
        rows.append(tab.num_rows)
    return rows


def stats_for_tier(cli, tier: str, n_sample: int) -> TierStats:
    objs = list_tier_objects(cli, tier)
    if not objs:
        return TierStats(tier, 0, 0, None, None, None, None, [])
    periods = sorted(period_from_key(o['key'], tier) for o in objs)
    sizes = [o['size'] for o in objs]
    rows = sample_row_counts(cli, objs, n_sample)
    return TierStats(
        tier=tier,
        n_shards=len(objs),
        total_bytes=sum(sizes),
        first_period=periods[0],
        last_period=periods[-1],
        min_bytes=min(sizes),
        max_bytes=max(sizes),
        sample_row_counts=rows,
    )


def human_bytes(n: int) -> str:
    for unit, lim in [('B', 1024), ('KB', 1024**2), ('MB', 1024**3), ('GB', 1024**4)]:
        if n < lim:
            return f'{n / (lim // 1024):.1f} {unit}'
    return f'{n / 1024**4:.1f} TB'


@ctbk.command('avail-v2-probe', help="Per-tier stats for avail-v2/ shards on R2.")
@option('-s', '--sample', 'n_sample', type=int, default=2,
        help="Shards per tier to sample for row counts (default 2; 0 to skip).")
@option('-t', '--tier', 'tiers', multiple=True,
        help="Restrict to these tier(s). Repeatable. Default: all tiers in TIER_SPECS.")
def avail_v2_probe_cmd(n_sample: int, tiers: tuple[str, ...]):
    cli = r2_client()
    tier_list = list(tiers) if tiers else list(TIER_SPECS)
    err(f"probing {len(tier_list)} tier(s)")

    # Header
    cols = ['tier', 'shards', 'first', 'last', 'total', 'min/max', 'rows (sample)']
    rows_out: list[list[str]] = []
    for tier in tier_list:
        s = stats_for_tier(cli, tier, n_sample)
        if s.n_shards == 0:
            rows_out.append([tier, '0', '-', '-', '-', '-', '-'])
            continue
        rng = f'{human_bytes(s.min_bytes)} / {human_bytes(s.max_bytes)}'
        rc = ', '.join(f'{r:,}' for r in s.sample_row_counts) if s.sample_row_counts else '-'
        rows_out.append([
            tier,
            f'{s.n_shards:,}',
            s.first_period or '-',
            s.last_period or '-',
            human_bytes(s.total_bytes),
            rng,
            rc,
        ])

    # Render simple aligned table to stdout
    widths = [max(len(r[i]) for r in [cols] + rows_out) for i in range(len(cols))]
    fmt = '  '.join(f'{{:<{w}}}' for w in widths)
    print(fmt.format(*cols))
    print(fmt.format(*['-' * w for w in widths]))
    for r in rows_out:
        print(fmt.format(*r))
