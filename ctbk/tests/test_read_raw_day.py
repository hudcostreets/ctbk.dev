from pathlib import Path

import pandas as pd
import pytest

from ctbk.avail_agg import RAW_COLS, read_raw_day

DATE = '2026-07-15'


def poll_rows(ts: int, src: str, dtype: str) -> pd.DataFrame:
    """One poll of two stations; `src` tags which input a row came from (via
    `last_reported`, so it survives `RAW_COLS` selection)."""
    tag = {'h1': 1, 'daily': 2}[src]
    df = pd.DataFrame({
        'station_id': ['a', 'b'],
        'ts': [ts, ts],
        'polled_at': [ts + 5, ts + 5],
        'num_bikes_available': [3, 4],
        'num_ebikes_available': [1, 0],
        'num_docks_available': [7, 6],
        'num_bikes_disabled': [0, 0],
        'num_docks_disabled': [0, 1],
        'is_installed': [1, 1],
        'is_renting': [1, 1],
        'is_returning': [1, 1],
        'last_reported': [tag, tag],
    })
    return df.astype({c: dtype for c in df.columns if c.startswith(('num_', 'is_'))})


def seed(tmp_path: Path, hours: list[int], daily: bool) -> tuple[Path, Path]:
    h1_dir, daily_dir = tmp_path / 'h1', tmp_path / 'daily'
    (h1_dir / DATE).mkdir(parents=True)
    daily_dir.mkdir()
    base = 1_784_073_600  # 2026-07-15T00:00Z
    for h in hours:
        poll_rows(base + h * 3600, 'h1', 'int32').to_parquet(h1_dir / DATE / f'{h:02d}.parquet')
    if daily:
        df = pd.concat([poll_rows(base + h * 3600, 'daily', 'int16') for h in range(24)], ignore_index=True)
        df['vehicle_types_available'] = '{}'
        df.to_parquet(daily_dir / f'{DATE}.parquet')
    return h1_dir, daily_dir


def summary(df: pd.DataFrame) -> tuple[list[str], int, set[int], set[str]]:
    return list(df.columns), len(df), set(df.last_reported), {str(df[c].dtype) for c in df.columns if c.startswith(('num_', 'is_'))}


def test_all_24_hourly_shards(tmp_path):
    h1_dir, daily_dir = seed(tmp_path, list(range(24)), daily=True)
    df = read_raw_day(DATE, sync=False, h1_dir=h1_dir, daily_dir=daily_dir)
    assert summary(df) == (RAW_COLS, 48, {1}, {'int32'})


def test_partial_hourly_reads_daily(tmp_path):
    h1_dir, daily_dir = seed(tmp_path, [h for h in range(24) if h != 7], daily=True)
    df = read_raw_day(DATE, sync=False, h1_dir=h1_dir, daily_dir=daily_dir)
    assert summary(df) == (RAW_COLS, 48, {2}, {'int32'})


def test_no_hourly_reads_daily_cols(tmp_path):
    h1_dir, daily_dir = seed(tmp_path, [], daily=True)
    df = read_raw_day(DATE, cols=['station_id', 'ts', 'num_bikes_available'], sync=False, h1_dir=h1_dir, daily_dir=daily_dir)
    assert (list(df.columns), len(df), str(df.num_bikes_available.dtype)) == (['station_id', 'ts', 'num_bikes_available'], 48, 'int32')


def test_partial_hourly_without_daily(tmp_path):
    h1_dir, daily_dir = seed(tmp_path, [0, 1], daily=False)
    df = read_raw_day(DATE, sync=False, h1_dir=h1_dir, daily_dir=daily_dir)
    assert summary(df) == (RAW_COLS, 4, {1}, {'int32'})


def test_no_input(tmp_path):
    h1_dir, daily_dir = seed(tmp_path, [], daily=False)
    with pytest.raises(FileNotFoundError, match=f'No raw availability data for {DATE}'):
        read_raw_day(DATE, sync=False, h1_dir=h1_dir, daily_dir=daily_dir)
