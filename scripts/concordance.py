#!/usr/bin/env python3
"""Concordance check across two pyramid-cascade output prefixes.

Compares a single `(tier, period)` shard between two R2 prefixes:

  - Equal-shard tiers (1h, 2h, 3h, 1d in our case): each prefix has
    one file for the period, so we read both, compare row count + per-
    (cell, dt) histogram equality.
  - Cross-format tiers: enumerate which files in EACH prefix cover the
    requested period, read+union them, then compare. (Not implemented
    yet — pass `--logical` to enable; for now: keep it equal-shard only.)

Reports any (cell, dt) where the histograms disagree, with the metric
that differs and the per-state count diff.

Example:
  scripts/concordance.py \\
    -a avail-v3 \\
    -b avail-v3-test \\
    -t 1h \\
    -p 2026-05
"""
from __future__ import annotations

import io
import json
import sys
from collections import defaultdict

import polars as pl
import pyarrow.parquet as pq
from click import command, option

from ctbk.avail_v3 import AVAIL_METRICS, R2_BUCKET, r2_client


def _read_shard(cli, prefix: str, tier: str, period: str) -> pl.DataFrame | None:
    """Read `<prefix>/<tier>/<period>.parquet` from R2 into a Polars DF."""
    key = f"{prefix}/{tier}/{period}.parquet"
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    except cli.exceptions.NoSuchKey:
        return None
    tab = pq.read_table(io.BytesIO(obj['Body'].read()))
    return pl.from_arrow(tab)


def _hist_dict(s: str | None) -> dict[int, int]:
    """Parse a `{state:count,...}` JSON string into an int-keyed dict.
    Returns {} for None or empty input."""
    if not s:
        return {}
    return {int(k): int(v) for k, v in json.loads(s).items()}


@command()
@option('-a', '--prefix-a', default='avail-v3', show_default=True, help='Baseline prefix (default: existing prior-layout shards).')
@option('-b', '--prefix-b', default='avail-v3-test', show_default=True, help='Comparison prefix (default: today\'s pyramid-cascade run).')
@option('-l', '--limit', type=int, default=20, show_default=True, help='Max disagreement rows to print before truncating.')
@option('-p', '--period', required=True, help='Period label, e.g. `2026-05`, `2026-05-13`, `2026`, `all`.')
@option('-t', '--tier', required=True, help='Tier name, e.g. `1h`, `2h`, `1d`.')
def main(prefix_a: str, prefix_b: str, limit: int, period: str, tier: str):
    cli = r2_client()
    print(f"a: {prefix_a}/{tier}/{period}.parquet")
    print(f"b: {prefix_b}/{tier}/{period}.parquet")

    a = _read_shard(cli, prefix_a, tier, period)
    b = _read_shard(cli, prefix_b, tier, period)

    if a is None:
        print(f"  a: MISSING", file=sys.stderr)
        sys.exit(2)
    if b is None:
        print(f"  b: MISSING", file=sys.stderr)
        sys.exit(2)

    print(f"  a: {a.shape[0]:>10,} rows  {a.columns}")
    print(f"  b: {b.shape[0]:>10,} rows  {b.columns}")

    # Sort both by (s2_cell, dt) — wide schema.
    sort_cols = [c for c in ('s2_cell', 'dt') if c in a.columns and c in b.columns]
    if not sort_cols:
        print(f"  ! no common sort key; a={a.columns} b={b.columns}", file=sys.stderr)
        sys.exit(2)
    a = a.sort(sort_cols)
    b = b.sort(sort_cols)

    # Index by (cell, dt) → row dict (one (cell, dt) per row in wide).
    a_idx = {(r['s2_cell'], r['dt']): r for r in a.iter_rows(named=True)}
    b_idx = {(r['s2_cell'], r['dt']): r for r in b.iter_rows(named=True)}

    only_a = set(a_idx) - set(b_idx)
    only_b = set(b_idx) - set(a_idx)
    both = set(a_idx) & set(b_idx)

    print(f"  (cell, dt) pairs: a={len(a_idx)}  b={len(b_idx)}  both={len(both)}  only_a={len(only_a)}  only_b={len(only_b)}")

    if only_a:
        print(f"  first only_a (up to 3): {sorted(only_a)[:3]}")
    if only_b:
        print(f"  first only_b (up to 3): {sorted(only_b)[:3]}")

    # Per-metric histogram comparison on the intersection.
    metric_disagreements: dict[str, int] = defaultdict(int)
    metric_total_diff: dict[str, int] = defaultdict(int)
    disagreement_samples: list[tuple] = []
    for key in sorted(both):
        ra, rb = a_idx[key], b_idx[key]
        for m in AVAIL_METRICS:
            if m not in ra or m not in rb:
                continue
            ha, hb = _hist_dict(ra[m]), _hist_dict(rb[m])
            if ha != hb:
                metric_disagreements[m] += 1
                # quantify diff
                states = set(ha) | set(hb)
                diff = sum(abs(ha.get(s, 0) - hb.get(s, 0)) for s in states)
                metric_total_diff[m] += diff
                if len(disagreement_samples) < limit:
                    disagreement_samples.append((key[0], key[1], m, ha, hb))

    print()
    print(f"=== Per-metric histogram disagreements (over {len(both)} cells × {len(AVAIL_METRICS)} metrics) ===")
    any_diff = False
    for m in AVAIL_METRICS:
        n = metric_disagreements[m]
        tot = metric_total_diff[m]
        marker = '✓' if n == 0 else '!'
        print(f"  {marker} {m:8s}: {n:>8} rows disagree   sum|Δcounts|={tot:>10}")
        if n > 0:
            any_diff = True

    if disagreement_samples:
        print()
        print(f"=== First {len(disagreement_samples)} disagreement samples ===")
        for cell, dt, m, ha, hb in disagreement_samples:
            print(f"  {cell:10s} dt={dt} {m}: a={ha} b={hb}")

    sys.exit(1 if any_diff or only_a or only_b else 0)


if __name__ == '__main__':
    main()
