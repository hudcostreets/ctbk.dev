"""Build the v1 rides pyramid: two sibling h3-keyed sum-monoid pyramids
(`rides-v1-start` / `rides-v1-end`) replacing legacy `trips/{agg,region,stations}`.

See `specs/rides-pyramid-v1.md` for the runbook + tier table.

This module implements the finest tier (1h@1mo). Coarser tiers cascade via
`pyrmts.cascade_tiers` (TODO: wire up).

Output schema (per anchor, per `pyrmts-geo` sum-monoid convention):
    {anchor}_h3_cell : STRING   e.g. '892a1072117ffff' (mixed resolutions 9/7/5)
    dt               : INT64    bucket-start unix **milliseconds**
    gender           : STRING   'unknown' | 'male' | 'female'
    user_type        : STRING   'Subscriber' | 'Customer' | ...
    bike_type        : STRING   'classic_bike' | 'electric_bike' | ...
    count_n          : INT64    # rides
    count_sum        : INT64    sum(1) ≡ n
    count_sumsq      : INT64    sum(1**2) ≡ n
    duration_n       : INT64    n
    duration_sum     : INT64    sum(duration_s)
    duration_sumsq   : INT64    sum(duration_s**2)
"""
from __future__ import annotations

import io
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date as Date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Literal

import boto3
import h3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from botocore.exceptions import ClientError
from click import BadParameter, option
from pyrmts import write_tier_parquet
from utz import err
from utz.cli import flag
from utz.ym import YM

from ctbk.cli.base import ctbk

R2_BUCKET = 'ctbk'
SRC_DIR = Path(f's3/{R2_BUCKET}/normalized')
STATION_OBS_PATH = Path(f's3/{R2_BUCKET}/stations/station-observations.parquet')

Variant = Literal['v1', 'v2']
VARIANTS: tuple[Variant, ...] = ('v1', 'v2')


def dst_prefix(variant: Variant) -> str:
    return f'rides-{variant}'

DEFAULT_RESOLUTIONS: tuple[int, ...] = (9, 7, 5)

# Citibike's `Gender` column: 0 unknown, 1 male, 2 female. (Removed 2021-02
# alongside `Bike ID`; pre-2021 months have values.)
GENDER_MAP = {0: 'unknown', 1: 'male', 2: 'female'}

SRC_COLS = [
    'Start Time', 'Stop Time',
    'Start Station ID', 'Start Station Latitude', 'Start Station Longitude',
    'End Station ID',   'End Station Latitude',   'End Station Longitude',
    'Gender', 'User Type', 'Rideable Type',
]

Anchor = Literal['start', 'end']
ANCHORS: tuple[Anchor, ...] = ('start', 'end')

ANCHOR_CONFIG: dict[Anchor, dict[str, str]] = {
    'start': {
        'cell_col': 'start_h3_cell',
        'time_col': 'Start Time',
        'lat_col': 'Start Station Latitude',
        'lng_col': 'Start Station Longitude',
    },
    'end': {
        'cell_col': 'end_h3_cell',
        'time_col': 'Stop Time',
        'lat_col': 'End Station Latitude',
        'lng_col': 'End Station Longitude',
    },
}

DIM_COLS = ['gender', 'user_type', 'bike_type']
METRIC_NAMES = ['count', 'duration']
MONOID_COLS = [f'{m}_{s}' for m in METRIC_NAMES for s in ('n', 'sum', 'sumsq')]


# ─── Tier specs + cascade ladder (spec §1) ─────────────────────────────

@dataclass(frozen=True)
class TierSpec:
    name: str
    bin_sec: int | None        # None for calendar tiers (1mo, 3mo, 1y)
    shard: str                 # '1mo' | '3mo' | '6mo' | '1y' | 'all'
    derive_from: str | None    # None ⇒ built from normalized source


V1_TIER_SPECS: dict[str, TierSpec] = {
    '1h':  TierSpec('1h',  3600,    '1mo', None),
    '3h':  TierSpec('3h',  10800,   '1mo', '1h'),
    '6h':  TierSpec('6h',  21600,   '1mo', '1h'),
    '12h': TierSpec('12h', 43200,   '1mo', '6h'),
    '1d':  TierSpec('1d',  86400,   '1y',  '1h'),
    '3d':  TierSpec('3d',  259200,  '1y',  '1d'),
    '7d':  TierSpec('7d',  604800,  '1y',  '1d'),
    '14d': TierSpec('14d', 1209600, '1y',  '7d'),
    '1mo': TierSpec('1mo', None,    '1y',  '1d'),
    '3mo': TierSpec('3mo', None,    '1y',  '1mo'),
    '1y':  TierSpec('1y',  None,    'all', '1mo'),
}

V2_TIER_SPECS: dict[str, TierSpec] = {
    '1h':  TierSpec('1h',  3600,    '1mo', None),
    '3h':  TierSpec('3h',  10800,   '3mo', '1h'),
    '6h':  TierSpec('6h',  21600,   '6mo', '1h'),
    '12h': TierSpec('12h', 43200,   '1y',  '6h'),
    '1d':  TierSpec('1d',  86400,   'all', '1h'),
    '3d':  TierSpec('3d',  259200,  'all', '1d'),
    '7d':  TierSpec('7d',  604800,  'all', '1d'),
    '14d': TierSpec('14d', 1209600, 'all', '7d'),
    '1mo': TierSpec('1mo', None,    'all', '1d'),
    '3mo': TierSpec('3mo', None,    'all', '1mo'),
    '1y':  TierSpec('1y',  None,    'all', '1mo'),
}

TIER_SPECS_BY_VARIANT: dict[Variant, dict[str, TierSpec]] = {
    'v1': V1_TIER_SPECS,
    'v2': V2_TIER_SPECS,
}


def tier_specs(variant: Variant) -> dict[str, TierSpec]:
    return TIER_SPECS_BY_VARIANT[variant]


def sort_cols(variant: Variant, cell_col: str) -> list[str]:
    """v1: (dt, cell) — time-window queries prune via `dt` RG stats.
    v2: (cell, dt) — cell-filter queries prune via cell RG stats.
    """
    if variant == 'v1':
        return ['dt', cell_col]
    if variant == 'v2':
        return [cell_col, 'dt']
    raise ValueError(f"unknown variant: {variant!r}")


def _add_months(t: datetime, n: int) -> datetime:
    m_idx = (t.month - 1) + n
    y = t.year + m_idx // 12
    m = m_idx % 12 + 1
    return t.replace(year=y, month=m)


def shard_period(shard: str, t: datetime) -> str:
    """Encode a shard-start `t` as a filename-safe period string.

    v2 adds quarter (3mo) and half-year (6mo) shards. Quarters are
    encoded as `YYYY-QN` (N ∈ 1..4); half-years as `YYYY-HN` (N ∈ 1..2).
    """
    if shard == '1mo': return t.strftime('%Y-%m')
    if shard == '3mo': return f'{t.year}-Q{(t.month - 1) // 3 + 1}'
    if shard == '6mo': return f'{t.year}-H{(t.month - 1) // 6 + 1}'
    if shard == '1y':  return t.strftime('%Y')
    if shard == 'all': return 'all'
    raise ValueError(f"unknown shard granularity: {shard!r}")


def shard_end(shard: str, t: datetime) -> datetime:
    if shard == '1mo':
        return _add_months(t, 1)
    if shard == '3mo':
        return _add_months(t, 3)
    if shard == '6mo':
        return _add_months(t, 6)
    if shard == '1y':
        return t.replace(year=t.year + 1)
    if shard == 'all':
        return datetime(9999, 12, 31, tzinfo=timezone.utc)
    raise ValueError(f"unknown shard granularity: {shard!r}")


def shard_starts_in_range(shard: str, lo: datetime, hi: datetime) -> list[datetime]:
    """Enumerate UTC shard-start times in `[lo, hi)` for granularity `shard`.

    `3mo` shards start on Jan/Apr/Jul/Oct; `6mo` shards on Jan/Jul.
    """
    if lo >= hi:
        return []
    out: list[datetime] = []
    base = lo.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if shard == '1mo':
        cur = base
        while cur < hi:
            out.append(cur)
            cur = _add_months(cur, 1)
    elif shard == '3mo':
        q_month = ((base.month - 1) // 3) * 3 + 1
        cur = base.replace(month=q_month)
        while cur < hi:
            out.append(cur)
            cur = _add_months(cur, 3)
    elif shard == '6mo':
        h_month = ((base.month - 1) // 6) * 6 + 1
        cur = base.replace(month=h_month)
        while cur < hi:
            out.append(cur)
            cur = _add_months(cur, 6)
    elif shard == '1y':
        cur = base.replace(month=1)
        while cur < hi:
            out.append(cur)
            cur = cur.replace(year=cur.year + 1)
    elif shard == 'all':
        out.append(datetime(1970, 1, 1, tzinfo=timezone.utc))
    else:
        raise ValueError(f"unknown shard granularity: {shard!r}")
    return out


def dt_floor_ms_fixed(dt_ms: int, bin_sec: int) -> int:
    bin_ms = bin_sec * 1000
    return (dt_ms // bin_ms) * bin_ms


def dt_floor_ms_calendar(dt_ms: int, tier: str) -> int:
    d = datetime.fromtimestamp(dt_ms / 1000, tz=timezone.utc)
    if tier == '1mo':
        floored = datetime(d.year, d.month, 1, tzinfo=timezone.utc)
    elif tier == '3mo':
        q_month = ((d.month - 1) // 3) * 3 + 1
        floored = datetime(d.year, q_month, 1, tzinfo=timezone.utc)
    elif tier == '1y':
        floored = datetime(d.year, 1, 1, tzinfo=timezone.utc)
    else:
        raise ValueError(f"not a calendar tier: {tier!r}")
    return int(floored.timestamp()) * 1000


# ─── R2 client (mirrors avail_v2.r2_client) ────────────────────────────

def r2_endpoint() -> str:
    aid = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or os.environ.get('R2_ACCOUNT_ID')
    if not aid:
        raise RuntimeError("CLOUDFLARE_ACCOUNT_ID (or R2_ACCOUNT_ID) not set")
    return f'https://{aid}.r2.cloudflarestorage.com'


def r2_client():
    if 'R2_ACCESS_KEY_ID' in os.environ and 'R2_SECRET_ACCESS_KEY' in os.environ:
        sess = boto3.Session(
            aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
            aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
            region_name='auto',
        )
    else:
        sess = boto3.Session(profile_name='cf', region_name='auto')
    return sess.client('s3', endpoint_url=r2_endpoint())


def r2_head(cli, key: str) -> dict | None:
    try:
        return cli.head_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        if e.response.get('Error', {}).get('Code', '') in ('404', 'NoSuchKey'):
            return None
        raise


def output_key(anchor: Anchor, tier: str, period: str, variant: Variant = 'v1') -> str:
    return f'{dst_prefix(variant)}/{anchor}/{tier}/{period}.parquet'


# ─── Station-id → lat/lng fallback ─────────────────────────────────────

@lru_cache(maxsize=1)
def station_geo_lookup() -> dict[str, tuple[float, float]]:
    """Build station_id → (lat, lng) lookup from station-observations.

    Used to recover h3 cells for rides whose source row has null lat/lng
    but a known station_id. Picks the most-recent non-null, non-(0,0)
    observation per id.
    """
    import pandas as pd
    obs = pd.read_parquet(STATION_OBS_PATH, columns=['date', 'id', 'lat', 'lng'])
    obs = obs.dropna(subset=['lat', 'lng'])
    obs = obs[(obs['lat'] != 0.0) | (obs['lng'] != 0.0)]
    obs = obs.sort_values('date').drop_duplicates('id', keep='last')
    return {sid: (float(la), float(ln)) for sid, la, ln in zip(obs['id'], obs['lat'], obs['lng'])}


# ─── Source loader ─────────────────────────────────────────────────────

def _load_rides_for_anchor(ym: YM, anchor: Anchor) -> pd.DataFrame:
    """Read normalized rides relevant to (ym, anchor), filtered to anchor-
    time falling in ym.

    `normalized/<YYYYMM>.parquet` contains rides that **end** in YYYYMM. So:
    - end-anchored ym: just read normalized[ym].
    - start-anchored ym: read normalized[ym] + normalized[ym+1] (rides started
      in ym may end in ym or ym+1).
    """
    ym_str = str(ym)
    ym_start = pd.Timestamp(f'{ym_str[:4]}-{ym_str[4:6]}-01')
    ym_end = ym_start + pd.offsets.MonthBegin(1)

    paths = [SRC_DIR / f'{ym}.parquet']
    if anchor == 'start':
        nxt = ym + 1
        nxt_path = SRC_DIR / f'{nxt}.parquet'
        if nxt_path.exists():
            paths.append(nxt_path)

    frames = []
    for p in paths:
        if not p.exists():
            err(f"  missing source: {p}")
            continue
        frames.append(pd.read_parquet(p, columns=SRC_COLS))
    if not frames:
        return pd.DataFrame(columns=SRC_COLS)
    df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]

    cfg = ANCHOR_CONFIG[anchor]
    t = df[cfg['time_col']]
    mask = (t >= ym_start) & (t < ym_end)
    return df[mask].copy()


# ─── 1h tier: per-month build ──────────────────────────────────────────

def build_1h_month_table(
    ym: YM,
    anchor: Anchor,
    resolutions: tuple[int, ...] = DEFAULT_RESOLUTIONS,
) -> pa.Table | None:
    """Build one `rides-v1/<anchor>/1h/<YYYY-MM>.parquet` table.

    Reads normalized rides for `ym`, h3-materializes each ride at every
    requested resolution, groups by `(<anchor>_h3_cell, dt_hour, *dims)`,
    aggregates `count` + `duration` with the sum monoid.

    Returns None if the source has no rides for this (ym, anchor).
    """
    cfg = ANCHOR_CONFIG[anchor]
    df = _load_rides_for_anchor(ym, anchor)
    if df.empty:
        return None

    # Fill null lat/lng from station-observations fallback (covers the rare
    # source rows where lat/lng is null but station_id is known — e.g. the
    # ~189-ride validation gap vs legacy trips/agg across 2013-2026).
    sid_col = 'Start Station ID' if anchor == 'start' else 'End Station ID'
    null_mask = df[cfg['lat_col']].isna() | df[cfg['lng_col']].isna()
    n_initial_null = int(null_mask.sum())
    if n_initial_null:
        lookup = station_geo_lookup()
        null_rows = df.index[null_mask]
        sids = df.loc[null_rows, sid_col].astype(str)
        geo = sids.map(lookup)
        found_mask = geo.notna()
        if found_mask.any():
            found_rows = null_rows[found_mask.values]
            df.loc[found_rows, cfg['lat_col']] = [geo[r][0] for r in found_rows]
            df.loc[found_rows, cfg['lng_col']] = [geo[r][1] for r in found_rows]
            err(f"  {ym} [{anchor}]: filled {int(found_mask.sum()):,}/{n_initial_null:,} null lat/lng from station-observations")

    n_still_null = int((df[cfg['lat_col']].isna() | df[cfg['lng_col']].isna()).sum())
    if n_still_null:
        df = df.dropna(subset=[cfg['lat_col'], cfg['lng_col']])
        err(f"  {ym} [{anchor}]: dropped {n_still_null:,} rides still missing lat/lng after fallback")
    err(f"  {ym} [{anchor}]: {len(df):,} rides")

    # Hour-floor dt → unix ms
    dt_s = df[cfg['time_col']].values.astype('datetime64[s]').astype('int64')
    dt_hour_ms = ((dt_s // 3600) * 3600 * 1000).astype('int64')
    duration_s = (
        (df['Stop Time'] - df['Start Time'])
        .dt.total_seconds().astype('int64').values
    )
    duration_sq = (duration_s.astype('int64') ** 2)

    gender = df['Gender'].fillna(0).astype(int).map(GENDER_MAP).fillna('unknown').values
    user_type = df['User Type'].astype(str).values
    bike_type = df['Rideable Type'].astype(str).values

    lat = df[cfg['lat_col']].values
    lng = df[cfg['lng_col']].values

    # Inflate by 3× (one row per resolution), then groupby+sum.
    chunks = []
    for res in resolutions:
        cells = [h3.latlng_to_cell(la, ln, res) for la, ln in zip(lat, lng)]
        chunks.append(pd.DataFrame({
            cfg['cell_col']: cells,
            'dt': dt_hour_ms,
            'gender': gender,
            'user_type': user_type,
            'bike_type': bike_type,
            'duration_s': duration_s,
            'duration_sq': duration_sq,
        }))
    long_df = pd.concat(chunks, ignore_index=True)

    group_keys = [cfg['cell_col'], 'dt', 'gender', 'user_type', 'bike_type']
    agg = (
        long_df
        .groupby(group_keys, observed=True, sort=False)
        .agg(
            count_n=('duration_s', 'count'),
            duration_sum=('duration_s', 'sum'),
            duration_sumsq=('duration_sq', 'sum'),
        )
        .reset_index()
    )
    # `count` is sum-monoid over the constant 1: n, sum, sumsq all equal n.
    agg['count_sum'] = agg['count_n']
    agg['count_sumsq'] = agg['count_n']
    agg['duration_n'] = agg['count_n']

    out_cols = [
        cfg['cell_col'], 'dt', 'gender', 'user_type', 'bike_type',
        'count_n', 'count_sum', 'count_sumsq',
        'duration_n', 'duration_sum', 'duration_sumsq',
    ]
    schema = pa.schema([
        (cfg['cell_col'], pa.string()),
        ('dt', pa.int64()),
        ('gender', pa.string()),
        ('user_type', pa.string()),
        ('bike_type', pa.string()),
        ('count_n', pa.int64()),
        ('count_sum', pa.int64()),
        ('count_sumsq', pa.int64()),
        ('duration_n', pa.int64()),
        ('duration_sum', pa.int64()),
        ('duration_sumsq', pa.int64()),
    ])
    return pa.Table.from_pandas(agg[out_cols], schema=schema, preserve_index=False)


def write_table_to_r2(cli, table: pa.Table, key: str, cell_col: str, variant: Variant = 'v1') -> int:
    """Serialize via `pyrmts.write_tier_parquet` (sort per `sort_cols(variant)` +
    pick RG size for hyparquet RG-pruning) and PUT to R2."""
    buf = io.BytesIO()
    write_tier_parquet(table, out=buf, sort=sort_cols(variant, cell_col))
    body = buf.getvalue()
    cli.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=body,
        ContentType='application/octet-stream',
    )
    return len(body)


def write_table_to_local(table: pa.Table, path: Path, cell_col: str, variant: Variant = 'v1') -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    write_tier_parquet(table, out=buf, sort=sort_cols(variant, cell_col))
    body = buf.getvalue()
    path.write_bytes(body)
    return len(body)


# ─── Cascade: read input shard from R2/local ──────────────────────────

def read_shard(
    anchor: Anchor,
    tier: str,
    period: str,
    local_dir: str | None,
    cli=None,
    variant: Variant = 'v1',
) -> pa.Table | None:
    """Fetch one rides-<variant>/<anchor>/<tier>/<period>.parquet. None on 404."""
    key = output_key(anchor, tier, period, variant)
    if local_dir:
        p = Path(local_dir) / key
        if not p.exists():
            return None
        return pq.read_table(p)
    assert cli is not None
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        raise
    return pq.read_table(io.BytesIO(obj['Body'].read()))


def input_periods_for_output(
    output_tier: str,
    output_start: datetime,
    input_tier: str,
    all_dates: tuple[Date, Date] | None,
    variant: Variant = 'v1',
) -> list[str]:
    """Enumerate input-shard `period` strings overlapping one output shard window."""
    specs = tier_specs(variant)
    out_spec = specs[output_tier]
    in_spec = specs[input_tier]
    if out_spec.shard == 'all':
        if all_dates is None:
            raise ValueError("output shard='all' requires all_dates=(from, to)")
        lo = datetime.combine(all_dates[0], datetime.min.time(), tzinfo=timezone.utc)
        hi = datetime.combine(all_dates[1], datetime.min.time(), tzinfo=timezone.utc)
    else:
        lo = output_start
        hi = shard_end(out_spec.shard, output_start)
    starts = shard_starts_in_range(in_spec.shard, lo, hi)
    return [shard_period(in_spec.shard, s) for s in starts]


def build_cascade_table(
    anchor: Anchor,
    tier: str,
    shard_start: datetime,
    local_dir: str | None,
    all_dates: tuple[Date, Date] | None = None,
    variant: Variant = 'v1',
) -> pa.Table | None:
    """Cascade one rides-<variant>/<anchor>/<tier>/<period>.parquet shard.

    Reads all input shards (at derive_from tier's shard granularity) that
    overlap the output window, re-buckets `dt` to the output tier's bin,
    sums the 6 monoid columns per (cell, dt_out, *dims). Returns None if
    no input shards present.
    """
    specs = tier_specs(variant)
    spec = specs[tier]
    if spec.derive_from is None:
        raise ValueError(f"tier {tier!r} has no derive_from")
    cfg = ANCHOR_CONFIG[anchor]
    cell_col = cfg['cell_col']
    in_periods = input_periods_for_output(tier, shard_start, spec.derive_from, all_dates, variant)

    cli = None if local_dir else r2_client()
    frames: list[pd.DataFrame] = []
    n_present = 0
    for p in in_periods:
        tab = read_shard(anchor, spec.derive_from, p, local_dir, cli, variant)
        if tab is None:
            continue
        n_present += 1
        frames.append(tab.to_pandas())
    if n_present == 0:
        return None

    df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]

    # Re-floor dt to output bin.
    if spec.bin_sec is not None:
        df['dt'] = (df['dt'].astype('int64') // (spec.bin_sec * 1000)) * (spec.bin_sec * 1000)
    else:
        df['dt'] = df['dt'].astype('int64').map(lambda v: dt_floor_ms_calendar(int(v), tier))

    group_keys = [cell_col, 'dt', *DIM_COLS]
    agg = df.groupby(group_keys, sort=False, observed=True, dropna=False)[MONOID_COLS].sum().reset_index()
    for c in MONOID_COLS:
        agg[c] = agg[c].astype('int64')

    schema = pa.schema([
        (cell_col, pa.string()),
        ('dt', pa.int64()),
        ('gender', pa.string()),
        ('user_type', pa.string()),
        ('bike_type', pa.string()),
        ('count_n', pa.int64()),
        ('count_sum', pa.int64()),
        ('count_sumsq', pa.int64()),
        ('duration_n', pa.int64()),
        ('duration_sum', pa.int64()),
        ('duration_sumsq', pa.int64()),
    ])
    out_cols = [cell_col, 'dt', *DIM_COLS, *MONOID_COLS]
    return pa.Table.from_pandas(agg[out_cols], schema=schema, preserve_index=False)


# ─── Worker (top-level for ProcessPool pickling) ───────────────────────

def _build_shard_task(
    tier: str,
    shard_start_iso: str,
    anchor: Anchor,
    overwrite: bool,
    resolutions: tuple[int, ...],
    local_dir: str | None,
    all_dates_iso: tuple[str, str] | None,
    variant: Variant = 'v1',
) -> tuple[str, Anchor, str, int]:
    """Build + write one rides-<variant>/<anchor>/<tier>/<period>.parquet shard.

    Dispatches on `tier_specs(variant)[tier].derive_from`:
      - None → build from normalized source (1h tier only)
      - else → cascade from derive_from tier
    Returns (period, anchor, status, bytes). status ∈ {wrote, skip, empty}."""
    spec = tier_specs(variant)[tier]
    t = datetime.fromisoformat(shard_start_iso)
    period = shard_period(spec.shard, t)
    cfg = ANCHOR_CONFIG[anchor]

    if local_dir:
        out_path = Path(local_dir) / output_key(anchor, tier, period, variant)
        if not overwrite and out_path.exists():
            return (period, anchor, 'skip', 0)
        cli = None
    else:
        cli = r2_client()
        key = output_key(anchor, tier, period, variant)
        if not overwrite and r2_head(cli, key) is not None:
            return (period, anchor, 'skip', 0)

    if spec.derive_from is None:
        if tier != '1h':
            raise RuntimeError(f"tier {tier!r} has no derive_from but isn't '1h'")
        ym = YM(t.strftime('%Y%m'))
        table = build_1h_month_table(ym, anchor, resolutions)
    else:
        ad = (
            (Date.fromisoformat(all_dates_iso[0]), Date.fromisoformat(all_dates_iso[1]))
            if all_dates_iso else None
        )
        table = build_cascade_table(anchor, tier, t, local_dir, ad, variant)

    if table is None:
        return (period, anchor, 'empty', 0)

    if local_dir:
        n = write_table_to_local(table, out_path, cfg['cell_col'], variant)
    else:
        n = write_table_to_r2(cli, table, output_key(anchor, tier, period, variant), cfg['cell_col'], variant)
    return (period, anchor, 'wrote', n)


# ─── CLI ───────────────────────────────────────────────────────────────

def _parse_ym(s: str) -> YM:
    s = s.strip()
    if len(s) == 7 and s[4] == '-':
        return YM(s[:4] + s[5:7])
    if len(s) == 6:
        return YM(s)
    raise BadParameter(f"YM must be YYYYMM or YYYY-MM; got {s!r}")


def _ym_range(date_from: str, date_to: str) -> list[YM]:
    """Inclusive YM range `[date_from, date_to]` (both YYYY-MM)."""
    f = _parse_ym(date_from)
    t = _parse_ym(date_to)
    out: list[YM] = []
    cur = f
    while cur <= t:
        out.append(cur)
        cur = cur + 1
    return out


@ctbk.command('rides-v1-build', help="Build rides-<variant>/<anchor>/<tier>/<period>.parquet shards.")
@option('-a', '--anchor', type=str, default='both',
        help="'start' | 'end' | 'both' (default 'both').")
@option('-c', '--concurrency', type=int, default=4, help="Worker process count.")
@option('-f', '--ym-from', 'ym_from', required=True, help="Inclusive start (YYYY-MM).")
@option('-l', '--local-dir', type=str, default=None,
        help="Read/write local dir instead of R2 (prototype/smoke).")
@option('-n', '--dry-run', is_flag=True)
@option('-O', '--overwrite', '--force', is_flag=True, help="Rebuild even if output exists.")
@option('-r', '--resolution', 'resolutions', multiple=True, type=int, default=DEFAULT_RESOLUTIONS,
        help="h3 resolutions to materialize (1h only; default 9 7 5).")
@option('-t', '--tier', type=str, default='1h',
        help="Tier name (depends on --variant; v1+v2 share the same tier names).")
@option('-T', '--ym-to', 'ym_to', required=True, help="Inclusive end (YYYY-MM).")
@option('-v', '--variant', type=str, default='v1',
        help=f"Pyramid variant; one of {list(VARIANTS)} (default 'v1').")
def rides_v1_build_cmd(
    anchor: str,
    concurrency: int,
    ym_from: str,
    local_dir: str | None,
    dry_run: bool,
    overwrite: bool,
    resolutions: tuple[int, ...],
    tier: str,
    ym_to: str,
    variant: str,
):
    if variant not in VARIANTS:
        raise BadParameter(f"unknown --variant {variant!r}; known: {list(VARIANTS)}")
    specs = tier_specs(variant)  # type: ignore[arg-type]
    if tier not in specs:
        raise BadParameter(f"unknown --tier {tier!r}; known ({variant}): {list(specs)}")
    if anchor not in ('start', 'end', 'both'):
        raise BadParameter(f"--anchor must be one of start/end/both; got {anchor!r}")
    anchors: tuple[Anchor, ...] = ANCHORS if anchor == 'both' else (anchor,)  # type: ignore[assignment]

    spec = specs[tier]
    ymf = _parse_ym(ym_from)
    ymt = _parse_ym(ym_to)
    yf, mf = int(str(ymf)[:4]), int(str(ymf)[4:6])
    yt, mt = int(str(ymt)[:4]), int(str(ymt)[4:6])
    lo = datetime(yf, mf, 1, tzinfo=timezone.utc)
    # exclusive upper bound: first day of month after `ym_to`
    if mt == 12:
        hi = datetime(yt + 1, 1, 1, tzinfo=timezone.utc)
    else:
        hi = datetime(yt, mt + 1, 1, tzinfo=timezone.utc)

    starts = shard_starts_in_range(spec.shard, lo, hi)
    all_dates_iso: tuple[str, str] | None = None
    if spec.shard == 'all':
        all_dates_iso = (lo.date().isoformat(), hi.date().isoformat())

    err(f"rides-{variant}-build tier={tier} shard={spec.shard} anchors={anchors} "
        f"{len(starts)} shards in [{ym_from}, {ym_to}] (inclusive)")

    res_tup = tuple(resolutions)
    tasks = [(s.isoformat(), a) for s in starts for a in anchors]

    if dry_run:
        for s_iso, a in tasks:
            t = datetime.fromisoformat(s_iso)
            period = shard_period(spec.shard, t)
            print(f"  BUILD {output_key(a, tier, period, variant)}")  # type: ignore[arg-type]
        return

    n_wrote = n_skip = n_empty = bytes_total = 0
    if concurrency <= 1:
        for s_iso, a in tasks:
            period, _a, status, n = _build_shard_task(
                tier, s_iso, a, overwrite, res_tup, local_dir, all_dates_iso, variant,  # type: ignore[arg-type]
            )
            err(f"  {status:5s} {a:5s} {period} ({n:,} B)")
            n_wrote += (status == 'wrote'); n_skip += (status == 'skip'); n_empty += (status == 'empty')
            bytes_total += n
    else:
        with ProcessPoolExecutor(max_workers=concurrency) as pool:
            futs = {
                pool.submit(
                    _build_shard_task, tier, s_iso, a, overwrite, res_tup, local_dir, all_dates_iso, variant,  # type: ignore[arg-type]
                ): (s_iso, a)
                for s_iso, a in tasks
            }
            for fut in as_completed(futs):
                period, a, status, n = fut.result()
                err(f"  {status:5s} {a:5s} {period} ({n:,} B)")
                n_wrote += (status == 'wrote'); n_skip += (status == 'skip'); n_empty += (status == 'empty')
                bytes_total += n

    err(f"done: {n_wrote} wrote, {n_skip} skip, {n_empty} empty, {bytes_total:,} bytes total")


# ─── Validation: cross-check vs legacy trips/agg/h1 ────────────────────

REF_H1_DIR = Path(f'r2/{R2_BUCKET}/trips/agg/h1')


def _ride_totals_for_anchor(
    rv_path: Path,
    anchor: Anchor,
    pick_res: int = 9,
) -> tuple[int, int, int]:
    """Read rides-v1/<anchor>/1h/<period>.parquet, filter to one h3 resolution,
    return (n_rides, duration_sum, duration_sumsq).

    All resolutions contain the same total — picking one avoids 3× double-count.
    """
    df = pd.read_parquet(rv_path, columns=[
        f'{anchor}_h3_cell', 'count_n', 'duration_sum', 'duration_sumsq',
    ])
    res = df[f'{anchor}_h3_cell'].apply(h3.get_resolution)
    sub = df[res == pick_res]
    return (
        int(sub['count_n'].sum()),
        int(sub['duration_sum'].sum()),
        int(sub['duration_sumsq'].sum()),
    )


def _ref_totals_for_anchor(ref_path: Path, anchor: Anchor) -> tuple[int, int, int]:
    df = pd.read_parquet(ref_path, columns=['side', 'count', 'duration_s', 'duration_s_sq'])
    sub = df[df['side'] == anchor]
    return (
        int(sub['count'].sum()),
        int(sub['duration_s'].sum()),
        int(sub['duration_s_sq'].sum()),
    )


@ctbk.command('rides-v1-validate', help="Cross-check rides-v1 totals vs trips/agg/h1.")
@option('-a', '--anchor', type=str, default='both', help="'start' | 'end' | 'both'.")
@option('-f', '--ym-from', 'ym_from', required=True, help="Inclusive start (YYYY-MM).")
@option('-l', '--local-dir', type=str, required=True,
        help="Local dir with rides-v1/<anchor>/1h/<period>.parquet shards.")
@option('-r', '--pick-res', type=int, default=9,
        help="h3 resolution to filter on (default 9; all resolutions agree on totals).")
@option('-T', '--ym-to', 'ym_to', required=True, help="Inclusive end (YYYY-MM).")
def rides_v1_validate_cmd(
    anchor: str,
    ym_from: str,
    local_dir: str,
    pick_res: int,
    ym_to: str,
):
    if anchor not in ('start', 'end', 'both'):
        raise BadParameter(f"--anchor must be one of start/end/both; got {anchor!r}")
    anchors: tuple[Anchor, ...] = ANCHORS if anchor == 'both' else (anchor,)  # type: ignore[assignment]
    yms = _ym_range(ym_from, ym_to)

    root = Path(local_dir)
    n_ok = n_fail = n_skip = 0
    fails: list[str] = []
    for y in yms:
        period = f'{str(y)[:4]}-{str(y)[4:6]}'
        ref_path = REF_H1_DIR / f'{period}.parquet'
        if not ref_path.exists():
            err(f"  skip  {period}: no reference at {ref_path}")
            n_skip += 1
            continue
        for a in anchors:
            rv_path = root / output_key(a, '1h', period)
            if not rv_path.exists():
                err(f"  skip  {period} [{a}]: no rides-v1 at {rv_path}")
                n_skip += 1
                continue
            rv_totals = _ride_totals_for_anchor(rv_path, a, pick_res)
            ref_totals = _ref_totals_for_anchor(ref_path, a)
            if rv_totals == ref_totals:
                err(f"  ok    {period} [{a}]: n={rv_totals[0]:,} dur={rv_totals[1]:,} dur_sq={rv_totals[2]:,}")
                n_ok += 1
            else:
                msg = (f"  FAIL  {period} [{a}]: rv={rv_totals} ref={ref_totals} "
                       f"(Δn={rv_totals[0]-ref_totals[0]:+d} "
                       f"Δdur={rv_totals[1]-ref_totals[1]:+d} "
                       f"Δdur_sq={rv_totals[2]-ref_totals[2]:+d})")
                err(msg)
                fails.append(msg)
                n_fail += 1
    err(f"\nrides-v1-validate: {n_ok} ok, {n_fail} fail, {n_skip} skip")
    if fails:
        raise SystemExit(1)
