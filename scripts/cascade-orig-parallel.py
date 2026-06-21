#!/usr/bin/env python3
"""Parallel-ProcessPool wrapper around `cascade_from_1m` for benchmarking.

Splits the input range into N sub-ranges, runs an independent
`cascade_from_1m` per sub-range into a per-worker staging sub-prefix,
then reduces (tier, period) shards that appear in multiple
sub-prefixes by histogram-merging them.

Compares against the unparallelized baseline and against the
Polars `pyramid-cascade` engine. See `specs/cascade-perf-comparison.md`.

Usage:
  scripts/cascade-orig-parallel.py \\
    -r 2026-06-11/2026-06-18 \\
    -j 4 \\
    -p avail-v3-orig-par-7d \\
    -S avail-v3
"""
from __future__ import annotations

import io
import json
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date as Date, datetime, timedelta, timezone

import pyarrow.parquet as pq
from click import command, option

from ctbk.avail_v3 import (
    AVAIL_METRICS,
    DST_PREFIX,
    R2_BUCKET,
    _accum_to_table,
    cascade_from_1m,
    r2_client,
    write_table_to_r2,
)
from utz import err


def _split_range(date_from: Date, date_to: Date, n: int) -> list[tuple[Date, Date]]:
    """Split half-open [date_from, date_to) into N contiguous calendar-day
    sub-ranges. Each sub-range covers ceil((to-from)/n) days; last absorbs
    the remainder."""
    total_days = (date_to - date_from).days
    if total_days < n:
        raise ValueError(f"can't split {total_days} days across {n} workers")
    per = total_days // n
    extra = total_days % n
    out: list[tuple[Date, Date]] = []
    cur = date_from
    for i in range(n):
        size = per + (1 if i < extra else 0)
        nxt = cur + timedelta(days=size)
        out.append((cur, nxt))
        cur = nxt
    assert cur == date_to
    return out


def _run_subrange(
    sub_id: int,
    sub_from_iso: str,
    sub_to_iso: str,
    sub_prefix: str,
    src_prefix: str,
    ad_from_iso: str,
    ad_to_iso: str,
    concurrency: int,
) -> tuple[int, int, int, float]:
    """ProcessPool worker. Runs cascade_from_1m on one sub-range, writes
    derived tiers to `sub_prefix`. Reads 1m source from `src_prefix`."""
    sub_from = Date.fromisoformat(sub_from_iso)
    sub_to = Date.fromisoformat(sub_to_iso)
    ad_from = Date.fromisoformat(ad_from_iso)
    ad_to = Date.fromisoformat(ad_to_iso)
    t0 = time.time()
    n_wrote, n_skip, bytes_total = cascade_from_1m(
        date_from=sub_from,
        date_to=sub_to,
        concurrency=concurrency,
        overwrite=True,
        all_dates=(ad_from, ad_to),
        prefix=sub_prefix,
        src_prefix=src_prefix,
    )
    return (n_wrote, n_skip, bytes_total, time.time() - t0)


def _list_subrange_keys(cli, sub_prefix: str) -> list[str]:
    """List all derived-tier output keys under one sub-range's staging
    prefix. Returns full R2 keys."""
    paginator = cli.get_paginator('list_objects_v2')
    out: list[str] = []
    for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=sub_prefix + '/'):
        for obj in page.get('Contents', []):
            out.append(obj['Key'])
    return out


def _parse_tier_period(key: str, sub_prefix: str) -> tuple[str, str]:
    """`<sub_prefix>/<tier>/<period>.parquet` → (tier, period)."""
    rel = key.removeprefix(sub_prefix + '/').removesuffix('.parquet')
    parts = rel.split('/', 1)
    if len(parts) == 1:
        return parts[0], '<root>'
    return parts[0], parts[1]


def _merge_shards(cli, keys: list[str]) -> bytes:
    """Read all `keys` (each a `(s2_cell, dt, *metrics:hist_json)` table),
    hist-merge across them, return parquet bytes of the merged shard."""
    accum: dict[tuple[str, int, str], dict[str, int]] = {}
    for key in keys:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
        tab = pq.read_table(io.BytesIO(obj['Body'].read()))
        cell_col = tab['s2_cell'].to_pylist()
        dt_col = tab['dt'].to_pylist()
        metric_cols = {m: tab[m].to_pylist() for m in AVAIL_METRICS}
        n_rows = tab.num_rows
        for i in range(n_rows):
            cell = cell_col[i]
            dt = dt_col[i]
            for m in AVAIL_METRICS:
                js = metric_cols[m][i]
                if js is None:
                    continue
                d = json.loads(js)
                if not d:
                    continue
                acc_key = (cell, dt, m)
                acc_d = accum.get(acc_key)
                if acc_d is None:
                    accum[acc_key] = dict(d)
                else:
                    for k, v in d.items():
                        acc_d[k] = acc_d.get(k, 0) + v
    tab_out = _accum_to_table(accum)
    buf = io.BytesIO()
    pq.write_table(tab_out, buf, compression='zstd')
    return buf.getvalue()


def _reduce_one(args: tuple) -> tuple[str, str, int, int]:
    """ProcessPool worker for reduce. `args = (tier, period, keys, out_key)`.
    Returns (tier, period, n_partials, bytes_written)."""
    tier, period, keys, out_key = args
    cli = r2_client()
    if len(keys) == 1:
        # Single-owner: server-side copy, no merge needed.
        cli.copy_object(
            Bucket=R2_BUCKET, Key=out_key,
            CopySource={'Bucket': R2_BUCKET, 'Key': keys[0]},
        )
        meta = cli.head_object(Bucket=R2_BUCKET, Key=out_key)
        return (tier, period, 1, meta['ContentLength'])
    blob = _merge_shards(cli, keys)
    cli.put_object(Bucket=R2_BUCKET, Key=out_key, Body=blob)
    return (tier, period, len(keys), len(blob))


@command()
@option('-c', '--concurrency', type=int, default=8, show_default=True, help='R2-fetch thread-pool size per worker (inner cascade_from_1m).')
@option('-j', '--workers', type=int, default=4, show_default=True, help='Number of ProcessPool workers across sub-ranges.')
@option('-p', '--prefix', required=True, help='R2 output prefix (e.g. `avail-v3-orig-par-7d`). Staging under `<prefix>/_tmp/sub<NNN>/`; final under `<prefix>/<tier>/<period>.parquet`.')
@option('-r', '--range', 'range_', required=True, help='Date range `YYYY-MM-DD/YYYY-MM-DD` (half-open).')
@option('-R', '--reduce-workers', type=int, default=None, help='Reduce-phase ProcessPool size. Defaults to --workers.')
@option('-S', '--src-prefix', default=DST_PREFIX, show_default=True, help='R2 prefix for 1m source reads.')
def main(
    concurrency: int,
    workers: int,
    prefix: str,
    range_: str,
    reduce_workers: int | None,
    src_prefix: str,
):
    a, b = range_.split('/', 1)
    date_from = Date.fromisoformat(a)
    date_to = Date.fromisoformat(b)
    reduce_workers = reduce_workers or workers

    sub_ranges = _split_range(date_from, date_to, workers)
    err(f"parallel cascade-from-1m")
    err(f"  range:           {date_from} → {date_to}  ({(date_to - date_from).days} days)")
    err(f"  workers:         {workers}")
    err(f"  reduce_workers:  {reduce_workers}")
    err(f"  src_prefix:      {src_prefix}")
    err(f"  dst_prefix:      {prefix}")
    err(f"  sub-ranges:")
    for i, (sf, st) in enumerate(sub_ranges):
        err(f"    sub{i:03d}: {sf} → {st}  ({(st - sf).days} days)")

    # ─── Map phase ────────────────────────────────────────────────
    t_map_start = time.time()
    err()
    err(f"=== map phase ({workers} workers) ===")
    map_results: list[tuple[int, int, int, float]] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futs = {
            pool.submit(
                _run_subrange,
                i, sf.isoformat(), st.isoformat(),
                f"{prefix}/_tmp/sub{i:03d}",
                src_prefix,
                date_from.isoformat(), date_to.isoformat(),
                concurrency,
            ): i
            for i, (sf, st) in enumerate(sub_ranges)
        }
        for fut in as_completed(futs):
            i = futs[fut]
            n_wrote, n_skip, bytes_total, wall = fut.result()
            err(f"  sub{i:03d}: {n_wrote} wrote, {n_skip} skip, {bytes_total:,} B, {wall:.1f}s")
            map_results.append((n_wrote, n_skip, bytes_total, wall))
    t_map = time.time() - t_map_start
    err(f"map phase: {t_map:.1f}s")

    # ─── Reduce phase ─────────────────────────────────────────────
    t_reduce_start = time.time()
    err()
    err(f"=== reduce phase ({reduce_workers} workers) ===")
    cli = r2_client()
    by_tp: dict[tuple[str, str], list[str]] = defaultdict(list)
    for i in range(workers):
        sub_prefix = f"{prefix}/_tmp/sub{i:03d}"
        for key in _list_subrange_keys(cli, sub_prefix):
            tier, period = _parse_tier_period(key, sub_prefix)
            by_tp[(tier, period)].append(key)
    n_total = len(by_tp)
    n_multi = sum(1 for ks in by_tp.values() if len(ks) > 1)
    err(f"  {n_total} (tier, period) shards: {n_total - n_multi} single-owner, {n_multi} need merging")

    reduce_tasks = []
    for (tier, period), keys in sorted(by_tp.items()):
        out_key = f"{prefix}/{tier}/{period}.parquet"
        reduce_tasks.append((tier, period, sorted(keys), out_key))

    n_wrote = bytes_total = 0
    with ProcessPoolExecutor(max_workers=reduce_workers) as pool:
        for tier, period, n_partials, n_bytes in pool.map(_reduce_one, reduce_tasks):
            err(f"  {tier:4s} {period:20s}  {n_partials}×  ({n_bytes:,} B)")
            n_wrote += 1
            bytes_total += n_bytes
    t_reduce = time.time() - t_reduce_start
    err(f"reduce phase: {t_reduce:.1f}s")

    # ─── Summary ──────────────────────────────────────────────────
    err()
    err(f"=== summary ===")
    err(f"  map:    {t_map:>7.1f}s  ({workers} workers)")
    err(f"  reduce: {t_reduce:>7.1f}s  ({reduce_workers} workers, {n_wrote} shards, {bytes_total:,} B)")
    err(f"  total:  {t_map + t_reduce:>7.1f}s")


if __name__ == '__main__':
    main()
