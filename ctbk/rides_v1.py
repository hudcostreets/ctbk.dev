"""Build the rides-v3 pyramid: two sibling S2-keyed sum-monoid pyramids
(`rides-v3/{start,end}`), the rollback path behind prod's rides-v5.

(Module name is historical: it once also built the h3-keyed rides-v1/v2
pyramids, GC'd 2026-08-15 — child hexes are neither necessary nor
sufficient to cover their parent, so exact multi-resolution aggregation
is unachievable on h3. See `specs/done/rides-pyramid-v3.md`.)

This module implements the finest tier (1h@1mo); coarser tiers cascade
via `build_cascade_table`.

Output schema (per anchor, per `pyrmts-geo` sum-monoid convention):
    {anchor}_s2_cell : STRING   S2 token, levels 10..15 (LUC chains)
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
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import s2cell
from botocore.exceptions import ClientError
from click import BadParameter, argument, option
from pyrmts import write_tier_parquet
from utz import err
from utz.cli import flag
from utz.ym import YM

from ctbk.cli.base import ctbk

R2_BUCKET = 'ctbk'
SRC_DIR = Path(f's3/{R2_BUCKET}/normalized')
STATION_OBS_PATH = Path(f's3/{R2_BUCKET}/stations/station-observations.parquet')

Variant = Literal['v3']
VARIANTS: tuple[Variant, ...] = ('v3',)

# Earliest tripdata month. 'all'-sharded outputs span [genesis, now); any
# full-history recompute must enumerate inputs from here, never from a
# narrower CLI window (see the 2026-08-14 truncation incident, task #183).
GENESIS_DATE = Date(2013, 6, 1)


def dst_prefix(variant: Variant) -> str:
    return f'rides-{variant}'


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
        'time_col': 'Start Time',
        'lat_col': 'Start Station Latitude',
        'lng_col': 'Start Station Longitude',
    },
    'end': {
        'time_col': 'Stop Time',
        'lat_col': 'End Station Latitude',
        'lng_col': 'End Station Longitude',
    },
}


def cell_col(anchor: Anchor, variant: Variant) -> str:
    return f'{anchor}_s2_cell'

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


# Consolidated cascade (originated as rides-v2's ladder; v3 reuses it
# verbatim — only cell-key column + level set differ).
V3_TIER_SPECS: dict[str, TierSpec] = {
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
    'v3': V3_TIER_SPECS,
}


def tier_specs(variant: Variant) -> dict[str, TierSpec]:
    return TIER_SPECS_BY_VARIANT[variant]


def sort_cols(variant: Variant, cell_col: str) -> list[str]:
    """(cell, dt) — cell-filter queries prune via cell RG stats; dims as
    tertiary keys for deterministic layout + better dictionary/RLE
    encoding (rows within one (cell, dt) are the handful of dim combos).
    Dims deliberately come AFTER dt: the dominant query fetches the full
    dim cartesian over a time window, which stays one contiguous range
    per cell; dims-before-dt would shatter it into a range per combo.
    """
    return [cell_col, 'dt', *DIM_COLS]


def _add_months(t: datetime, n: int) -> datetime:
    m_idx = (t.month - 1) + n
    y = t.year + m_idx // 12
    m = m_idx % 12 + 1
    return t.replace(year=y, month=m)


def shard_period(shard: str, t: datetime) -> str:
    """Encode a shard-start `t` as a filename-safe period string.

    All `mo`-unit shards use `YYYY-MM` (start-of-period month) to
    match pyrmts JS's `formatPeriod` default — the JS planner builds
    keys from `{count, unit}` only, so multi-month spans (3mo / 6mo)
    share the 1mo formatter. A 3mo shard starting Apr 2013 is
    `2013-04.parquet`; a 6mo shard starting Jul 2013 is
    `2013-07.parquet`.

    `'all'` shards are declared as `120y` on the worker side
    (`gbfs/api/src/rides_v1.ts` — pyrmts has no whole-dataset shard
    concept), so their `{period}` is the 120y-aligned window start:
    pyrmts floors any year in 1920-2039 to `1920`. Writing `all` here
    made the coarse tiers unreadable via the parquet backend (planner
    requested `1920.parquet`, R2 had `all.parquet`) — masked in prod
    by the D1 hybrid until the LUC-rebuild acceptance run.
    """
    if shard in ('1mo', '3mo', '6mo'):
        return t.strftime('%Y-%m')
    if shard == '1y':  return t.strftime('%Y')
    if shard == 'all': return '1920'
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


# ─── R2 client ─────────────────────────────────────────────────────────

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


def output_key(anchor: Anchor, tier: str, period: str, variant: Variant = 'v3') -> str:
    return f'{dst_prefix(variant)}/{anchor}/{tier}/{period}.parquet'


# ─── LUC denorm (v3 canonical keying) ──────────────────────────────────

STATION_LUC_PATH = Path('www/public/assets/station-luc.json')
ID_MAP_PATH = Path(f's3/{R2_BUCKET}/stations/station-id-map.json')

# Coordinate-fallback levels for rides whose station id resolves to no
# denorm entry (expected ≈0 after the historical union). Cells that ARE
# some station's LUC are excluded so fallback rows can never leak into a
# per-station query.
FALLBACK_LEVELS: tuple[int, ...] = (10, 11, 12, 13, 14, 15)


@lru_cache(maxsize=1)
def luc_chains() -> tuple[dict[str, tuple[str, ...]], frozenset[str]]:
    """Per-canonical S2 cell chain (L10..LUC ancestors from the
    CANONICAL position, LUC cell verbatim) + the set of all LUC cells
    (fallback exclusion). Keying rides by station identity instead of
    per-ride coordinates is what makes per-station queries exact: era
    coordinate jitter crosses cell boundaries at ANY magnitude (JC115's
    2023-01..2024-07 rides undercounted -3..-16%/mo under coordinate
    keying). See `specs/rides-v3-luc.md`."""
    import json
    d = json.loads(STATION_LUC_PATH.read_text())
    bs = d['by_short_name']
    chains = {
        sn: tuple(
            s2cell.lat_lon_to_token(e['lat'], e['lng'], lvl)
            for lvl in range(FALLBACK_LEVELS[0], e['level'])
        ) + (e['cell'],)
        for sn, e in bs.items()
    }
    return chains, frozenset(e['cell'] for e in bs.values())


@lru_cache(maxsize=1)
def canonical_station_map() -> dict[str, str]:
    """Raw ride station id → canonical short_name: `station-id-map`
    composed with the denorm's same-dock `merged` map."""
    import json
    idm = json.loads(ID_MAP_PATH.read_text())
    merged = json.loads(STATION_LUC_PATH.read_text()).get('merged', {})
    return {sid: merged.get(canon, canon) for sid, canon in idm.items()}


# ─── Station-id → lat/lng fallback ─────────────────────────────────────

@lru_cache(maxsize=1)
def station_geo_lookup() -> dict[str, tuple[float, float]]:
    """Build station_id → (lat, lng) lookup from station-observations.

    Used to recover coordinates for rides whose source row has null
    lat/lng but a known station_id. Picks the most-recent non-null,
    non-(0,0) observation per id.
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

    # The month's own parquet is a hard requirement: building from a partial
    # source set silently truncates the shard. Only the spillover month
    # (ym+1, not yet published for the latest ym) may be legitimately absent.
    own_path = SRC_DIR / f'{ym}.parquet'
    if not own_path.exists():
        raise FileNotFoundError(
            f"normalized source missing: {own_path} — `dvc pull` it before building {ym}"
        )
    paths = [own_path]
    if anchor == 'start':
        nxt = ym + 1
        nxt_path = SRC_DIR / f'{nxt}.parquet'
        if nxt_path.exists():
            paths.append(nxt_path)

    frames = [pd.read_parquet(p, columns=SRC_COLS) for p in paths]
    df = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]

    cfg = ANCHOR_CONFIG[anchor]
    t = df[cfg['time_col']]
    mask = (t >= ym_start) & (t < ym_end)
    return df[mask].copy()


# ─── 1h tier: per-month build ──────────────────────────────────────────

def build_1h_month_table(
    ym: YM,
    anchor: Anchor,
    variant: Variant = 'v3',
) -> pa.Table | None:
    """Build one `rides-<variant>/<anchor>/1h/<YYYY-MM>.parquet` table.

    Reads normalized rides for `ym`, materializes each ride at its
    canonical station's L10..LUC S2 chain, groups by
    `(<anchor>_s2_cell, dt_hour, *dims)`, aggregates `count` +
    `duration` with the sum monoid.

    Returns None if the source has no rides for this (ym, anchor).
    """
    cfg = ANCHOR_CONFIG[anchor]
    cc = cell_col(anchor, variant)
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

    # Rides are keyed by station identity, so coordinates only matter for
    # the (unmapped-sid) fallback — null-coord rides with a known station
    # id are kept (they were dropped under coordinate keying).
    still_null = df[cfg['lat_col']].isna() | df[cfg['lng_col']].isna()
    canon0 = canonical_station_map()
    chains0, _ = luc_chains()
    sids0 = df[sid_col].astype(str)
    unmapped = ~sids0.map(lambda s: canon0.get(s, s)).isin(chains0.keys())
    droppable = still_null & unmapped
    n_drop = int(droppable.sum())
    if n_drop:
        df = df[~droppable]
        err(f"  {ym} [{anchor}]: dropped {n_drop:,} rides with no lat/lng and no station-id mapping")
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

    # LUC-anchored: each ride materializes at its CANONICAL
    # station's L10..LUC chain (station identity, not per-ride
    # coordinates — see `luc_chains` docstring / rides-v3-luc.md).
    import itertools
    import numpy as np
    chains, luc_cells = luc_chains()
    canon = canonical_station_map()
    sids = df[sid_col].astype(str).values
    ride_chains: list[tuple[str, ...]] = []
    n_unknown = 0
    for sid, la, ln in zip(sids, lat, lng):
        ch = chains.get(canon.get(sid, sid))
        if ch is None:
            n_unknown += 1
            ch = tuple(
                t for lvl in FALLBACK_LEVELS
                if (t := s2cell.lat_lon_to_token(la, ln, lvl)) not in luc_cells
            )
        ride_chains.append(ch)
    if n_unknown:
        err(f"  {ym} [{anchor}]: {n_unknown:,} rides with unmapped station id — "
            f"coordinate fallback (LUC cells excluded)")
    lens = np.fromiter((len(c) for c in ride_chains), dtype=np.int64, count=len(ride_chains))
    rep = np.repeat(np.arange(len(ride_chains)), lens)
    long_df = pd.DataFrame({
        cc: list(itertools.chain.from_iterable(ride_chains)),
        'dt': dt_hour_ms[rep],
        'gender': gender[rep],
        'user_type': user_type[rep],
        'bike_type': bike_type[rep],
        'duration_s': duration_s[rep],
        'duration_sq': duration_sq[rep],
    })

    group_keys = [cc, 'dt', 'gender', 'user_type', 'bike_type']
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

    return shard_table(agg, cc)


def shard_schema(cc: str) -> pa.Schema:
    return pa.schema([
        (cc, pa.string()),
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


def shard_table(df: pd.DataFrame, cc: str) -> pa.Table:
    out_cols = [cc, 'dt', *DIM_COLS, *MONOID_COLS]
    return pa.Table.from_pandas(df[out_cols], schema=shard_schema(cc), preserve_index=False)


def write_table_to_r2(cli, table: pa.Table, key: str, cell_col: str, variant: Variant = 'v3') -> int:
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


def write_table_to_local(table: pa.Table, path: Path, cell_col: str, variant: Variant = 'v3') -> int:
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
    variant: Variant = 'v3',
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
    variant: Variant = 'v3',
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
    variant: Variant = 'v3',
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
    cc = cell_col(anchor, variant)
    in_periods = input_periods_for_output(tier, shard_start, spec.derive_from, all_dates, variant)

    # Row-level window bounds, mirroring `input_periods_for_output`'s shard
    # window. Enumeration alone can't restrict what's read when the *source*
    # tier is 'all'-sharded (every v2/v3 derived tier): its single shard
    # holds full history, so unfiltered rows would leak outside the window.
    if spec.shard == 'all':
        if all_dates is None:
            raise ValueError("output shard='all' requires all_dates=(from, to)")
        lo_dt = datetime.combine(all_dates[0], datetime.min.time(), tzinfo=timezone.utc)
        hi_dt = datetime.combine(all_dates[1], datetime.min.time(), tzinfo=timezone.utc)
    else:
        lo_dt = shard_start
        hi_dt = shard_end(spec.shard, shard_start)
    lo_ms = int(lo_dt.timestamp()) * 1000
    hi_ms = int(hi_dt.timestamp()) * 1000

    cli = None if local_dir else r2_client()
    group_keys = [cc, 'dt', *DIM_COLS]

    # Stream-aggregate: read each input shard, re-floor dt, groupby+sum,
    # then merge into running accumulator. Avoids holding all shards in
    # memory simultaneously — critical for 'all'-shard cascades over 13yr.
    acc: pd.DataFrame | None = None
    n_present = 0
    for p in in_periods:
        tab = read_shard(anchor, spec.derive_from, p, local_dir, cli, variant)
        if tab is None:
            continue
        n_present += 1
        df = tab.to_pandas()
        del tab
        df = df[(df['dt'] >= lo_ms) & (df['dt'] < hi_ms)]
        if df.empty:
            continue
        if spec.bin_sec is not None:
            df['dt'] = (df['dt'].astype('int64') // (spec.bin_sec * 1000)) * (spec.bin_sec * 1000)
        else:
            df['dt'] = df['dt'].astype('int64').map(lambda v: dt_floor_ms_calendar(int(v), tier))
        chunk = df.groupby(group_keys, sort=False, observed=True, dropna=False)[MONOID_COLS].sum().reset_index()
        del df
        if acc is None:
            acc = chunk
        else:
            acc = pd.concat([acc, chunk], ignore_index=True)
            del chunk
            acc = acc.groupby(group_keys, sort=False, observed=True, dropna=False)[MONOID_COLS].sum().reset_index()
    if n_present == 0 or acc is None:
        return None

    agg = acc
    for c in MONOID_COLS:
        agg[c] = agg[c].astype('int64')
    return shard_table(agg, cc)


# ─── Worker (top-level for ProcessPool pickling) ───────────────────────

def _build_shard_task(
    tier: str,
    shard_start_iso: str,
    anchor: Anchor,
    overwrite: bool,
    local_dir: str | None,
    all_dates_iso: tuple[str, str] | None,
    full: bool = False,
    variant: Variant = 'v3',
) -> tuple[str, Anchor, str, int]:
    """Build + write one rides-<variant>/<anchor>/<tier>/<period>.parquet shard.

    Dispatches on `tier_specs(variant)[tier].derive_from`:
      - None → build from normalized source (1h tier only)
      - else → cascade from derive_from tier

    'all'-sharded outputs hold full history, so `[-f, -T]` must never bound
    their recompute directly (the 2026-08-14 truncation incident, task #183).
    Instead:
      - `full=True` (or no existing shard): recompute from `GENESIS_DATE`.
      - else (merge-patch): recompute only output buckets overlapping
        `[-f, -T]` from source, carry earlier rows over from the existing
        shard unchanged.
    Returns (period, anchor, status, bytes). status ∈ {wrote, skip, empty}."""
    spec = tier_specs(variant)[tier]
    t = datetime.fromisoformat(shard_start_iso)
    period = shard_period(spec.shard, t)
    cc = cell_col(anchor, variant)

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
        table = build_1h_month_table(ym, anchor, variant)
    else:
        ad = (
            (Date.fromisoformat(all_dates_iso[0]), Date.fromisoformat(all_dates_iso[1]))
            if all_dates_iso else None
        )
        if spec.shard == 'all':
            assert ad is not None
            lo_ms = int(datetime.combine(ad[0], datetime.min.time(), tzinfo=timezone.utc).timestamp()) * 1000
            cutoff_ms = (
                dt_floor_ms_fixed(lo_ms, spec.bin_sec) if spec.bin_sec is not None
                else dt_floor_ms_calendar(lo_ms, tier)
            )
            existing = None if full else read_shard(anchor, tier, period, local_dir, cli, variant)
            if existing is None:
                table = build_cascade_table(anchor, tier, t, local_dir, (GENESIS_DATE, ad[1]), variant)
            else:
                # Merge-patch: recompute output buckets from the bucket-floor
                # of `-f` (straddling fixed-width buckets refill completely),
                # keep strictly-earlier rows from the existing shard.
                cutoff_date = datetime.fromtimestamp(cutoff_ms / 1000, tz=timezone.utc).date()
                fresh = build_cascade_table(anchor, tier, t, local_dir, (cutoff_date, ad[1]), variant)
                old_df = existing.to_pandas()
                old_df = old_df[old_df['dt'] < cutoff_ms]
                parts = [df for df in (old_df, fresh.to_pandas() if fresh is not None else None)
                         if df is not None and not df.empty]
                table = shard_table(pd.concat(parts, ignore_index=True), cc) if parts else None
        else:
            table = build_cascade_table(anchor, tier, t, local_dir, ad, variant)

    if table is None:
        return (period, anchor, 'empty', 0)

    if local_dir:
        n = write_table_to_local(table, out_path, cc, variant)
    else:
        n = write_table_to_r2(cli, table, output_key(anchor, tier, period, variant), cc, variant)
    return (period, anchor, 'wrote', n)


# ─── CLI ───────────────────────────────────────────────────────────────

def _parse_ym(s: str) -> YM:
    s = s.strip()
    if len(s) == 7 and s[4] == '-':
        return YM(s[:4] + s[5:7])
    if len(s) == 6:
        return YM(s)
    raise BadParameter(f"YM must be YYYYMM or YYYY-MM; got {s!r}")


@ctbk.command('rides-v1-build', help="Build rides-<variant>/<anchor>/<tier>/<period>.parquet shards.")
@option('-a', '--anchor', type=str, default='both',
        help="'start' | 'end' | 'both' (default 'both').")
@option('-c', '--concurrency', type=int, default=4, help="Worker process count.")
@option('-f', '--ym-from', 'ym_from', required=True, help="Inclusive start (YYYY-MM).")
@flag('-F', '--full', help="'all'-sharded tiers: recompute the whole history (genesis → --ym-to) instead of merge-patching [-f, -T] into the existing shard. Implies -O.")
@option('-l', '--local-dir', type=str, default=None,
        help="Read/write local dir instead of R2 (prototype/smoke).")
@option('-n', '--dry-run', is_flag=True)
@option('-O', '--overwrite', '--force', is_flag=True, help="Rebuild even if output exists.")
@option('-t', '--tier', type=str, default='1h', help="Tier name.")
@option('-T', '--ym-to', 'ym_to', required=True, help="Inclusive end (YYYY-MM).")
@option('-v', '--variant', type=str, default='v3',
        help=f"Pyramid variant; one of {list(VARIANTS)} (default 'v3').")
def rides_v1_build_cmd(
    anchor: str,
    concurrency: int,
    ym_from: str,
    full: bool,
    local_dir: str | None,
    dry_run: bool,
    overwrite: bool,
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
    if full:
        overwrite = True

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
                tier, s_iso, a, overwrite, local_dir, all_dates_iso, full, variant,  # type: ignore[arg-type]
            )
            err(f"  {status:5s} {a:5s} {period} ({n:,} B)")
            n_wrote += (status == 'wrote'); n_skip += (status == 'skip'); n_empty += (status == 'empty')
            bytes_total += n
    else:
        with ProcessPoolExecutor(max_workers=concurrency) as pool:
            futs = {
                pool.submit(
                    _build_shard_task, tier, s_iso, a, overwrite, local_dir, all_dates_iso, full, variant,  # type: ignore[arg-type]
                ): (s_iso, a)
                for s_iso, a in tasks
            }
            for fut in as_completed(futs):
                period, a, status, n = fut.result()
                err(f"  {status:5s} {a:5s} {period} ({n:,} B)")
                n_wrote += (status == 'wrote'); n_skip += (status == 'skip'); n_empty += (status == 'empty')
                bytes_total += n

    err(f"done: {n_wrote} wrote, {n_skip} skip, {n_empty} empty, {bytes_total:,} bytes total")


@ctbk.command('rides-v3-extend', help="Monthly rides-v3 (rollback pyramid) extension for one freshly-ingested month: `rides-v1-build -O` over [prev, ym] for the 1h tier + every derived tier.")
@option('-c', '--concurrency', type=int, default=1, help="Worker process count per tier build (default 1: the 'all'-shard merge-patch peaks ~5.4GB RSS per worker; two workers OOM'd 16GB GHA runners, 2026-08-15).")
@argument('ym', metavar='YM')
def rides_v3_extend_cmd(concurrency: int, ym: str) -> None:
    """Range = prev-month → current: rebuilding prev month's /1h
    start-anchored shard picks up rides that started in prev but ended
    in the new month (invisible until the new month's normalized parquet
    existed) — `-O` makes that refold actually happen (without it the
    existing prev shard short-circuits as `skip`). Requires prev's
    `normalized/<ym>.parquet` locally (`ci.yml` pulls it). Derived tiers
    need `-O` to fold in the new /1h data; 'all'-sharded tiers
    merge-patch the [-f, -T] window into the existing full-history shard
    (2026-08-14 truncation incident). Each tier runs as a subprocess so
    peak memory resets between tiers."""
    from utz import run
    y = _parse_ym(ym)
    prev = y - 1
    ym_new = f'{str(y)[:4]}-{str(y)[4:6]}'
    ym_prev = f'{str(prev)[:4]}-{str(prev)[4:6]}'
    c = str(concurrency)
    run('ctbk', 'rides-v1-build', '-c', c, '-v', 'v3', '-f', ym_prev, '-T', ym_new, '-O')
    for t in ('3h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo', '3mo', '1y'):
        run('ctbk', 'rides-v1-build', '-c', c, '-v', 'v3', '-f', ym_prev, '-T', ym_new, '-t', t, '-O')
