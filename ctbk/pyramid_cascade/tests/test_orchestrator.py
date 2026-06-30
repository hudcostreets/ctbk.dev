"""Orchestrator tests on synthetic data + MemStorage.

Validates the map-shuffle-reduce flow end-to-end without R2 or real source:
  - Multi-block fan-out via ProcessPool
  - Block-owned finals vs partials
  - Reduce phase: merge partials → finals
  - Manifest emission
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone

import polars as pl
import pyarrow.parquet as pq
import pytest
from pyrmts import Dim, Metric, Pyramid, Tier
from pyrmts.storage import MemStorage

from ctbk.pyramid_cascade.orchestrator import pyramid_cascade


def synth_rows(date_str: str, hours: int) -> pl.LazyFrame:
    """Emit long-form (s2_cell, dt, metric, state, count) rows for
    `hours` hours of synthetic 1m source data. Each minute contributes
    one observation `{state: m%5, count: 1}` for metric `bikes`. Matches
    the engine.py ingester contract (long form, not wide hist_json)."""
    base = datetime.fromisoformat(f'{date_str}T00:00:00+00:00')
    base_ms = int(base.timestamp() * 1000)
    rows = []
    for h in range(hours):
        for m in range(60):
            dt_ms = base_ms + (h * 3600 + m * 60) * 1000
            rows.append({
                's2_cell': 'cellA',
                'dt': dt_ms,
                'metric': 'bikes',
                'state': m % 5,
                'count': 1,
            })
    return pl.DataFrame(rows, schema={
        's2_cell': pl.Utf8,
        'dt': pl.Int64,
        'metric': pl.Utf8,
        'state': pl.Int64,
        'count': pl.Int64,
    }).lazy()


def _empty_long_lf() -> pl.LazyFrame:
    return pl.DataFrame(schema={
        's2_cell': pl.Utf8, 'dt': pl.Int64,
        'metric': pl.Utf8, 'state': pl.Int64, 'count': pl.Int64,
    }).lazy()


def _ingester_2026_06_17_to_19(block_from, block_to):
    # Source is 2 days of synthetic 1m data starting 2026-06-17.
    day_starts = {
        datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc): '2026-06-17',
        datetime(2026, 6, 18, 0, 0, tzinfo=timezone.utc): '2026-06-18',
    }
    for start, date_str in day_starts.items():
        if start == block_from:
            return synth_rows(date_str, hours=24)
    return _empty_long_lf()


def _pyramid() -> Pyramid:
    """2-day-spanning pyramid: 1m base, 2m@1d (block-owned at 1d task_size),
    1h@1mo (partial → needs reduce across both day-blocks)."""
    return Pyramid(
        storage=MemStorage(),
        keyTemplate='avail-test/{tier}/{shard}/{period}.parquet',
        binCol='dt',
        dims=[Dim(name='s2_cell', type='string')],
        metrics=[Metric(name='bikes', monoid='histogram')],
        tiers=[
            Tier(name='1m', bin='1min', shards=('1d',)),
            Tier(name='2m', bin='2min', shards=('1d',)),
            Tier(name='1h', bin='1h',   shards=('1mo',)),
        ],
    )


def test_orchestrator_single_block_single_process():
    """1-day range × 1d task_size = 1 block. Workers=1 (sync, debuggable).

    Should produce:
    - 1 final 2m@1d (block fully owns the day)
    - 1 partial 1h@1mo (block doesn't fully own the month) → reduced to 1 final
    """
    pyramid = _pyramid()
    range_ = (
        datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 18, 0, 0, tzinfo=timezone.utc),
    )

    result = pyramid_cascade(
        pyramid,
        range_,
        _ingester_2026_06_17_to_19,
        task_size='1d',
        workers=1,
        staging_uri='mem://',
        base_tier='1m',
        partial_cover='overwrite',
    )

    assert result.blocks == 1
    assert result.finals == 1, f"expected 1 block-owned final, got {result.finals}"
    assert result.partials_written == 1
    assert result.finals_via_reduce == 1


def test_orchestrator_two_blocks_with_reduce():
    """2-day range × 1d task_size = 2 blocks.

    - 2 finals (one per day) for 2m@1d
    - 2 partials for 1h@1mo (one per day, same month) → reduced to 1 final
    """
    pyramid = _pyramid()
    range_ = (
        datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc),
    )

    result = pyramid_cascade(
        pyramid,
        range_,
        _ingester_2026_06_17_to_19,
        task_size='1d',
        workers=1,  # sync for deterministic test
        staging_uri='mem://',
        base_tier='1m',
        partial_cover='overwrite',
    )

    assert result.blocks == 2
    assert result.finals == 2, f"expected 2 block-owned finals (2m on each day), got {result.finals}"
    assert result.partials_written == 2, \
        f"expected 2 partials (1h@1mo from each day), got {result.partials_written}"
    assert result.finals_via_reduce == 1, \
        f"expected 1 reduced final (merged 1h@2026-06), got {result.finals_via_reduce}"

    # Verify the reduced 1h shard contains BOTH days' contributions.
    blob = pyramid.storage.get('avail-test/1h/1mo/2026-06.parquet')
    assert blob is not None
    df = pl.from_arrow(pq.read_table(io.BytesIO(blob)))
    # 2 days × 24 hours = 48 hourly bins for cellA.
    assert df.height == 48, f"expected 48 hourly bins, got {df.height}"

    # Each hourly bin: 60 minutes × histogram {m%5: 1} for m∈[0..59].
    # Expected: {0:12, 1:12, 2:12, 3:12, 4:12}.
    sample = df.row(0, named=True)
    hist = json.loads(sample['bikes'])
    assert hist == {'0': 12, '1': 12, '2': 12, '3': 12, '4': 12}, \
        f"hourly bin should sum to {{state: 12}} for state in 0..4, got {hist}"


def test_orchestrator_emits_manifest():
    """After a run, `_manifest.json` records the latest period per tier."""
    pyramid = _pyramid()
    range_ = (
        datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc),
    )

    pyramid_cascade(
        pyramid,
        range_,
        _ingester_2026_06_17_to_19,
        task_size='1d',
        workers=1,
        staging_uri='mem://',
        base_tier='1m',
        partial_cover='overwrite',
    )

    manifest_bytes = pyramid.storage.get('avail-test/_manifest.json')
    assert manifest_bytes is not None
    manifest = json.loads(manifest_bytes)
    assert '2m' in manifest['tiers']
    assert manifest['tiers']['2m']['latest_period'] == '2026-06-18'
    assert '1h' in manifest['tiers']
    assert manifest['tiers']['1h']['latest_period'] == '2026-06'


def test_orchestrator_partial_cover_error_default():
    """Default partial_cover='error' refuses runs whose range only
    partially covers a shard (e.g. 2-day range against a /1mo shard).

    Catches the failure mode where a gap-fill run silently truncates an
    existing shard from full-month data to 2-day-only data.
    """
    pyramid = _pyramid()
    range_ = (
        datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc),
    )

    with pytest.raises(RuntimeError, match=r"partial-cover.*shards extend outside"):
        pyramid_cascade(
            pyramid,
            range_,
            _ingester_2026_06_17_to_19,
            task_size='1d',
            workers=1,
            staging_uri='mem://',
            base_tier='1m',
            # partial_cover='error' (default)
        )


def test_orchestrator_partial_cover_merge_extends_existing_shard():
    """partial_cover='merge' fetches the existing R2 shard and adds it
    as another partial in the reduce phase, so the final shard contains
    BOTH the prior data and this run's new data.

    Concretely: build /1h@2026-06 once over 6/17-6/19, then re-run over
    6/19-6/21 with merge mode. Final shard should contain 4 days of
    hourly bins (6/17, 6/18, 6/19, 6/20) — not just the 2 new days.
    """
    pyramid = _pyramid()

    # Phase 1: build initial /1h@2026-06 shard from 6/17-6/19 (2 days).
    pyramid_cascade(
        pyramid,
        (datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc),
         datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc)),
        _ingester_2026_06_17_to_21,
        task_size='1d',
        workers=1,
        staging_uri='mem://',
        base_tier='1m',
        partial_cover='overwrite',
    )

    initial_blob = pyramid.storage.get('avail-test/1h/1mo/2026-06.parquet')
    assert initial_blob is not None
    initial_df = pl.from_arrow(pq.read_table(io.BytesIO(initial_blob)))
    assert initial_df.height == 48, f"initial /1h should hold 48 bins, got {initial_df.height}"

    # Phase 2: re-cascade 6/19-6/21 in merge mode. Should add 2 more days.
    pyramid_cascade(
        pyramid,
        (datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc),
         datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc)),
        _ingester_2026_06_17_to_21,
        task_size='1d',
        workers=1,
        staging_uri='mem://',
        base_tier='1m',
        partial_cover='merge',
    )

    merged_blob = pyramid.storage.get('avail-test/1h/1mo/2026-06.parquet')
    assert merged_blob is not None
    merged_df = pl.from_arrow(pq.read_table(io.BytesIO(merged_blob)))
    # 4 days × 24 hourly bins = 96. If merge didn't fire, this would be 48
    # (overwrite with only 6/19-6/21 data).
    assert merged_df.height == 96, \
        f"merged /1h should hold 96 bins (4 days × 24h), got {merged_df.height}"


def _ingester_2026_06_17_to_21(block_from, block_to):
    """Wider synthetic ingester covering 6/17 → 6/21 (4 days)."""
    day_starts = {
        datetime(2026, 6, d, 0, 0, tzinfo=timezone.utc): f'2026-06-{d:02d}'
        for d in (17, 18, 19, 20)
    }
    for start, date_str in day_starts.items():
        if start == block_from:
            return synth_rows(date_str, hours=24)
    return _empty_long_lf()


def test_orchestrator_partial_cover_overwrite_proceeds():
    """partial_cover='overwrite' bypasses the guard rail.

    Same setup as test_orchestrator_partial_cover_error_default; this one
    should NOT raise — proceeds with the (silently truncating, in real
    deployments) overwrite. Exists to document the explicit-opt-in
    behavior.
    """
    pyramid = _pyramid()
    range_ = (
        datetime(2026, 6, 17, 0, 0, tzinfo=timezone.utc),
        datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc),
    )

    result = pyramid_cascade(
        pyramid,
        range_,
        _ingester_2026_06_17_to_19,
        task_size='1d',
        workers=1,
        staging_uri='mem://',
        base_tier='1m',
        partial_cover='overwrite',
    )

    assert result.blocks == 2
    # Same expectation as the default 2-block test — proves the cascade
    # still ran end-to-end after the guard rail bypass.
    assert result.finals_via_reduce == 1
