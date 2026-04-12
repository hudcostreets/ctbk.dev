#!/usr/bin/env python3
"""Load per-station monthly trip aggregates into D1.

Reads `s3/ctbk/aggregated/ymrsgtb_cd_<ym>.parquet` (start side) and
`ymregtb_cd_<ym>.parquet` (end side), unions into a single table
with `is_start` boolean. Idempotent (uses INSERT OR REPLACE on PK).

Usage:
    load_station_trips_monthly.py                    # all available months
    load_station_trips_monthly.py 202603 202604      # specific months
    load_station_trips_monthly.py --side start       # only start-side
    load_station_trips_monthly.py --dry-run          # generate SQL, don't push
"""
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

D1_DB = 'ctbk-gbfs'
AGG_DIR = Path('s3/ctbk/aggregated')
SQL_OUT = Path('s3/ctbk/aggregated/_d1_load.sql')

# DVC-tracked: actual files only present after `dvc pull`. The .dvc files
# tell us which ms we have data for.
START_PATTERN = re.compile(r'^ymrsgtb_cd_(\d{6})\.parquet(\.dvc)?$')
END_PATTERN = re.compile(r'^ymregtb_cd_(\d{6})\.parquet(\.dvc)?$')


def lit(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    if isinstance(v, (int, float)):
        return str(int(v) if isinstance(v, int) or v == int(v) else v)
    return "'" + str(v).replace("'", "''") + "'"


def discover_months(side: str) -> list[str]:
    pat = START_PATTERN if side == 'start' else END_PATTERN
    months = set()
    for f in AGG_DIR.iterdir():
        m = pat.match(f.name)
        if m:
            months.add(m.group(1))
    return sorted(months)


def parquet_path(ym: str, side: str) -> Path:
    name = f'ymrsgtb_cd_{ym}.parquet' if side == 'start' else f'ymregtb_cd_{ym}.parquet'
    return AGG_DIR / name


def load_month_side(ym: str, side: str) -> tuple[pd.DataFrame, list[str]]:
    """Return (rows_df, sql_lines) for one month/side. Empty if file not present."""
    pq = parquet_path(ym, side)
    if not pq.exists():
        return pd.DataFrame(), []

    df = pd.read_parquet(pq)
    # Schema check: should have columns we care about
    # Common ymrgtb columns: ym, region (r), gender (g), user_type (t), bike_type (b),
    # plus the side-specific station id (s_id or e_id), plus count + duration.
    # The aggregated parquet column names depend on ctbk's `agg` impl. Try common variants.
    station_col = None
    for cand in ('Start Station ID', 'End Station ID', 'start_station_id', 'end_station_id', 's', 'e'):
        if cand in df.columns:
            station_col = cand
            break
    if station_col is None:
        print(f"WARNING: {pq}: couldn't find station_id column. Columns: {list(df.columns)}", file=sys.stderr)
        return pd.DataFrame(), []

    is_start = 1 if side == 'start' else 0

    # Best-effort column renaming
    rename = {
        station_col: 'short_name',
        'Year': 'year',
        'Month': 'month',
        'Region': 'region',
        'Gender': 'gender',
        'User Type': 'user_type',
        'Rideable Type': 'bike_type',
        'Count': 'trips',
        'Duration': 'duration_s',
    }
    df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})

    # Build ym from year+month if not already a column
    if 'ym' not in df.columns:
        if 'year' in df.columns and 'month' in df.columns:
            df['ym'] = df['year'].astype(str) + df['month'].astype(int).astype(str).str.zfill(2)
        else:
            df['ym'] = ym  # fallback

    df['is_start'] = is_start

    # Ensure required columns exist
    for col in ('region', 'gender', 'user_type', 'bike_type'):
        if col not in df.columns:
            df[col] = None
    if 'trips' not in df.columns:
        print(f"WARNING: {pq}: no Count column. Columns: {list(df.columns)}", file=sys.stderr)
        return pd.DataFrame(), []
    if 'duration_s' not in df.columns:
        df['duration_s'] = 0

    cols = ['short_name', 'ym', 'is_start', 'region', 'gender', 'user_type', 'bike_type', 'trips', 'duration_s']
    df = df[cols]

    sql_lines = []
    for _, r in df.iterrows():
        sql_lines.append(
            f"INSERT OR REPLACE INTO station_trips_monthly "
            f"(short_name, ym, is_start, region, gender, user_type, bike_type, trips, duration_s) VALUES ("
            f"{lit(r['short_name'])}, {lit(r['ym'])}, {is_start}, "
            f"{lit(r['region'])}, {lit(r['gender'])}, {lit(r['user_type'])}, {lit(r['bike_type'])}, "
            f"{int(r['trips'])}, {int(r['duration_s'])});"
        )
    return df, sql_lines


def execute_sql(sql_path: Path):
    """Run a .sql file against D1."""
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', D1_DB, '--remote', '--file', str(sql_path.resolve())],
        cwd='gbfs/loader', capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"D1 execute failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('months', nargs='*', help='Specific YYYYMM months (default: all available)')
    ap.add_argument('--side', choices=['start', 'end', 'both'], default='both')
    ap.add_argument('--dry-run', action='store_true', help='Write SQL, do not execute')
    ap.add_argument('--out', type=Path, default=SQL_OUT)
    args = ap.parse_args()

    sides = ['start', 'end'] if args.side == 'both' else [args.side]

    target_months = set(args.months) if args.months else None
    now = int(time.time())

    for side in sides:
        all_months = discover_months(side)
        months = sorted(set(all_months) & target_months) if target_months else all_months
        print(f"[{side}] {len(months)} months to load", file=sys.stderr)

        total_rows = 0
        for i, ym in enumerate(months, 1):
            df, sql_lines = load_month_side(ym, side)
            if not sql_lines:
                continue

            sql_lines.append(
                f"INSERT OR REPLACE INTO trips_loaded (ym, is_start, loaded_at, row_count) VALUES "
                f"({lit(ym)}, {1 if side == 'start' else 0}, {now}, {len(sql_lines)});"
            )

            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text('\n'.join(sql_lines) + '\n')

            if args.dry_run:
                print(f"  [{i}/{len(months)}] {ym}: {len(df)} rows -> SQL written to {args.out}", file=sys.stderr)
            else:
                print(f"  [{i}/{len(months)}] {ym}: loading {len(df)} rows...", file=sys.stderr)
                execute_sql(args.out)

            total_rows += len(df)

        print(f"[{side}] Total: {total_rows} rows across {len(months)} months", file=sys.stderr)


if __name__ == '__main__':
    main()
