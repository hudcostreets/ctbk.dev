"""Per-day raw availability bundle.

Phase 3 of `specs/multiscale-timeseries-v2.md` (= `specs/avail-day-raw.md`).
Reads the closed day's 24 per-hour raw shards (`gbfs/avail/h1/<date>/<HH>.parquet`)
and writes a single sorted, row-group-pruned parquet:

    gbfs/avail/raw/day/<YYYY-MM-DD>.parquet

Schema is preserved from the input (station_id, ts, polled_at, the 5 num_*
metric cols, is_installed/renting/returning, last_reported). Sort is
`(station_id, ts)`; row groups via `_write_sorted_parquet` so per-station
queries decode ~10 stations' worth of rows from one row group.

Unlocks fast sub-hour-binned multi-day queries (worker reads N daily files
instead of N×24 hourly shards). See `specs/avail-unified-api.md` for the
worker + FE consumer side.
"""
from pathlib import Path

import pandas as pd
from click import argument
from utz import err

from ctbk.avail_agg import (
    LOCAL_RAW,
    R2_AVAIL_H1_RAW,
    R2_BUCKET,
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
        raw_dir = LOCAL_RAW / self.date
        if sync:
            _r2_sync_in(f'{R2_AVAIL_H1_RAW}/{self.date}/', raw_dir)
        files = sorted(raw_dir.glob('*.parquet'))
        if not files:
            raise FileNotFoundError(f"No h1 raw shards for {self.date} at {raw_dir}")
        # Closed-day invariant: expect 24 hourly shards. Warn (don't fail) if
        # fewer — historical days sometimes have gaps from compactor outages.
        if len(files) < 24:
            err(f"WARNING: {self.date} has only {len(files)} of 24 h1 shards")
        frames = [pd.read_parquet(f) for f in files]
        return pd.concat(frames, ignore_index=True)

    def create(self, sync: bool = True, upload: bool = False) -> Path:
        df = self._read_input(sync=sync)
        # Dedupe per the avail-agg comment: GBFS feed updates `last_updated`
        # every 60-90s but our poller runs every 60s, so 30-50% of polls
        # re-report the same `ts`. One row per (station, ts).
        df = df.drop_duplicates(subset=['station_id', 'ts'])
        df = df.sort_values(['station_id', 'ts'], kind='mergesort').reset_index(drop=True)

        out_path = Path(self.url)
        out_path.parent.mkdir(parents=True, exist_ok=True)
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
