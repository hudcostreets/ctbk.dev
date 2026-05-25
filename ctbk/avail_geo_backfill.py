"""Backfill `avail-geo/<tier>/<period>.parquet` shards from existing
`avail/agg/<tier>/<period>.parquet` shards on R2.

For each source shard that doesn't yet have a corresponding geo shard,
download it, build the geo version locally, and upload. Idempotent —
re-runs only process missing dates.

Station lat/lng comes from the latest `gbfs/info/<date>.json`. Stations
that existed historically but are no longer in `info` get dropped (the
build warns with a count); the per-build dropped count is currently
~0.3% in practice.

Usage:
    ctbk avail-geo-backfill                  # all missing h1 shards
    ctbk avail-geo-backfill --tier d1        # d1 instead
    ctbk avail-geo-backfill --limit 5        # only process up to 5 missing dates
    ctbk avail-geo-backfill --dry-run        # list what would be built
"""
from __future__ import annotations

import os
import subprocess
import sys
from os.path import basename, join
from tempfile import TemporaryDirectory

from click import option
from utz import err

from ctbk.avail_geo import DEFAULT_RESOLUTIONS, build_geo_shard, load_station_geo
from ctbk.cli.base import ctbk

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


def _endpoint() -> str:
    """R2 S3-compat endpoint URL from env."""
    acct = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    if not acct:
        raise RuntimeError("CLOUDFLARE_ACCOUNT_ID not set in environment (expected in .envrc)")
    return f"https://{acct}.r2.cloudflarestorage.com"


def _aws_env() -> dict[str, str]:
    """Env vars that point `aws` at R2 with R2_ creds."""
    e = os.environ.copy()
    e['AWS_ACCESS_KEY_ID'] = os.environ['R2_ACCESS_KEY_ID']
    e['AWS_SECRET_ACCESS_KEY'] = os.environ['R2_SECRET_ACCESS_KEY']
    e['AWS_DEFAULT_REGION'] = 'auto'
    return e


def _r2_ls(prefix: str) -> list[str]:
    """List object basenames under `s3://ctbk/<prefix>` (non-recursive)."""
    p = subprocess.run(
        ['aws', 's3', 'ls', f's3://ctbk/{prefix}', '--endpoint-url', _endpoint()],
        capture_output=True, text=True, env=_aws_env(),
    )
    if p.returncode != 0:
        raise RuntimeError(f"aws s3 ls failed: {p.stderr}")
    out: list[str] = []
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            out.append(parts[-1])
    return out


def _r2_cp(src: str, dst: str) -> None:
    """`aws s3 cp` either direction. Args are full s3://… or local paths."""
    p = subprocess.run(
        ['aws', 's3', 'cp', src, dst, '--endpoint-url', _endpoint(), '--quiet'],
        env=_aws_env(),
    )
    if p.returncode != 0:
        raise RuntimeError(f"aws s3 cp {src} {dst} failed")


@ctbk.command('avail-geo-backfill', help="Build avail-geo shards for any source avail/agg shards not yet processed.")
@option('-t', '--tier', default='h1', type=str, help="Tier to backfill: h1 / d1 / mo1 (default h1)")
@option('-n', '--limit', type=int, default=None, help="Only process up to N missing dates (default: all)")
@option('-r', '--resolution', 'resolutions', multiple=True, type=int, default=DEFAULT_RESOLUTIONS,
        help="h3 resolutions (finest first). Default: 9,7,5.")
@option('--dry-run', 'dry_run', is_flag=True, help="List missing dates, don't build/upload")
def avail_geo_backfill(tier: str, limit: int | None, resolutions: tuple[int, ...], dry_run: bool):
    src_prefix = f'avail/agg/{tier}/'
    dst_prefix = f'avail-geo/{tier}/'
    err(f"Listing source shards under s3://ctbk/{src_prefix}")
    sources = sorted([f for f in _r2_ls(src_prefix) if f.endswith('.parquet')])
    err(f"  {len(sources)} source shards")

    err(f"Listing existing geo shards under s3://ctbk/{dst_prefix}")
    existing = set(_r2_ls(dst_prefix))
    err(f"  {len(existing)} already built")

    missing = [s for s in sources if s not in existing]
    err(f"Missing: {len(missing)} dates")

    if dry_run:
        for m in missing[:limit]:
            print(m)
        return

    if not missing:
        err("Nothing to do.")
        return

    # Resolve station info once (latest available).
    info_files = sorted([f for f in _r2_ls('gbfs/info/') if f.endswith('.json')])
    if not info_files:
        raise RuntimeError("no gbfs/info/*.json found")
    info_latest = info_files[-1]
    err(f"Using station info: gbfs/info/{info_latest}")

    with TemporaryDirectory() as tmp:
        info_path = join(tmp, 'info.json')
        _r2_cp(f's3://ctbk/gbfs/info/{info_latest}', info_path)
        station_geo = load_station_geo(info_path)
        err(f"  {len(station_geo)} stations with lat/lng")

        todo = missing[:limit] if limit else missing
        for i, name in enumerate(todo, 1):
            src = f's3://ctbk/{src_prefix}{name}'
            dst = f's3://ctbk/{dst_prefix}{name}'
            err(f"[{i}/{len(todo)}] {name}")
            local_src = join(tmp, f'src-{name}')
            local_dst = join(tmp, f'dst-{name}')
            _r2_cp(src, local_src)
            tall = pd.concat(_iter_chunks(local_src), ignore_index=True)
            table = build_geo_shard(tall, station_geo, tuple(resolutions))
            pq.write_table(table, local_dst, compression='snappy')
            _r2_cp(local_dst, dst)
            os.unlink(local_src)
            os.unlink(local_dst)
            err(f"  → s3://ctbk/{dst_prefix}{name} ({table.num_rows:,} rows)")

    err(f"Done. Processed {len(todo)} shards.")


def _iter_chunks(path: str):
    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(batch_size=200_000):
        yield batch.to_pandas()
