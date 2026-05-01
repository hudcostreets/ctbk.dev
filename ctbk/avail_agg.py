"""State-histogram aggregator for GBFS availability data.

Phase 2 of `specs/multiscale-timeseries-backend.md`. Reads the new compactor's
hourly raw shards (`gbfs/avail/h1/<YYYY-MM-DD>/<HH>.parquet`, one row per
station per minute poll) and emits state-histogram parquets in long format:

    dt              int64    bucket start, unix-s
    station_id      string   GBFS UUID
    metric          string   "bikes" | "ebikes" | "docks" | "disabled" | "pending"
    state           int16    metric value (e.g. # bikes available)
    minutes         int32    minutes spent in that state during the bucket

Per the P0 EDA: marginal × 5 (one row per `(metric, state)` cell, not joint
5-tuple). Sparse — states with zero minutes are not stored.

Stages:
- `AvailAggH1Day(date)`     -> avail/agg/h1/<YYYY-MM-DD>.parquet  (1-hour buckets)
- `AvailAggD1Month(ym)`     -> avail/agg/d1/<YYYY-MM>.parquet     (1-day buckets)
- `AvailAggMo1Year(year)`   -> avail/agg/mo1/<YYYY>.parquet       (1-month buckets)

Coarser tiers consume finer ones (h1 -> d1 -> mo1) so we read raw at most
once per pyramid build. Histograms are pointwise additive on `(dt, station_id,
metric, state)` so the merge is a `groupby().sum()`.
"""
import subprocess
from pathlib import Path

import pandas as pd
from click import argument
from pandas import DataFrame
from utz import err

from ctbk.cli.base import ctbk
from ctbk.cli.git_dvc_cmd import git_dvc_cmd
from ctbk.util.constants import BKT

R2_BUCKET = BKT
R2_AVAIL_H1_RAW = f's3://{R2_BUCKET}/gbfs/avail/h1'  # input: per-hour raw shards (new compactor, 2026-04-20+)
R2_DAILY_RAW = f's3://{R2_BUCKET}/gbfs/status'       # input: per-day raw parquet (legacy `compact-r2.py`)
R2_AVAIL_AGG = f's3://{R2_BUCKET}/avail/agg'        # output: histogram tiers

LOCAL_RAW = Path(f'r2/{R2_BUCKET}/gbfs/avail/h1')    # hourly input mirror
LOCAL_DAILY = Path(f'r2/{R2_BUCKET}/gbfs/status')    # daily input mirror
LOCAL_AGG = Path(f'r2/{R2_BUCKET}/avail/agg')        # output mirror

# Map raw column name -> canonical metric name (spec §Storage layout).
METRIC_COLS = {
    'num_bikes_available': 'bikes',
    'num_ebikes_available': 'ebikes',
    'num_docks_available': 'docks',
    'num_bikes_disabled': 'disabled',
    'num_docks_disabled': 'pending',
}

OUT_COLS = ['dt', 'station_id', 'metric', 'state', 'minutes']


def _r2_sync_in(remote_prefix: str, local_dir: Path):
    """Download from R2 to local mirror via aws s3 sync."""
    local_dir.mkdir(parents=True, exist_ok=True)
    cmd = ['aws', 's3', 'sync', remote_prefix, str(local_dir)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"aws s3 sync failed: {res.stderr}")


def _r2_cp_in(remote_uri: str, local_path: Path) -> bool:
    """Download one R2 object to a local file. Returns False if 404."""
    local_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ['aws', 's3', 'cp', remote_uri, str(local_path)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        return True
    # 404 / NoSuchKey → return False so caller can fall back.
    err_text = res.stderr or res.stdout
    if 'NoSuchKey' in err_text or '404' in err_text or 'does not exist' in err_text:
        return False
    raise RuntimeError(f"aws s3 cp failed: {err_text}")


def _r2_upload(local_path: Path, remote_uri: str):
    """Upload one file to R2."""
    cmd = ['aws', 's3', 'cp', str(local_path), remote_uri]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"aws s3 cp failed: {res.stderr}")


def _aggregate_to_histogram(df: DataFrame, dt_col: str = 'dt') -> DataFrame:
    """Long-format histogram from a poll-grain frame.

    Input must have `station_id`, `dt_col` (already bucketed), and the 5 raw
    metric columns. Each input row contributes 1 minute (or 1 sub-bucket
    weight when called from the d1/mo1 stages with pre-aggregated inputs —
    see `_rebucket()` for that path).

    Returns rows in the canonical `OUT_COLS` order, sorted by
    `(station_id, dt, metric, state)`. Sort order is critical: row-group
    min/max stats on `station_id` give the API row-group pruning for
    per-station queries (see specs/multiscale-timeseries-v2.md).
    """
    frames = []
    for col, metric in METRIC_COLS.items():
        if col not in df.columns:
            continue
        g = (
            df.groupby([dt_col, 'station_id', col], as_index=False, observed=True)
              .size()
              .rename(columns={dt_col: 'dt', col: 'state', 'size': 'minutes'})
        )
        g['metric'] = metric
        frames.append(g[OUT_COLS])
    if not frames:
        return DataFrame(columns=OUT_COLS)
    out = pd.concat(frames, ignore_index=True)
    out['state'] = out['state'].astype('int16')
    out['minutes'] = out['minutes'].astype('int32')
    return (
        out.sort_values(['station_id', 'dt', 'metric', 'state'], kind='mergesort')
           .reset_index(drop=True)
    )


def _rebucket(agg: DataFrame, bucket_s: int) -> DataFrame:
    """Re-bucket a finer-grain histogram up to a coarser-grain one.

    Histograms are pointwise additive on `(dt, station_id, metric, state)`,
    so collapsing to a coarser `dt` is just `floor` + `groupby().sum()`.
    """
    a = agg.copy()
    a['dt'] = (a['dt'] // bucket_s) * bucket_s
    a['dt'] = a['dt'].astype('int64')
    out = (
        a.groupby(['dt', 'station_id', 'metric', 'state'], as_index=False, observed=True)
         ['minutes'].sum()
    )
    out['state'] = out['state'].astype('int16')
    out['minutes'] = out['minutes'].astype('int32')
    return (
        out[OUT_COLS]
           .sort_values(['station_id', 'dt', 'metric', 'state'], kind='mergesort')
           .reset_index(drop=True)
    )


HOUR_S = 3600
DAY_S = 86400


def _write_sorted_parquet(df: DataFrame, out_path: Path, stations_per_rg: int = 10) -> None:
    """Write df to parquet with row-group size ≈ `stations_per_rg` stations' rows.

    Combined with parquet's per-row-group min/max stats on the leading sort
    column (`station_id`), the Worker prunes to a small set of row groups when
    filtering by one station. Tradeoff: smaller RGs blow up footer metadata
    (~4× file size at 1 station/rg with histogram-shape data); larger RGs
    defeat pruning. Default 10 is the sweet spot for histogram /agg files.

    Pass `stations_per_rg=1` for /day raw bundles where per-station rows are
    dense (~1440/day) and tighter rg pruning is worth the extra metadata.

    No-ops cleanly on empty DataFrame (writes a 0-row parquet with schema only).
    """
    n = len(df)
    if n == 0:
        df.to_parquet(out_path, index=False)
        return
    n_stations = df['station_id'].nunique()
    # +20% slack for variance in per-station row count (some stations have
    # more states active than others). Floor at 100.
    rg = max(100, int(n / n_stations * stations_per_rg * 1.2))
    df.to_parquet(out_path, index=False, engine='pyarrow', row_group_size=rg)


# ---- h1: 1-hour buckets, packaged daily ------------------------------------

class AvailAggH1Day:
    NAMES = ['avail_agg_h1_day', 'avh1']

    def __init__(self, date: str):
        # date = YYYY-MM-DD
        self.date = date

    @property
    def url(self) -> str:
        return str(LOCAL_AGG / 'h1' / f'{self.date}.parquet')

    def _read_input(self, sync: bool) -> DataFrame:
        """Source preference: hourly compactor shards if present, else the
        legacy daily compaction parquet (`gbfs/status/<date>.parquet` from
        `compact-r2.py`). Both schemas carry the 5 metric cols + station_id +
        ts; the daily file uses int16 vs int32 but pandas reads either."""
        cols = ['station_id', 'ts', *METRIC_COLS.keys()]
        # Try hourly shards first (the new compactor's output, 2026-04-20+).
        raw_dir = LOCAL_RAW / self.date
        if sync:
            _r2_sync_in(f'{R2_AVAIL_H1_RAW}/{self.date}/', raw_dir)
        files = sorted(raw_dir.glob('*.parquet'))
        if files:
            frames = [pd.read_parquet(f, columns=cols) for f in files]
            return pd.concat(frames, ignore_index=True)

        # Fallback: legacy daily parquet (compact-r2.py output).
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
        return pd.read_parquet(daily_local, columns=cols)

    def create(self, sync: bool = True) -> Path:
        df = self._read_input(sync=sync)

        # Dedupe by (station_id, ts): the upstream GBFS feed only updates
        # `last_updated` every 60-90s, but our poller runs every 60s — so
        # 30-50% of polls re-report an unchanged ts. The compactor writes
        # both records (it dedupes on (ts, polled_at), which IS unique).
        # For histogram counts we want one row = one minute = one unique ts.
        # Matches `compact-r2.py slice_stations`'s dedupe key.
        df = df.drop_duplicates(subset=['station_id', 'ts'])

        df['dt'] = ((df['ts'] // HOUR_S) * HOUR_S).astype('int64')
        df = df.drop(columns=['ts'])

        agg = _aggregate_to_histogram(df, dt_col='dt')

        out_path = Path(self.url)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _write_sorted_parquet(agg, out_path)
        err(f"avail-agg h1 {self.date}: {len(agg):,} rows, {out_path.stat().st_size/1024:.1f} KB")
        return out_path


# ---- d1: 1-day buckets, packaged monthly -----------------------------------

class AvailAggD1Month:
    NAMES = ['avail_agg_d1_month', 'avd1']

    def __init__(self, ym: str):
        # ym = YYYY-MM
        self.ym = ym

    @property
    def url(self) -> str:
        return str(LOCAL_AGG / 'd1' / f'{self.ym}.parquet')

    def _h1_paths(self) -> list[Path]:
        h1_dir = LOCAL_AGG / 'h1'
        return sorted(h1_dir.glob(f'{self.ym}-??.parquet'))

    def create(self, sync: bool = True) -> Path:
        # Pull all h1 files for the month from R2 so a fresh CI runner sees
        # the full month (the daily compaction cron only builds + uploads one
        # day's h1 file per run).
        if sync:
            h1_dir = LOCAL_AGG / 'h1'
            _r2_sync_in(f'{R2_AVAIL_AGG}/h1/', h1_dir)
        files = self._h1_paths()
        if not files:
            raise FileNotFoundError(f"No h1 shards for {self.ym} at {LOCAL_AGG/'h1'}")
        frames = [pd.read_parquet(f) for f in files]
        h1 = pd.concat(frames, ignore_index=True)
        d1 = _rebucket(h1, DAY_S)

        out_path = Path(self.url)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _write_sorted_parquet(d1, out_path)
        err(f"avail-agg d1 {self.ym}: {len(d1):,} rows from {len(files)} h1 files, "
            f"{out_path.stat().st_size/1024:.1f} KB")
        return out_path


# ---- mo1: 1-month buckets, packaged yearly ---------------------------------

# A "month bucket" doesn't have a fixed second count, so re-bucket via
# pandas.Period rather than integer floor.
def _rebucket_to_month(agg: DataFrame) -> DataFrame:
    a = agg.copy()
    ts = pd.to_datetime(a['dt'], unit='s', utc=True)
    month_start = (ts.dt.tz_convert('UTC')
                     .dt.to_period('M')
                     .dt.to_timestamp(how='start')
                     .dt.tz_localize('UTC'))
    a['dt'] = (month_start.astype('int64') // 10**9).astype('int64')
    out = (
        a.groupby(['dt', 'station_id', 'metric', 'state'], as_index=False, observed=True)
         ['minutes'].sum()
    )
    out['state'] = out['state'].astype('int16')
    out['minutes'] = out['minutes'].astype('int32')
    return (
        out[OUT_COLS]
           .sort_values(['station_id', 'dt', 'metric', 'state'], kind='mergesort')
           .reset_index(drop=True)
    )


class AvailAggMo1Year:
    NAMES = ['avail_agg_mo1_year', 'avmo1']

    def __init__(self, year: int):
        self.year = int(year)

    @property
    def url(self) -> str:
        return str(LOCAL_AGG / 'mo1' / f'{self.year}.parquet')

    def _d1_paths(self) -> list[Path]:
        d1_dir = LOCAL_AGG / 'd1'
        return sorted(d1_dir.glob(f'{self.year}-??.parquet'))

    def create(self, sync: bool = True) -> Path:
        # Pull all d1 files for the year from R2 (same rationale as
        # `AvailAggD1Month.create`).
        if sync:
            d1_dir = LOCAL_AGG / 'd1'
            _r2_sync_in(f'{R2_AVAIL_AGG}/d1/', d1_dir)
        files = self._d1_paths()
        if not files:
            raise FileNotFoundError(f"No d1 shards for {self.year} at {LOCAL_AGG/'d1'}")
        frames = [pd.read_parquet(f) for f in files]
        d1 = pd.concat(frames, ignore_index=True)
        mo1 = _rebucket_to_month(d1)

        out_path = Path(self.url)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _write_sorted_parquet(mo1, out_path)
        err(f"avail-agg mo1 {self.year}: {len(mo1):,} rows from {len(files)} d1 files, "
            f"{out_path.stat().st_size/1024:.1f} KB")
        return out_path


# --- CLI ---

@ctbk.command('avail-agg-h1', help="Build daily h1 (1-hour bucket) histogram from raw shards.")
@argument('date', type=str)  # YYYY-MM-DD
@git_dvc_cmd
def cmd_h1(dry_run: bool, date: str) -> str | None:
    stage = AvailAggH1Day(date=date)
    if dry_run:
        err(f"Dry run: would write {stage.url}")
        return None
    stage.create()
    return f"Avail h1 histogram: {date}"


@ctbk.command('avail-agg-d1', help="Build monthly d1 (1-day bucket) histogram from h1 shards.")
@argument('ym', type=str)  # YYYY-MM
@git_dvc_cmd
def cmd_d1(dry_run: bool, ym: str) -> str | None:
    stage = AvailAggD1Month(ym=ym)
    if dry_run:
        err(f"Dry run: would write {stage.url}")
        return None
    stage.create()
    return f"Avail d1 histogram: {ym}"


@ctbk.command('avail-agg-mo1', help="Build yearly mo1 (1-month bucket) histogram from d1 shards.")
@argument('year', type=int)
@git_dvc_cmd
def cmd_mo1(dry_run: bool, year: int) -> str | None:
    stage = AvailAggMo1Year(year=year)
    if dry_run:
        err(f"Dry run: would write {stage.url}")
        return None
    stage.create()
    return f"Avail mo1 histogram: {year}"
