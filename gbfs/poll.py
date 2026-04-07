#!/usr/bin/env python3
"""GBFS station status poller.

Fetches Citi Bike station_status every minute, writes per-minute parquet snapshots
to local disk and R2. At midnight, compacts the previous day's WAL into a single
daily parquet.

Storage layout (local and R2):
    gbfs/status/YYYY-MM-DD.parquet       — compacted daily file
    gbfs/status/YYYY-MM-DD/HH-MM.parquet — per-minute WAL snapshots
    gbfs/info/YYYY-MM-DD.json            — daily station_information snapshot

Usage:
    # Single poll (for cron: * * * * *)
    ./poll.py

    # Compact a specific day's WAL to daily parquet
    ./poll.py compact 2026-04-06

    # Compact yesterday (default)
    ./poll.py compact
"""
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pandas as pd
import requests
from utz import err

STATUS_URL = 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json'
INFO_URL = 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json'

KEEP_COLS = [
    'station_id',
    'num_bikes_available',
    'num_ebikes_available',
    'num_docks_available',
    'num_bikes_disabled',
    'num_docks_disabled',
    'is_installed',
    'is_renting',
    'is_returning',
    'last_reported',
]

INT16_COLS = [
    'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
    'num_bikes_disabled', 'num_docks_disabled',
    'is_installed', 'is_renting', 'is_returning',
]

DATA_DIR = Path(__file__).parent / 'data'
WAL_DIR = DATA_DIR / 'wal'
PARQUET_DIR = DATA_DIR / 'parquet'
INFO_DIR = DATA_DIR / 'info'

R2_BUCKET = 'ctbk'
R2_PREFIX = 'gbfs'
NPX = '/home/ubuntu/.nvm/versions/node/v24.12.0/bin/npx'


def fetch_status() -> tuple[int, list[dict]]:
    """Fetch station_status.json, return (last_updated, stations)."""
    resp = requests.get(STATUS_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data['last_updated'], data['data']['stations']


def stations_to_df(stations: list[dict], ts: int, polled_at: int) -> pd.DataFrame:
    """Convert station list to a typed DataFrame."""
    df = pd.DataFrame([{k: s.get(k) for k in KEEP_COLS} for s in stations])
    for col in INT16_COLS:
        if col in df.columns:
            df[col] = df[col].fillna(0).astype('int16')
    df['ts'] = pd.array([ts] * len(df), dtype='int64')
    df['polled_at'] = pd.array([polled_at] * len(df), dtype='int64')
    df['last_reported'] = df['last_reported'].astype('int64')
    return df.sort_values('station_id').reset_index(drop=True)


def r2_put(local_path: Path, r2_key: str):
    """Upload a file to R2 via wrangler."""
    cmd = [NPX, 'wrangler', 'r2', 'object', 'put',
           f'{R2_BUCKET}/{r2_key}', '--file', str(local_path), '--remote']
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err(f"R2 upload failed: {result.stderr}")
        raise RuntimeError(f"R2 upload failed for {r2_key}")
    err(f"  → R2: {r2_key} ({local_path.stat().st_size / 1024:.1f} KB)")


def r2_delete(r2_key: str):
    """Delete an object from R2 via wrangler."""
    cmd = [NPX, 'wrangler', 'r2', 'object', 'delete',
           f'{R2_BUCKET}/{r2_key}', '--remote']
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        err(f"R2 delete failed for {r2_key}: {result.stderr}")


def poll():
    """Fetch one snapshot, write per-minute parquet locally and to R2."""
    now = datetime.now(timezone.utc)
    ts, stations = fetch_status()
    polled_at = int(now.timestamp())
    df = stations_to_df(stations, ts, polled_at)

    date_str = now.strftime('%Y-%m-%d')
    time_str = now.strftime('%H-%M')

    # Write local WAL parquet
    wal_day_dir = WAL_DIR / date_str
    wal_day_dir.mkdir(parents=True, exist_ok=True)
    local_path = wal_day_dir / f'{time_str}.parquet'
    df.to_parquet(local_path, index=False)

    # Upload to R2 WAL
    r2_key = f'{R2_PREFIX}/status/{date_str}/{time_str}.parquet'
    r2_put(local_path, r2_key)

    err(f"[{now.strftime('%H:%M:%S')}] {len(df)} stations, ts={ts}")

    # Check if we should compact yesterday
    yesterday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
    yesterday_wal = WAL_DIR / yesterday
    yesterday_parquet = PARQUET_DIR / f'{yesterday}.parquet'
    if yesterday_wal.exists() and not yesterday_parquet.exists():
        err(f"Compacting yesterday: {yesterday}")
        compact(yesterday)


def compact(date_str: str | None = None):
    """Compact a day's WAL parquets into a single daily parquet."""
    if date_str is None:
        date_str = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%d')

    wal_day_dir = WAL_DIR / date_str
    if not wal_day_dir.exists():
        err(f"No WAL directory for {date_str}")
        return

    wal_files = sorted(wal_day_dir.glob('*.parquet'))
    if not wal_files:
        err(f"No WAL files for {date_str}")
        return

    PARQUET_DIR.mkdir(parents=True, exist_ok=True)
    parquet_path = PARQUET_DIR / f'{date_str}.parquet'

    dfs = [pd.read_parquet(f) for f in wal_files]
    df = pd.concat(dfs, ignore_index=True)
    df = df.sort_values(['ts', 'station_id']).reset_index(drop=True)
    df.to_parquet(parquet_path, index=False)

    n_snapshots = df['ts'].nunique()
    size_kb = parquet_path.stat().st_size / 1024
    err(f"Compacted {date_str}: {len(df)} rows, {n_snapshots} snapshots, {size_kb:.1f} KB")

    # Upload compacted parquet to R2
    r2_key = f'{R2_PREFIX}/status/{date_str}.parquet'
    r2_put(parquet_path, r2_key)

    # Clean up WAL fragments from R2
    err(f"Cleaning up {len(wal_files)} WAL fragments from R2...")
    for f in wal_files:
        wal_key = f'{R2_PREFIX}/status/{date_str}/{f.stem}.parquet'
        r2_delete(wal_key)

    # Clean up local WAL
    for f in wal_files:
        f.unlink()
    wal_day_dir.rmdir()
    err(f"Cleaned up local WAL for {date_str}")


def fetch_info():
    """Fetch and save station_information (daily)."""
    INFO_DIR.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    info_path = INFO_DIR / f'{date_str}.json'

    if info_path.exists():
        err(f"Station info already fetched today: {info_path}")
        return

    resp = requests.get(INFO_URL, timeout=30)
    resp.raise_for_status()
    with open(info_path, 'w') as f:
        json.dump(resp.json(), f, separators=(',', ':'))

    n = len(resp.json()['data']['stations'])
    err(f"Saved station_information: {n} stations → {info_path}")

    # Upload to R2
    r2_key = f'{R2_PREFIX}/info/{date_str}.json'
    r2_put(info_path, r2_key)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'compact':
        date_arg = sys.argv[2] if len(sys.argv) > 2 else None
        compact(date_arg)
    elif len(sys.argv) > 1 and sys.argv[1] == 'info':
        fetch_info()
    else:
        poll()
        # Also fetch station_information once daily
        fetch_info()
