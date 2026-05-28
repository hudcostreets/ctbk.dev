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
from functools import lru_cache
from pathlib import Path
from typing import Literal

import boto3
import h3
import pandas as pd
import pyarrow as pa
from botocore.exceptions import ClientError
from click import BadParameter, option
from pyrmts import write_tier_parquet
from utz import err
from utz.cli import flag
from utz.ym import YM

from ctbk.cli.base import ctbk

R2_BUCKET = 'ctbk'
DST_PREFIX = 'rides-v1'
SRC_DIR = Path(f's3/{R2_BUCKET}/normalized')
STATION_OBS_PATH = Path(f's3/{R2_BUCKET}/stations/station-observations.parquet')

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


def output_key(anchor: Anchor, tier: str, period: str) -> str:
    return f'{DST_PREFIX}/{anchor}/{tier}/{period}.parquet'


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


def write_table_to_r2(cli, table: pa.Table, key: str, cell_col: str) -> int:
    """Serialize via `pyrmts.write_tier_parquet` (sorts by `(dt, cell)` +
    picks RG size for hyparquet RG-pruning) and PUT to R2."""
    buf = io.BytesIO()
    write_tier_parquet(table, out=buf, sort=['dt', cell_col])
    body = buf.getvalue()
    cli.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=body,
        ContentType='application/octet-stream',
    )
    return len(body)


def write_table_to_local(table: pa.Table, path: Path, cell_col: str) -> int:
    import pyarrow.parquet as pq
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    write_tier_parquet(table, out=buf, sort=['dt', cell_col])
    body = buf.getvalue()
    path.write_bytes(body)
    return len(body)


# ─── Worker (top-level for ProcessPool pickling) ───────────────────────

def _build_1h_task(
    ym_str: str,
    anchor: Anchor,
    overwrite: bool,
    resolutions: tuple[int, ...],
    local_dir: str | None,
) -> tuple[str, Anchor, str, int]:
    """Build + write one rides-v1/<anchor>/1h/<ym>.parquet shard.
    Returns (ym_str, anchor, status, bytes). status ∈ {wrote, skip, empty}."""
    ym = YM(ym_str)
    period = f'{str(ym)[:4]}-{str(ym)[4:6]}'
    cfg = ANCHOR_CONFIG[anchor]

    if local_dir:
        out_path = Path(local_dir) / output_key(anchor, '1h', period)
        if not overwrite and out_path.exists():
            return (period, anchor, 'skip', 0)
    else:
        cli = r2_client()
        key = output_key(anchor, '1h', period)
        if not overwrite and r2_head(cli, key) is not None:
            return (period, anchor, 'skip', 0)

    table = build_1h_month_table(ym, anchor, resolutions)
    if table is None:
        return (period, anchor, 'empty', 0)

    if local_dir:
        n = write_table_to_local(table, out_path, cfg['cell_col'])
    else:
        n = write_table_to_r2(cli, table, key, cfg['cell_col'])
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


@ctbk.command('rides-v1-build', help="Build rides-v1/<anchor>/<tier>/<period>.parquet shards.")
@option('-a', '--anchor', type=str, default='both',
        help="'start' | 'end' | 'both' (default 'both').")
@option('-c', '--concurrency', type=int, default=4, help="Worker process count.")
@option('-f', '--ym-from', 'ym_from', required=True, help="Inclusive start (YYYY-MM).")
@option('-l', '--local-dir', type=str, default=None,
        help="Write to local dir instead of R2 (prototype/smoke).")
@option('-n', '--dry-run', is_flag=True)
@option('-O', '--overwrite', '--force', is_flag=True, help="Rebuild even if output exists.")
@option('-r', '--resolution', 'resolutions', multiple=True, type=int, default=DEFAULT_RESOLUTIONS,
        help="h3 resolutions to materialize (repeatable; default 9 7 5).")
@option('-t', '--tier', type=str, default='1h', help="Tier (only '1h' supported initially).")
@option('-T', '--ym-to', 'ym_to', required=True, help="Inclusive end (YYYY-MM).")
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
):
    if tier != '1h':
        raise BadParameter(f"only tier='1h' supported currently; got {tier!r}")
    if anchor not in ('start', 'end', 'both'):
        raise BadParameter(f"--anchor must be one of start/end/both; got {anchor!r}")
    anchors: tuple[Anchor, ...] = ANCHORS if anchor == 'both' else (anchor,)  # type: ignore[assignment]

    yms = _ym_range(ym_from, ym_to)
    err(f"rides-v1-build tier={tier} anchors={anchors} "
        f"{len(yms)} months in [{ym_from}, {ym_to}] (inclusive)")

    res_tup = tuple(resolutions)
    tasks = [(str(y), a) for y in yms for a in anchors]

    if dry_run:
        for y_str, a in tasks:
            period = f'{y_str[:4]}-{y_str[4:6]}'
            key = output_key(a, '1h', period)
            print(f"  BUILD {key}")
        return

    n_wrote = n_skip = n_empty = bytes_total = 0
    if concurrency <= 1:
        for y_str, a in tasks:
            period, _a, status, n = _build_1h_task(y_str, a, overwrite, res_tup, local_dir)
            err(f"  {status:5s} {a:5s} {period} ({n:,} B)")
            n_wrote += (status == 'wrote'); n_skip += (status == 'skip'); n_empty += (status == 'empty')
            bytes_total += n
    else:
        with ProcessPoolExecutor(max_workers=concurrency) as pool:
            futs = {
                pool.submit(_build_1h_task, y_str, a, overwrite, res_tup, local_dir): (y_str, a)
                for y_str, a in tasks
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
