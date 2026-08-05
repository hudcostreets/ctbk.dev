"""Tests for `DailyStatusSource` (pyrmts `specs/engine-raw-ingest.md`):
LU attribution (`dt` from `ts`, never poll minute), the per-(minute,
station) max-`ts` dedupe, vocab-chain expansion, and window clipping /
missing-tile coverage via the `TiledSource` chassis.
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyrmts import MemStorage, parse_pyramid_yaml, pyramid_from_config

from ctbk.pyramid_cascade.raw_source import DailyStatusSource

YAML = """
storage: { type: s3, bucket: x, key: "t/{tier}/{shard}/{period}.parquet" }
axis: time
binCol: dt
dims:
  - { name: s2_cell, type: string }
metrics:
  - { name: bikes,    monoid: histogram }
  - { name: ebikes,   monoid: histogram }
  - { name: docks,    monoid: histogram }
  - { name: disabled, monoid: histogram }
  - { name: pending,  monoid: histogram }
tiers:
  - { name: 1m, bin: 1min, shards: [5min] }
"""

CHAINS = {
    'uuid-a': ['cell-1', 's:100'],
    'uuid-b': ['cell-1', 's:200'],
}

DAY = datetime(2026, 8, 4, tzinfo=timezone.utc)
T0 = int(DAY.timestamp())


def status_blob(rows: list[dict]) -> bytes:
    cols = [
        'station_id', 'ts', 'polled_at', 'last_reported',
        'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
        'num_bikes_disabled', 'num_docks_disabled',
    ]
    table = pa.table({c: [r.get(c, 0) for r in rows] for c in cols})
    buf = BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


@pytest.fixture
def pyramid():
    cfg = parse_pyramid_yaml(YAML)
    return pyramid_from_config(cfg, MemStorage())


def source_with(pyramid, rows: list[dict]) -> DailyStatusSource:
    pyramid.storage.put('gbfs/status/2026-08-04.parquet', status_blob(rows))
    return DailyStatusSource(pyramid, CHAINS)


def read_sorted(src: DailyStatusSource, start: datetime, end: datetime) -> list[tuple]:
    df = src.read_window(start, end)
    return sorted(
        df
        .with_columns(pl.col('metric').cast(pl.Utf8))
        .select('s2_cell', 'dt', 'metric', 'state', 'count')
        .rows()
    )


def test_lu_attribution_and_dedupe(pyramid):
    # Three records for uuid-a: two in LU-minute 0 (ts 5 then 59 — the
    # max-ts one, bikes=7, must win) and one in LU-minute 1 (ts 65).
    # `polled_at` is a decoy 10 minutes later — attribution must ignore it.
    rows = [
        {'station_id': 'uuid-a', 'ts': T0 + 5,  'polled_at': T0 + 605, 'num_bikes_available': 3},
        {'station_id': 'uuid-a', 'ts': T0 + 59, 'polled_at': T0 + 659, 'num_bikes_available': 7},
        {'station_id': 'uuid-a', 'ts': T0 + 65, 'polled_at': T0 + 665, 'num_bikes_available': 2},
        # uuid-z has no chain — dropped entirely.
        {'station_id': 'uuid-z', 'ts': T0 + 5,  'num_bikes_available': 9},
    ]
    src = source_with(pyramid, rows)
    got = read_sorted(src, DAY, datetime(2026, 8, 4, 0, 2, tzinfo=timezone.utc))
    dt0, dt1 = T0 * 1000, (T0 + 60) * 1000
    expected = sorted(
        (cell, dt, metric, state, 1.0)
        for cell in ('cell-1', 's:100')
        for dt, bikes in ((dt0, 7), (dt1, 2))
        for metric, state in (
            ('bikes', bikes), ('ebikes', 0), ('docks', 0), ('disabled', 0), ('pending', 0),
        )
    )
    assert got == expected


def test_station_counts_aggregate_per_cell(pyramid):
    # Both stations share cell-1 with bikes=4 → one long row with count=2
    # at that (cell, state); identity keys stay count=1.
    rows = [
        {'station_id': 'uuid-a', 'ts': T0 + 5, 'num_bikes_available': 4, 'num_docks_available': 1},
        {'station_id': 'uuid-b', 'ts': T0 + 6, 'num_bikes_available': 4, 'num_docks_available': 2},
    ]
    src = source_with(pyramid, rows)
    got = read_sorted(src, DAY, datetime(2026, 8, 4, 0, 1, tzinfo=timezone.utc))
    dt0 = T0 * 1000
    expected = sorted(
        [('cell-1', dt0, 'bikes', 4, 2.0)]
        + [('cell-1', dt0, 'docks', d, 1.0) for d in (1, 2)]
        + [('cell-1', dt0, m, 0, 2.0) for m in ('ebikes', 'disabled', 'pending')]
        + [(f's:{n}', dt0, 'bikes', 4, 1.0) for n in (100, 200)]
        + [('s:100', dt0, 'docks', 1, 1.0), ('s:200', dt0, 'docks', 2, 1.0)]
        + [(f's:{n}', dt0, m, 0, 1.0) for n in (100, 200) for m in ('ebikes', 'disabled', 'pending')]
    )
    assert got == expected


def test_window_clips_and_empty_minutes_yield_nothing(pyramid):
    # Record at minute 10 only; a window over minutes [0, 10) is empty
    # (legitimate — no coverage miss), and [10, 11) sees it.
    rows = [{'station_id': 'uuid-a', 'ts': T0 + 600, 'num_bikes_available': 1}]
    src = source_with(pyramid, rows)
    before = src.read_window(DAY, datetime(2026, 8, 4, 0, 10, tzinfo=timezone.utc))
    assert before.height == 0
    hit = read_sorted(
        src,
        datetime(2026, 8, 4, 0, 10, tzinfo=timezone.utc),
        datetime(2026, 8, 4, 0, 11, tzinfo=timezone.utc),
    )
    dt10 = (T0 + 600) * 1000
    expected = sorted(
        (cell, dt10, metric, state, 1.0)
        for cell in ('cell-1', 's:100')
        for metric, state in (
            ('bikes', 1), ('ebikes', 0), ('docks', 0), ('disabled', 0), ('pending', 0),
        )
    )
    assert hit == expected
    assert src.coverage() == (1, [])


def test_missing_day_is_a_coverage_miss(pyramid):
    src = DailyStatusSource(pyramid, CHAINS)
    df = src.read_window(DAY, datetime(2026, 8, 4, 1, 0, tzinfo=timezone.utc))
    assert df.height == 0
    assert src.coverage() == (1, ['gbfs/status/2026-08-04.parquet'])
