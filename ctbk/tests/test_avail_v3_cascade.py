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
    TIER_SPECS,
    build_1m_hour_table,
    build_cascade_shard,
    cascade_from_1m,
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

# Treat the synthetic station's GBFS UUID = the short_name to keep the
# dual-index mapping trivial. Production `station-luc-build` distinguishes
# them (UUID is the WAL key, short_name is the canonical denorm key); for
# build-table tests the mapping is identity.
_BY_SHORT_NAME: dict[str, dict] = {
    's1': {'lat': S1['lat'], 'lng': S1['lng'], 'uuid': 's1'},
    's2': {'lat': S2['lat'], 'lng': S2['lng'], 'uuid': 's2'},
    's3': {'lat': S3['lat'], 'lng': S3['lng'], 'uuid': 's3'},
}
compute_luc(_BY_SHORT_NAME)
STATION_LUC: dict = {
    'by_short_name': _BY_SHORT_NAME,
    'by_uuid': {'s1': 's1', 's2': 's2', 's3': 's3'},
}
S1_LUC_LEVEL = _BY_SHORT_NAME['s1']['level']
S2_LUC_LEVEL = _BY_SHORT_NAME['s2']['level']
S3_LUC_LEVEL = _BY_SHORT_NAME['s3']['level']
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
    for sid, luc in STATION_LUC['by_short_name'].items():
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
    s3_luc_cell = STATION_LUC['by_short_name']['s3']['cell']
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


# ─── Single-pass cascade_from_1m ───────────────────────────────────────

def _table_rowset(tab: pa.Table) -> set[tuple]:
    """Hashable representation of a table's rows for unordered equality."""
    return {tuple(r.items()) for r in [
        {c: row[c] for c in tab.column_names} for row in tab.to_pylist()
    ]}


def test_cascade_from_1m_matches_per_level_cascade():
    """The single-pass `cascade_from_1m` over a synthetic 1-day source
    must produce the same `(s2_cell, dt, metrics)` set for every derived
    tier as the per-level `build_cascade_shard` does.

    This is the byte-/row-level invariant that justifies the rewrite:
    each output tier is a pure histogram-sum roll-up of 1m rows, so a
    direct-from-1m emit and an intermediate-tier-relay emit must agree.
    """
    from datetime import date as Date

    date_str = '2026-05-22'
    one_m_tables = build_1m_for_full_day(date_str)
    one_d = Date.fromisoformat(date_str)
    next_d = Date.fromisoformat('2026-05-23')

    # cascade_from_1m's storage. Capture writes; serve reads from
    # the per-level relay (1m source + each intermediate it needs).
    written: dict[str, pa.Table] = {}

    def fake_read_v3_shard(cli, tier, period):
        # cascade_from_1m only reads 1m source.
        if tier == '1m':
            return one_m_tables.get(period)
        # build_cascade_shard reads its derive_from tier — synthesize
        # via recursive cascade up from 1m, mirroring the same logic
        # cascade_from_1m exercises.
        return _relay_cascade.get((tier, period))

    def fake_write(cli, table, key):
        # `avail-v3/<tier>/<period>.parquet`
        _, tier, leaf = key.split('/', 2)
        period = leaf[:-len('.parquet')]
        written[f'{tier}/{period}'] = table
        return len(table.to_pandas().to_csv(index=False))  # arbitrary; only sign matters

    def fake_head(cli, key):
        return None  # never skip

    # Pre-build the per-level relay outputs for comparison.
    _relay_cascade: dict[tuple[str, str], pa.Table] = {}
    # Helper to relay-build any tier's expected output for the 1-day window.
    def relay_build(tier: str, shard_start_iso: str):
        spec = TIER_SPECS[tier]
        shard_start = datetime.fromisoformat(shard_start_iso).replace(tzinfo=timezone.utc)
        with patch.object(avail_v3, 'read_v3_shard', _relay_read), \
             patch.object(avail_v3, 'r2_client', lambda: None):
            tab = build_cascade_shard(tier, shard_start, all_dates=(one_d, next_d))
        return tab

    def _relay_read(cli, tier, period):
        if tier == '1m':
            return one_m_tables.get(period)
        return _relay_cascade.get((tier, period))

    # Build expected per-tier outputs in derive-from order.
    # 1m → {2m..30m} hourly|daily, 30m → {1h..12h} monthly,
    # 1h → {1d..7d} yearly, 1d → {1mo..1y} yearly|all.
    expected_writes: dict[str, pa.Table] = {}
    for tier, spec in TIER_SPECS.items():
        if spec.derive_from is None:
            continue
        # Enumerate output shards covering the test window.
        if spec.shard == '1h':
            starts = [f'{date_str}T{h:02d}:00:00' for h in range(24)]
        elif spec.shard == '1d':
            starts = [f'{date_str}T00:00:00']
        elif spec.shard == '1mo':
            starts = ['2026-05-01T00:00:00']
        elif spec.shard == '1y':
            starts = ['2026-01-01T00:00:00']
        else:  # 'all'
            starts = ['2026-05-22T00:00:00']
        for s_iso in starts:
            tab = relay_build(tier, s_iso)
            if tab is None:
                continue
            shard_start = datetime.fromisoformat(s_iso).replace(tzinfo=timezone.utc)
            period = (
                'all' if spec.shard == 'all'
                else avail_v3.shard_period(spec.shard, shard_start)
            )
            _relay_cascade[(tier, period)] = tab
            expected_writes[f'{tier}/{period}'] = tab

    # Now run cascade_from_1m on the same window and capture writes.
    with patch.object(avail_v3, 'read_v3_shard', fake_read_v3_shard), \
         patch.object(avail_v3, 'write_table_to_r2', fake_write), \
         patch.object(avail_v3, 'r2_head', fake_head), \
         patch.object(avail_v3, 'r2_client', lambda: None):
        cascade_from_1m(
            date_from=one_d,
            date_to=next_d,
            concurrency=1,  # deterministic ordering for test
            overwrite=True,
            all_dates=(one_d, next_d),
        )

    # Every derived tier the relay produced should appear in `written`,
    # and conversely cascade_from_1m shouldn't invent extras.
    assert set(written) == set(expected_writes), (
        f"tier/period set mismatch:\n"
        f"  only in cascade_from_1m: {sorted(set(written) - set(expected_writes))}\n"
        f"  only in relay:           {sorted(set(expected_writes) - set(written))}"
    )

    # Row-set equality per (tier, period).
    for key in sorted(expected_writes):
        single_pass = written[key]
        relay = expected_writes[key]
        assert _table_rowset(single_pass) == _table_rowset(relay), \
            f"row mismatch for {key}"
