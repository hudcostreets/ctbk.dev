#!/usr/bin/env python3
"""Convert a compacted GBFS daily JSON to parquet.

Usage: json-to-parquet.py input.json output.parquet
"""
import json
import sys
from pathlib import Path

import pandas as pd

INT16_COLS = [
    'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
    'num_bikes_disabled', 'num_docks_disabled',
    'is_installed', 'is_renting', 'is_returning',
]


def convert(input_path: str, output_path: str):
    with open(input_path) as f:
        snapshots = json.load(f)

    rows = []
    for record in snapshots:
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

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(output_path, index=False)

    n_snapshots = df['ts'].nunique()
    size_kb = Path(output_path).stat().st_size / 1024
    print(f"{len(df)} rows, {n_snapshots} snapshots, {size_kb:.1f} KB → {output_path}")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: json-to-parquet.py input.json output.parquet")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
