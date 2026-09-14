"""ctbk-side materialized canonicalization (`specs/materialized-canonicalization.md`).

Two things, both hermetic:

1. **The derive rule** (`rides_assets.cluster_canonicalize_map`): raw-id →
   canonical grouping → the pyrmts `identityRollup.map` `{s:<raw>: c:<canonical>}`,
   over *merged* clusters only. Pins the two subtle calls — a merged cluster
   keeps its self-member (`s:C -> c:C` when the canonical id is itself a raw
   reported leaf), and a singleton is dropped (no `c:` row duplicating one leaf).

2. **The rollup** (pyrmts `recanonicalize_table` fed ctbk's derived map): a
   built rides shard keyed by raw `s:` leaves gains one `c:<canonical>` row per
   (bin, canonical, dims), summed from its constituent leaves; raw leaves and
   s2 cells pass through untouched. This is the identity-fold the golden
   `test_golden_raw_leaves_unfolded` defers to (`test_rides_v5_golden.py`).
"""
from __future__ import annotations

import pyarrow as pa
import pyarrow.parquet as pq
from io import BytesIO

import pytest
from pyrmts import parse_pyramid_yaml, pyramid_from_config, recanonicalize_table, MemStorage

from ctbk.pyramid_cascade.rides_assets import cluster_canonicalize_map
from ctbk.pyramid_cascade.tests.test_rides_v5_golden import YAML


def test_cluster_map_keeps_self_member_and_drops_singletons():
    # `6148.02` is a real reported id AND the canonical of the {116, 6148.02}
    # renumber cluster: BOTH `s:116` and `s:6148.02` must fold into `c:6148.02`
    # (dropping the self-member `s:6148.02` would lose every ride reported under
    # the new id). `999` is a singleton → no `c:` row. `A` is a synthetic
    # canonical (not itself a reported id), merging {1, L} with no self-member.
    eff = {'116': '6148.02', '6148.02': '6148.02', '999': '999', '1': 'A', 'L': 'A'}
    assert cluster_canonicalize_map(eff) == {
        's:1': 'c:A',
        's:116': 'c:6148.02',
        's:6148.02': 'c:6148.02',
        's:L': 'c:A',
    }


# ─── The rollup over a built shard ──────────────────────────────────────
# One bin (dt=0); a built rides shard is one wide row per (cell, dims) with the
# sum-monoid state. `cA` is station A's coarse s2 cell (pass-through). The raw
# leaves mirror the golden START-June counts (`test_rides_v5_golden`): s:1 = the
# two classic rides, s:L = the legacy-alias electric ride, s:2 = the two B rides.
SHARD_ROWS: list[tuple] = [
    # (cell, gender, user_type, bike_type, n, dur_sum, dur_sumsq)
    ('cA',  'male',   'Subscriber', 'classic',  2, 1200, 720_000),
    ('cA',  'female', 'Customer',   'electric', 1, 300,  90_000),
    ('s:1', 'male',   'Subscriber', 'classic',  2, 1200, 720_000),
    ('s:L', 'female', 'Customer',   'electric', 1, 300,  90_000),
    ('s:2', 'male',   'Subscriber', 'classic',  1, 900,  810_000),
    ('s:2', 'male',   'Subscriber', 'electric', 1, 2400, 5_760_000),
]


def _shard_table(rows: list[tuple]) -> pa.Table:
    cols: dict[str, list] = {
        'cell': [], 'dt': [], 'gender': [], 'user_type': [], 'bike_type': [],
        'count_n': [], 'count_sum': [], 'count_sumsq': [],
        'duration_n': [], 'duration_sum': [], 'duration_sumsq': [],
    }
    for cell, gender, ut, bt, n, dsum, dsumsq in rows:
        cols['cell'].append(cell)
        cols['dt'].append(0)
        cols['gender'].append(gender)
        cols['user_type'].append(ut)
        cols['bike_type'].append(bt)
        cols['count_n'].append(float(n))
        cols['count_sum'].append(float(n))
        cols['count_sumsq'].append(float(n))
        cols['duration_n'].append(float(n))
        cols['duration_sum'].append(float(dsum))
        cols['duration_sumsq'].append(float(dsumsq))
    return pa.table(cols)


def _parse_shard(table: pa.Table) -> list[tuple]:
    d = table.to_pydict()
    return sorted(
        (d['cell'][i], d['gender'][i], d['user_type'][i], d['bike_type'][i],
         d['count_sum'][i], d['duration_sum'][i], d['duration_sumsq'][i])
        for i in range(table.num_rows)
    )


def _summed(cell: str, gender: str, ut: str, bt: str, n: int, dsum: int, dsumsq: int) -> tuple:
    """A `(cell, dims, count_sum, duration_sum, duration_sumsq)` row as floats,
    matching `_parse_shard`'s read of the float64 monoid-state columns."""
    return (cell, gender, ut, bt, float(n), float(dsum), float(dsumsq))


@pytest.fixture
def pyramid():
    return pyramid_from_config(parse_pyramid_yaml(YAML), MemStorage())


def test_recanonicalize_folds_merged_cluster_leaves(pyramid):
    # ctbk's derive rule over the golden identity map: A merges {1, L}; B (id 2)
    # is a singleton → omitted, so `s:2` stays leaf-only with no `c:B`.
    id_map = cluster_canonicalize_map({'1': 'A', '2': 'B', 'L': 'A'})
    assert id_map == {'s:1': 'c:A', 's:L': 'c:A'}

    out = recanonicalize_table(_shard_table(SHARD_ROWS), id_map, pyramid=pyramid, col='cell')
    # Every raw leaf + s2 cell passes through untouched, plus one `c:A` row per
    # (dims) group summed from its raw constituents. s:1 and s:L differ in every
    # dim, so c:A is two rows, not one — the canonical row preserves the
    # dimensional breakdown. `s:2` (singleton B) gets no `c:` row.
    assert _parse_shard(out) == sorted(
        [_summed(*r) for r in SHARD_ROWS] + [
            _summed('c:A', 'female', 'Customer',   'electric', 1, 300,  90_000),   # from s:L
            _summed('c:A', 'male',   'Subscriber', 'classic',  2, 1200, 720_000),  # from s:1
        ]
    )


def test_recanonicalize_is_idempotent(pyramid):
    # A second pass drops the stale `c:` rows and rebuilds them identically:
    # byte-for-byte stable, so re-running after an unchanged map is a no-op.
    id_map = cluster_canonicalize_map({'1': 'A', '2': 'B', 'L': 'A'})
    once = recanonicalize_table(_shard_table(SHARD_ROWS), id_map, pyramid=pyramid, col='cell')
    twice = recanonicalize_table(once, id_map, pyramid=pyramid, col='cell')

    def _bytes(t: pa.Table) -> bytes:
        buf = BytesIO()
        pq.write_table(t, buf, compression='snappy')
        return buf.getvalue()

    assert _bytes(once) == _bytes(twice)
