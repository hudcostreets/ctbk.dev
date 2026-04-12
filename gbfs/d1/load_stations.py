#!/usr/bin/env python3
"""Load stations into D1 from station-history.parquet (tripdata corpus).

For each canonical station (id0), upserts into the `stations` table.
Run after `ctbk station-harmonize create` produces fresh outputs.

Usage:
    load_stations.py
    load_stations.py --history s3/ctbk/stations/station-history.parquet
    load_stations.py --dry-run     # write SQL to stdout, no D1 calls
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

D1_DB = 'ctbk-gbfs'
DEFAULT_HISTORY = Path('s3/ctbk/stations/station-history.parquet')


def parse_date(s) -> str | None:
    """station-history `first`/`last` are YYMMDD strings (e.g. '130601'). Convert to YYYY-MM-DD."""
    if s is None or (isinstance(s, float) and pd.isna(s)):
        return None
    s = str(s)
    if len(s) == 6:
        return f"20{s[:2]}-{s[2:4]}-{s[4:6]}"
    if len(s) == 8:
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return None


def lit(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--history', type=Path, default=DEFAULT_HISTORY)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--out', type=Path, default=Path('gbfs/d1/load_stations.sql'))
    args = ap.parse_args()

    df = pd.read_parquet(args.history)

    # Reduce spans to one row per canonical station (id0). Sort by `last`
    # (nulls last → most-recent at end), use the last row's name/loc, and
    # take min(first)/max(last) across all spans for the id0.
    df = df.copy()
    df['_last_sort'] = df['last'].fillna('999999')  # nulls treated as "open-ended" → most recent
    df_sorted = df.sort_values(['id0', '_last_sort'])

    def aggregate(group):
        latest = group.iloc[-1]
        firsts = group['first'].dropna()
        lasts = group['last'].dropna()
        return pd.Series({
            'name': latest['name'],
            'lat': latest['lat'],
            'lng': latest['lng'],
            'first_raw': firsts.min() if not firsts.empty else None,
            'last_raw': lasts.max() if not lasts.empty else None,
        })

    canonical = df_sorted.groupby('id0', sort=False).apply(aggregate, include_groups=False).reset_index()
    canonical['first_seen'] = canonical['first_raw'].apply(parse_date)
    canonical['last_seen'] = canonical['last_raw'].apply(parse_date)

    print(f"Building SQL for {len(canonical)} stations from {args.history}", file=sys.stderr)

    now = int(time.time())
    # Use COALESCE to preserve fields written by other loaders (gbfs_station_id,
    # capacity, station_type, in_gbfs).
    upsert_template = """
INSERT INTO stations (short_name, name, lat, lon, first_seen, last_seen, updated_at)
VALUES ({short_name}, {name}, {lat}, {lon}, {first_seen}, {last_seen}, {updated_at})
ON CONFLICT(short_name) DO UPDATE SET
  name = COALESCE(excluded.name, stations.name),
  lat = COALESCE(excluded.lat, stations.lat),
  lon = COALESCE(excluded.lon, stations.lon),
  first_seen = COALESCE(min(stations.first_seen, excluded.first_seen), excluded.first_seen),
  last_seen = COALESCE(max(stations.last_seen, excluded.last_seen), excluded.last_seen),
  updated_at = excluded.updated_at;
""".strip()

    sql_lines = []
    for _, r in canonical.iterrows():
        sql_lines.append(upsert_template.format(
            short_name=lit(r['id0']),
            name=lit(r['name']),
            lat=lit(r['lat']),
            lon=lit(r['lng']),
            first_seen=lit(r['first_seen']),
            last_seen=lit(r['last_seen']),
            updated_at=lit(now),
        ))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text('\n'.join(sql_lines) + '\n')
    print(f"Wrote {len(sql_lines)} statements → {args.out}", file=sys.stderr)

    if args.dry_run:
        return

    print(f"Executing on D1 `{D1_DB}`...", file=sys.stderr)
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', D1_DB, '--remote', '--file', str(args.out.resolve())],
        cwd='gbfs/loader', capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"D1 execute failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    # Parse summary line from JSON output
    print(result.stdout.strip().split('\n')[-1] if result.stdout else 'OK', file=sys.stderr)


if __name__ == '__main__':
    main()
