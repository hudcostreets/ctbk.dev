"""Per-day raw availability bundle.

Phase 3 of `specs/multiscale-timeseries-v2.md` (= `specs/avail-day-raw.md`).
Reads the closed day's 24 per-hour raw shards (`gbfs/avail/h1/<date>/<HH>.parquet`)
and writes a single sorted, row-group-pruned parquet:

    gbfs/avail/raw/day/<YYYY-MM-DD>.parquet

Schema is preserved from the input (station_id, ts, polled_at, the 5 num_*
metric cols, is_installed/renting/returning, last_reported). Sort is
`(station_id, ts)`; row groups via `_write_sorted_parquet` so per-station
queries decode ~10 stations' worth of rows from one row group.

For dates pre-2026-04-20 (before the new per-hour compactor existed), falls
back to the legacy `gbfs/status/<date>.parquet` (compact-r2.py daily output).
Same 12 cols, just unsorted in the legacy file — we re-sort + re-rg as part
of writing the /day raw bundle.

Unlocks fast sub-hour-binned multi-day queries (worker reads N daily files
instead of N×24 hourly shards). See `specs/avail-unified-api.md` for the
worker + FE consumer side.
"""
from pathlib import Path

import pandas as pd
from click import argument
from utz import err

from ctbk.avail_agg import (
    LOCAL_DAILY,
    LOCAL_RAW,
    R2_AVAIL_H1_RAW,
    R2_BUCKET,
    R2_DAILY_RAW,
    _r2_cp_in,
    _r2_sync_in,
    _r2_upload,
    _write_sorted_parquet,
)
from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd

R2_AVAIL_RAW_DAY = f's3://{R2_BUCKET}/gbfs/avail/raw/day'
LOCAL_RAW_DAY = Path(f'r2/{R2_BUCKET}/gbfs/avail/raw/day')


class AvailRawDay:
    NAMES = ['avail_raw_day', 'avr1d']

    def __init__(self, date: str):
        # date = YYYY-MM-DD
        self.date = date

    @property
    def url(self) -> str:
        return str(LOCAL_RAW_DAY / f'{self.date}.parquet')

    def _read_input(self, sync: bool) -> pd.DataFrame:
        # Try the new per-hour compactor's output first.
        raw_dir = LOCAL_RAW / self.date
        if sync:
            _r2_sync_in(f'{R2_AVAIL_H1_RAW}/{self.date}/', raw_dir)
        files = sorted(raw_dir.glob('*.parquet'))
        if files:
            if len(files) < 24:
                err(f"WARNING: {self.date} has only {len(files)} of 24 h1 shards")
            frames = [pd.read_parquet(f) for f in files]
            return pd.concat(frames, ignore_index=True)

        # Fallback: legacy daily parquet (compact-r2.py output, available for
        # dates before the per-hour compactor came online on 2026-04-20). Same
        # 12 cols, just unsorted; we re-sort downstream.
        daily_local = LOCAL_DAILY / f'{self.date}.parquet'
        if sync and not daily_local.exists():
            ok = _r2_cp_in(f'{R2_DAILY_RAW}/{self.date}.parquet', daily_local)
            if not ok:
                raise FileNotFoundError(
                    f"No raw availability data for {self.date}: "
                    f"neither {R2_AVAIL_H1_RAW}/{self.date}/ nor {R2_DAILY_RAW}/{self.date}.parquet"
                )
        if not daily_local.exists():
            raise FileNotFoundError(f"No raw availability data for {self.date}")
        return pd.read_parquet(daily_local)

    def create(self, sync: bool = True, upload: bool = False) -> Path:
        df = self._read_input(sync=sync)
        # Dedupe per the avail-agg comment: GBFS feed updates `last_updated`
        # every 60-90s but our poller runs every 60s, so 30-50% of polls
        # re-report the same `ts`. One row per (station, ts).
        df = df.drop_duplicates(subset=['station_id', 'ts'])
        df = df.sort_values(['station_id', 'ts'], kind='mergesort').reset_index(drop=True)

        out_path = Path(self.url)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Tried `stations_per_rg=1` (≈1440 rows/rg per spec); regressed worker
        # latency 7-13× because hyparquet parses the full footer eagerly and
        # rg-count dominates parse time on CFW. Stick with shared default
        # (10 stations/rg) until the worker switches to range-read metadata.
        _write_sorted_parquet(df, out_path)
        err(f"avail-raw-day {self.date}: {len(df):,} rows, {out_path.stat().st_size/1024/1024:.1f} MB")
        if upload:
            _r2_upload(out_path, f'{R2_AVAIL_RAW_DAY}/{self.date}.parquet')
        return out_path


@ctbk.command('avail-raw-day', help="Build per-day raw availability bundle from h1 shards.")
@argument('date', type=str)  # YYYY-MM-DD
@git_dvc_cmd
def cmd_raw_day(dry_run: bool, date: str) -> str | None:
    stage = AvailRawDay(date=date)
    if dry_run:
        err(f"Dry run: would write {stage.url}")
        return None
    stage.create()
    return f"Avail raw-day bundle: {date}"
