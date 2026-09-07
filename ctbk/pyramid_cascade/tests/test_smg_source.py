"""Tests for `SmgDailySource` (`specs/avail-smg-pyramid.md`): the per-day
`gbfs/smg/<day>.parquet` (station, minute, state, state_ff) → long-form
`(s2_cell, dt, metric, state, count)` histogram rows, with vocab-chain expansion
(ancestor cells aggregate across stations; `s:` identity keys stay per-station),
via the `TiledSource` chassis.
"""
from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyrmts import MemStorage, parse_pyramid_yaml, pyramid_from_config

from ctbk.pyramid_cascade.smg_source import SmgDailySource

YAML = """
storage: { type: s3, bucket: x, key: "t/{tier}/{shard}/{period}.parquet" }
axis: time
binCol: dt
dims:
  - { name: s2_cell, type: string }
metrics:
  - { name: state,    monoid: histogram }
  - { name: state_ff, monoid: histogram }
tiers:
  - { name: 1m, bin: 1min, shards: [5min] }
"""

CHAINS = {
    'uuid-a': ['cell-1', 's:100'],
    'uuid-b': ['cell-1', 's:200'],
}

DAY = datetime(2026, 8, 4, tzinfo=timezone.utc)
T0_MS = int(DAY.timestamp()) * 1000
EMPTY, FULL, OK, STALE = 5, 6, 9, 1


def smg_blob(rows: list[tuple[str, int, int, int]]) -> bytes:
    """rows = (station_id, minute, state, state_ff)."""
    table = pa.table({
        'station_id': pa.array([r[0] for r in rows]),
        'dt': pa.array([T0_MS + r[1] * 60_000 for r in rows], type=pa.int64()),
        'state': pa.array([r[2] for r in rows], type=pa.int8()),
        'state_ff': pa.array([r[3] for r in rows], type=pa.int8()),
    })
    buf = BytesIO()
    pq.write_table(table, buf)
    return buf.getvalue()


@pytest.fixture
def pyramid():
    return pyramid_from_config(parse_pyramid_yaml(YAML), MemStorage())


def source_with(pyramid, rows) -> SmgDailySource:
    pyramid.storage.put('gbfs/smg/2026-08-04.parquet', smg_blob(rows))
    return SmgDailySource(pyramid, CHAINS)


def read_sorted(src: SmgDailySource, start: datetime, end: datetime) -> list[tuple]:
    df = src.read_window(start, end)
    return sorted(
        df
        .with_columns(pl.col('metric').cast(pl.Utf8))
        .select('s2_cell', 'dt', 'metric', 'state', 'count')
        .rows()
    )


def test_states_become_histogram_rows_with_cell_aggregation(pyramid):
    # Minute 0: a empty, b empty → cell-1 aggregates to count=2 at state 5;
    # identity keys stay count=1. Minute 1: a stale (ff → empty), b full.
    rows = [
        ('uuid-a', 0, EMPTY, EMPTY), ('uuid-b', 0, EMPTY, EMPTY),
        ('uuid-a', 1, STALE, EMPTY), ('uuid-b', 1, FULL, FULL),
        ('uuid-z', 0, OK, OK),  # no chain → dropped
    ]
    src = source_with(pyramid, rows)
    got = read_sorted(src, DAY, datetime(2026, 8, 4, 0, 2, tzinfo=timezone.utc))
    dt0, dt1 = T0_MS, T0_MS + 60_000
    assert got == sorted([
        ('cell-1', dt0, 'state', EMPTY, 2), ('cell-1', dt0, 'state_ff', EMPTY, 2),
        ('s:100', dt0, 'state', EMPTY, 1), ('s:100', dt0, 'state_ff', EMPTY, 1),
        ('s:200', dt0, 'state', EMPTY, 1), ('s:200', dt0, 'state_ff', EMPTY, 1),
        ('cell-1', dt1, 'state', STALE, 1), ('cell-1', dt1, 'state', FULL, 1),
        ('cell-1', dt1, 'state_ff', EMPTY, 1), ('cell-1', dt1, 'state_ff', FULL, 1),
        ('s:100', dt1, 'state', STALE, 1), ('s:100', dt1, 'state_ff', EMPTY, 1),
        ('s:200', dt1, 'state', FULL, 1), ('s:200', dt1, 'state_ff', FULL, 1),
    ])


def test_window_clips_to_requested_minutes(pyramid):
    rows = [('uuid-a', m, OK, OK) for m in range(5)]
    src = source_with(pyramid, rows)
    got = read_sorted(src, datetime(2026, 8, 4, 0, 2, tzinfo=timezone.utc), datetime(2026, 8, 4, 0, 4, tzinfo=timezone.utc))
    assert sorted({r[1] for r in got}) == [T0_MS + 2 * 60_000, T0_MS + 3 * 60_000]
    assert got == sorted(
        (cell, T0_MS + m * 60_000, metric, OK, 1)
        for cell in ('cell-1', 's:100')
        for m in (2, 3)
        for metric in ('state', 'state_ff')
    )
