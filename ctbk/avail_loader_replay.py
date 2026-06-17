"""Replay the loader's WAL→1m@1m transform for pre-loader-deployment dates.

The R2-event-driven loader (`gbfs/loader/src/index.ts`) has been writing
`gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` shards from per-minute
WAL JSONs (`gbfs/status/<date>/<HH-MM>.json`) since 2026-05-03. Pre-
deployment WAL JSONs exist back to 2026-04-07 but were never compacted.

This module fills that gap: for each WAL JSON in `[date_from, date_to)`,
build the same 1m@1m parquet shard pyarrow-side and PUT it to R2 at the
canonical key. Idempotent (skip-if-exists). Re-derives `dt` from
`polled_at` exactly like `buildMinuteShard` in `gbfs/lib/avail-monoid.ts`.

The avail-v3 1m-tier build (`avail_v3.py`) then reads from a continuous
[2026-04-07, present) range with no gap.
"""
from __future__ import annotations

import io
import json
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date as Date, timedelta
from typing import Iterable

import pyarrow as pa
import pyarrow.parquet as pq
from botocore.exceptions import ClientError
from click import option
from utz import err

from ctbk.avail_v3 import R2_BUCKET, r2_client, r2_head
from ctbk.cli.base import ctbk

WAL_PREFIX = 'gbfs/status'
OUT_PREFIX = 'gbfs/avail/agg=1m/cons=1m'

# Same metric→src-field mapping as gbfs/lib/avail-monoid.ts AVAIL_METRICS.
METRICS: tuple[tuple[str, str], ...] = (
    ('bikes',    'num_bikes_available'),
    ('ebikes',   'num_ebikes_available'),
    ('docks',    'num_docks_available'),
    ('disabled', 'num_bikes_disabled'),
    ('pending',  'num_docks_disabled'),
)

# Matches AVAIL_1M_ROW_GROUP_SIZE in gbfs/lib/avail-monoid.ts (~10 stations/rg
# for ~2,400 stations → ~4 row groups per shard, enabling row-group prune by
# station_id stats).
ROW_GROUP_SIZE = 600


def wal_key(date_str: str, hh: int, mm: int) -> str:
    return f'{WAL_PREFIX}/{date_str}/{hh:02d}-{mm:02d}.json'


def out_key(date_str: str, hh: int, mm: int) -> str:
    return f'{OUT_PREFIX}/{date_str}/{hh:02d}{mm:02d}.parquet'


def build_minute_table(record: dict) -> pa.Table | None:
    """Port of `buildMinuteShard` (gbfs/lib/avail-monoid.ts).

    Returns None if `record.stations` is empty (matches loader semantics:
    "warn empty status, write nothing").
    """
    stations = record.get('stations') or []
    if not stations:
        return None
    stations = sorted(stations, key=lambda s: s['station_id'])
    polled_at = int(record['polled_at'])
    dt = (polled_at // 60) * 60

    sids = [s['station_id'] for s in stations]
    dts = [dt] * len(stations)

    arrays: list[pa.Array] = [
        pa.array(sids, type=pa.string()),
        pa.array(dts, type=pa.int64()),
    ]
    names: list[str] = ['station_id', 'dt']

    for metric, src in METRICS:
        ns: list[int] = []
        sums: list[float] = []
        sqs: list[float] = []
        for s in stations:
            v = s.get(src)
            if v is None:
                v = 0
            ns.append(1)
            sums.append(float(v))
            sqs.append(float(v) * float(v))
        arrays.extend([
            pa.array(ns, type=pa.int32()),
            pa.array(sums, type=pa.float64()),
            pa.array(sqs, type=pa.float64()),
        ])
        names.extend([f'{metric}_n', f'{metric}_sum', f'{metric}_sum_sq'])

    return pa.table(arrays, names=names)


def list_wal_keys_for_date(cli, date_str: str) -> list[tuple[int, int]]:
    """Enumerate (hh, mm) pairs present in `gbfs/status/<date>/`."""
    pairs: list[tuple[int, int]] = []
    paginator = cli.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=f'{WAL_PREFIX}/{date_str}/'):
        for obj in page.get('Contents', []) or []:
            key = obj['Key']
            # gbfs/status/YYYY-MM-DD/HH-MM.json
            base = key.rsplit('/', 1)[-1]
            if not base.endswith('.json'): continue
            stem = base[:-5]  # 'HH-MM'
            if len(stem) != 5 or stem[2] != '-': continue
            try:
                hh = int(stem[:2]); mm = int(stem[3:])
            except ValueError:
                continue
            pairs.append((hh, mm))
    pairs.sort()
    return pairs


def daterange(date_from: Date, date_to: Date) -> Iterable[Date]:
    cur = date_from
    while cur < date_to:
        yield cur
        cur = cur + timedelta(days=1)


# ─── Per-minute worker ─────────────────────────────────────────────────

def _replay_minute_task(
    date_str: str,
    hh: int,
    mm: int,
    overwrite: bool,
) -> tuple[str, str, int]:
    """Read one WAL JSON, build the 1m@1m shard, PUT to R2.

    Returns (key_suffix, status, bytes_written). Status ∈ {wrote, skip, empty, missing}.
    """
    cli = r2_client()
    out = out_key(date_str, hh, mm)
    suffix = f'{date_str}/{hh:02d}{mm:02d}'
    if not overwrite and r2_head(cli, out) is not None:
        return (suffix, 'skip', 0)
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=wal_key(date_str, hh, mm))
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return (suffix, 'missing', 0)
        raise
    record = json.loads(obj['Body'].read())
    table = build_minute_table(record)
    if table is None:
        return (suffix, 'empty', 0)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression='snappy', row_group_size=ROW_GROUP_SIZE)
    body = buf.getvalue()
    cli.put_object(
        Bucket=R2_BUCKET,
        Key=out,
        Body=body,
        ContentType='application/octet-stream',
    )
    return (suffix, 'wrote', len(body))


# ─── CLI ───────────────────────────────────────────────────────────────

@ctbk.command(
    'avail-loader-replay',
    help="Backfill gbfs/avail/agg=1m/cons=1m/ from WAL JSONs (pre-loader-deployment dates).",
)
@option('-c', '--concurrency', type=int, default=16, help="Worker process count.")
@option('-f', '--date-from', 'date_from', required=True, help="Inclusive start (YYYY-MM-DD).")
@option('-n', '--dry-run', is_flag=True, help="List would-be writes; do nothing.")
@option('-O', '--overwrite', is_flag=True, help="Rewrite even if output exists.")
@option('-T', '--date-to', 'date_to', required=True, help="Exclusive end (YYYY-MM-DD).")
def avail_loader_replay_cmd(
    concurrency: int,
    date_from: str,
    dry_run: bool,
    overwrite: bool,
    date_to: str,
):
    df = Date.fromisoformat(date_from)
    dt = Date.fromisoformat(date_to)
    cli = r2_client()

    # Enumerate all (date, hh, mm) tuples present in the WAL bucket.
    tasks: list[tuple[str, int, int]] = []
    for d in daterange(df, dt):
        date_str = d.isoformat()
        pairs = list_wal_keys_for_date(cli, date_str)
        if not pairs:
            err(f"  {date_str}: no WAL JSONs found")
            continue
        err(f"  {date_str}: {len(pairs)} WAL JSONs")
        for hh, mm in pairs:
            tasks.append((date_str, hh, mm))
    err(f"avail-loader-replay: {len(tasks)} minutes in [{date_from}, {date_to})")

    if dry_run:
        # Just count present/missing outputs without doing any writes.
        n_exists = 0
        for date_str, hh, mm in tasks:
            if r2_head(cli, out_key(date_str, hh, mm)) is not None:
                n_exists += 1
        err(f"  {n_exists}/{len(tasks)} outputs already present (would skip)")
        err(f"  {len(tasks) - n_exists} would be written")
        return

    n_wrote = n_skip = n_empty = n_missing = bytes_total = 0
    if concurrency <= 1:
        for date_str, hh, mm in tasks:
            suf, status, n = _replay_minute_task(date_str, hh, mm, overwrite)
            n_wrote   += (status == 'wrote')
            n_skip    += (status == 'skip')
            n_empty   += (status == 'empty')
            n_missing += (status == 'missing')
            bytes_total += n
    else:
        with ProcessPoolExecutor(max_workers=concurrency) as pool:
            futs = {
                pool.submit(_replay_minute_task, date_str, hh, mm, overwrite): (date_str, hh, mm)
                for (date_str, hh, mm) in tasks
            }
            n_total = len(futs)
            n_done = 0
            for fut in as_completed(futs):
                suf, status, n = fut.result()
                n_done += 1
                n_wrote   += (status == 'wrote')
                n_skip    += (status == 'skip')
                n_empty   += (status == 'empty')
                n_missing += (status == 'missing')
                bytes_total += n
                if n_done % 500 == 0:
                    err(f"  progress: {n_done:,}/{n_total:,} ({n_wrote} wrote, {n_skip} skip, {n_empty} empty, {n_missing} missing)")

    err(f"done: {n_wrote} wrote, {n_skip} skip, {n_empty} empty, {n_missing} missing, {bytes_total:,} bytes total")
