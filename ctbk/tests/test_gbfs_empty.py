"""`ctbk gbfs empty`: planes from status rows, Zarr day-shard round trip + reference range-reader."""
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from ctbk.gbfs_empty import (
    LAYOUTS, MINUTES_PER_DAY, PLANES, S_MAX, LocalShard, Vocab, build_planes, coverage_doc, day_idx, open_group, open_store,
)

DAY = date(2026, 8, 25)
T0 = int(datetime(2026, 8, 25, tzinfo=timezone.utc).timestamp())
A, B, C, D = 'aaaa', 'bbbb', 'cccc', 'dddd'


def row(station, minute, bikes=5, ebikes=2, docks=10, installed=1, renting=1, sec=0):
    return dict(
        station_id=station, num_bikes_available=bikes, num_ebikes_available=ebikes,
        num_docks_available=docks, is_installed=installed, is_renting=renting, ts=T0 + minute * 60 + sec,
    )


ROWS = [
    row(A, 0),                                  # observed, nothing empty
    row(A, 1, bikes=0, ebikes=0),               # no bikes (⇒ no ebikes)
    row(A, 2, ebikes=0),                        # no ebikes only
    row(A, 3, docks=0),                         # full
    row(A, 4, bikes=0, ebikes=0, docks=0),      # 0/0 ⇒ dead ⇒ unobserved
    row(A, 5, renting=0, bikes=0, ebikes=0),    # not renting ⇒ unobserved
    row(A, 6, installed=0, bikes=0, ebikes=0),  # not installed ⇒ unobserved
    row(B, 480, bikes=0, ebikes=0),             # hour 8, station in vocab
    row(B, 480, bikes=3, ebikes=0, sec=30),     # duplicate (station, minute): later ts wins
    row(C, 481, docks=0),                       # station not in vocab ⇒ appended
    row(D, MINUTES_PER_DAY, bikes=0),           # next day ⇒ spill
    row(D, -1, bikes=0),                        # previous day ⇒ spill
]


def coords(a: np.ndarray) -> list[tuple[int, int]]:
    return [(int(t), int(s)) for t, s in zip(*np.nonzero(a))]


def test_build_planes():
    vocab = Vocab([B, A])
    dp = build_planes(pd.DataFrame(ROWS), DAY, vocab)
    assert vocab.stations == [B, A, C]
    assert dp.added == [C]
    assert (dp.n_rows, dp.n_spill) == (9, 2)
    a, b, c = 1, 0, 2
    assert coords(dp.planes['observed']) == [(0, a), (1, a), (2, a), (3, a), (480, b), (481, c)]
    # strict = as reported
    assert coords(dp.strict('no_bikes')) == [(1, a)]
    assert coords(dp.strict('no_ebikes')) == [(1, a), (2, a), (480, b)]
    assert coords(dp.strict('full')) == [(3, a), (481, c)]
    # stored = forward-filled over unobserved minutes, uncapped within the day, zero before first observation
    assert coords(dp.planes['no_bikes']) == [(1, a)]
    assert coords(dp.planes['no_ebikes']) == sorted([(1, a), (2, a)] + [(t, b) for t in range(480, MINUTES_PER_DAY)])
    assert coords(dp.planes['full']) == sorted([(t, a) for t in range(3, MINUTES_PER_DAY)] + [(t, c) for t in range(481, MINUTES_PER_DAY)])
    assert dp.carry.shape == (3, S_MAX)
    assert [(int(i), int(j)) for i, j in zip(*np.nonzero(dp.carry[:, :3]))] == [(1, b), (2, a), (2, c)]


def test_build_planes_seeded():
    """The previous day's carry fills a station's minutes before its first observation."""
    vocab = Vocab([B, A, C])
    seed = np.zeros((3, S_MAX), dtype=bool)
    seed[0, 2] = True   # C carried in as no_bikes
    seed[2, 0] = True   # B carried in as full
    dp = build_planes(pd.DataFrame(ROWS), DAY, vocab, seed)
    b, c = 0, 2
    assert coords(dp.planes['no_bikes'][:, [b, c]]) == [(t, 1) for t in range(0, 481)]          # C until its 481 observation (docks=0, bikes=5)
    assert coords(dp.planes['full'][:, [b, c]]) == sorted([(t, 0) for t in range(0, 480)] + [(t, 1) for t in range(481, MINUTES_PER_DAY)])
    assert coords(dp.planes['observed'][:, [b, c]]) == [(480, 0), (481, 1)]


def test_round_trip_and_range_reader(tmp_path: Path):
    L = LAYOUTS['packed']
    vocab = Vocab([B, A])
    dp = build_planes(pd.DataFrame(ROWS), DAY, vocab)
    root = tmp_path / L.prefix
    g = open_group(L, open_store(str(root)))
    assert L.write_day(g, dp) == 1
    d = day_idx(DAY)
    assert sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()) == ['planes/c/0/%d/0' % d, 'planes/zarr.json', 'zarr.json']

    def shards(shard: int):
        return {'_': LocalShard(tmp_path / L.keys(DAY, shard)[0])}

    # reference range-reader vs. the built planes: every hour of shard 0 carries bits (A's `full` is forward-filled
    # from minute 3 through the day); station-shard 1 is an absent object
    for hour in (0, 1, 8, 23):
        got = L.read_hour(shards(0), hour)
        assert np.array_equal(got, dp.hour(hour, 0)), hour
    assert L.read_hour(shards(1), 0) is None
    # subset of planes (what a single-condition query fetches)
    sub = L.read_hour(shards(0), 8, ('observed', 'no_ebikes'))
    assert np.array_equal(sub, dp.hour(8, 0)[[0, 2]])


def test_coverage_doc():
    vocab = Vocab([B, A])
    dp = build_planes(pd.DataFrame(ROWS), DAY, vocab)
    doc = coverage_doc(dp)
    counts = [0] * MINUTES_PER_DAY
    for t in (0, 1, 2, 3, 480, 481):
        counts[t] = 1
    per_hour = [0] * 24
    per_hour[0], per_hour[8] = 7, 3                # distinct `ts` (pre-dedup, incl. unobserved rows): minutes 0..6; 480, 480+30s, 481
    intervals = [60] * 6 + [(480 - 6) * 60, 30, 30]
    skips = [0] * 24
    skips[0] = round(intervals[6] / 60) - 1          # the one long interval, minute 6 → 480, credited to hour 0
    assert {k: v for k, v in doc.items() if k != 'counts'} == {
        'day': '2026-08-25',
        'live': 3,
        'observed_minutes': 0,                   # 1 of 3 live stations observed is below the 50% gap threshold everywhere
        'gaps': [[0, MINUTES_PER_DAY, 0]],
        'lu_updates': 10,
        'lu_per_hour': per_hour,
        'lu_skips_per_hour': skips,
        'lu_skips': 473,
        'lu_interval': {'p50': 60, 'p99': int(np.percentile(intervals, 99)), 'max': 28440},
        'lu_hist': {'30': 2, '60': 6, '28440': 1},
    }
    assert doc['counts'] == counts
