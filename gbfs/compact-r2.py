#!/usr/bin/env python3
"""GBFS daily compaction: download WAL from R2, compact to parquet, upload.

Uses AWS CLI with --profile cf (R2's S3-compatible API).

Usage:
    compact-r2.py download 2026-04-07
    compact-r2.py compact 2026-04-07
    compact-r2.py upload 2026-04-07
    compact-r2.py slice 2026-04-07       # split daily parquet into per-station files
    compact-r2.py all 2026-04-07         # download + compact + upload + slice
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
STATION_DIR = DATA_DIR / 'stations'

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


def slice_stations(date_str: str):
    """Split daily parquet into per-station monthly files with daily row groups.

    Each station's monthly file (`{station_id}/YYYY-MM.parquet`) accumulates
    one row group per day. Daily RGs let readers skip irrelevant time ranges.
    """
    parquet_path = PARQUET_DIR / f'{date_str}.parquet'
    if not parquet_path.exists():
        print(f"No daily parquet for {date_str}", file=sys.stderr)
        sys.exit(1)

    ym = date_str[:7]  # YYYY-MM
    df = pd.read_parquet(parquet_path)
    grouped = df.groupby('station_id')
    station_ids = sorted(grouped.groups.keys())
    print(f"Slicing {len(df)} rows across {len(station_ids)} stations into {ym}...")

    STATION_DIR.mkdir(parents=True, exist_ok=True)
    r2_stations = f's3://{R2_BUCKET}/{R2_PREFIX}/stations/'

    # Download existing per-station monthly parquets for this YM
    # (only what we'll be appending to). Skip if local dir already populated.
    existing_local = list(STATION_DIR.glob(f'*/{ym}.parquet'))
    if not existing_local:
        print(f"Downloading existing {ym}.parquet files...")
        subprocess.run(
            [
                'aws', 's3', 'sync', r2_stations, str(STATION_DIR),
                '--exclude', '*', '--include', f'*/{ym}.parquet',
                *AWS_PROFILE_ARGS,
            ],
            capture_output=True, text=True,
        )

    # Append today's rows to each station's monthly file, preserving daily RGs
    import pyarrow as pa
    import pyarrow.parquet as pq

    for station_id in station_ids:
        station_df = grouped.get_group(station_id)
        local_path = STATION_DIR / station_id / f'{ym}.parquet'
        local_path.parent.mkdir(parents=True, exist_ok=True)

        if local_path.exists():
            existing_df = pd.read_parquet(local_path)
            combined = pd.concat([existing_df, station_df]).drop_duplicates(
                subset=['ts', 'station_id'],
            )
        else:
            combined = station_df

        combined = combined.sort_values('ts').reset_index(drop=True)

        # Write with one row group per day (~1440 rows each)
        # Compute day buckets from `ts` (unix seconds → date)
        days = pd.to_datetime(combined['ts'], unit='s', utc=True).dt.strftime('%Y-%m-%d')
        table = pa.Table.from_pandas(combined, preserve_index=False)
        with pq.ParquetWriter(local_path, table.schema, compression='snappy') as writer:
            for day in sorted(days.unique()):
                day_mask = (days == day).values
                writer.write_table(table.filter(pa.array(day_mask)))

    # Batch upload
    print(f"Uploading {ym}.parquet files...")
    result = subprocess.run(
        [
            'aws', 's3', 'sync', str(STATION_DIR), r2_stations,
            '--exclude', '*', '--include', f'*/{ym}.parquet',
            *AWS_PROFILE_ARGS,
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Upload failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    print(f"Sliced {len(station_ids)} station {ym} parquets")


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
    elif cmd == 'slice':
        slice_stations(date_str)
    elif cmd == 'all':
        if r2_exists(f'{R2_PREFIX}/status/{date_str}.parquet'):
            print(f"Already compacted: {date_str}.parquet exists in R2")
            sys.exit(0)
        download(date_str)
        compact(date_str)
        upload(date_str)
        slice_stations(date_str)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
