#!/usr/bin/env python3
"""GBFS daily compaction: download WAL from R2, compact to parquet, upload.

Usage:
    # Download yesterday's WAL JSONs from R2
    compact-r2.py download 2026-04-07

    # Compact downloaded JSONs to parquet
    compact-r2.py compact 2026-04-07

    # Upload compacted parquet to R2
    compact-r2.py upload 2026-04-07

    # All three steps
    compact-r2.py all 2026-04-07
"""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd

R2_BUCKET = 'ctbk'
R2_PREFIX = 'gbfs'

DATA_DIR = Path(__file__).parent / 'data'
WAL_DIR = DATA_DIR / 'wal'
PARQUET_DIR = DATA_DIR / 'parquet'

INT16_COLS = [
    'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
    'num_bikes_disabled', 'num_docks_disabled',
    'is_installed', 'is_renting', 'is_returning',
]


def r2_get(r2_key: str) -> str | None:
    """Get an object from R2, return contents or None if not found."""
    result = subprocess.run(
        ['wrangler', 'r2', 'object', 'get', f'{R2_BUCKET}/{r2_key}', '--remote', '--pipe'],
        capture_output=True, text=True,
    )
    if result.returncode == 0 and result.stdout:
        return result.stdout
    return None


def r2_put(local_path: Path, r2_key: str):
    """Upload a file to R2."""
    result = subprocess.run(
        ['wrangler', 'r2', 'object', 'put', f'{R2_BUCKET}/{r2_key}',
         '--file', str(local_path), '--remote'],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Upload failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)


def download_one(args: tuple[str, Path]) -> bool:
    """Download a single WAL file. Returns True if found."""
    r2_key, out_path = args
    content = r2_get(r2_key)
    if content:
        out_path.write_text(content)
        return True
    return False


def download(date_str: str):
    """Download all WAL JSONs for a date from R2 (parallel)."""
    out_dir = WAL_DIR / date_str
    out_dir.mkdir(parents=True, exist_ok=True)

    tasks = []
    for h in range(24):
        for m in range(60):
            time_str = f'{h:02d}-{m:02d}'
            r2_key = f'{R2_PREFIX}/status/{date_str}/{time_str}.json'
            out_path = out_dir / f'{time_str}.json'
            tasks.append((r2_key, out_path))

    print(f"Downloading WAL for {date_str} ({len(tasks)} slots, parallel)...")
    with ThreadPoolExecutor(max_workers=32) as pool:
        results = list(pool.map(download_one, tasks))

    count = sum(results)
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

    r2_key = f'{R2_PREFIX}/status/{date_str}.parquet'
    r2_put(parquet_path, r2_key)

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
        download(date_str)
        compact(date_str)
        upload(date_str)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
