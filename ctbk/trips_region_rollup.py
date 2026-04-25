"""Region-sharded pre-aggregated trips parquets for the multi-scale backend.

Two stages, both fanning in from the existing `AggregatedMonth` output:

- `TripsRegionH1Year(region, year)`
  Reads 12 months of `AggregatedMonth(ym, 'ymdhrgtb', 'cd')`, filters to
  `region`, writes one parquet per (region, year) at
  `s3/ctbk/trips/region/<region>/h1/<YYYY>.parquet`.

- `TripsRegionN1Month(region, year, month)`
  Reads 1 month of `AggregatedMonth(ym, 'ymdhnrgtb', 'cd')` (where `n` is the
  new minute-grouping), filters to `region`, writes one parquet per
  (region, year-month) at
  `s3/ctbk/trips/region/<region>/n1/<YYYYMM>.parquet`.

Schema (both stages; only `dt` granularity differs):

    dt             int64   unix seconds of the bucket start
    gender         str     passthrough
    user_type      str     passthrough (NOT remapped to Daily/Annual here;
                           consumers can do that when needed)
    rideable_type  str     passthrough
    count          int64   sum
    duration_s     int64   sum of ride durations in seconds

Rows are sorted by `dt` ascending so parquet row-group stats give readers a
free dt zone-map, matching the Worker's range-filter strategy.
"""
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from click import argument, option
from pandas import DataFrame
from utz import err
from utz.ym import YM

from ctbk.aggregated import AggregatedMonth
from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd
from ctbk.util.constants import BKT

# `r2/` rather than `s3/` because these outputs land in CF R2, not the
# AWS S3 data-lake. Synced via `aws s3 sync r2/ s3://ctbk/ --profile cf`.
OUT_DIR = Path(f'r2/{BKT}/trips/region')
REGIONS = ('NYC', 'JC', 'HB')  # canonical region values as they appear in the parquets

OUT_COLS = [
    'dt',
    'gender',
    'user_type',
    'rideable_type',
    'count',
    'duration_s',
]


def _bucket_dt_hour(df: DataFrame) -> pd.Series:
    """Build a unix-seconds `dt` column from Year/Month/Day/Hour group keys."""
    ts = pd.to_datetime(dict(
        year=df['Start Year'],
        month=df['Start Month'],
        day=df['Start Day'],
        hour=df['Start Hour'],
    ), utc=True)
    return pd.array(ts.values.astype('datetime64[s]').astype('int64'), dtype='int64')


def _bucket_dt_minute(df: DataFrame) -> pd.Series:
    ts = pd.to_datetime(dict(
        year=df['Start Year'],
        month=df['Start Month'],
        day=df['Start Day'],
        hour=df['Start Hour'],
        minute=df['Start Minute'],
    ), utc=True)
    return pd.array(ts.values.astype('datetime64[s]').astype('int64'), dtype='int64')


def _normalize_region(region: str) -> str:
    """Normalize a region label for filename / URL use."""
    return region.lower().replace('hb', 'hob')


def _shape(df: DataFrame, dt: pd.Series) -> DataFrame:
    return (
        DataFrame({
            'dt': dt,
            'gender': df['Gender'],
            'user_type': df['User Type'],
            'rideable_type': df['Rideable Type'],
            'count': df['Count'].astype('int64'),
            'duration_s': df['Duration'].astype('int64'),
        })
        [OUT_COLS]
        .sort_values('dt', kind='mergesort')
        .reset_index(drop=True)
    )


class TripsRegionH1Year:
    """Hour-level region rollup, one file per (region, year)."""
    NAMES = ['trips_region_h1_year', 'trh1']

    def __init__(self, region: str, year: int):
        self.region = region
        self.year = int(year)

    @property
    def url(self) -> str:
        return str(OUT_DIR / _normalize_region(self.region) / 'h1' / f'{self.year}.parquet')

    def _df(self) -> DataFrame:
        frames = []
        for m in range(1, 13):
            ym = YM(self.year * 100 + m)
            am = AggregatedMonth(ym, 'ymdhrgtb', 'cd')
            try:
                mdf = am.read()
            except FileNotFoundError:
                err(f"  {ym}: no aggregated input, skipping")
                continue
            mdf = mdf[mdf['Region'] == self.region]
            if mdf.empty:
                continue
            frames.append(mdf)
        if not frames:
            return DataFrame(columns=OUT_COLS)
        df = pd.concat(frames, ignore_index=True)
        return _shape(df, _bucket_dt_hour(df))

    def create(self) -> Path:
        df = self._df()
        out = Path(self.url)
        out.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(out, index=False)
        err(f"Wrote {out} ({len(df):,} rows)")
        return out


class TripsRegionN1Month:
    """Minute-level region rollup, one file per (region, year-month)."""
    NAMES = ['trips_region_n1_month', 'trn1']

    def __init__(self, region: str, ym: YM):
        self.region = region
        self.ym = YM(ym)

    @property
    def url(self) -> str:
        return str(OUT_DIR / _normalize_region(self.region) / 'n1' / f'{self.ym}.parquet')

    def _df(self) -> DataFrame:
        am = AggregatedMonth(self.ym, 'ymdhnrgtb', 'cd')
        df = am.read()
        df = df[df['Region'] == self.region]
        if df.empty:
            return DataFrame(columns=OUT_COLS)
        return _shape(df, _bucket_dt_minute(df))

    def create(self) -> Path:
        df = self._df()
        out = Path(self.url)
        out.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(out, index=False)
        err(f"Wrote {out} ({len(df):,} rows)")
        return out


# --- CLI ---

region_opt = option(
    '-r', '--region',
    type=str, required=True,
    help=f"Region to filter by ({'|'.join(REGIONS)}).",
)


@ctbk.command('trips-region-h1', help="Build hour-level region rollup for a (region, year).")
@region_opt
@argument('year', type=int)
@git_dvc_cmd
def create_h1(dry_run: bool, region: str, year: int) -> str | None:
    stage = TripsRegionH1Year(region=region, year=year)
    if dry_run:
        err(f"Dry run: would write {stage.url}")
        return None
    stage.create()
    return f"Trips region h1 rollup: {region} {year}"


@ctbk.command('trips-region-n1', help="Build minute-level region rollup for a (region, YYYYMM).")
@region_opt
@argument('ym', type=str)
@git_dvc_cmd
def create_n1(dry_run: bool, region: str, ym: str) -> str | None:
    stage = TripsRegionN1Month(region=region, ym=ym)
    if dry_run:
        err(f"Dry run: would write {stage.url}")
        return None
    stage.create()
    return f"Trips region n1 rollup: {region} {stage.ym}"
