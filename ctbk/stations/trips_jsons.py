"""Per-station `ymdgtb_cd.json` static files.

Reads all aggregated `ymrgtbs_cd_<ym>.parquet` + `ymrgtbe_cd_<ym>.parquet`
(station-side start + end aggregations), maps historical station IDs to
canonical ones via `station-id-map.json`, and writes one JSON file per
canonical station to `s3/ctbk/stations/ymdgtb/<short_name>.json`.

Each row has shape:
    { Year, Month, Docking: 'start'|'end', Gender, User Type,
      Rideable Type, Count, Duration }

User Type values are remapped `Customer`→`Daily`, `Subscriber`→`Annual`
to match the homepage `ymrgtb_cd.json` convention.

The output directory is DVC-tracked as a single artifact.
"""
import json
import shutil
from glob import glob
from pathlib import Path

import pandas as pd
from utz import err, run

from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd

OUT_DIR = Path('s3/ctbk/stations/ymdgtb')
AGG_DIR = Path('s3/ctbk/aggregated')
ID_MAP = Path('s3/ctbk/stations/station-id-map.json')

OUT_COLS = ['Year', 'Month', 'Docking', 'Gender', 'User Type', 'Rideable Type', 'Count', 'Duration']
SORT_COLS = ['Year', 'Month', 'Docking', 'Gender', 'User Type', 'Rideable Type']


@ctbk.command('station-trips-json', help="Generate per-station ymdgtb_cd.json files from aggregated parquets.")
@git_dvc_cmd
def create(dry_run: bool) -> str | None:
    id_map = json.loads(ID_MAP.read_text())

    frames = []
    for side, letter, sid_col in [
        ('start', 's', 'Start Station ID'),
        ('end', 'e', 'End Station ID'),
    ]:
        files = sorted(glob(str(AGG_DIR / f'ymrgtb{letter}_cd_*.parquet')))
        err(f"Reading {len(files)} {side}-side parquets")
        for f in files:
            df = pd.read_parquet(f)
            df = df.rename(columns={
                sid_col: 'short_name',
                'Start Year': 'Year',
                'Start Month': 'Month',
            })
            df['Docking'] = side
            frames.append(df)

    all_df = pd.concat(frames, ignore_index=True)
    err(f"Concatenated {len(all_df):,} rows")

    all_df['short_name'] = all_df['short_name'].map(id_map)
    all_df['User Type'] = all_df['User Type'].map({'Customer': 'Daily', 'Subscriber': 'Annual'})

    group_cols = ['short_name', *SORT_COLS]
    agg = (
        all_df
        .groupby(group_cols, observed=True, as_index=False)
        [['Count', 'Duration']]
        .sum()
    )
    err(f"Aggregated to {len(agg):,} rows across {agg['short_name'].nunique():,} canonical stations")

    if dry_run:
        err("Dry run, not writing files")
        return None

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    n_stations = 0
    total_bytes = 0
    for short_name, g in agg.groupby('short_name', observed=True):
        rows = (
            g
            .sort_values(SORT_COLS)
            [OUT_COLS]
            .to_dict(orient='records')
        )
        payload = json.dumps(rows, separators=(',', ':'))
        (OUT_DIR / f'{short_name}.json').write_text(payload)
        n_stations += 1
        total_bytes += len(payload)

    avg_bytes = total_bytes / n_stations
    total_mb = total_bytes / 1024 / 1024
    err(f"Wrote {n_stations:,} stations, total {total_mb:.2f} MB, avg {avg_bytes:,.0f} B")

    run('dvx', 'add', str(OUT_DIR), dry_run=dry_run)

    return (
        f"Station trips JSONs ({n_stations:,} stations, "
        f"{total_mb:.1f} MB total, avg {avg_bytes:,.0f} B)"
    )
