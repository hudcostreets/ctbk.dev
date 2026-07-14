"""Unit tests for rides-v3 LUC-anchored keying (`specs/rides-v3-luc.md`).

The v3 build keys each ride by its CANONICAL station's L10..LUC chain
(station identity), not per-ride coordinates — coordinate jitter across
eras crosses cell boundaries at any magnitude (JC115's 2023-01..2024-07
months undercounted -3..-16% under coordinate keying). These tests pin:

1. chain construction from the denorm (ancestors from canonical
   position, LUC cell verbatim),
2. id-map ∘ same-dock-merge composition,
3. the build path: jittered coordinates collapse onto one chain,
   unmapped sids fall back to coordinates minus LUC cells, null-coord
   rides are kept iff their sid maps.

Synthetic denorm + rides; no R2, no repo data files.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import s2cell

from ctbk import rides_v1
from ctbk.rides_v1 import build_1h_month_table, canonical_station_map, luc_chains


def tok(lat: float, lng: float, lvl: int) -> str:
    return s2cell.lat_lon_to_token(lat, lng, lvl)


AAA = {'lat': 40.75, 'lng': -73.99}
BBB = {'lat': 40.60, 'lng': -74.10}
AAA_LEVEL, BBB_LEVEL = 15, 14
AAA_CELL = tok(AAA['lat'], AAA['lng'], AAA_LEVEL)
BBB_CELL = tok(BBB['lat'], BBB['lng'], BBB_LEVEL)

DENORM = {
    'by_short_name': {
        'AAA': {**AAA, 'cell': AAA_CELL, 'level': AAA_LEVEL, 'active': True},
        'BBB': {**BBB, 'cell': BBB_CELL, 'level': BBB_LEVEL, 'active': False},
    },
    'by_uuid': {},
    'merged': {'OLD': 'AAA'},
}
ID_MAP = {'123': 'OLD', '456': 'BBB', 'AAA': 'AAA'}

AAA_CHAIN = tuple(tok(AAA['lat'], AAA['lng'], lvl) for lvl in range(10, 15)) + (AAA_CELL,)
BBB_CHAIN = tuple(tok(BBB['lat'], BBB['lng'], lvl) for lvl in range(10, 14)) + (BBB_CELL,)


def with_denorm(fn):
    """Point the module's denorm/id-map paths at fixture files, clearing
    the lru caches on both sides."""
    def wrapper(tmp_path: Path):
        luc_path = tmp_path / 'station-luc.json'
        idm_path = tmp_path / 'station-id-map.json'
        luc_path.write_text(json.dumps(DENORM))
        idm_path.write_text(json.dumps(ID_MAP))
        luc_chains.cache_clear()
        canonical_station_map.cache_clear()
        try:
            with patch.object(rides_v1, 'STATION_LUC_PATH', luc_path), \
                 patch.object(rides_v1, 'ID_MAP_PATH', idm_path):
                fn(tmp_path)
        finally:
            luc_chains.cache_clear()
            canonical_station_map.cache_clear()
    return wrapper


@with_denorm
def test_luc_chains(tmp_path: Path):
    chains, luc_cells = luc_chains()
    assert chains == {'AAA': AAA_CHAIN, 'BBB': BBB_CHAIN}
    assert luc_cells == frozenset({AAA_CELL, BBB_CELL})


@with_denorm
def test_canonical_station_map_composes_merge(tmp_path: Path):
    # '123' → id-map 'OLD' → merged 'AAA'; '456' → 'BBB' (no merge).
    assert canonical_station_map() == {'123': 'AAA', '456': 'BBB', 'AAA': 'AAA'}


def ride(sid: str, lat: float | None, lng: float | None, start: str = '2023-06-01 08:10:00'):
    st = pd.Timestamp(start)
    return {
        'Start Time': st, 'Stop Time': st + pd.Timedelta(minutes=10),
        'Start Station ID': sid, 'Start Station Latitude': lat, 'Start Station Longitude': lng,
        'End Station ID': sid, 'End Station Latitude': lat, 'End Station Longitude': lng,
        'Gender': 0, 'User Type': 'Subscriber', 'Rideable Type': 'classic_bike',
    }


@with_denorm
def test_build_v3_luc_keying(tmp_path: Path):
    rides = pd.DataFrame([
        # Same station ('123'→AAA) at two jittered positions — must
        # collapse onto AAA's single canonical chain.
        ride('123', 40.7500, -73.9900),
        ride('123', 40.7504, -73.9897),
        # Known sid, null coords: kept (identity keying needs no coords).
        ride('AAA', None, None),
        # Unknown sid, null coords: dropped (nothing to key by).
        ride('ZZZ', None, None),
    ])
    ym_start = pd.Timestamp('2023-06-01')
    ym_end = pd.Timestamp('2023-07-01')

    def fake_load(ym, anchor):
        t = rides['Start Time']
        return rides[(t >= ym_start) & (t < ym_end)].copy()

    with patch.object(rides_v1, '_load_rides_for_anchor', fake_load), \
         patch.object(rides_v1, 'station_geo_lookup', lambda: {}):
        table = build_1h_month_table('2023-06', 'start', variant='v3')

    df = table.to_pandas()
    dt_ms = int(datetime(2023, 6, 1, 8, 0, tzinfo=timezone.utc).timestamp() * 1000)
    got = sorted(zip(df['start_s2_cell'], df['dt'], df['count_sum']))
    # 3 kept rides, all AAA → one row per chain cell with count 3.
    assert got == sorted((cell, dt_ms, 3) for cell in AAA_CHAIN)


@with_denorm
def test_build_v3_unknown_sid_fallback_excludes_luc_cells(tmp_path: Path):
    # An unmapped sid AT station AAA's exact position: fallback emits its
    # coordinate chain L10..L15 minus any LUC cell — so AAA's L15 LUC
    # cell must NOT appear (per-station queries stay uncontaminated).
    rides = pd.DataFrame([ride('ZZZ', AAA['lat'], AAA['lng'])])
    ym_start, ym_end = pd.Timestamp('2023-06-01'), pd.Timestamp('2023-07-01')

    def fake_load(ym, anchor):
        return rides.copy()

    with patch.object(rides_v1, '_load_rides_for_anchor', fake_load), \
         patch.object(rides_v1, 'station_geo_lookup', lambda: {}):
        table = build_1h_month_table('2023-06', 'start', variant='v3')

    df = table.to_pandas()
    expected_cells = sorted(
        tok(AAA['lat'], AAA['lng'], lvl) for lvl in range(10, 16)
        if tok(AAA['lat'], AAA['lng'], lvl) != AAA_CELL
    )
    assert sorted(df['start_s2_cell']) == expected_cells
    assert set(df['count_sum']) == {1}
