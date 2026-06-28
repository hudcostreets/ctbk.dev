"""Synthetic tests for the per-block cascade engine.

Builds a small in-memory base tier, runs cascade_block, asserts that
the derived tiers' rows are correct histogram-sums of the source rows.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone

import polars as pl
import pyarrow.parquet as pq
import pytest
from pyrmts import (
    Dim,
    Metric,
    Pyramid,
    Tier,
)
from pyrmts.storage import MemStorage

from ctbk.pyramid_cascade import cascade_block


# ─── Fixtures ──────────────────────────────────────────────────────────

@pytest.fixture
def pyramid() -> Pyramid:
    """Tiny avail-shaped pyramid: 1m base, 2m + 5m derived, 1d shards.

    Just enough tiers to exercise the cascade math without lots of shards.
    """
    return Pyramid(
        storage=MemStorage(),
        keyTemplate='avail-test/{tier}/{period}.parquet',
        binCol='dt',
        dims=[Dim(name='s2_cell', type='string')],
        metrics=[Metric(name='bikes', monoid='histogram')],
        tiers=[
            Tier(name='1m', bin='1min', shard='1d'),
            Tier(name='2m', bin='2min', shard='1d'),
            Tier(name='5m', bin='5min', shard='1d'),
        ],
    )


def synth_base_rows(date_str: str, hours: int = 1) -> pl.DataFrame:
    """Synthetic 1m base rows over `hours` hours, in LONG form matching the
    engine's ingester contract: (*dims, bin_col, metric, state, count).

    Two cells (A, B). Every minute, each cell contributes a `bikes` observation
    of `state = (minute_of_hour % 5)` with count 1.
    """
    base_dt = datetime.fromisoformat(f'{date_str}T00:00:00+00:00')
    base_ms = int(base_dt.timestamp() * 1000)
    rows: list[dict] = []
    for h in range(hours):
        for m in range(60):
            dt_ms = base_ms + (h * 3600 + m * 60) * 1000
            state = m % 5
            for cell in ['cellA', 'cellB']:
                rows.append({
                    's2_cell': cell, 'dt': dt_ms,
                    'metric': 'bikes', 'state': state, 'count': 1,
                })
    return pl.DataFrame(rows, schema={
        's2_cell': pl.Utf8, 'dt': pl.Int64,
        'metric': pl.Utf8, 'state': pl.Int64, 'count': pl.Int64,
    })


# ─── Tests ─────────────────────────────────────────────────────────────

def test_cascade_block_one_hour_to_2m_and_5m(pyramid: Pyramid):
    """1 hour of synthetic 1m data → cascade to 2m, 5m.

    Verifies:
    - 30 output rows per cell at 2m (60 mins / 2 = 30 bins per cell × 2 cells)
    - 12 output rows per cell at 5m
    - Each 2m hist sums the right pair of 1m hists.
    """
    block_from = datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc)
    block_to = datetime(2026, 6, 17, 1, 0, tzinfo=timezone.utc)

    df = synth_base_rows('2026-06-17', hours=1)
    ingester = lambda f, t: df.lazy()

    result = cascade_block(
        pyramid,
        (block_from, block_to),
        ingester,
        base_tier='1m',
    )

    # Block ends mid-day → both 2m@1d and 5m@1d are partials (not full days).
    # All output should land in partials.
    assert result.finals == [], f"expected no full-day finals, got {result.finals}"
    assert {tier for tier, _, _ in result.partials} == {'2m', '5m'}

    # Read back partial outputs from MemStorage.
    for tier, period, key in result.partials:
        blob = pyramid.storage.get(key)
        assert blob is not None, f"missing {key}"
        table = pq.read_table(io.BytesIO(blob))
        df_out = pl.from_arrow(table)

        n_cells = 2
        bins_per_hour = 60 // {'2m': 2, '5m': 5}[tier]
        assert df_out.height == n_cells * bins_per_hour, \
            f"{tier}: expected {n_cells * bins_per_hour} rows, got {df_out.height}"
        assert set(df_out.columns) >= {'s2_cell', 'dt', 'bikes'}

        # First 2m bin of cellA: minutes 0+1 → states {0:1, 1:1}
        if tier == '2m':
            first = df_out.filter(
                (pl.col('s2_cell') == 'cellA') & (pl.col('dt') == int(block_from.timestamp() * 1000))
            )
            assert first.height == 1
            hist = json.loads(first['bikes'][0])
            assert hist == {'0': 1, '1': 1}, f"2m cellA bin0 expected {{0:1, 1:1}}, got {hist}"

        # First 5m bin of cellA: minutes 0..4 → states {0:1, 1:1, 2:1, 3:1, 4:1}
        if tier == '5m':
            first = df_out.filter(
                (pl.col('s2_cell') == 'cellA') & (pl.col('dt') == int(block_from.timestamp() * 1000))
            )
            assert first.height == 1
            hist = json.loads(first['bikes'][0])
            assert hist == {'0': 1, '1': 1, '2': 1, '3': 1, '4': 1}, \
                f"5m cellA bin0 expected {{0..4: 1}}, got {hist}"


def test_cascade_block_multi_metric_and_calendar_tier():
    """Multi-metric + a calendar-aligned tier (1h@1mo).

    Verifies the long-format melt handles multiple metric columns and
    the calendar `_bin_floor` path doesn't crash.
    """
    pyramid = Pyramid(
        storage=MemStorage(),
        keyTemplate='avail-test/{tier}/{period}.parquet',
        binCol='dt',
        dims=[Dim(name='s2_cell', type='string')],
        metrics=[
            Metric(name='bikes',  monoid='histogram'),
            Metric(name='ebikes', monoid='histogram'),
        ],
        tiers=[
            Tier(name='1m', bin='1min', shard='1d'),
            Tier(name='1h', bin='1h',   shard='1mo'),
        ],
    )

    block_from = datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc)
    block_to   = datetime(2026, 6, 17, 3, 0, tzinfo=timezone.utc)

    base_ms = int(block_from.timestamp() * 1000)
    rows = []
    for h in range(3):
        for m in range(60):
            dt_ms = base_ms + (h * 3600 + m * 60) * 1000
            # Long form: one row per (cell, dt, metric).
            rows.append({'s2_cell': 'cellA', 'dt': dt_ms,
                         'metric': 'bikes',  'state': h,     'count': 1})
            rows.append({'s2_cell': 'cellA', 'dt': dt_ms,
                         'metric': 'ebikes', 'state': h * 2, 'count': 1})
    df = pl.DataFrame(rows, schema={
        's2_cell': pl.Utf8, 'dt': pl.Int64,
        'metric': pl.Utf8, 'state': pl.Int64, 'count': pl.Int64,
    })
    ingester = lambda f, t: df.lazy()

    result = cascade_block(pyramid, (block_from, block_to), ingester, base_tier='1m')

    # 1h tier: partial (block doesn't cover whole month) → staging.
    assert {tier for tier, _, _ in result.partials} == {'1h'}, \
        f"unexpected partials: {result.partials}"

    # Verify the 1h shard has 3 rows (3 hours × 1 cell). Each hour aggregates
    # all 60 of its minutes; each minute's bikes hist was {h: 1} → 1h bin
    # has bikes = {h: 60}.
    _, _, key = next(p for p in result.partials if p[0] == '1h')
    table = pq.read_table(io.BytesIO(pyramid.storage.get(key)))
    df_out = pl.from_arrow(table)
    assert df_out.height == 3, f"expected 3 hourly bins, got {df_out.height}"

    by_dt = df_out.sort('dt').to_dicts()
    for h, row in enumerate(by_dt):
        bikes  = json.loads(row['bikes'])
        ebikes = json.loads(row['ebikes'])
        assert bikes == {str(h): 60}, f"hour {h} bikes: expected {{{h}: 60}}, got {bikes}"
        assert ebikes == {str(h * 2): 60}, f"hour {h} ebikes: expected {{{h*2}: 60}}, got {ebikes}"


def test_cascade_block_full_day_writes_finals(pyramid: Pyramid):
    """Block covers a full day → 2m, 5m shards land in the final R2 path."""
    block_from = datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc)
    block_to = datetime(2026, 6, 18, 0, 0, tzinfo=timezone.utc)

    df = synth_base_rows('2026-06-17', hours=24)
    ingester = lambda f, t: df.lazy()

    result = cascade_block(
        pyramid,
        (block_from, block_to),
        ingester,
        base_tier='1m',
    )

    assert result.partials == [], f"expected no partials, got {result.partials}"
    assert {key.split('/')[1] for key in result.finals} == {'2m', '5m'}, \
        f"unexpected tiers in finals: {result.finals}"

    # 24 × 30 = 720 bins per cell × 2 cells = 1440 rows in 2m@1d.
    key_2m = next(k for k in result.finals if '/2m/' in k)
    table_2m = pq.read_table(io.BytesIO(pyramid.storage.get(key_2m)))
    assert table_2m.num_rows == 2 * 24 * 30, \
        f"2m@1d expected 1440 rows, got {table_2m.num_rows}"
