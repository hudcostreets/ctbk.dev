"""Unit tests for the avail-v3 build + cascade.

Verifies the histogram-monoid invariants that the v3 pyramid relies on:
1. Each station materializes at LUC + ancestors only (no rows finer than
   its LUC).
2. Cascade roll-up: a 30m bucket's histogram == sum of its underlying
   1m histograms; a 1h bucket == sum of its underlying 30m histograms.

Uses synthetic in-memory 1m@1m source tables (no R2). Runnable in CI
without credentials.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from unittest.mock import patch

import pyarrow as pa
import s2cell

from ctbk import avail_v3
from ctbk.avail_v3 import (
    AVAIL_METRICS,
    COARSEST_LEVEL,
    build_1m_hour_table,
    build_cascade_shard,
    dt_floor_ms_fixed,
)
from ctbk.station_luc import compute_luc


# ─── Synthetic station-LUC denorm ──────────────────────────────────────

# Three stations clustered tightly enough to share L10..L13 cells, but
# spread to split at L14 (s3 alone) and L17 (s1 vs s2). LUCs computed
# by the production `compute_luc` so test stays in sync with the build
# code. Expected: s1.LUC=L17, s2.LUC=L17, s3.LUC=L14.
S1 = {'lat': 40.7500, 'lng': -73.9900}
S2 = {'lat': 40.7510, 'lng': -73.9890}
S3 = {'lat': 40.7530, 'lng': -73.9870}

STATION_GEO: dict[str, tuple[float, float]] = {
    's1': (S1['lat'], S1['lng']),
    's2': (S2['lat'], S2['lng']),
    's3': (S3['lat'], S3['lng']),
}
STATION_LUC: dict[str, dict] = compute_luc(STATION_GEO)
S1_LUC_LEVEL = STATION_LUC['s1']['level']
S2_LUC_LEVEL = STATION_LUC['s2']['level']
S3_LUC_LEVEL = STATION_LUC['s3']['level']
MAX_LUC_LEVEL = max(S1_LUC_LEVEL, S2_LUC_LEVEL, S3_LUC_LEVEL)

HOUR_START = datetime(2026, 5, 22, 0, tzinfo=timezone.utc)
HOUR_START_S = int(HOUR_START.timestamp())


def make_minute_table(sids: list[str], dt_s: int, values: dict[str, dict[str, int]]) -> pa.Table:
    """One synthetic 1m@1m source table.

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


def synthetic_minute_tables(hour: int) -> dict[str, pa.Table | None]:
    """60 minute-tables for one hour. `s3.bikes` cycles 0..9 across the
    hour to exercise multi-state histograms; s1/s2 are constant."""
    base_s = int(HOUR_START.replace(hour=hour).timestamp())
    out: dict[str, pa.Table | None] = {}
    for m in range(60):
        dt_s = base_s + m * 60
        vals = {
            's1': {'bikes': 5, 'ebikes': 2, 'docks': 10, 'disabled': 0, 'pending': 0},
            's2': {'bikes': 3, 'ebikes': 7, 'docks': 8, 'disabled': 1, 'pending': 0},
            's3': {'bikes': m // 6, 'ebikes': 1, 'docks': 9, 'disabled': 0, 'pending': 0},
        }
        out[f'{hour:02d}{m:02d}'] = make_minute_table(['s1', 's2', 's3'], dt_s, vals)
    return out


def run_build_1m_hour(hour: int = 0) -> pa.Table:
    """Build the 1m hour-shard with patched R2 reads. Returns the table."""
    minute_tables = synthetic_minute_tables(hour)

    def fake_read_minute_shard(cli, key):
        stem = key.rsplit('/', 1)[-1].split('.')[0]
        return minute_tables.get(stem)

    with patch.object(avail_v3, 'read_minute_shard', fake_read_minute_shard), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        tab = build_1m_hour_table('2026-05-22', hour, STATION_LUC)
    assert tab is not None
    return tab


# ─── 1m tier build ─────────────────────────────────────────────────────

def test_build_1m_hour_table_schema():
    tab = run_build_1m_hour()
    assert tab.column_names == ['s2_cell', 'dt'] + list(AVAIL_METRICS)


def test_build_1m_hour_table_levels_per_station():
    """Output spans L<COARSEST>..L<MAX_LUC>, i.e. the union of materialized
    levels across all stations."""
    tab = run_build_1m_hour()
    cells = tab['s2_cell'].to_pylist()
    levels_seen = Counter(s2cell.token_to_level(c) for c in cells)
    assert set(levels_seen.keys()) == set(range(COARSEST_LEVEL, MAX_LUC_LEVEL + 1)), \
        f"expected levels {COARSEST_LEVEL}..{MAX_LUC_LEVEL}, got {sorted(levels_seen.keys())}"


def test_build_1m_hour_table_no_rows_above_station_luc():
    """For every station, no row appears at any level finer than its LUC."""
    tab = run_build_1m_hour()
    cells = set(tab['s2_cell'].to_pylist())
    for sid, luc in STATION_LUC.items():
        lat, lng, luc_level = luc['lat'], luc['lng'], luc['level']
        for above in range(luc_level + 1, MAX_LUC_LEVEL + 1):
            forbidden = s2cell.lat_lon_to_token(lat, lng, above)
            assert forbidden not in cells, \
                f"{sid} (LUC=L{luc_level}) should NOT have an L{above} row at {forbidden}"


def test_build_1m_hour_table_luc_row_is_unique_to_station():
    """At s3's LUC (L14) cell, the histogram contains only s3's data —
    s3 is alone in its L14 cell by LUC construction (s1 and s2 share a
    different L14 cell)."""
    tab = run_build_1m_hour()
    s3_luc_cell = STATION_LUC['s3']['cell']
    rows_for_s3_luc = [r for r in tab.to_pylist() if r['s2_cell'] == s3_luc_cell]
    # 60 minute rows for s3's LUC cell.
    assert len(rows_for_s3_luc) == 60
    # s3.bikes cycles 0..9, but at each minute m the histogram is just
    # {str(m//6): 1}. Pick minute 0 to check.
    dt0_ms = HOUR_START_S * 1000
    minute0 = next(r for r in rows_for_s3_luc if r['dt'] == dt0_ms)
    assert json.loads(minute0['bikes']) == {'0': 1}  # s3 alone, bikes=0 at min 0
    assert json.loads(minute0['ebikes']) == {'1': 1}  # s3 alone, ebikes=1


def test_build_1m_hour_table_l10_aggregates_all_stations():
    """At L10 (coarsest, shared cell), the bikes histogram at minute 0
    sums all 3 stations' contributions: s1=5, s2=3, s3=0."""
    tab = run_build_1m_hour()
    l10_cell = s2cell.lat_lon_to_token(S1['lat'], S1['lng'], 10)
    # Confirm all 3 stations share this L10 cell.
    assert s2cell.lat_lon_to_token(S2['lat'], S2['lng'], 10) == l10_cell
    assert s2cell.lat_lon_to_token(S3['lat'], S3['lng'], 10) == l10_cell

    dt0_ms = HOUR_START_S * 1000
    matches = [r for r in tab.to_pylist() if r['s2_cell'] == l10_cell and r['dt'] == dt0_ms]
    assert len(matches) == 1
    # bikes at minute 0: s1=5, s2=3, s3=0 → {'5':1, '3':1, '0':1}
    assert json.loads(matches[0]['bikes']) == {'0': 1, '3': 1, '5': 1}


# ─── Cascade round-trip ────────────────────────────────────────────────

def build_1m_for_full_day(date_str: str) -> dict[str, pa.Table]:
    """24 1m hour-shards for a day; period key = 'YYYY-MM-DD/HH'."""
    return {f'{date_str}/{hour:02d}': run_build_1m_hour(hour) for hour in range(24)}


def test_cascade_30m_from_1m_matches_manual_sum():
    """For one (L10 cell, dt_30m) row, verify its histogram == manual
    sum of the 30 underlying 1m histograms."""
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

    l10_cell = s2cell.lat_lon_to_token(S1['lat'], S1['lng'], 10)
    bucket_dt_ms = HOUR_START_S * 1000  # 30m bucket starts at hour 0, min 0
    assert dt_floor_ms_fixed(bucket_dt_ms, 1800) == bucket_dt_ms

    rows = thirty_m_tab.to_pylist()
    cascaded = [r for r in rows if r['s2_cell'] == l10_cell and r['dt'] == bucket_dt_ms]
    assert len(cascaded) == 1
    cascaded_bikes = json.loads(cascaded[0]['bikes'])

    # Manual sum over minutes 0-29 of hour 0:
    # s1=5 (×30), s2=3 (×30), s3=m//6 ∈ {0,1,2,3,4} (×6 each).
    expected: dict[str, int] = {}
    for m in range(30):
        for v in (5, 3, m // 6):
            expected[str(v)] = expected.get(str(v), 0) + 1
    expected = dict(sorted(expected.items(), key=lambda kv: int(kv[0])))
    assert cascaded_bikes == expected, \
        f"30m cascade mismatch at L10 hour 0: got {cascaded_bikes}, expected {expected}"


def test_cascade_1h_from_30m_matches_manual_sum():
    """1m → 30m → 1h chain. Verify 1h bucket histogram == sum of the two
    underlying 30m histograms (= sum of all 60 minutes)."""
    date_str = '2026-05-22'
    one_m_tables = build_1m_for_full_day(date_str)

    def read_1m(cli, tier, period):
        assert tier == '1m'
        return one_m_tables.get(period)

    shard_start = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)
    with patch.object(avail_v3, 'read_v3_shard', read_1m), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        thirty_m_tab = build_cascade_shard('30m', shard_start)
    assert thirty_m_tab is not None

    thirty_m_shards = {date_str: thirty_m_tab}

    def read_30m(cli, tier, period):
        assert tier == '30m'
        return thirty_m_shards.get(period)

    hour_shard_start = datetime.fromisoformat('2026-05-01').replace(tzinfo=timezone.utc)
    with patch.object(avail_v3, 'read_v3_shard', read_30m), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        one_h_tab = build_cascade_shard('1h', hour_shard_start)
    assert one_h_tab is not None

    l10_cell = s2cell.lat_lon_to_token(S1['lat'], S1['lng'], 10)
    bucket_dt_ms = HOUR_START_S * 1000  # already on a 1h boundary
    rows = one_h_tab.to_pylist()
    matches = [r for r in rows if r['s2_cell'] == l10_cell and r['dt'] == bucket_dt_ms]
    assert len(matches) == 1
    cascaded_bikes = json.loads(matches[0]['bikes'])

    expected: dict[str, int] = {}
    for m in range(60):
        for v in (5, 3, m // 6):
            expected[str(v)] = expected.get(str(v), 0) + 1
    expected = dict(sorted(expected.items(), key=lambda kv: int(kv[0])))
    assert cascaded_bikes == expected
