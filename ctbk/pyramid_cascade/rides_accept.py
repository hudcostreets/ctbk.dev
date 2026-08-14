"""rides-v5 acceptance vs rides-v3 (`specs/rides-v5.md` §Acceptance).

Three checks, per anchor, over sample months spanning eras:

1. Station-row equivalence: every v5 `s:<short_name>` monthly row must
   equal the corresponding v3 row at that station's LUC cell (via
   `www/public/assets/station-luc.json`), across all dims and all 6
   monoid columns. Reads each pyramid's own `1mo` tier, so it exercises
   base ingest + the full cascade of both.
2. Monoid rebin probe: v5 `1h` rows re-floored to `6h` and re-summed
   must equal the materialized `6h` rows (all keys — `s:` leaves and
   vocab cells alike).
3. Ground-truth totals: per-month `count` totals from v5 leaf rows (and
   v3 LUC-leaf rows) must equal ride counts taken straight from the
   normalized parquets (rides whose anchor-time falls in the month —
   one step more primitive than the spec's `ctbk agg` gt, and free of
   the agg files' end-month/start-month keying ambiguity).

Run on a host with R2 access (`cf` boto profile or R2_* env) and the
sample months' (+1 spillover) normalized parquets pulled locally
(check 3).
"""
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
from utz import err

from ctbk.rides_v1 import MONOID_COLS, R2_BUCKET, SRC_DIR, read_shard

STATION_LUC_PATH = Path('www/public/assets/station-luc.json')

V5_PREFIX = 'rides-v5'


def _parse_period(period: str) -> datetime:
    for fmt in ('%Y-%m-%d', '%Y-%m', '%Y'):
        try:
            return datetime.strptime(period, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"unparseable shard period: {period!r}")


def _shard_span(shard: str, period: str) -> tuple[datetime, datetime]:
    """[start, end) of `rides-v5/{anchor}/{tier}/{shard}/{period}.parquet`."""
    t0 = _parse_period(period)
    n, unit = int(shard[:-1]), shard[-1]
    if unit == 'd':
        return t0, t0 + timedelta(days=n)
    if unit == 'y':
        return t0, t0.replace(year=t0.year + n)
    raise ValueError(f"unexpected shard duration unit: {shard!r}")


def v5_shards_covering(cli, anchor: str, tier: str, t0: datetime, t1: datetime) -> list[str]:
    """Keys of v5 shards overlapping [t0, t1), largest-rung first, with
    already-covered spans skipped (superseded smaller tiles may coexist
    until GC; taking both would double-count)."""
    prefix = f'{V5_PREFIX}/{anchor}/{tier}/'
    keys: list[tuple[str, datetime, datetime]] = []
    token = None
    while True:
        kw = dict(Bucket=R2_BUCKET, Prefix=prefix)
        if token:
            kw['ContinuationToken'] = token
        resp = cli.list_objects_v2(**kw)
        for o in resp.get('Contents', []):
            key = o['Key']
            shard, period = key[len(prefix):-len('.parquet')].split('/')
            s0, s1 = _shard_span(shard, period)
            if s0 < t1 and s1 > t0:
                keys.append((key, s0, s1))
        if not resp.get('IsTruncated'):
            break
        token = resp['NextContinuationToken']
    # Largest span first; drop shards fully inside an already-taken span.
    keys.sort(key=lambda k: (k[1] - k[2], k[1]))
    taken: list[tuple[datetime, datetime]] = []
    out: list[str] = []
    for key, s0, s1 in keys:
        if any(a0 <= s0 and s1 <= a1 for a0, a1 in taken):
            continue
        taken.append((s0, s1))
        out.append(key)
    return out


def read_v5(cli, anchor: str, tier: str, t0: datetime, t1: datetime) -> pd.DataFrame:
    keys = v5_shards_covering(cli, anchor, tier, t0, t1)
    if not keys:
        raise RuntimeError(f"no v5 {anchor}/{tier} shards cover [{t0:%Y-%m-%d}, {t1:%Y-%m-%d})")
    lo_ms, hi_ms = int(t0.timestamp()) * 1000, int(t1.timestamp()) * 1000
    frames = []
    for key in keys:
        obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
        df = pq.read_table(io.BytesIO(obj['Body'].read())).to_pandas()
        df = df[(df['dt'] >= lo_ms) & (df['dt'] < hi_ms)]
        if not df.empty:
            frames.append(df)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def month_bounds(ym: str) -> tuple[datetime, datetime]:
    t0 = datetime.strptime(ym, '%Y-%m').replace(tzinfo=timezone.utc)
    t1 = t0.replace(year=t0.year + 1, month=1) if t0.month == 12 else t0.replace(month=t0.month + 1)
    return t0, t1


def luc_map() -> dict[str, str]:
    by_short = json.loads(STATION_LUC_PATH.read_text())['by_short_name']
    return {short: rec['cell'] for short, rec in by_short.items()}


GROUP = ['gender', 'user_type', 'bike_type']


def check_station_equiv(cli, anchor: str, ym: str) -> dict:
    """Check 1: v5 `s:` monthly rows ≡ v3 LUC monthly rows, dims-level."""
    t0, t1 = month_bounds(ym)
    luc = luc_map()

    v5 = read_v5(cli, anchor, '1mo', t0, t1)
    v5 = v5[v5['cell'].str.startswith('s:')].copy()
    v5['short'] = v5['cell'].str[2:]

    v3 = read_shard(anchor, '1mo', '1920', None, cli, 'v3')
    if v3 is None:
        raise RuntimeError("v3 1mo/1920 missing")
    v3 = v3.to_pandas()
    lo_ms, hi_ms = int(t0.timestamp()) * 1000, int(t1.timestamp()) * 1000
    v3 = v3[(v3['dt'] >= lo_ms) & (v3['dt'] < hi_ms)].copy()
    cell_col = [c for c in v3.columns if c.endswith('_s2_cell')][0]
    luc_to_short = {c: s for s, c in luc.items()}
    v3 = v3[v3[cell_col].isin(luc_to_short)].copy()
    v3['short'] = v3[cell_col].map(luc_to_short)

    key = ['short', *GROUP]
    a = v5.groupby(key, observed=True)[MONOID_COLS].sum()
    b = v3.groupby(key, observed=True)[MONOID_COLS].sum()
    j = a.join(b, how='outer', lsuffix='_v5', rsuffix='_v3').fillna(0).astype('int64')
    diff_mask = pd.Series(False, index=j.index)
    for c in MONOID_COLS:
        diff_mask |= j[f'{c}_v5'] != j[f'{c}_v3']
    diffs = j[diff_mask]
    return {
        'ym': ym, 'anchor': anchor,
        'v5_rows': len(a), 'v3_rows': len(b),
        'stations_v5': v5['short'].nunique(), 'stations_v3': v3['short'].nunique(),
        'diff_rows': len(diffs),
        'examples': diffs.head(5).reset_index().to_dict(orient='records'),
    }


def check_rebin(cli, anchor: str, ym: str) -> dict:
    """Check 2: v5 1h re-floored to 6h ≡ materialized 6h (all keys)."""
    t0, t1 = month_bounds(ym)
    h1 = read_v5(cli, anchor, '1h', t0, t1)
    h6 = read_v5(cli, anchor, '6h', t0, t1)
    bin_ms = 6 * 3600 * 1000
    h1 = h1.copy()
    h1['dt'] = (h1['dt'] // bin_ms) * bin_ms
    key = ['cell', 'dt', *GROUP]
    a = h1.groupby(key, observed=True)[MONOID_COLS].sum()
    b = h6.groupby(key, observed=True)[MONOID_COLS].sum()
    j = a.join(b, how='outer', lsuffix='_r', rsuffix='_m').fillna(0).astype('int64')
    diff_mask = pd.Series(False, index=j.index)
    for c in MONOID_COLS:
        diff_mask |= j[f'{c}_r'] != j[f'{c}_m']
    diffs = j[diff_mask]
    return {
        'ym': ym, 'anchor': anchor, 'rebinned_rows': len(a), 'materialized_rows': len(b),
        'diff_rows': len(diffs),
        'examples': diffs.head(5).reset_index().to_dict(orient='records'),
    }


def _gt_count(anchor: str, ym: str) -> int:
    """Rides whose anchor-time falls in `ym`, counted from normalized
    parquets. `normalized/<M>.parquet` holds rides *ending* in M, so:
    end-anchor = file M filtered to Stop Time ∈ M (≡ all rows);
    start-anchor = files M and M+1 filtered to Start Time ∈ M."""
    t0, t1 = month_bounds(ym)
    lo, hi = pd.Timestamp(t0).tz_localize(None), pd.Timestamp(t1).tz_localize(None)
    ymc = ym.replace('-', '')
    col = 'Start Time' if anchor == 'start' else 'Stop Time'
    months = [ymc]
    if anchor == 'start':
        nxt = t1.strftime('%Y%m')
        if (SRC_DIR / f'{nxt}.parquet').exists():
            months.append(nxt)
    n = 0
    for m in months:
        p = SRC_DIR / f'{m}.parquet'
        if not p.exists():
            raise FileNotFoundError(f"{p} — `dvc pull` it first")
        t = pd.read_parquet(p, columns=[col])[col]
        n += int(((t >= lo) & (t < hi)).sum())
    return n


def check_totals(cli, anchor: str, ym: str) -> dict:
    """Check 3: v5 leaf `count` total ≡ normalized-source ride count
    (and v3 LUC-leaf total alongside)."""
    t0, t1 = month_bounds(ym)
    gt = _gt_count(anchor, ym)

    v5 = read_v5(cli, anchor, '1mo', t0, t1)
    v5_total = int(v5[v5['cell'].str.startswith('s:')]['count_sum'].sum())

    luc_cells = set(luc_map().values())
    v3 = read_shard(anchor, '1mo', '1920', None, cli, 'v3').to_pandas()
    lo_ms, hi_ms = int(t0.timestamp()) * 1000, int(t1.timestamp()) * 1000
    v3 = v3[(v3['dt'] >= lo_ms) & (v3['dt'] < hi_ms)]
    cell_col = [c for c in v3.columns if c.endswith('_s2_cell')][0]
    v3_total = int(v3[v3[cell_col].isin(luc_cells)]['count_sum'].sum())

    return {
        'ym': ym, 'anchor': anchor, 'agg': gt, 'v5': v5_total, 'v3_luc': v3_total,
        'v5_delta': v5_total - gt, 'v3_delta': v3_total - gt,
    }
