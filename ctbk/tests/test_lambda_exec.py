"""Unit tests for the Lambda executor's hole-fill planning.

Pins the fix for the 2026-07-13 evening wedge: `/30m@2h [20:00, 22:00)`
and `/1h@3h [18:00, 21:00)` bounced `no_inputs` for 2.5 h (damming every
coarser tier) because the cross-tier hole-fill only saw source tiles
NESTED inside the hole — a source min-cover tile that partially overlaps
the hole (`/15m@3h [18:00, 21:00)` covering the hole's first hour) was
invisible, and the nested 1h tile it subsumes never exists.

Pure planning tests: no R2, no network.
"""
from __future__ import annotations

from datetime import datetime, timezone

from pyrmts.types import Tier

from ctbk.pyramid_cascade.lambda_exec import _overlap_cover


class _Pyramid:
    """Only `keyTemplate` is consulted by `_shard_key`."""
    keyTemplate = 'avail-v3/{tier}/{shard}/{period}.parquet'


PYRAMID = _Pyramid()

# The /15m tier's production ladder (merged CFW + lambda rungs).
T15M = Tier(name='15m', bin='15min',
            shards=('1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d'))


def dt(h: int, m: int = 0, day: int = 13) -> datetime:
    return datetime(2026, 7, day, h, m, tzinfo=timezone.utc)


def test_overlap_cover_wedge_shape():
    """The exact 2026-07-13 23:0x state: /15m tail covered by min-cover
    tiles 12h@00:00 + 6h@12:00 + 3h@18:00 + 1h@21:00 + 1h@22:00. The
    /30m@2h hole [20:00, 22:00) must be covered by the 3h tile (clipped
    to its last hour) + the 21:00 1h tile — no /15m@1h tile at 20:00
    exists, so nested-slot tiling (the pre-fix behavior) dead-ends."""
    key_set = {
        'avail-v3/15m/12h/2026-07-13T00.parquet',
        'avail-v3/15m/6h/2026-07-13T12.parquet',
        'avail-v3/15m/3h/2026-07-13T18.parquet',
        'avail-v3/15m/1h/2026-07-13T21.parquet',
        'avail-v3/15m/1h/2026-07-13T22.parquet',
    }
    picks, uncovered = _overlap_cover(PYRAMID, T15M, dt(20), dt(22), key_set)
    assert uncovered == []
    assert picks == [
        ('avail-v3/15m/3h/2026-07-13T18.parquet', dt(20), dt(21)),
        ('avail-v3/15m/1h/2026-07-13T21.parquet', dt(21), dt(22)),
    ]


def test_overlap_cover_single_containing_tile():
    """A single coarse tile containing the hole is picked alone, clipped
    to the hole (the old `containing` fast-path, subsumed)."""
    key_set = {'avail-v3/15m/12h/2026-07-13T12.parquet'}
    picks, uncovered = _overlap_cover(PYRAMID, T15M, dt(20), dt(22), key_set)
    assert uncovered == []
    assert picks == [
        ('avail-v3/15m/12h/2026-07-13T12.parquet', dt(20), dt(22)),
    ]


def test_overlap_cover_nested_tiles():
    """Plain nested tiling still works: two 1h tiles exactly tile the
    hole, each assigned its own slot."""
    key_set = {
        'avail-v3/15m/1h/2026-07-13T20.parquet',
        'avail-v3/15m/1h/2026-07-13T21.parquet',
    }
    picks, uncovered = _overlap_cover(PYRAMID, T15M, dt(20), dt(22), key_set)
    assert uncovered == []
    assert picks == [
        ('avail-v3/15m/1h/2026-07-13T20.parquet', dt(20), dt(21)),
        ('avail-v3/15m/1h/2026-07-13T21.parquet', dt(21), dt(22)),
    ]


def test_overlap_cover_no_double_count_with_redundant_tiles():
    """When both a containing 12h tile and the finer tiles exist
    (GC-pending redundancy), the coarsest wins and covers the whole
    hole; finer tiles are NOT also picked (disjoint clip invariant)."""
    key_set = {
        'avail-v3/15m/12h/2026-07-13T12.parquet',
        'avail-v3/15m/3h/2026-07-13T18.parquet',
        'avail-v3/15m/1h/2026-07-13T21.parquet',
    }
    picks, uncovered = _overlap_cover(PYRAMID, T15M, dt(20), dt(22), key_set)
    assert uncovered == []
    assert picks == [
        ('avail-v3/15m/12h/2026-07-13T12.parquet', dt(20), dt(22)),
    ]


def test_overlap_cover_reports_residual_hole():
    """Source coverage genuinely short (final hour absent everywhere):
    the covered head is picked, the tail is reported uncovered."""
    key_set = {'avail-v3/15m/3h/2026-07-13T18.parquet'}
    picks, uncovered = _overlap_cover(PYRAMID, T15M, dt(20), dt(22), key_set)
    assert picks == [
        ('avail-v3/15m/3h/2026-07-13T18.parquet', dt(20), dt(21)),
    ]
    assert uncovered == [(dt(21), dt(22))]


def test_overlap_cover_gap_in_middle_two_disjoint_segments():
    """A mid-hole gap splits the residue: tiles cover [20, 21) and
    [22, 23) of a [20, 23) hole; [21, 22) stays uncovered."""
    key_set = {
        'avail-v3/15m/1h/2026-07-13T20.parquet',
        'avail-v3/15m/1h/2026-07-13T22.parquet',
    }
    picks, uncovered = _overlap_cover(PYRAMID, T15M, dt(20), dt(23), key_set)
    assert picks == [
        ('avail-v3/15m/1h/2026-07-13T20.parquet', dt(20), dt(21)),
        ('avail-v3/15m/1h/2026-07-13T22.parquet', dt(22), dt(23)),
    ]
    assert uncovered == [(dt(21), dt(22))]
