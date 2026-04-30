"""Multi-scale sum-monoid aggregator for trips data (v2).

Per `specs/trips-agg.md` — the trips-side analog of `ctbk avail_agg`,
v2-aligned with calendar-anchored big files + per-station row-group pruning.

Pyramid:

    consolidated <YYYY-MM>.parquet           (existing source — 1 row/ride)
        ↓ groupby(hour, all dims) + sum
    trips/agg/h1/<YYYY-MM>.parquet           (1-hour bins, monthly file)
        ↓ groupby(day, all dims) + sum
    trips/agg/d1/<YYYY>.parquet              (1-day bins, yearly file)
        ↓ groupby(month, all dims) + sum
    trips/agg/mo1/<DECADE>.parquet           (1-month bins, decade file
                                              — decade = floor(year/10)*10)

Schema (long format, sum monoid `(n, sum, sum_sq)` so worker can derive
mean / stddev / etc on duration):

    dt              int64    bucket start, unix-s (UTC)
    short_name      string   canonical station short_name
    side            string   'start' | 'end'
    region          string   'NYC' | 'JC' | 'HB' | …
    gender          int16    0 (unknown) | 1 (male) | 2 (female)
    user_type       string   'Subscriber' | 'Customer' | …
    rideable_type   string   'classic_bike' | 'electric_bike' | …
    count           int64    # trips
    duration_s      int64    sum(duration_seconds)
    duration_s_sq   int64    sum(duration_seconds**2)

Each consolidated trip contributes TWO rows (`side='start'` and `side='end'`)
keyed off the canonical short_name of the corresponding endpoint. Consumers
that want unique trips should `groupby('side').sum()` or filter `side='start'`.

Cross-month-tail behaviour: a trip starting on day D and ending on day D+1
contributes a `start` row to D's shard and an `end` row to D+1's shard.
For h1 we therefore read cons[month(date)] AND cons[next_month] (start-side
rows for late-month trips spill into next month's consolidated parquet).

Sort: `(short_name, dt, side, region, gender, user_type, rideable_type)` so
each station's slice of any one file lives in one row group, allowing exact
per-station row-group pruning at query time.
"""
import json
from glob import glob
from pathlib import Path

import pandas as pd
from click import argument
from pandas import DataFrame
from utz import err
from utz.ym import YM

from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd
from ctbk.util.constants import BKT

# Source: consolidated month parquets (one row per ride).
CONS_DIR = Path(f's3/{BKT}/normalized')
ID_MAP = Path(f's3/{BKT}/stations/station-id-map.json')

# Outputs land in r2/ mirror — synced to CF R2, not the AWS S3 data-lake.
OUT_DIR = Path(f'r2/{BKT}/trips/agg')

OUT_COLS = [
    'dt',
    'short_name',
    'side',
    'region',
    'gender',
    'user_type',
    'rideable_type',
    'count',
    'duration_s',
    'duration_s_sq',
]
GROUP_COLS = [c for c in OUT_COLS if c not in ('count', 'duration_s', 'duration_s_sq')]
SUM_COLS = ['count', 'duration_s', 'duration_s_sq']
SORT_COLS = ['short_name', 'dt', 'side', 'region', 'gender', 'user_type', 'rideable_type']

HOUR_S = 3600
DAY_S = 86400

# Row-group sizing: ~10 stations per rg (matches `ctbk/avail_agg.py`'s
# `_write_sorted_parquet`). Per-station queries decode 10× the minimum
# but avoid footer-bloat from 1-rg-per-station.
STATIONS_PER_RG = 10


def _load_id_map() -> dict[str, str]:
    if not ID_MAP.exists():
        raise RuntimeError(f"Missing {ID_MAP}; run `ctbk station-harmonize create` first")
    return json.loads(ID_MAP.read_text())


def _expand_month_to_sides(ym: YM, id_map: dict[str, str]) -> DataFrame:
    """Read one consolidated month, fan to per-side rows, return raw frame.

    Output schema (NOT yet aggregated):
        dt:int64 (start- or end-time floored to hour),
        short_name, side, region, gender, user_type, rideable_type,
        duration_s:int64, duration_s_sq:int64

    The `count` column is implicit (one row per ride per side); we add it at
    aggregation time. Drops rows with unknown station IDs.
    """
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

    duration_s = ((df['Stop Time'] - df['Start Time']).dt.total_seconds()).astype('int64')
    duration_s_sq = (duration_s.astype('int64') ** 2).astype('int64')
    # Resolution-independent dt cast — same trick as `trips_region_rollup.py`.
    dt_start = df['Start Time'].values.astype('datetime64[s]').astype('int64')
    dt_end = df['Stop Time'].values.astype('datetime64[s]').astype('int64')
    dt_start_h = (dt_start // HOUR_S) * HOUR_S
    dt_end_h = (dt_end // HOUR_S) * HOUR_S

    start_sn = df['Start Station ID'].astype(str).map(id_map)
    end_sn = df['End Station ID'].astype(str).map(id_map)

    gender = df['Gender'].astype('int16')

    start_df = pd.DataFrame({
        'dt': dt_start_h,
        'short_name': start_sn,
        'side': 'start',
        'region': df['Start Region'],
        'gender': gender,
        'user_type': df['User Type'],
        'rideable_type': df['Rideable Type'],
        'duration_s': duration_s,
        'duration_s_sq': duration_s_sq,
    })
    end_df = pd.DataFrame({
        'dt': dt_end_h,
        'short_name': end_sn,
        'side': 'end',
        'region': df['End Region'],
        'gender': gender,
        'user_type': df['User Type'],
        'rideable_type': df['Rideable Type'],
        'duration_s': duration_s,
        'duration_s_sq': duration_s_sq,
    })

    out = pd.concat([start_df, end_df], ignore_index=True)
    n_unknown = out['short_name'].isna().sum()
    if n_unknown:
        err(f"  {ym}: {n_unknown} rows with unknown station id, dropping")
    out = out.dropna(subset=['short_name'])
    return out


def _agg(df: DataFrame) -> DataFrame:
    """groupby all dims → sum(count, duration_s, duration_s_sq).

    `count` is synthesized as 1-per-input-row.
    """
    g = (
        df.assign(count=1)
          .groupby(GROUP_COLS, observed=True, sort=False, dropna=False)
          .agg(
              count=('count', 'sum'),
              duration_s=('duration_s', 'sum'),
              duration_s_sq=('duration_s_sq', 'sum'),
          )
          .reset_index()
    )
    return _finalize(g)


def _finalize(g: DataFrame) -> DataFrame:
    """Cast monoid cols + sort → final shape ready to write."""
    for c in SUM_COLS:
        g[c] = g[c].astype('int64')
    g['gender'] = g['gender'].astype('int16')
    return (
        g[OUT_COLS]
         .sort_values(SORT_COLS, kind='mergesort')
         .reset_index(drop=True)
    )


def _rebucket(agg: DataFrame, bucket_s: int) -> DataFrame:
    """Re-bucket a finer-grain agg up to a coarser one (sum-monoid + groupby)."""
    a = agg.copy()
    a['dt'] = ((a['dt'] // bucket_s) * bucket_s).astype('int64')
    out = (
        a.groupby(GROUP_COLS, observed=True, sort=False, dropna=False)
         .agg(
             count=('count', 'sum'),
             duration_s=('duration_s', 'sum'),
             duration_s_sq=('duration_s_sq', 'sum'),
         )
         .reset_index()
    )
    return _finalize(out)


def _rebucket_to_month(agg: DataFrame) -> DataFrame:
    """Re-bucket day-grain agg to month-grain (calendar-aligned UTC)."""
    a = agg.copy()
    ts = pd.to_datetime(a['dt'], unit='s', utc=True)
    month_start = ts.dt.tz_convert('UTC').values.astype('datetime64[M]').astype('datetime64[s]').astype('int64')
    a['dt'] = month_start
    out = (
        a.groupby(GROUP_COLS, observed=True, sort=False, dropna=False)
         .agg(
             count=('count', 'sum'),
             duration_s=('duration_s', 'sum'),
             duration_s_sq=('duration_s_sq', 'sum'),
         )
         .reset_index()
    )
    return _finalize(out)


def _write_sorted_parquet(df: DataFrame, out_path: Path) -> None:
    """Write `df` sorted by `(short_name, dt, …)` with row groups holding
    ~`STATIONS_PER_RG` stations' rows, so per-station queries prune to ≤1 rg.

    No-ops cleanly on empty DataFrame (writes a 0-row parquet with schema only).
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = len(df)
    if n == 0:
        df.to_parquet(out_path, index=False)
        return
    n_stations = df['short_name'].nunique()
    # +20% slack for variance in per-station row count. Floor at 100.
    rg = max(100, int((n / max(1, n_stations)) * STATIONS_PER_RG * 1.2))
    df.to_parquet(out_path, index=False, engine='pyarrow', row_group_size=rg, compression='snappy')


# ---- h1: 1-hour buckets, packaged per month --------------------------------

class TripsAggH1Month:
    """Build the h1 monthly file for a YYYY-MM.

    Reads cons[ym] AND cons[next_month] (for trips that started in ym but
    ended in the next month — they appear in next month's consolidated). Then
    aggregates to hourly buckets, filters to ym's UTC window, and writes one
    file: `trips/agg/h1/<YYYY-MM>.parquet`.
    """
    NAMES = ['trips_agg_h1_month', 'trh1']

    def __init__(self, ym: YM):
        self.ym = YM(ym)

    @property
    def url(self) -> str:
        ym_dashed = f'{self.ym}'[:4] + '-' + f'{self.ym}'[4:6]
        return str(OUT_DIR / 'h1' / f'{ym_dashed}.parquet')

    def _input_months(self) -> list[YM]:
        ms = [self.ym]
        nxt = self.ym + 1
        nxt_path = CONS_DIR / f'{nxt}.parquet'
        if nxt_path.exists():
            ms.append(nxt)
        return ms

    def create(self) -> Path:
        id_map = _load_id_map()
        frames = [_expand_month_to_sides(m, id_map) for m in self._input_months()]
        df = pd.concat(frames, ignore_index=True)
        agg = _agg(df)

        ym_str = f'{self.ym}'
        ym_start = pd.Timestamp(f'{ym_str[:4]}-{ym_str[4:6]}-01', tz='UTC')
        ym_end = ym_start + pd.offsets.MonthBegin(1)
        ym_start_s = int(ym_start.timestamp())
        ym_end_s = int(ym_end.timestamp())
        in_month = (agg['dt'] >= ym_start_s) & (agg['dt'] < ym_end_s)
        agg_ym = agg[in_month].copy()

        out_path = Path(self.url)
        _write_sorted_parquet(agg_ym, out_path)
        size_kb = out_path.stat().st_size / 1024
        err(f"trips-agg h1 {self.ym}: {len(agg_ym):,} rows, {size_kb:.1f} KB")
        return out_path


# ---- d1: 1-day buckets, packaged per year ----------------------------------

class TripsAggD1Year:
    NAMES = ['trips_agg_d1_year', 'trd1']

    def __init__(self, year: int):
        self.year = int(year)

    @property
    def url(self) -> str:
        return str(OUT_DIR / 'd1' / f'{self.year}.parquet')

    def _h1_paths(self) -> list[Path]:
        return sorted((OUT_DIR / 'h1').glob(f'{self.year}-??.parquet'))

    def create(self) -> Path:
        files = self._h1_paths()
        if not files:
            raise FileNotFoundError(
                f"No h1 shards for {self.year} at {OUT_DIR/'h1'} (build h1 first)"
            )
        h1 = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
        d1 = _rebucket(h1, DAY_S)

        out_path = Path(self.url)
        _write_sorted_parquet(d1, out_path)
        size_kb = out_path.stat().st_size / 1024
        err(f"trips-agg d1 {self.year}: {len(d1):,} rows from {len(files)} h1 files, {size_kb:.1f} KB")
        return out_path


# ---- mo1: 1-month buckets, packaged per decade -----------------------------

class TripsAggMo1Decade:
    NAMES = ['trips_agg_mo1_decade', 'trmo1']

    def __init__(self, decade: int):
        # decade = floor(year/10)*10, e.g. 2010 covers 2010-2019.
        self.decade = int(decade)
        if self.decade % 10:
            raise ValueError(f"decade must be a multiple of 10; got {self.decade}")

    @property
    def url(self) -> str:
        return str(OUT_DIR / 'mo1' / f'{self.decade}.parquet')

    def _d1_paths(self) -> list[Path]:
        out: list[Path] = []
        for y in range(self.decade, self.decade + 10):
            p = OUT_DIR / 'd1' / f'{y}.parquet'
            if p.exists():
                out.append(p)
        return out

    def create(self) -> Path:
        files = self._d1_paths()
        if not files:
            raise FileNotFoundError(
                f"No d1 shards for decade {self.decade} (looking for {self.decade}…{self.decade+9} in {OUT_DIR/'d1'})"
            )
        d1 = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
        mo1 = _rebucket_to_month(d1)

        out_path = Path(self.url)
        _write_sorted_parquet(mo1, out_path)
        size_kb = out_path.stat().st_size / 1024
        err(f"trips-agg mo1 {self.decade}s: {len(mo1):,} rows from {len(files)} d1 files, {size_kb:.1f} KB")
        return out_path


# --- CLI ---

@ctbk.command('trips-agg-h1', help="Build h1 (1-hour bucket, 1-month file) trips agg.")
@argument('ym', type=str)  # YYYY-MM or YYYYMM
@git_dvc_cmd
def cmd_h1(dry_run: bool, ym: str) -> str | None:
    if len(ym) == 7 and ym[4] == '-':
        ymo = YM(ym[:4] + ym[5:7])
    else:
        ymo = YM(ym)
    stage = TripsAggH1Month(ym=ymo)
    if dry_run:
        err(f"Dry run: would write {stage.url}"); return None
    stage.create()
    return f"trips-agg h1: {ymo}"


@ctbk.command('trips-agg-d1', help="Build d1 (1-day bucket, 1-year file) trips agg.")
@argument('year', type=int)
@git_dvc_cmd
def cmd_d1(dry_run: bool, year: int) -> str | None:
    stage = TripsAggD1Year(year=year)
    if dry_run:
        err(f"Dry run: would write {stage.url}"); return None
    stage.create()
    return f"trips-agg d1: {year}"


@ctbk.command('trips-agg-mo1', help="Build mo1 (1-month bucket, 1-decade file) trips agg.")
@argument('decade', type=int)
@git_dvc_cmd
def cmd_mo1(dry_run: bool, decade: int) -> str | None:
    stage = TripsAggMo1Decade(decade=decade)
    if dry_run:
        err(f"Dry run: would write {stage.url}"); return None
    stage.create()
    return f"trips-agg mo1: {decade}s"
