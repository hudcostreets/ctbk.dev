"""Unit tests for the avail-v3 build + cascade.

Verifies the histogram-monoid invariants that the v3 pyramid relies on:
1. S2 cell materialization writes one row per (cell, dt, metric) where
   each cell appears at every materialized level for every station.
2. Cascade roll-up: a 30m bucket's histogram == sum of its underlying
   1m histograms; a 1h bucket == sum of its underlying 30m histograms.

Uses synthetic in-memory 1m@1m source tables (no R2). The cascade tests
mock `read_v3_shard` to return in-memory tables instead of fetching
from R2. Runnable in CI without credentials.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import patch

import pyarrow as pa
import s2cell

from ctbk import avail_v3
from ctbk.avail_v3 import (
    AVAIL_METRICS,
    DEFAULT_RESOLUTIONS,
    TIER_SPECS,
    build_1m_hour_table,
    build_cascade_shard,
    dt_floor_ms_fixed,
)


# ─── Synthetic source data ─────────────────────────────────────────────

STATIONS = {
    # Three stations clustered tightly so they share coarse cells but
    # differ at L14/L15 → exercises both single-station and multi-station
    # histograms across the level set.
    's1': (40.7505, -73.9505),
    's2': (40.7510, -73.9510),
    's3': (40.7515, -73.9515),
}

HOUR_START = datetime(2026, 5, 22, 0, tzinfo=timezone.utc)
HOUR_START_S = int(HOUR_START.timestamp())


def make_minute_table(sids: list[str], dt_s: int, values: dict[str, dict[str, int]]) -> pa.Table:
    """Build one synthetic 1m@1m source table.

    `values[sid][metric]` = int count for that station+metric at minute
    `dt_s`. Missing metrics default to 0.
    """
    n = len(sids)
    cols: dict[str, list] = {
        'station_id': list(sids),
        'dt': [dt_s] * n,
    }
    for m in AVAIL_METRICS:
        cols[f'{m}_sum'] = [values.get(sid, {}).get(m, 0) for sid in sids]
    return pa.table(cols)


def synthetic_hour_minute_tables() -> dict[str, pa.Table | None]:
    """60 minute-tables for one hour. Station s3 has variable bike counts
    across the hour to exercise multi-state histograms; s1/s2 are
    constant."""
    out: dict[str, pa.Table | None] = {}
    for m in range(60):
        dt_s = HOUR_START_S + m * 60
        # s1: constant 5 bikes, 2 ebikes
        # s2: constant 3 bikes, 7 ebikes
        # s3: bikes cycles 0→9 over the hour for variety
        vals = {
            's1': {'bikes': 5, 'ebikes': 2, 'docks': 10, 'disabled': 0, 'pending': 0},
            's2': {'bikes': 3, 'ebikes': 7, 'docks': 8, 'disabled': 1, 'pending': 0},
            's3': {'bikes': m // 6, 'ebikes': 1, 'docks': 9, 'disabled': 0, 'pending': 0},
        }
        out[f'{HOUR_START.strftime("%H")}{m:02d}'] = make_minute_table(['s1', 's2', 's3'], dt_s, vals)
    return out


# ─── 1m tier build ─────────────────────────────────────────────────────

def test_build_1m_hour_table_schema_and_levels():
    """1m build materializes every (station × level) → expect rows at
    every level for each minute."""
    minute_tables = synthetic_hour_minute_tables()

    def fake_read_minute_shard(cli, key):
        stem = key.rsplit('/', 1)[-1].split('.')[0]  # 'HHMM'
        return minute_tables.get(stem)

    with patch.object(avail_v3, 'read_minute_shard', fake_read_minute_shard):
        # Also stub r2_client since build_1m_hour_table calls it
        with patch.object(avail_v3, 'r2_client', lambda: None):
            tab = build_1m_hour_table(
                date_str='2026-05-22',
                hour=0,
                station_geo=STATIONS,
                resolutions=DEFAULT_RESOLUTIONS,
            )

    assert tab is not None
    assert tab.column_names == ['s2_cell', 'dt'] + list(AVAIL_METRICS)

    # Every minute, every level should have ≥1 cell. Across all minutes,
    # total cells per level = 60 × (#distinct cells at that level among
    # our 3 stations). The level distribution shape verifies S2
    # materialization didn't drop levels.
    cells = tab['s2_cell'].to_pylist()
    from collections import Counter
    levels = Counter(s2cell.token_to_level(c) for c in cells)
    assert set(levels.keys()) == set(DEFAULT_RESOLUTIONS), \
        f"expected all {DEFAULT_RESOLUTIONS} levels, got {sorted(levels)}"


def test_build_1m_hour_table_histograms_byte_exact():
    """At L15 (~1 station/cell), each (cell, dt, metric) row's histogram
    is `{<value>: 1}` since only one station contributed."""
    minute_tables = synthetic_hour_minute_tables()

    def fake_read_minute_shard(cli, key):
        stem = key.rsplit('/', 1)[-1].split('.')[0]
        return minute_tables.get(stem)

    with patch.object(avail_v3, 'read_minute_shard', fake_read_minute_shard), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        tab = build_1m_hour_table('2026-05-22', 0, STATIONS, DEFAULT_RESOLUTIONS)

    assert tab is not None
    # Find the L15 row for s1 at minute 0; bikes hist should be {"5":1}
    s1_l15 = s2cell.lat_lon_to_token(*STATIONS['s1'], 15)
    dt0_ms = HOUR_START_S * 1000
    df = tab.to_pylist()
    matches = [r for r in df if r['s2_cell'] == s1_l15 and r['dt'] == dt0_ms]
    assert len(matches) == 1, f"expected 1 row for s1 L15 minute 0, got {len(matches)}"
    assert json.loads(matches[0]['bikes']) == {'5': 1}
    assert json.loads(matches[0]['ebikes']) == {'2': 1}


def test_build_1m_hour_table_coarsest_multi_station_histogram():
    """At L10 (borough scale), all 3 stations share one cell; bikes
    histogram at minute 0 should be `{"3":1, "5":1, "0":1}` since s1=5,
    s2=3, s3=0 at minute 0."""
    minute_tables = synthetic_hour_minute_tables()

    def fake_read_minute_shard(cli, key):
        stem = key.rsplit('/', 1)[-1].split('.')[0]
        return minute_tables.get(stem)

    with patch.object(avail_v3, 'read_minute_shard', fake_read_minute_shard), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        tab = build_1m_hour_table('2026-05-22', 0, STATIONS, DEFAULT_RESOLUTIONS)

    l10_cell = s2cell.lat_lon_to_token(*STATIONS['s1'], 10)
    # s2 and s3 should share this cell at L10
    assert s2cell.lat_lon_to_token(*STATIONS['s2'], 10) == l10_cell
    assert s2cell.lat_lon_to_token(*STATIONS['s3'], 10) == l10_cell

    dt0_ms = HOUR_START_S * 1000
    df = tab.to_pylist()
    matches = [r for r in df if r['s2_cell'] == l10_cell and r['dt'] == dt0_ms]
    assert len(matches) == 1
    # bikes at minute 0: s1=5, s2=3, s3=0 → {"5":1, "3":1, "0":1}
    assert json.loads(matches[0]['bikes']) == {'0': 1, '3': 1, '5': 1}


# ─── Cascade round-trip ────────────────────────────────────────────────

def build_1m_for_full_day(date_str: str) -> dict[str, pa.Table]:
    """Build one 1m tier shard per hour for `date_str` using synthetic
    data. Returns {period: table} where period is 'YYYY-MM-DD/HH'."""
    out: dict[str, pa.Table] = {}
    for hour in range(24):
        hour_start = datetime.fromisoformat(date_str).replace(hour=hour, tzinfo=timezone.utc)
        # Reuse the same minute-table generator, offset to this hour.
        def make_for_hour(h):
            def gen():
                tables = {}
                for m in range(60):
                    dt_s = int(hour_start.timestamp()) + m * 60
                    vals = {
                        's1': {'bikes': 5, 'ebikes': 2, 'docks': 10, 'disabled': 0, 'pending': 0},
                        's2': {'bikes': 3, 'ebikes': 7, 'docks': 8, 'disabled': 1, 'pending': 0},
                        's3': {'bikes': m // 6, 'ebikes': 1, 'docks': 9, 'disabled': 0, 'pending': 0},
                    }
                    tables[f'{h:02d}{m:02d}'] = make_minute_table(['s1', 's2', 's3'], dt_s, vals)
                return tables
            return gen()
        minute_tables = make_for_hour(hour)

        def fake_read_minute_shard(cli, key):
            stem = key.rsplit('/', 1)[-1].split('.')[0]
            return minute_tables.get(stem)

        with patch.object(avail_v3, 'read_minute_shard', fake_read_minute_shard), \
             patch.object(avail_v3, 'r2_client', lambda: None):
            tab = build_1m_hour_table(date_str, hour, STATIONS, DEFAULT_RESOLUTIONS)
        assert tab is not None
        out[f'{date_str}/{hour:02d}'] = tab
    return out


def test_cascade_30m_from_1m_matches_manual_sum():
    """Build 1m for 1 day; cascade to 30m; pick one (cell, dt_30m) row;
    verify its histogram == manual sum of the 30 underlying 1m
    histograms."""
    date_str = '2026-05-22'
    one_m_tables = build_1m_for_full_day(date_str)

    def fake_read_v3_shard(cli, tier, period):
        assert tier == '1m', f"cascade should only read 1m, got {tier}"
        return one_m_tables.get(period)

    shard_start = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)

    with patch.object(avail_v3, 'read_v3_shard', fake_read_v3_shard), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        thirty_m_tab = build_cascade_shard('30m', shard_start)

    assert thirty_m_tab is not None
    assert thirty_m_tab.column_names == ['s2_cell', 'dt'] + list(AVAIL_METRICS)

    # Pick the L10 cell + 30m bucket starting at hour 0, minute 0.
    # That bucket covers minutes 0-29 of hour 0.
    l10_cell = s2cell.lat_lon_to_token(*STATIONS['s1'], 10)
    bucket_dt_s = HOUR_START_S  # 30m bucket starts at hour 0
    bucket_dt_ms = bucket_dt_s * 1000
    assert dt_floor_ms_fixed(bucket_dt_ms, 1800) == bucket_dt_ms

    rows = thirty_m_tab.to_pylist()
    cascaded = [r for r in rows if r['s2_cell'] == l10_cell and r['dt'] == bucket_dt_ms]
    assert len(cascaded) == 1
    cascaded_bikes = json.loads(cascaded[0]['bikes'])

    # Manual sum over minutes 0-29 of hour 0.
    expected: dict[str, int] = {}
    for m in range(30):
        # s1 always contributes 5, s2 always 3, s3 contributes m//6 ∈ {0,1,2,3,4}
        for v in (5, 3, m // 6):
            expected[str(v)] = expected.get(str(v), 0) + 1
    expected = dict(sorted(expected.items(), key=lambda kv: int(kv[0])))
    assert cascaded_bikes == expected, \
        f"30m cascade mismatch at L10 hour 0: got {cascaded_bikes}, expected {expected}"


def test_cascade_1h_from_30m_matches_manual_sum():
    """Build 1m → cascade to 30m → cascade to 1h. Verify the 1h bucket
    histogram == sum of the two underlying 30m histograms."""
    date_str = '2026-05-22'
    one_m_tables = build_1m_for_full_day(date_str)

    # First cascade 1m → 30m for the full day
    def read_1m(cli, tier, period):
        assert tier == '1m'
        return one_m_tables.get(period)

    shard_start = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)
    with patch.object(avail_v3, 'read_v3_shard', read_1m), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        thirty_m_tab = build_cascade_shard('30m', shard_start)
    assert thirty_m_tab is not None

    # Now cascade 30m → 1h. 1h shards are 1mo-shaped; we need to provide
    # the 30m shard (1d-shaped) covering this hour's source data.
    thirty_m_shards = {date_str: thirty_m_tab}

    def read_30m(cli, tier, period):
        assert tier == '30m'
        return thirty_m_shards.get(period)

    # 1h tier shard is 1mo-shaped: '2026-05'
    hour_shard_start = datetime.fromisoformat('2026-05-01').replace(tzinfo=timezone.utc)
    with patch.object(avail_v3, 'read_v3_shard', read_30m), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        one_h_tab = build_cascade_shard('1h', hour_shard_start)
    assert one_h_tab is not None

    # Pick L10 + 1h bucket at hour 0 of date_str.
    l10_cell = s2cell.lat_lon_to_token(*STATIONS['s1'], 10)
    bucket_dt_ms = HOUR_START_S * 1000  # already on a 1h boundary
    rows = one_h_tab.to_pylist()
    matches = [r for r in rows if r['s2_cell'] == l10_cell and r['dt'] == bucket_dt_ms]
    assert len(matches) == 1
    cascaded_bikes = json.loads(matches[0]['bikes'])

    # Manual sum over all 60 minutes of hour 0.
    expected: dict[str, int] = {}
    for m in range(60):
        for v in (5, 3, m // 6):
            expected[str(v)] = expected.get(str(v), 0) + 1
    expected = dict(sorted(expected.items(), key=lambda kv: int(kv[0])))
    assert cascaded_bikes == expected
