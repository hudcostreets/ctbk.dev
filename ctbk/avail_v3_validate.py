"""Cross-check avail-v3 (S2) against avail-v2 (H3) for the same window.

Invariant: for each `(dt, metric)`, the sum of histogram values across
**all cells at any one level** must be identical between v2 and v3,
because:

  - Both pyramids see the same per-station, per-minute WAL observations.
  - Each observation is bucketed into exactly one cell at each
    materialized level (regardless of spatial-index family).
  - Histogram values are observation counts, which sum-conserve under
    cell-shape changes.

So `sum(v2_1h_shard.histograms at any level)` per `(dt, metric)` must
equal `sum(v3_1h_shard.histograms at any level)` per `(dt, metric)`.

Usage:
  ctbk avail-v3-parity-check --period 2026-05            # default tier=1h
  ctbk avail-v3-parity-check -p 2026-05 -t 30m -t 1h     # multiple tiers
  ctbk avail-v3-parity-check -p 2026-05 --tier 1h -v     # verbose

Exits non-zero if any mismatch found; prints per-(dt, metric) diffs.
"""
from __future__ import annotations

import io
import json
from collections import defaultdict
from datetime import datetime, timezone

import h3
import pyarrow.parquet as pq
import s2cell
from botocore.exceptions import ClientError
from click import option
from utz import err

from ctbk.avail_v2 import R2_BUCKET, r2_client
from ctbk.cli.base import ctbk


def _read_r2_parquet(cli, key: str):
    """Fetch one parquet from R2 → pyarrow Table. None on 404."""
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        raise
    return pq.read_table(io.BytesIO(obj['Body'].read()))


def cell_level_h3(cell: str) -> int:
    return h3.get_resolution(cell)


def cell_level_s2(cell: str) -> int:
    return s2cell.token_to_level(cell)


def shard_path(prefix: str, tier: str, period: str) -> str:
    return f'{prefix}/{tier}/{period}.parquet'


def collect_totals(
    tab,
    cell_col: str,
    cell_level_fn,
    metrics: tuple[str, ...],
    level_filter: int | None = None,
) -> dict[tuple[int, str, str], int]:
    """Sum histogram values across all rows.

    Returns: `(dt, metric, state_str) → total_count`. If `level_filter`
    is given, only rows at that cell level contribute (use this to
    isolate one materialized resolution).
    """
    out: dict[tuple[int, str, str], int] = defaultdict(int)
    cells = tab[cell_col].to_pylist()
    dts = tab['dt'].to_pylist()
    metric_cols = {m: tab[m].to_pylist() for m in metrics}
    for i, cell in enumerate(cells):
        if level_filter is not None and cell_level_fn(cell) != level_filter:
            continue
        dt = dts[i]
        for m in metrics:
            js = metric_cols[m][i]
            if js is None:
                continue
            for state, count in json.loads(js).items():
                out[(dt, m, state)] += count
    return out


AVAIL_METRICS = ('bikes', 'ebikes', 'docks', 'disabled', 'pending')


def compare_one_tier(
    v2_tab,
    v3_tab,
    verbose: bool,
) -> tuple[int, int]:
    """Per-(dt, metric, state) totals must match between v2 and v3 when
    isolated to one materialized level on each side. Compare at v2's
    finest level (H3 r9) vs v3's finest level (S2 L15) — both are
    "~1 station/cell" and span the same observation set.

    Returns (n_keys_checked, n_mismatch).
    """
    v2_totals = collect_totals(v2_tab, 'h3_cell', cell_level_h3, AVAIL_METRICS, level_filter=9)
    v3_totals = collect_totals(v3_tab, 's2_cell', cell_level_s2, AVAIL_METRICS, level_filter=15)

    all_keys = sorted(set(v2_totals) | set(v3_totals))
    n_mismatch = 0
    for k in all_keys:
        v2_v = v2_totals.get(k, 0)
        v3_v = v3_totals.get(k, 0)
        if v2_v != v3_v:
            n_mismatch += 1
            if verbose:
                dt, metric, state = k
                err(f"  MISMATCH dt={dt} metric={metric} state={state}: v2={v2_v} v3={v3_v}")
    return (len(all_keys), n_mismatch)


@ctbk.command('avail-v3-parity-check',
              help="Verify avail-v3 (S2) histograms sum-conserve vs avail-v2 (H3) for matching shards.")
@option('-p', '--period', required=True, help="Shard period (e.g. '2026-05' for 1h tier).")
@option('-t', '--tier', 'tiers', multiple=True, default=('1h',),
        help="Tier(s) to check (default 1h). Repeatable.")
@option('-v', '--verbose', is_flag=True, help="Print per-key mismatches.")
def avail_v3_parity_check_cmd(period: str, tiers: tuple[str, ...], verbose: bool):
    cli = r2_client()
    total_checked = 0
    total_mismatch = 0
    for tier in tiers:
        v2_key = shard_path('avail-v2', tier, period)
        v3_key = shard_path('avail-v3', tier, period)
        err(f"comparing {v2_key} vs {v3_key}")
        v2_tab = _read_r2_parquet(cli, v2_key)
        v3_tab = _read_r2_parquet(cli, v3_key)
        if v2_tab is None:
            err(f"  SKIP: v2 shard not found ({v2_key})")
            continue
        if v3_tab is None:
            err(f"  SKIP: v3 shard not found ({v3_key})")
            continue
        n_keys, n_mis = compare_one_tier(v2_tab, v3_tab, verbose)
        err(f"  tier={tier}: {n_keys} (dt, metric, state) keys checked, {n_mis} mismatch")
        total_checked += n_keys
        total_mismatch += n_mis

    err(f"done: {total_checked} keys total, {total_mismatch} mismatch")
    if total_mismatch > 0:
        raise SystemExit(1)
