#!/usr/bin/env python3
"""One-time backfill: upsert stations from a local GBFS info JSON.

Going forward, the loader Worker handles this on R2 PutObject events.
Use this for initial load or to force-refresh from a known good snapshot.

Usage:
    aws s3 cp s3://ctbk/gbfs/info/2026-04-12.json /tmp/info.json --profile cf
    load_gbfs_info.py /tmp/info.json
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

D1_DB = 'ctbk-gbfs'


def lit(v) -> str:
    if v is None:
        return 'NULL'
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('info_json', type=Path)
    ap.add_argument('--out', type=Path, default=Path('gbfs/d1/load_gbfs_info.sql'))
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    info = json.loads(args.info_json.read_text())
    stations = info['data']['stations']
    now = int(time.time())

    sql_lines = []
    for s in stations:
        if not s.get('short_name'):
            continue
        sql_lines.append(
            f"INSERT INTO stations (short_name, gbfs_station_id, name, lat, lon, capacity, station_type, in_gbfs, updated_at) "
            f"VALUES ({lit(s['short_name'])}, {lit(s['station_id'])}, {lit(s.get('name'))}, "
            f"{lit(s.get('lat'))}, {lit(s.get('lon'))}, {lit(s.get('capacity'))}, "
            f"{lit(s.get('station_type'))}, 1, {now}) "
            f"ON CONFLICT(short_name) DO UPDATE SET "
            f"gbfs_station_id = excluded.gbfs_station_id, "
            f"name = COALESCE(excluded.name, stations.name), "
            f"lat = COALESCE(excluded.lat, stations.lat), "
            f"lon = COALESCE(excluded.lon, stations.lon), "
            f"capacity = COALESCE(excluded.capacity, stations.capacity), "
            f"station_type = COALESCE(excluded.station_type, stations.station_type), "
            f"in_gbfs = 1, updated_at = excluded.updated_at;"
        )

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
    print('OK', file=sys.stderr)


if __name__ == '__main__':
    main()
