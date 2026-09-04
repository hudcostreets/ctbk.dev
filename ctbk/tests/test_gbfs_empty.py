"""`ctbk gbfs empty`: planes from status rows, Zarr day-shard round trip + reference range-reader."""
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from ctbk.gbfs_empty import (
    LAYOUTS, MINUTES_PER_DAY, PLANES, LocalShard, Vocab, build_planes, day_idx, open_group, open_store,
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
    assert coords(dp.planes['no_bikes']) == [(1, a)]
    assert coords(dp.planes['no_ebikes']) == [(1, a), (2, a), (480, b)]
    assert coords(dp.planes['full']) == [(3, a), (481, c)]


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

    # reference range-reader vs. the built planes: hours 0 and 8 of shard 0 carry bits; shard 1 is absent
    for hour in (0, 8):
        got = L.read_hour(shards(0), hour)
        assert np.array_equal(got, dp.hour(hour, 0)), hour
    assert L.read_hour(shards(0), 1) is None          # hour 1: no bits in any plane ⇒ empty chunk
    assert L.read_hour(shards(1), 0) is None          # station-shard 1: absent object
    # subset of planes (what a single-condition query fetches)
    sub = L.read_hour(shards(0), 8, ('observed', 'no_ebikes'))
    assert np.array_equal(sub, dp.hour(8, 0)[[0, 2]])
