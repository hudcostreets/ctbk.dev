"""Per-station raw-ride parquets for the multi-scale time-series backend.

Reads a month of `ConsolidatedMonth` and emits two rows per ride (one for the
start station, one for the end station), keyed by the station's *canonical*
`short_name` (via `s3/ctbk/stations/station-id-map.json`). Each row also
carries `counterpart_short_name` — the canonical short_name of the other
endpoint — so the UI can render a "this station <-> that station" column
and filter by station-pair without joining back to the full consolidated
parquet.

Unlike the other `MonthTable` stages, the output is NOT a monthly parquet:
it's one all-history parquet per station, at
`s3/ctbk/trips/stations/<short_name>.parquet`. The fan-in pattern follows
`ymrgtb_cd.py` / `stations/trips_jsons.py`: iterate every month, group by
canonical `short_name`, write (or rewrite) one file per station.

For incremental updates we rewrite every touched station's file sorted by
`dt` ascending. Whole-history files are small (tens of MB worst case) so the
rewrite churn is acceptable; sort-on-write also gives parquet row groups
free dt-range zone maps, matching the spec's read path.
"""
import json
from glob import glob
from pathlib import Path

import pandas as pd
from pandas import DataFrame
from utz import err

from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd
from ctbk.util.constants import BKT

CONS_DIR = Path(f's3/{BKT}/normalized')
OUT_DIR = Path(f's3/{BKT}/trips/stations')
ID_MAP = Path(f's3/{BKT}/stations/station-id-map.json')

# Output column order. `dt` first so row-group stats are on the right column.
OUT_COLS = [
    'dt',
    'side',
    'short_name',
    'counterpart_short_name',
    'gender',
    'user_type',
    'rideable_type',
    'region',
    'duration_s',
]


def _load_id_map() -> dict[str, str]:
    if not ID_MAP.exists():
        raise RuntimeError(f"Missing {ID_MAP}; run `ctbk station-harmonize create` first")
    return json.loads(ID_MAP.read_text())


def _month_rows(ym: str, id_map: dict[str, str]) -> DataFrame:
    """Read one consolidated-month parquet and emit per-station rows (2 per ride)."""
    pqt = CONS_DIR / f'{ym}.parquet'
    if not pqt.exists():
        raise FileNotFoundError(f"Consolidated month missing: {pqt}")

    cols = [
        'Start Time', 'Stop Time',
        'Start Station ID', 'End Station ID',
        'Start Region', 'End Region',
        'Gender', 'User Type', 'Rideable Type',
    ]
    df = pd.read_parquet(pqt, columns=cols)

    # Duration is (Stop - Start) in whole seconds. Matches `AggregatedMonth`'s
    # `Duration` but in an int64 seconds column (`duration_s`).
    duration_s = ((df['Stop Time'] - df['Start Time']).dt.total_seconds()).astype('int64')

    # Unix-seconds `dt` for start and end sides.
    dt_start = (df['Start Time'].astype('int64') // 1_000_000_000)
    dt_end = (df['Stop Time'].astype('int64') // 1_000_000_000)

    # Canonical short_names for both endpoints (used for `short_name` on one
    # side and `counterpart_short_name` on the other).
    start_sn = df['Start Station ID'].astype(str).map(id_map)
    end_sn = df['End Station ID'].astype(str).map(id_map)

    base = dict(
        gender=df['Gender'],
        user_type=df['User Type'],
        rideable_type=df['Rideable Type'],
        duration_s=duration_s,
    )

    start_df = pd.DataFrame({
        'dt': dt_start,
        'side': 'start',
        'short_name': start_sn,
        'counterpart_short_name': end_sn,
        'region': df['Start Region'],
        **base,
    })
    end_df = pd.DataFrame({
        'dt': dt_end,
        'side': 'end',
        'short_name': end_sn,
        'counterpart_short_name': start_sn,
        'region': df['End Region'],
        **base,
    })

    out = pd.concat([start_df, end_df], ignore_index=True)

    # Drop rows where either endpoint has an unknown id. (If only the
    # counterpart is unknown we'd still be unable to support pair-filtering
    # for that row, so it's cleanest to require both.)
    n_unknown = (out['short_name'].isna() | out['counterpart_short_name'].isna()).sum()
    if n_unknown:
        err(f"{ym}: {n_unknown} rows with unknown station id on either endpoint, dropping")
    out = out.dropna(subset=['short_name', 'counterpart_short_name'])

    return out[OUT_COLS]


def _discover_months() -> list[str]:
    pqts = sorted(CONS_DIR.glob('??????.parquet'))
    return [p.stem for p in pqts]


@ctbk.command('trips-per-station', help="Emit per-canonical-station raw-ride parquets (dt-sorted).")
@git_dvc_cmd
def create(dry_run: bool) -> str | None:
    id_map = _load_id_map()
    months = _discover_months()
    err(f"Processing {len(months)} consolidated months")

    frames = []
    for ym in months:
        err(f"  {ym}")
        frames.append(_month_rows(ym, id_map))

    all_df = pd.concat(frames, ignore_index=True)
    err(f"Total rows: {len(all_df):,}")

    if dry_run:
        err("Dry run, not writing files")
        return None

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    n_stations = 0
    total_bytes = 0
    for short_name, g in all_df.groupby('short_name', observed=True, sort=False):
        out_path = OUT_DIR / f'{short_name}.parquet'
        sorted_g = g.sort_values('dt', kind='mergesort').reset_index(drop=True)
        sorted_g.to_parquet(out_path, index=False)
        n_stations += 1
        total_bytes += out_path.stat().st_size

    total_mb = total_bytes / 1024 / 1024
    avg_bytes = total_bytes / n_stations if n_stations else 0
    err(f"Wrote {n_stations:,} station parquets, total {total_mb:.2f} MB, avg {avg_bytes:,.0f} B")

    return (
        f"Trips-per-station parquets ({n_stations:,} stations, "
        f"{total_mb:.1f} MB total)"
    )
