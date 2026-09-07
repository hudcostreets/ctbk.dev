"""SMG classifier (`ctbk.gbfs_empty.classify_day`): state precedence, the system-wide nullish
defaults, forward-fill + seeding, the parquet long form, and the SMG↔bitmap identities."""
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd

from ctbk.gbfs_empty import (
    MINUTES_PER_DAY,
    SMG_ABSENT,
    SMG_BOGUS,
    SMG_CLASSIC_ONLY,
    SMG_EMPTY,
    SMG_FULL,
    SMG_FULL_NO_EBIKES,
    SMG_NO_POLL,
    SMG_OFFLINE,
    SMG_OK,
    SMG_STALE_FEED,
    SMG_STATES,
    Vocab,
    build_planes,
    classify_day,
    smg_check,
    smg_table,
)

DAY = date(2026, 8, 15)
T0 = int(datetime.combine(DAY, datetime.min.time(), tzinfo=timezone.utc).timestamp())


def row(station: str, minute: int, bikes: int, ebikes: int, docks: int, installed: int = 1, renting: int = 1) -> dict:
    return dict(
        station_id=station, ts=T0 + minute * 60 + 7,
        num_bikes_available=bikes, num_ebikes_available=ebikes, num_docks_available=docks,
        is_installed=installed, is_renting=renting,
    )


# Minute-by-minute script for stations A and B:
#   0: both reported — A ok, B empty
#   1: heartbeat, no snapshot            → stale_feed (both)
#   2: no heartbeat                       → no_poll (both)
#   3: snapshot with only A; A not renting → A offline, B absent
#   4: A bogus (0 bikes, 0 docks), B full with no e-bikes
#   5: A classic-only, B ok
ROWS = [
    row('A', 0, 5, 2, 10), row('B', 0, 0, 0, 15),
    row('A', 3, 5, 2, 10, renting=0),
    row('A', 4, 0, 0, 0), row('B', 4, 15, 0, 0),
    row('A', 5, 4, 0, 11), row('B', 5, 6, 1, 9),
]
POLLED = np.ones(MINUTES_PER_DAY, dtype=bool)
POLLED[2] = False


def test_states_follow_precedence_and_system_defaults():
    s = classify_day(pd.DataFrame(ROWS), DAY, POLLED)
    assert s.stations == ['A', 'B']
    assert s.state[:6].tolist() == [
        [SMG_OK, SMG_EMPTY],
        [SMG_STALE_FEED, SMG_STALE_FEED],
        [SMG_NO_POLL, SMG_NO_POLL],
        [SMG_OFFLINE, SMG_ABSENT],
        [SMG_BOGUS, SMG_FULL_NO_EBIKES],
        [SMG_CLASSIC_ONLY, SMG_OK],
    ]
    # Rest of the day: polled, no snapshot → stale_feed for every station.
    assert np.unique(s.state[6:]).tolist() == [SMG_STALE_FEED]
    assert s.lu_minutes[:6].tolist() == [True, False, False, True, True, True]
    assert s.polled[:3].tolist() == [True, True, False]


def test_forward_fill_carries_last_measured_state_over_nullish_minutes():
    s = classify_day(pd.DataFrame(ROWS), DAY, POLLED)
    assert s.state_ff[:6].tolist() == [
        [SMG_OK, SMG_EMPTY],
        [SMG_OK, SMG_EMPTY],          # stale_feed → last measured
        [SMG_OK, SMG_EMPTY],          # no_poll → last measured
        [SMG_OFFLINE, SMG_EMPTY],     # offline is measured (kept); B absent → filled
        [SMG_BOGUS, SMG_FULL_NO_EBIKES],
        [SMG_CLASSIC_ONLY, SMG_OK],
    ]
    assert np.unique(s.state_ff[6:, 0]).tolist() == [SMG_CLASSIC_ONLY]
    assert np.unique(s.state_ff[6:, 1]).tolist() == [SMG_OK]
    assert s.carry == {'A': SMG_CLASSIC_ONLY, 'B': SMG_OK}


def test_seed_fills_before_first_observation_only_when_measured():
    rows = [row('A', 3, 5, 2, 10), row('B', 3, 0, 0, 15)]
    seed = {'A': SMG_FULL, 'B': SMG_STALE_FEED}  # B's seed is nullish → not applied
    s = classify_day(pd.DataFrame(rows), DAY, POLLED, seed)
    assert s.state[:4].tolist() == [
        [SMG_STALE_FEED, SMG_STALE_FEED],
        [SMG_STALE_FEED, SMG_STALE_FEED],
        [SMG_NO_POLL, SMG_NO_POLL],
        [SMG_OK, SMG_EMPTY],
    ]
    assert s.state_ff[:4].tolist() == [
        [SMG_FULL, SMG_STALE_FEED],
        [SMG_FULL, SMG_STALE_FEED],
        [SMG_FULL, SMG_NO_POLL],
        [SMG_OK, SMG_EMPTY],
    ]


def test_partition_and_histogram():
    s = classify_day(pd.DataFrame(ROWS), DAY, POLLED)
    h = s.hist()
    assert sum(h.values()) == 2 * MINUTES_PER_DAY
    assert h == {
        'no_poll': 2,
        'stale_feed': 2 + 2 * (MINUTES_PER_DAY - 6),
        'absent': 1,
        'offline': 1,
        'bogus': 1,
        'empty': 1,
        'full': 0,
        'full_no_ebikes': 1,
        'classic_only': 1,
        'ok': 2,
    }
    assert list(SMG_STATES) == ['no_poll', 'stale_feed', 'absent', 'offline', 'bogus', 'empty', 'full', 'full_no_ebikes', 'classic_only', 'ok']


def test_table_is_station_major_long_form():
    s = classify_day(pd.DataFrame(ROWS), DAY, POLLED)
    t = smg_table(s)
    assert t.column_names == ['station_id', 'dt', 'state', 'state_ff']
    assert t.num_rows == 2 * MINUTES_PER_DAY
    assert t['station_id'][0].as_py() == 'A'
    assert t['station_id'][MINUTES_PER_DAY].as_py() == 'B'
    assert t['dt'][0].as_py() == T0 * 1000
    assert t['dt'][1].as_py() == T0 * 1000 + 60_000
    assert t['dt'][MINUTES_PER_DAY].as_py() == T0 * 1000
    assert t['state'][:6].to_pylist() == [SMG_OK, SMG_STALE_FEED, SMG_NO_POLL, SMG_OFFLINE, SMG_BOGUS, SMG_CLASSIC_ONLY]
    assert t['state'][MINUTES_PER_DAY:MINUTES_PER_DAY + 6].to_pylist() == [SMG_EMPTY, SMG_STALE_FEED, SMG_NO_POLL, SMG_ABSENT, SMG_FULL_NO_EBIKES, SMG_OK]


def test_smg_bitmap_identities_hold():
    df = pd.DataFrame(ROWS)
    s = classify_day(df, DAY, POLLED)
    dp = build_planes(df, DAY, Vocab(['A', 'B']))
    checks = smg_check(s, dp)
    assert checks == {
        'usable=observed': (5, 5),             # A ok, B empty, B full_no_ebikes, A classic, B ok
        'empty=no_bikes': (1, 1),
        'full+full_no_ebikes=full': (1, 1),
        'empty+full_no_ebikes+classic_only=no_ebikes': (3, 3),
        'partition=live×1440': (2 * MINUTES_PER_DAY, 2 * MINUTES_PER_DAY),
    }
