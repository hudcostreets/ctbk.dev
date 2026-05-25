"""Cross-check v2 1h-tier output against the PoC `avail-geo/h1` output.

Both produce the same logical thing — per `(h3_cell, hour)` cell, a
histogram per metric counting (station, minute) pairs in each state —
arrived at via different paths:
  - PoC h1: reads tall format `avail/agg/h1/<date>/<HH>.parquet` (rows
            of (dt, station_id, metric, state, minutes)), pivots into
            h3-cell-keyed wide-JSON.
  - v2 1h:  reads 1m@1m loader monoid shards, builds 1m tier h3-keyed,
            cascades through 30m → 1h via histogram-monoid combine.

If the histogram monoid is associative (which it is — sum of dicts) and
both pipelines see the same upstream WAL data, the per-cell histograms
must match exactly.

Usage:
  ctbk avail-v2-validate --dates 2026-05-22,2026-05-23
"""
from __future__ import annotations

import io
import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone

import pyarrow.parquet as pq
from botocore.exceptions import ClientError
from click import option
from utz import err

from ctbk.avail_v2 import (
    AVAIL_METRICS,
    DST_PREFIX,
    R2_BUCKET,
    r2_client,
)
from ctbk.cli.base import ctbk

POC_H1_PREFIX = 'avail-geo/h1'


def _read_r2_parquet(cli, key: str):
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        raise
    return pq.read_table(io.BytesIO(obj['Body'].read()))


def _to_keyed_histos(table) -> dict[tuple[str, int, str], dict[str, int]]:
    """Reshape a wide-JSON h3-keyed table → {(cell, dt_ms, metric): {state: count}}."""
    out: dict[tuple[str, int, str], dict[str, int]] = {}
    cells = table['h3_cell'].to_pylist()
    dts = table['dt'].to_pylist()
    cols = {m: table[m].to_pylist() for m in AVAIL_METRICS}
    for i in range(table.num_rows):
        cell = cells[i]
        dt = dts[i]
        for m in AVAIL_METRICS:
            js = cols[m][i]
            if js is None: continue
            d = json.loads(js)
            if not d: continue
            out[(cell, dt, m)] = {k: int(v) for k, v in d.items()}
    return out


def _v2_1h_shard_for_date(date_iso: str) -> str:
    """Period string for the v2 1h tier covering `date_iso`. 1h shards have shard=1mo."""
    d = datetime.fromisoformat(date_iso).replace(tzinfo=timezone.utc)
    return d.strftime('%Y-%m')


@dataclass
class DateValidationResult:
    date: str
    n_keys_poc: int
    n_keys_v2: int
    n_only_poc: int
    n_only_v2: int
    n_matching: int
    n_diff: int
    sample_diffs: list[str]


def validate_one_date(cli, date_iso: str) -> DateValidationResult:
    """Compare PoC h1 and v2 1h for one date."""
    poc_key = f'{POC_H1_PREFIX}/{date_iso}.parquet'
    poc = _read_r2_parquet(cli, poc_key)
    if poc is None:
        err(f"  {date_iso}: PoC h1 missing at {poc_key}")
        return DateValidationResult(date_iso, 0, 0, 0, 0, 0, 0, [])

    v2_period = _v2_1h_shard_for_date(date_iso)
    v2_key = f'{DST_PREFIX}/1h/{v2_period}.parquet'
    v2_full = _read_r2_parquet(cli, v2_key)
    if v2_full is None:
        err(f"  {date_iso}: v2 1h missing at {v2_key}")
        return DateValidationResult(date_iso, poc.num_rows, 0, 0, 0, 0, 0, [])

    # v2 1h is one month — filter to this date's hours.
    day_start = datetime.fromisoformat(date_iso).replace(tzinfo=timezone.utc)
    day_start_ms = int(day_start.timestamp()) * 1000
    day_end_ms = day_start_ms + 86400 * 1000
    import pyarrow.compute as pc
    v2_day = v2_full.filter(
        (pc.field('dt') >= day_start_ms) & (pc.field('dt') < day_end_ms)
    )

    poc_histos = _to_keyed_histos(poc)
    v2_histos  = _to_keyed_histos(v2_day)

    poc_keys = set(poc_histos)
    v2_keys = set(v2_histos)
    common = poc_keys & v2_keys
    only_poc = poc_keys - v2_keys
    only_v2  = v2_keys - poc_keys

    n_matching = 0
    n_diff = 0
    sample_diffs: list[str] = []
    for k in common:
        if poc_histos[k] == v2_histos[k]:
            n_matching += 1
        else:
            n_diff += 1
            if len(sample_diffs) < 5:
                a, b = poc_histos[k], v2_histos[k]
                # Show the symmetric diff
                diff_keys = sorted({*a, *b}, key=lambda s: int(s))
                deltas = {s: (a.get(s, 0), b.get(s, 0)) for s in diff_keys if a.get(s, 0) != b.get(s, 0)}
                sample_diffs.append(f"{k}: deltas (poc, v2) = {deltas}")

    return DateValidationResult(
        date=date_iso,
        n_keys_poc=len(poc_keys),
        n_keys_v2=len(v2_keys),
        n_only_poc=len(only_poc),
        n_only_v2=len(only_v2),
        n_matching=n_matching,
        n_diff=n_diff,
        sample_diffs=sample_diffs,
    )


@ctbk.command('avail-v2-validate', help="Cross-check v2 1h tier against PoC avail-geo/h1.")
@option('-d', '--dates', required=True, help="Comma-separated YYYY-MM-DD list to validate.")
def avail_v2_validate_cmd(dates: str):
    cli = r2_client()
    date_list = [d.strip() for d in dates.split(',') if d.strip()]
    err(f"validating {len(date_list)} date(s) — PoC avail-geo/h1 vs v2 avail-v2/1h")

    cols = ['date', 'poc_keys', 'v2_keys', 'only_poc', 'only_v2', 'match', 'diff']
    rows: list[list[str]] = []
    total_diffs: list[str] = []
    for d in date_list:
        r = validate_one_date(cli, d)
        rows.append([
            r.date,
            f'{r.n_keys_poc:,}',
            f'{r.n_keys_v2:,}',
            f'{r.n_only_poc:,}',
            f'{r.n_only_v2:,}',
            f'{r.n_matching:,}',
            f'{r.n_diff:,}',
        ])
        total_diffs.extend(r.sample_diffs)

    widths = [max(len(r[i]) for r in [cols] + rows) for i in range(len(cols))]
    fmt = '  '.join(f'{{:<{w}}}' for w in widths)
    print(fmt.format(*cols))
    print(fmt.format(*['-' * w for w in widths]))
    for r in rows:
        print(fmt.format(*r))

    if total_diffs:
        print()
        print(f"Sample diffs ({len(total_diffs)} shown):")
        for d in total_diffs:
            print(f"  {d}")
