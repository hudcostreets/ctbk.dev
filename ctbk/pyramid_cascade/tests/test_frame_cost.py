"""`frame_cost` (`specs/timelapse-map.md` §Frame cost): RG pruning on `dt`
stats, projected-vs-all byte accounting from the footer's column-chunk
offsets, and bin adjacency — on a small `dt,cell`-sorted parquet written
with a known row-group size."""
from __future__ import annotations

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from ctbk.pyramid_cascade import frame_cost as fc

H = 3_600_000
T0 = 1_748_736_000_000  # 2025-06-01T00:00Z


@pytest.fixture(scope='module')
def md(tmp_path_factory):
    # 3 rows per hourly bin × 4 bins, RG size 5 → RGs straddle bins:
    # rg0 = bins 0,1(partial); rg1 = bins 1,2,3(partial); rg2 = bin 3.
    rows = [(f's:{i}', T0 + b * H, 1.0) for b in range(4) for i in range(3)]
    t = pa.table({
        'cell': pa.array([r[0] for r in rows]),
        'dt': pa.array([r[1] for r in rows], pa.int64()),
        'count_sum': pa.array([r[2] for r in rows]),
    })
    t = t.replace_schema_metadata({'pyrmts.sort': 'dt,cell', 'pyrmts.row_group_size': '5'})
    path = tmp_path_factory.mktemp('fc') / 'shard.parquet'
    pq.write_table(t, path, row_group_size=5, compression='none', write_statistics=True)
    return pq.ParquetFile(path).metadata


def test_shard_info(md):
    info = fc.shard_info(md)
    assert (info.rows, info.row_groups, info.columns, info.sort, info.rg_size) == (
        12, 3, ('cell', 'dt', 'count_sum'), 'dt,cell', 5,
    )
    assert info.footer_bytes == md.serialized_size


def test_rg_spans_and_bin_costs(md):
    full = fc.rg_spans(md)
    proj = fc.rg_spans(md, ['cell', 'dt'])
    assert [(s.rg, s.rows, s.dt_min, s.dt_max) for s in full] == [
        (0, 5, T0, T0 + H), (1, 5, T0 + H, T0 + 3 * H), (2, 2, T0 + 3 * H, T0 + 3 * H),
    ]
    # Column chunks are contiguous within an RG, and RGs back to back.
    assert [s.hi for s in full][:-1] == [s.lo for s in full][1:]
    assert all(s.bytes == s.hi - s.lo for s in full)
    assert [s.bytes < f.bytes for s, f in zip(proj, full)] == [True, True, True]
    # A projection dropping the last column ends before the RG's end.
    assert [(s.lo == f.lo, s.hi < f.hi) for s, f in zip(proj, full)] == [(True, True)] * 3

    costs = [fc.bin_cost(proj, full, T0 + b * H, H) for b in range(4)]
    assert [(c.rgs, c.rows) for c in costs] == [((0,), 5), ((0, 1), 10), ((1,), 5), ((1, 2), 7)]
    assert [(c.lo, c.hi) for c in costs] == [
        (proj[0].lo, proj[0].hi), (proj[0].lo, proj[1].hi), (proj[1].lo, proj[1].hi), (proj[1].lo, proj[2].hi),
    ]
    assert [(c.bytes, c.all_bytes) for c in costs] == [
        (proj[0].bytes, full[0].bytes),
        (proj[0].bytes + proj[1].bytes, full[0].bytes + full[1].bytes),
        (proj[1].bytes, full[1].bytes),
        (proj[1].bytes + proj[2].bytes, full[1].bytes + full[2].bytes),
    ]
    assert [fc.adjacent(a, b) for a, b in zip(costs, costs[1:])] == [True, True, True]
    # A bin past the shard's data touches nothing.
    assert fc.bin_cost(proj, full, T0 + 4 * H, H) == fc.BinCost(bin=T0 + 4 * H, rgs=(), rows=0, lo=0, hi=0, bytes=0, all_bytes=0)


def test_run_cost_and_sample_bins(md):
    full = fc.rg_spans(md)
    run = fc.run_cost(full, full, T0, 2, H)
    assert run == fc.BinCost(bin=T0, rgs=(0, 1), rows=10, lo=full[0].lo, hi=full[1].hi, bytes=full[0].bytes + full[1].bytes, all_bytes=full[0].bytes + full[1].bytes)
    assert fc.sample_bins(full, H, 5) == [T0, T0 + H, T0 + 2 * H, T0 + 3 * H]
    assert fc.sample_bins(full, H, 2) == [T0, T0 + 3 * H]
    assert fc.sample_bins(full, H, 3) == [T0, T0 + 2 * H, T0 + 3 * H]
    assert fc.sample_bins(full, H, 1) == [T0]
