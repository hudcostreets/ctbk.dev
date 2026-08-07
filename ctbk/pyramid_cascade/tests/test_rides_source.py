"""Tests for `MonthlyRidesSource` (`specs/rides-v5.md`): sum-monoid
long-form emission, vocab-chain keying, start-anchor spillback tiles,
coordinate fallback for unmapped station ids, and coverage semantics.
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyrmts import MemStorage, parse_pyramid_yaml, pyramid_from_config

from ctbk.pyramid_cascade.rides_source import MonthlyRidesSource

YAML = """
storage: { type: s3, bucket: x, key: "t/{tier}/{shard}/{period}.parquet" }
axis: time
binCol: dt
dims:
  - { name: cell,      type: string }
  - { name: gender,    type: string }
  - { name: user_type, type: string }
  - { name: bike_type, type: string }
metrics:
  - { name: count,    monoid: sum }
  - { name: duration, monoid: sum }
tiers:
  - { name: 1h, bin: 1h, shards: [32d] }
"""

CHAINS = {
    'ST1': ['cell-a', 's:ST1'],
    'ST2': ['cell-a', 's:ST2'],
}
CANONICAL = {'101': 'ST1', '102': 'ST2', 'legacy-1': 'ST1'}
GEO = {'999': (40.7, -74.0)}
VOCAB_CELLS = frozenset({'cell-a'})

JUN = datetime(2026, 6, 1, tzinfo=timezone.utc)
JUL = datetime(2026, 7, 1, tzinfo=timezone.utc)
AUG = datetime(2026, 8, 1, tzinfo=timezone.utc)


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def ride(
    start: datetime,
    stop: datetime,
    start_sid: str = '101',
    end_sid: str = '102',
    gender: int | None = 1,
    user_type: str = 'Subscriber',
    bike_type: str = 'classic',
    start_lat: float | None = 40.7,
    start_lng: float | None = -74.0,
) -> dict:
    return {
        'Start Time': start.replace(tzinfo=None),
        'Stop Time': stop.replace(tzinfo=None),
        'Start Station ID': start_sid,
        'Start Station Latitude': start_lat,
        'Start Station Longitude': start_lng,
        'End Station ID': end_sid,
        'End Station Latitude': 40.71,
        'End Station Longitude': -74.01,
        'Gender': gender,
        'User Type': user_type,
        'Rideable Type': bike_type,
    }


RIDE_SCHEMA = pa.schema([
    ('Start Time', pa.timestamp('us')),
    ('Stop Time', pa.timestamp('us')),
    ('Start Station ID', pa.string()),
    ('Start Station Latitude', pa.float64()),
    ('Start Station Longitude', pa.float64()),
    ('End Station ID', pa.string()),
    ('End Station Latitude', pa.float64()),
    ('End Station Longitude', pa.float64()),
    ('Gender', pa.int64()),
    ('User Type', pa.string()),
    ('Rideable Type', pa.string()),
])


def rides_blob(rows: list[dict]) -> bytes:
    table = pa.table(
        {f.name: [r[f.name] for r in rows] for f in RIDE_SCHEMA},
        schema=RIDE_SCHEMA,
    )
    buf = BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


@pytest.fixture
def pyramid():
    cfg = parse_pyramid_yaml(YAML)
    return pyramid_from_config(cfg, MemStorage())


def make_source(
    pyramid,
    tiles: dict[str, list[dict]],
    anchor: str = 'start',
) -> MonthlyRidesSource:
    blobs = {f'normalized/{ym}.parquet': rides_blob(rows) for ym, rows in tiles.items()}
    return MonthlyRidesSource(
        pyramid,
        anchor,
        chains=CHAINS,
        canonical=CANONICAL,
        geo=GEO,
        vocab_cells=VOCAB_CELLS,
        available_months=set(tiles),
        fetch_fn=blobs.get,
    )


def read_sorted(src: MonthlyRidesSource, start: datetime, end: datetime) -> list[tuple]:
    df = src.read_window(start, end)
    return sorted(
        df
        .with_columns(pl.col('metric').cast(pl.Utf8))
        .select('cell', 'dt', 'gender', 'user_type', 'bike_type', 'metric', 'state', 'count')
        .rows()
    )


def expected_rows(
    cell: str, dt_ms: int, gender: str, user_type: str, bike_type: str,
    n: int, dsum: int, dsumsq: int,
) -> list[tuple]:
    dims = (cell, dt_ms, gender, user_type, bike_type)
    return [
        (*dims, 'count_n', None, float(n)),
        (*dims, 'count_sum', None, float(n)),
        (*dims, 'count_sumsq', None, float(n)),
        (*dims, 'duration_n', None, float(n)),
        (*dims, 'duration_sum', None, float(dsum)),
        (*dims, 'duration_sumsq', None, float(dsumsq)),
    ]


def test_sum_monoid_long_form(pyramid):
    # Two same-hour ST1 rides (600s, 1200s) + one next-hour ST2 ride
    # (300s): grouped sums per (chain cell, hour, dims), each group
    # emitting the six sum-monoid state rows.
    t0 = datetime(2026, 6, 10, 9, 5, tzinfo=timezone.utc)
    t1 = datetime(2026, 6, 10, 9, 40, tzinfo=timezone.utc)
    t2 = datetime(2026, 6, 10, 10, 15, tzinfo=timezone.utc)
    src = make_source(pyramid, {'202606': [
        ride(t0, t0.replace(minute=15), start_sid='101'),          # 600 s
        ride(t1, t1.replace(hour=10, minute=0), start_sid='101'),  # 1200 s
        ride(t2, t2.replace(minute=20), start_sid='102'),          # 300 s
    ]})
    h9 = ms(datetime(2026, 6, 10, 9, tzinfo=timezone.utc))
    h10 = ms(datetime(2026, 6, 10, 10, tzinfo=timezone.utc))
    assert read_sorted(src, JUN, JUL) == sorted(
        expected_rows('cell-a', h9, 'male', 'Subscriber', 'classic', 2, 1800, 1_800_000)
        + expected_rows('s:ST1', h9, 'male', 'Subscriber', 'classic', 2, 1800, 1_800_000)
        + expected_rows('cell-a', h10, 'male', 'Subscriber', 'classic', 1, 300, 90_000)
        + expected_rows('s:ST2', h10, 'male', 'Subscriber', 'classic', 1, 300, 90_000)
    )


def test_start_anchor_spillback(pyramid):
    # A ride starting 23:30 Jun 30 ending Jul 1 lives in JULY's parquet
    # (rides are stored by end month) but belongs to June's window under
    # the start anchor. `tiles_for` must pull the July tile for a June
    # window; the July-started ride in the same tile must be clipped out.
    jun30 = datetime(2026, 6, 30, 23, 30, tzinfo=timezone.utc)
    jul2 = datetime(2026, 7, 2, 8, 0, tzinfo=timezone.utc)
    src = make_source(pyramid, {
        '202606': [],
        '202607': [
            ride(jun30, datetime(2026, 7, 1, 0, 10, tzinfo=timezone.utc)),  # 2400 s
            ride(jul2, jul2.replace(minute=10), start_sid='102'),
        ],
    })
    h2330 = ms(datetime(2026, 6, 30, 23, tzinfo=timezone.utc))
    assert read_sorted(src, JUN, JUL) == sorted(
        expected_rows('cell-a', h2330, 'male', 'Subscriber', 'classic', 1, 2400, 5_760_000)
        + expected_rows('s:ST1', h2330, 'male', 'Subscriber', 'classic', 1, 2400, 5_760_000)
    )


def test_end_anchor_no_spillback_tile(pyramid):
    # End anchor: the boundary ride's END hour is in July, served by the
    # July tile alone; a June window over the June tile is empty, and no
    # spillback tile is requested (fetch of an absent 202607 would
    # record a coverage miss).
    jun30 = datetime(2026, 6, 30, 23, 30, tzinfo=timezone.utc)
    src = make_source(
        pyramid,
        {'202606': [ride(jun30, datetime(2026, 6, 30, 23, 55, tzinfo=timezone.utc))]},
        anchor='end',
    )
    h2330 = ms(datetime(2026, 6, 30, 23, tzinfo=timezone.utc))
    assert read_sorted(src, JUN, JUL) == sorted(
        expected_rows('cell-a', h2330, 'male', 'Subscriber', 'classic', 1, 1500, 2_250_000)
        + expected_rows('s:ST2', h2330, 'male', 'Subscriber', 'classic', 1, 1500, 2_250_000)
    )
    assert src.coverage() == (1, [])


def test_unmapped_sid_coordinate_fallback(pyramid):
    # Station id absent from the canonical map: keyed by S2 tokens from
    # coordinates (levels 10..15), with vocab cells excluded. Null
    # coordinates fill from the geo lookup. A ride with neither mapping
    # nor coordinates is dropped.
    t = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc)
    src = make_source(pyramid, {'202606': [
        ride(t, t.replace(minute=10), start_sid='999', start_lat=None, start_lng=None),
        ride(t, t.replace(minute=10), start_sid='888', start_lat=None, start_lng=None),
    ]})
    rows = read_sorted(src, JUN, JUL)
    import s2cell
    lat, lng = GEO['999']
    fallback_cells = [s2cell.lat_lon_to_token(lat, lng, lvl) for lvl in range(10, 16)]
    h12 = ms(t)
    assert rows == sorted(
        r
        for c in fallback_cells
        for r in expected_rows(c, h12, 'male', 'Subscriber', 'classic', 1, 600, 360_000)
    )


def test_identity_sid_maps_to_own_chain(pyramid):
    # Modern rides carry short_names directly as station ids ('ST1'),
    # absent from the legacy id-map: `canon.get(sid, sid)` semantics —
    # the sid itself is the candidate short_name, NOT coordinate
    # fallback (the JC149 finding, `specs/rides-v5.md` acceptance).
    t = datetime(2026, 6, 5, 12, 0, tzinfo=timezone.utc)
    src = make_source(pyramid, {'202606': [
        ride(t, t.replace(minute=10), start_sid='ST1'),
    ]})
    h12 = ms(t)
    assert read_sorted(src, JUN, JUL) == sorted(
        expected_rows('cell-a', h12, 'male', 'Subscriber', 'classic', 1, 600, 360_000)
        + expected_rows('s:ST1', h12, 'male', 'Subscriber', 'classic', 1, 600, 360_000)
    )


def test_missing_mid_history_month_is_coverage_miss(pyramid):
    # A window over a month whose parquet is absent: strict coverage
    # miss (the engine's `max_missing_source` guard turns it into a
    # build error). The spillback tile's absence must NOT be a miss —
    # covered by `test_end_anchor_no_spillback_tile` +
    # `available_months` gating in `tiles_for`.
    src = make_source(pyramid, {'202607': []})
    assert read_sorted(src, JUN, JUL) == []
    # 2 tiles read: the missing June tile + the (present, empty) July
    # spillback tile; only June counts as missing.
    assert src.coverage() == (2, ['normalized/202606.parquet'])
