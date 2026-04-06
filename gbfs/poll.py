#!/usr/bin/env python3
"""GBFS station status poller.

Fetches Citi Bike station_status every minute, appends slim rows to daily JSONL.
At midnight crossing, compacts the previous day's JSONL into a parquet file.

Usage:
    # Single poll (for cron: * * * * *)
    ./poll.py

    # Compact a specific day's JSONL to parquet
    ./poll.py compact 2026-04-06

    # Compact yesterday (default)
    ./poll.py compact
"""
import json
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

DATA_DIR = Path(__file__).parent / 'data'
STAGING_DIR = DATA_DIR / 'staging'
PARQUET_DIR = DATA_DIR / 'parquet'
INFO_DIR = DATA_DIR / 'info'


def fetch_status() -> tuple[int, list[dict]]:
    """Fetch station_status.json, return (last_updated, stations)."""
    resp = requests.get(STATUS_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    ts = data['last_updated']
    stations = data['data']['stations']
    return ts, stations


def slim_stations(stations: list[dict]) -> list[dict]:
    """Extract only the columns we care about."""
    return [{k: s.get(k) for k in KEEP_COLS} for s in stations]


def poll():
    """Fetch one snapshot, append to today's JSONL staging file."""
    now = datetime.now(timezone.utc)
    ts, stations = fetch_status()
    slim = slim_stations(stations)

    record = {'ts': ts, 'polled_at': int(now.timestamp()), 'stations': slim}

    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    date_str = now.strftime('%Y-%m-%d')
    staging_path = STAGING_DIR / f'{date_str}.jsonl'

    with open(staging_path, 'a') as f:
        f.write(json.dumps(record, separators=(',', ':')) + '\n')

    err(f"[{now.strftime('%H:%M:%S')}] Polled {len(slim)} stations, ts={ts}, appended to {staging_path.name}")

    # Check if we should compact yesterday
    yesterday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
    yesterday_staging = STAGING_DIR / f'{yesterday}.jsonl'
    yesterday_parquet = PARQUET_DIR / f'{yesterday}.parquet'
    if yesterday_staging.exists() and not yesterday_parquet.exists():
        err(f"Compacting yesterday's data: {yesterday}")
        compact(yesterday)


def compact(date_str: str | None = None):
    """Compact a day's JSONL staging file into a parquet."""
    if date_str is None:
        date_str = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%d')

    staging_path = STAGING_DIR / f'{date_str}.jsonl'
    if not staging_path.exists():
        err(f"No staging file for {date_str}")
        return

    PARQUET_DIR.mkdir(parents=True, exist_ok=True)
    parquet_path = PARQUET_DIR / f'{date_str}.parquet'

    rows = []
    with open(staging_path) as f:
        for line in f:
            record = json.loads(line)
            ts = record['ts']
            polled_at = record['polled_at']
            for s in record['stations']:
                s['ts'] = ts
                s['polled_at'] = polled_at
                rows.append(s)

    df = pd.DataFrame(rows)

    # Optimize types
    int_cols = [
        'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
        'num_bikes_disabled', 'num_docks_disabled',
        'is_installed', 'is_renting', 'is_returning',
    ]
    for col in int_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0).astype('int16')

    df['ts'] = df['ts'].astype('int64')
    df['polled_at'] = df['polled_at'].astype('int64')
    df['last_reported'] = df['last_reported'].astype('int64')

    # Sort for better compression
    df = df.sort_values(['ts', 'station_id']).reset_index(drop=True)

    df.to_parquet(parquet_path, index=False)

    n_snapshots = df['ts'].nunique()
    err(f"Compacted {date_str}: {len(df)} rows, {n_snapshots} snapshots, {parquet_path.stat().st_size / 1024:.1f} KB → {parquet_path}")


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
