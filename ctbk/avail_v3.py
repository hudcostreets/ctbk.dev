"""Build the avail-v3 pyramid: histogram monoid + S2 inline + dense ladder.

R2 layout: `avail-v3/<tier>/<period>.parquet`

Output schema (per `pyrmts-geo` convention):
    s2_cell  : STRING        S2 hex token, e.g. '89c25b1'
    dt       : INT64         bucket-start unix **milliseconds**
    bikes    : STRING        JSON {state_str: observations}
    ebikes   : STRING        JSON
    docks    : STRING        JSON
    disabled : STRING        JSON
    pending  : STRING        JSON

For the 1m tier, "observations" within a (cell, dt) bucket = number of
stations in that cell whose value at minute `dt` equals `state_str`.

S2 levels materialized: [10, 11, 12, 13, 14, 15] (finest-first per
pyrmts-geo convention), matching `rides-v3`'s level set so FE covers
computed via `s2Index.minimalCover` are reusable byte-for-byte across
both pyramids.
"""
from __future__ import annotations

import io
import json
import os
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date as Date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Iterable

import boto3
import pyarrow as pa
import pyarrow.parquet as pq
import s2cell
from botocore.exceptions import ClientError
from click import BadParameter, argument, option
from pyrmts import write_tier_parquet
from utz import err
from utz.cli import flag

from ctbk.cli.base import ctbk

R2_BUCKET = 'ctbk'
SRC_PREFIX = 'gbfs/avail/agg=1m/cons=1m'      # input: per-minute shards
DST_PREFIX = 'avail-v3'                       # output: v3 pyramid (S2)
INFO_PREFIX = 'gbfs/info'                     # daily station info JSON

AVAIL_METRICS: tuple[str, ...] = ('bikes', 'ebikes', 'docks', 'disabled', 'pending')

# Coarsest S2 level we materialize. Every station contributes at every
# level from L10 down to its LUC (finest unique level). Matches the
# `coarsestLevel` arg the FE passes to `s2Index.minimalCover`.
COARSEST_LEVEL: int = 10


@dataclass(frozen=True)
class TierSpec:
    name: str
    bin_sec: int | None   # None for calendar tiers (1mo, 3mo, 1y)
    shard: str            # '1h' | '1d' | '1mo' | '1y' | 'all'
    derive_from: str | None  # None ⇒ build from 1m@1m source


TIER_SPECS: dict[str, TierSpec] = {
    '1m':  TierSpec('1m',  60,         '1h',  None),
    '2m':  TierSpec('2m',  120,        '1h',  '1m'),
    '3m':  TierSpec('3m',  180,        '1h',  '1m'),
    '5m':  TierSpec('5m',  300,        '1d',  '1m'),
    '10m': TierSpec('10m', 600,        '1d',  '1m'),
    '15m': TierSpec('15m', 900,        '1d',  '1m'),
    '30m': TierSpec('30m', 1800,       '1d',  '1m'),
    '1h':  TierSpec('1h',  3600,       '1mo', '30m'),
    '2h':  TierSpec('2h',  7200,       '1mo', '30m'),
    '3h':  TierSpec('3h',  10800,      '1mo', '30m'),
    '6h':  TierSpec('6h',  21600,      '1mo', '30m'),
    '12h': TierSpec('12h', 43200,      '1mo', '30m'),
    '1d':  TierSpec('1d',  86400,      '1y',  '1h'),
    '3d':  TierSpec('3d',  259200,     '1y',  '1h'),
    '7d':  TierSpec('7d',  604800,     '1y',  '1h'),
    '1mo': TierSpec('1mo', None,       '1y',  '1d'),
    '3mo': TierSpec('3mo', None,       '1y',  '1d'),
    '1y':  TierSpec('1y',  None,       'all', '1d'),
}


# ─── R2 client ─────────────────────────────────────────────────────────

def r2_endpoint() -> str:
    aid = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or os.environ.get('R2_ACCOUNT_ID')
    if not aid:
        raise RuntimeError("CLOUDFLARE_ACCOUNT_ID (or R2_ACCOUNT_ID) not set")
    return f'https://{aid}.r2.cloudflarestorage.com'


def r2_client():
    """Boto3 S3 client wired for R2.

    Prefers `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (matches the
    convention in `avail_geo_backfill.py`); falls back to AWS profile
    `cf` (which we use locally with the R2 endpoint configured in
    `~/.aws/config`).
    """
    if 'R2_ACCESS_KEY_ID' in os.environ and 'R2_SECRET_ACCESS_KEY' in os.environ:
        sess = boto3.Session(
            aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
            aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
            region_name='auto',
        )
    else:
        sess = boto3.Session(profile_name='cf', region_name='auto')
    return sess.client('s3', endpoint_url=r2_endpoint())


# ─── Shard period encoding ─────────────────────────────────────────────

def shard_period(shard: str, t: datetime) -> str:
    """Filename-stem identifier for the shard covering `t` at granularity `shard`."""
    if shard == '1h':  return t.strftime('%Y-%m-%d/%H')
    if shard == '1d':  return t.strftime('%Y-%m-%d')
    if shard == '1mo': return t.strftime('%Y-%m')
    if shard == '1y':  return t.strftime('%Y')
    if shard == 'all': return 'all'
    raise ValueError(f"unknown shard granularity: {shard!r}")


def shard_starts(shard: str, date_from: Date, date_to: Date) -> list[datetime]:
    """Enumerate UTC shard-start times in `[date_from, date_to)` for granularity `shard`."""
    if date_from >= date_to:
        return []
    start = datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc)
    end = datetime.combine(date_to, datetime.min.time(), tzinfo=timezone.utc)
    out: list[datetime] = []
    cur = start
    if shard == '1h':
        step = timedelta(hours=1)
        while cur < end:
            out.append(cur); cur += step
    elif shard == '1d':
        step = timedelta(days=1)
        while cur < end:
            out.append(cur); cur += step
    elif shard == '1mo':
        cur = cur.replace(day=1)
        while cur < end:
            out.append(cur)
            y, m = (cur.year + (1 if cur.month == 12 else 0), 1 if cur.month == 12 else cur.month + 1)
            cur = cur.replace(year=y, month=m)
    elif shard == '1y':
        cur = cur.replace(month=1, day=1)
        while cur < end:
            out.append(cur)
            cur = cur.replace(year=cur.year + 1)
    elif shard == 'all':
        out.append(start)
    else:
        raise ValueError(f"unknown shard granularity: {shard!r}")
    return out


def output_key(tier: str, period: str) -> str:
    return f'{DST_PREFIX}/{tier}/{period}.parquet'


# ─── Station LUC denorm ────────────────────────────────────────────────

@lru_cache(maxsize=1)
def load_station_luc() -> dict:
    """Fetch `station-luc.json` from R2.

    Schema (see `ctbk/station_luc.py`):
      {
        "by_short_name": {<short_name>: {lat, lng, cell, level, uuid}, ...},
        "by_uuid":       {<gbfs_station_id>: <short_name>, ...},
      }
    """
    cli = r2_client()
    obj = cli.get_object(Bucket=R2_BUCKET, Key='station-luc.json')
    return json.loads(obj['Body'].read())


# ─── 1m tier: build one 1-hour shard from 60 minute-files ──────────────

def list_minute_keys(date_str: str, hour: int) -> list[str]:
    """The 60 source keys for `<date_str>` hour `<hour>`."""
    return [
        f'{SRC_PREFIX}/{date_str}/{hour:02d}{m:02d}.parquet'
        for m in range(60)
    ]


def read_minute_shard(cli, key: str) -> pa.Table | None:
    """Fetch one 1m@1m parquet from R2 → pyarrow Table. None if 404."""
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        raise
    return pq.read_table(io.BytesIO(obj['Body'].read()))


def build_1m_hour_table(
    date_str: str,
    hour: int,
    station_luc: dict,
    coarsest_level: int = COARSEST_LEVEL,
) -> pa.Table | None:
    """Build one avail-v3/1m/<date>/<HH>.parquet table from 60 minute files.

    Each station's observations are materialized at the station's LUC
    + all ancestor levels down to `coarsest_level`. WAL rows carry the
    GBFS UUID; resolve via `station_luc['by_uuid']` → canonical
    short_name → `by_short_name[…]` LUC entry. See
    `specs/per-station-luc-v3.md` for the architecture.

    Returns None if no source minutes are present (shard skipped upstream).
    """
    cli = r2_client()
    by_short_name: dict[str, dict] = station_luc['by_short_name']
    by_uuid: dict[str, str] = station_luc['by_uuid']
    # Precompute UUID → cell chain (L<coarsest_level>..L<LUC>) once.
    uuid_cell_chain: dict[str, list[str]] = {}
    for uuid, sn in by_uuid.items():
        entry = by_short_name.get(sn)
        if entry is None:
            continue  # by_uuid maps to a short_name we don't have LUC for
        lat, lng, luc_level, luc_cell = entry['lat'], entry['lng'], entry['level'], entry['cell']
        chain = [s2cell.lat_lon_to_token(lat, lng, lvl) for lvl in range(coarsest_level, luc_level)]
        chain.append(luc_cell)
        uuid_cell_chain[uuid] = chain

    # Accumulator: (cell, dt_sec, metric) → {state_str: observation_count}
    accum: dict[tuple[str, int, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))
    missing_sids: set[str] = set()
    n_minutes_seen = 0

    for key in list_minute_keys(date_str, hour):
        tab = read_minute_shard(cli, key)
        if tab is None: continue
        n_minutes_seen += 1
        # Project only the columns we need: station_id, dt, <m>_sum (since n=1 ⇒ sum==state).
        cols_needed = ['station_id', 'dt'] + [f'{m}_sum' for m in AVAIL_METRICS]
        d = tab.select(cols_needed).to_pydict()
        sids = d['station_id']
        dts = d['dt']
        metric_vals = {m: d[f'{m}_sum'] for m in AVAIL_METRICS}
        for i, sid in enumerate(sids):
            chain = uuid_cell_chain.get(sid)
            if chain is None:
                missing_sids.add(sid)
                continue
            dt_sec = int(dts[i])
            for m in AVAIL_METRICS:
                v = metric_vals[m][i]
                if v is None: continue
                state_s = str(int(v))
                for cell in chain:
                    accum[(cell, dt_sec, m)][state_s] += 1

    if n_minutes_seen == 0:
        return None
    if missing_sids:
        err(f"  {date_str} hr{hour:02d}: dropped {len(missing_sids)} station_ids missing from station-luc.json "
            f"(e.g. {sorted(missing_sids)[:3]})")

    # Pivot: (cell, dt_sec) → {metric: json_string}
    rows: dict[tuple[str, int], dict[str, str]] = {}
    for (cell, dt_sec, metric), hist in accum.items():
        # Sort by integer state for byte-reproducibility + readable diffs.
        sorted_hist = dict(sorted(hist.items(), key=lambda kv: int(kv[0])))
        rows.setdefault((cell, dt_sec), {})[metric] = json.dumps(sorted_hist, separators=(',', ':'))

    keys = list(rows.keys())
    s2_cell_col = [k[0] for k in keys]
    dt_ms_col = [k[1] * 1000 for k in keys]
    metric_cols: dict[str, list[str | None]] = {m: [] for m in AVAIL_METRICS}
    for k in keys:
        r = rows[k]
        for m in AVAIL_METRICS:
            metric_cols[m].append(r.get(m))

    arrays = [
        pa.array(s2_cell_col, type=pa.string()),
        pa.array(dt_ms_col, type=pa.int64()),
    ]
    names = ['s2_cell', 'dt']
    for m in AVAIL_METRICS:
        arrays.append(pa.array(metric_cols[m], type=pa.string()))
        names.append(m)
    return pa.table(arrays, names=names)


def write_table_to_r2(cli, table: pa.Table, key: str) -> int:
    """Serialize `table` to parquet via `pyrmts.write_tier_parquet` (sorts by
    `(dt, s2_cell)` + picks RG size for hyparquet RG-pruning) and PUT to R2.
    Returns bytes written."""
    buf = io.BytesIO()
    write_tier_parquet(table, out=buf, sort=['dt', 's2_cell'])
    body = buf.getvalue()
    cli.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=body,
        ContentType='application/octet-stream',
    )
    return len(body)


def r2_head(cli, key: str) -> dict | None:
    try:
        return cli.head_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('404', 'NoSuchKey'):
            return None
        raise


# ─── Cascade derived tiers ─────────────────────────────────────────────

def dt_floor_ms_fixed(dt_ms: int, bin_sec: int) -> int:
    """Floor `dt_ms` (unix ms) to the start of its `bin_sec`-second bucket."""
    bin_ms = bin_sec * 1000
    return (dt_ms // bin_ms) * bin_ms


def dt_floor_ms_calendar(dt_ms: int, tier: str) -> int:
    """Calendar-aware floor for {1mo, 3mo, 1y}."""
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


def shard_end(shard: str, t: datetime) -> datetime:
    """Exclusive end of the shard starting at `t`."""
    if shard == '1h':  return t + timedelta(hours=1)
    if shard == '1d':  return t + timedelta(days=1)
    if shard == '1mo':
        y, m = (t.year + (1 if t.month == 12 else 0), 1 if t.month == 12 else t.month + 1)
        return t.replace(year=y, month=m)
    if shard == '1y':  return t.replace(year=t.year + 1)
    if shard == 'all': return datetime(9999, 12, 31, tzinfo=timezone.utc)
    raise ValueError(f"unknown shard granularity: {shard!r}")


def input_periods_for_output(
    output_shard_start: datetime,
    output_shard: str,
    input_shard: str,
    all_dates: tuple[Date, Date] | None = None,
) -> list[str]:
    """Enumerate input-shard `period` strings that overlap one output shard window.

    `all_dates=(from, to)` is required when `output_shard == 'all'` to bound
    the input scan; ignored otherwise.
    """
    end = shard_end(output_shard, output_shard_start)
    if output_shard == 'all':
        if all_dates is None:
            raise ValueError("output_shard='all' requires all_dates=(from, to)")
        df, dt_ = all_dates
    else:
        df, dt_ = (output_shard_start.date(), end.date())
        # If end falls exactly on midnight UTC, end.date() is already exclusive.
        if end.time() != datetime.min.time():
            dt_ = (end + timedelta(days=1)).date()
    starts = shard_starts(input_shard, df, dt_)
    # For shard='all' the output window is unbounded below; accept any input start.
    # Otherwise only inputs that start within the output window contribute.
    if output_shard == 'all':
        return [shard_period(input_shard, s) for s in starts]
    return [shard_period(input_shard, s) for s in starts if output_shard_start <= s < end]


def read_v3_shard(cli, tier: str, period: str) -> pa.Table | None:
    """Fetch one `avail-v3/<tier>/<period>.parquet` from R2; None on 404."""
    key = output_key(tier, period)
    try:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in ('NoSuchKey', '404'):
            return None
        raise
    return pq.read_table(io.BytesIO(obj['Body'].read()))


def build_cascade_shard(
    tier: str,
    shard_start: datetime,
    all_dates: tuple[Date, Date] | None = None,
) -> pa.Table | None:
    """Build one cascaded output shard for `tier` covering `[shard_start, end)`.

    Reads all input shards (at the derive-from tier's granularity) that
    overlap the output window, re-buckets by the output tier's bin, and
    combines histograms per (s2_cell, dt_out, metric). Returns None if no
    input shards are present.
    """
    spec = TIER_SPECS[tier]
    if spec.derive_from is None:
        raise ValueError(f"tier {tier!r} has no derive_from")
    input_spec = TIER_SPECS[spec.derive_from]
    cli = r2_client()
    periods = input_periods_for_output(shard_start, spec.shard, input_spec.shard, all_dates)

    # Accumulator: (cell, dt_out_ms, metric) → {state_str: count}
    accum: dict[tuple[str, int, str], dict[str, int]] = {}
    n_present = 0
    for p in periods:
        tab = read_v3_shard(cli, spec.derive_from, p)
        if tab is None:
            continue
        n_present += 1
        cell_col = tab['s2_cell'].to_pylist()
        dt_col = tab['dt'].to_pylist()
        metric_cols_in = {m: tab[m].to_pylist() for m in AVAIL_METRICS}
        for i in range(tab.num_rows):
            cell = cell_col[i]
            dt_in = dt_col[i]
            if spec.bin_sec is not None:
                dt_out = dt_floor_ms_fixed(dt_in, spec.bin_sec)
            else:
                dt_out = dt_floor_ms_calendar(dt_in, tier)
            for m in AVAIL_METRICS:
                js = metric_cols_in[m][i]
                if js is None: continue
                d = json.loads(js)
                if not d: continue
                key = (cell, dt_out, m)
                acc_d = accum.get(key)
                if acc_d is None:
                    accum[key] = dict(d)
                else:
                    for k, v in d.items():
                        acc_d[k] = acc_d.get(k, 0) + v

    if n_present == 0:
        return None

    rows: dict[tuple[str, int], dict[str, str]] = {}
    for (cell, dt_out, metric), hist in accum.items():
        sorted_hist = dict(sorted(hist.items(), key=lambda kv: int(kv[0])))
        rows.setdefault((cell, dt_out), {})[metric] = json.dumps(sorted_hist, separators=(',', ':'))

    keys = list(rows.keys())
    s2_cell_col = [k[0] for k in keys]
    dt_ms_col = [k[1] for k in keys]
    metric_cols_out: dict[str, list[str | None]] = {m: [] for m in AVAIL_METRICS}
    for k in keys:
        r = rows[k]
        for m in AVAIL_METRICS:
            metric_cols_out[m].append(r.get(m))

    arrays = [
        pa.array(s2_cell_col, type=pa.string()),
        pa.array(dt_ms_col, type=pa.int64()),
    ]
    names = ['s2_cell', 'dt']
    for m in AVAIL_METRICS:
        arrays.append(pa.array(metric_cols_out[m], type=pa.string()))
        names.append(m)
    return pa.table(arrays, names=names)


# ─── Per-shard worker (top-level for ProcessPool pickling) ─────────────

def _build_shard_task(
    tier: str,
    shard_start_iso: str,
    overwrite: bool,
    all_dates_iso: tuple[str, str] | None,
) -> tuple[str, str, int]:
    """ProcessPool worker: build + write one shard (any tier).

    Dispatches on `TIER_SPECS[tier].derive_from`:
      - None → build from 1m@1m source (S2-materialize per-station LUC + ancestors)
      - else → cascade-combine from the derive-from tier
    Returns (period_str, status, bytes_written). Status ∈ {"wrote", "skip", "empty"}.
    """
    t = datetime.fromisoformat(shard_start_iso)
    spec = TIER_SPECS[tier]
    period = shard_period(spec.shard, t)
    out_key = output_key(tier, period)
    cli = r2_client()
    if not overwrite and r2_head(cli, out_key) is not None:
        return (period, 'skip', 0)
    if spec.derive_from is None:
        date_str = t.strftime('%Y-%m-%d')
        luc = load_station_luc()
        table = build_1m_hour_table(date_str, t.hour, luc)
    else:
        ad = (
            (Date.fromisoformat(all_dates_iso[0]), Date.fromisoformat(all_dates_iso[1]))
            if all_dates_iso else None
        )
        table = build_cascade_shard(tier, t, ad)
    if table is None:
        return (period, 'empty', 0)
    n = write_table_to_r2(cli, table, out_key)
    return (period, 'wrote', n)


# ─── CLI ───────────────────────────────────────────────────────────────

@ctbk.command('avail-v3-build', help="Build avail-v3/<tier>/<period>.parquet shards (S2-keyed, LUC-anchored).")
@option('-c', '--concurrency', type=int, default=8, help="Worker process count.")
@option('-f', '--date-from', 'date_from', required=True, help="Inclusive start (YYYY-MM-DD).")
@option('-n', '--dry-run', is_flag=True, help="Print shards that would be (re)built, then exit.")
@option('-O', '--overwrite', '--force', is_flag=True, help="Rebuild even if output exists.")
@option('-t', '--tier', required=True, type=str, help="Tier name (see TIER_SPECS).")
@option('-T', '--date-to', 'date_to', required=True, help="Exclusive end (YYYY-MM-DD).")
def avail_v3_build_cmd(
    concurrency: int,
    date_from: str,
    dry_run: bool,
    overwrite: bool,
    tier: str,
    date_to: str,
):
    if tier not in TIER_SPECS:
        raise BadParameter(f"unknown tier {tier!r}; known: {list(TIER_SPECS)}")
    spec = TIER_SPECS[tier]
    df = Date.fromisoformat(date_from)
    dt = Date.fromisoformat(date_to)

    # For 'all' shards there's one output globally; emit a single start (UTC midnight of date_from).
    if spec.shard == 'all':
        starts = [datetime.combine(df, datetime.min.time(), tzinfo=timezone.utc)]
    else:
        starts = shard_starts(spec.shard, df, dt)
    err(f"avail-v3-build tier={tier} {len(starts)} shards in [{date_from}, {date_to})")

    if dry_run:
        cli = r2_client()
        for s in starts:
            period = shard_period(spec.shard, s)
            out_key = output_key(tier, period)
            present = r2_head(cli, out_key) is not None
            mark = 'EXISTS' if present and not overwrite else 'BUILD'
            print(f"  {mark} {out_key}")
        return

    starts_iso = [s.isoformat() for s in starts]
    all_dates_iso = (date_from, date_to) if spec.shard == 'all' else None
    n_wrote = n_skip = n_empty = bytes_total = 0
    if concurrency <= 1:
        for s_iso in starts_iso:
            period, status, n = _build_shard_task(tier, s_iso, overwrite, all_dates_iso)
            err(f"  {status:5s} {period} ({n:,} B)")
            n_wrote  += (status == 'wrote')
            n_skip   += (status == 'skip')
            n_empty  += (status == 'empty')
            bytes_total += n
    else:
        with ProcessPoolExecutor(max_workers=concurrency) as pool:
            futs = {
                pool.submit(_build_shard_task, tier, s_iso, overwrite, all_dates_iso): s_iso
                for s_iso in starts_iso
            }
            for fut in as_completed(futs):
                period, status, n = fut.result()
                err(f"  {status:5s} {period} ({n:,} B)")
                n_wrote  += (status == 'wrote')
                n_skip   += (status == 'skip')
                n_empty  += (status == 'empty')
                bytes_total += n

    err(f"done: {n_wrote} wrote, {n_skip} skip, {n_empty} empty, {bytes_total:,} bytes total")
