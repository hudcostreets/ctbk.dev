#!/usr/bin/env python3
"""GBFS daily compaction: download WAL from R2, compact to parquet, upload.

Uses AWS CLI with --profile cf (R2's S3-compatible API).

Usage:
    compact-r2.py download 2026-04-07
    compact-r2.py compact 2026-04-07
    compact-r2.py upload 2026-04-07
    compact-r2.py all 2026-04-07
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd

R2_BUCKET = 'ctbk'
R2_PREFIX = 'gbfs'
# Use --profile cf locally; in GHA, AWS_ENDPOINT_URL + env creds handle auth
AWS_PROFILE = os.environ.get('R2_AWS_PROFILE', 'cf')
AWS_PROFILE_ARGS = ['--profile', AWS_PROFILE] if 'AWS_ENDPOINT_URL' not in os.environ else []

DATA_DIR = Path(__file__).parent / 'data'
WAL_DIR = DATA_DIR / 'wal'
PARQUET_DIR = DATA_DIR / 'parquet'

INT16_COLS = [
    'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
    'num_bikes_disabled', 'num_docks_disabled',
    'is_installed', 'is_renting', 'is_returning',
]


def r2_exists(r2_key: str) -> bool:
    """Check if an object exists in R2."""
    result = subprocess.run(
        [
            'aws', 's3api', 'head-object',
            '--bucket', R2_BUCKET, '--key', r2_key,
            *AWS_PROFILE_ARGS,
        ],
        capture_output=True, text=True,
    )
    return result.returncode == 0


def download(date_str: str):
    """Download all WAL JSONs for a date from R2 via aws s3 sync."""
    out_dir = WAL_DIR / date_str
    out_dir.mkdir(parents=True, exist_ok=True)

    r2_prefix = f's3://{R2_BUCKET}/{R2_PREFIX}/status/{date_str}/'
    result = subprocess.run(
        [
            'aws', 's3', 'sync', r2_prefix, str(out_dir),
            '--exclude', '*', '--include', '*.json',
            *AWS_PROFILE_ARGS,
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Download failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    count = len(list(out_dir.glob('*.json')))
    print(f"Downloaded {count} WAL files for {date_str}")
    if count == 0:
        print("No WAL files found — is the date correct?", file=sys.stderr)
        sys.exit(1)


def compact(date_str: str):
    """Compact downloaded WAL JSONs into a single parquet."""
    wal_day_dir = WAL_DIR / date_str
    if not wal_day_dir.exists():
        print(f"No WAL directory for {date_str}", file=sys.stderr)
        sys.exit(1)

    json_files = sorted(wal_day_dir.glob('*.json'))
    if not json_files:
        print(f"No JSON files for {date_str}", file=sys.stderr)
        sys.exit(1)

    print(f"Compacting {len(json_files)} files for {date_str}...")
    rows = []
    for f in json_files:
        record = json.loads(f.read_text())
        ts = record['ts']
        polled_at = record['polled_at']
        for s in record['stations']:
            s['ts'] = ts
            s['polled_at'] = polled_at
            rows.append(s)

    df = pd.DataFrame(rows)
    for col in INT16_COLS:
        if col in df.columns:
            df[col] = df[col].fillna(0).astype('int16')
    df['ts'] = df['ts'].astype('int64')
    df['polled_at'] = df['polled_at'].astype('int64')
    df['last_reported'] = df['last_reported'].astype('int64')
    df = df.sort_values(['ts', 'station_id']).reset_index(drop=True)

    PARQUET_DIR.mkdir(parents=True, exist_ok=True)
    parquet_path = PARQUET_DIR / f'{date_str}.parquet'
    df.to_parquet(parquet_path, index=False)

    n_snapshots = df['ts'].nunique()
    size_kb = parquet_path.stat().st_size / 1024
    print(f"Compacted: {len(df)} rows, {n_snapshots} snapshots, {size_kb:.1f} KB → {parquet_path}")


def upload(date_str: str):
    """Upload compacted parquet to R2."""
    parquet_path = PARQUET_DIR / f'{date_str}.parquet'
    if not parquet_path.exists():
        print(f"No parquet for {date_str}", file=sys.stderr)
        sys.exit(1)

    r2_key = f's3://{R2_BUCKET}/{R2_PREFIX}/status/{date_str}.parquet'
    result = subprocess.run(
        ['aws', 's3', 'cp', str(parquet_path), r2_key, *AWS_PROFILE_ARGS],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Upload failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    size_kb = parquet_path.stat().st_size / 1024
    print(f"Uploaded to R2: {r2_key} ({size_kb:.1f} KB)")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: compact-r2.py <download|compact|upload|all> [YYYY-MM-DD]")
        sys.exit(1)

    cmd = sys.argv[1]
    date_str = sys.argv[2] if len(sys.argv) > 2 else (
        datetime.now(timezone.utc) - timedelta(days=1)
    ).strftime('%Y-%m-%d')

    if cmd == 'download':
        download(date_str)
    elif cmd == 'compact':
        compact(date_str)
    elif cmd == 'upload':
        upload(date_str)
    elif cmd == 'all':
        if r2_exists(f'{R2_PREFIX}/status/{date_str}.parquet'):
            print(f"Already compacted: {date_str}.parquet exists in R2")
            sys.exit(0)
        download(date_str)
        compact(date_str)
        upload(date_str)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
