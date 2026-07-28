"""Tests for the pyrmts-engine validation comparer
(`specs/pyrmts-engine-validation.md`): streaming aligned-chunk equality,
hist-JSON key-order normalization, and the bin-range covering filter.
"""
from __future__ import annotations

from io import BytesIO

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from pyrmts import parse_pyramid_yaml, pyramid_from_config

from ctbk.pyramid_cascade.engine_check import _compare_streaming, canonical_long

YAML = """
storage: { type: s3, bucket: x, key: "t/{tier}/{shard}/{period}.parquet" }
axis: time
binCol: dt
dims:
  - { name: s2_cell, type: string }
metrics:
  - { name: bikes, monoid: histogram }
tiers:
  - { name: 1m, bin: 1min, shards: [5min] }
"""


@pytest.fixture
def pyramid():
    return pyramid_from_config(parse_pyramid_yaml(YAML), storage=None)


def blob(rows: list[tuple[str, int, str]]) -> bytes:
    table = pa.table({
        's2_cell': [r[0] for r in rows],
        'dt': pa.array([r[1] for r in rows], pa.int64()),
        'bikes': [r[2] for r in rows],
    })
    buf = BytesIO()
    pq.write_table(table, buf, row_group_size=2)
    return buf.getvalue()


ROWS = [
    ('a', 0, '{"1":2,"3":4}'),
    ('a', 60_000, '{"5":1}'),
    ('b', 0, '{"0":7}'),
    ('b', 60_000, '{"2":2,"9":1}'),
]


class TestCompareStreaming:
    def test_identical(self, pyramid):
        assert _compare_streaming(blob(ROWS), blob(ROWS), pyramid, chunk_rows=2) == ('equal', '')

    def test_hist_key_order_normalized(self, pyramid):
        permuted = [ROWS[0][:2] + ('{"3":4,"1":2}',)] + ROWS[1:]
        assert _compare_streaming(blob(ROWS), blob(permuted), pyramid, chunk_rows=2) == ('equal', '')

    def test_count_change_is_diff(self, pyramid):
        changed = [ROWS[0][:2] + ('{"1":2,"3":5}',)] + ROWS[1:]
        assert _compare_streaming(blob(ROWS), blob(changed), pyramid, chunk_rows=2) == \
            ('diff', 'content diverges in rows [0, 2)')

    def test_row_count_mismatch(self, pyramid):
        assert _compare_streaming(blob(ROWS), blob(ROWS[:3]), pyramid, chunk_rows=2) == \
            ('diff', 'row counts: 4 vs 3')

    def test_empty_both(self, pyramid):
        assert _compare_streaming(blob([]), blob([]), pyramid) == ('empty_both', '')


class TestCanonicalLongBinRange:
    def test_filter_matches_full_parse_of_slice(self, pyramid):
        full = canonical_long(blob(ROWS), pyramid, bin_range=(60_000, 120_000))
        sliced = canonical_long(blob([r for r in ROWS if r[1] == 60_000]), pyramid)
        assert full.equals(sliced)
        assert full.height == 3  # {"5":1} + {"2":2,"9":1} → 1 + 2 long rows
