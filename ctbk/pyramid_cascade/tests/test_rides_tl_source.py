"""Tests for `MonthlyRidesSource`'s config-driven dims/metrics and
identity-only mode (`specs/timelapse-map.md`, the `rides-tl-*`
pyramids): `dims: [cell]` sums the rider dims away, `metrics: [count]`
drops the duration rows, and `identity_only=True` emits one raw `s:<sid>`
leaf row per station-bin (no vocab-chain cells) plus exactly one
coarsest fallback row per unmapped ride.
"""
from __future__ import annotations

from datetime import datetime, timezone

import polars as pl
import pytest
import s2cell
from pyrmts import MemStorage, parse_pyramid_yaml, pyramid_from_config

from ctbk.pyramid_cascade.engine_check import CONFIG_DIR
from ctbk.pyramid_cascade.rides_source import MonthlyRidesSource

from .test_rides_source import CANONICAL, CHAINS, GEO, JUL, JUN, VOCAB_CELLS, ms, ride, rides_blob

TL_YAML = """
storage: { type: s3, bucket: x, key: "t/{tier}/{shard}/{period}.{hash:12}.parquet" }
axis: time
binCol: dt
dims:
  - { name: cell, type: string }
metrics:
  - { name: count, monoid: sum }
tiers:
  - { name: 1h, bin: 1h, shards: [32d] }
identityRollup: { col: cell, map: stations/station-canonicalize-map.json }
"""


@pytest.fixture
def tl_pyramid():
    return pyramid_from_config(parse_pyramid_yaml(TL_YAML), MemStorage())


def make_tl_source(pyramid, tiles: dict[str, list[dict]], anchor: str = 'start', **kwargs) -> MonthlyRidesSource:
    blobs = {f'normalized/{ym}.parquet': rides_blob(rows) for ym, rows in tiles.items()}
    return MonthlyRidesSource(
        pyramid,
        anchor,
        chains=CHAINS,
        canonical=CANONICAL,
        geo=GEO,
        vocab_cells=VOCAB_CELLS,
        available_months=set(tiles),
        fetch_fn=blobs.get,
        **kwargs,
    )


def read_sorted(src: MonthlyRidesSource, start: datetime, end: datetime) -> list[tuple]:
    df = src.read_window(start, end)
    return sorted(
        df
        .with_columns(pl.col('metric').cast(pl.Utf8))
        .select('cell', 'dt', 'metric', 'state', 'count')
        .rows()
    )


def count_rows(cell: str, dt_ms: int, n: int) -> list[tuple]:
    return [
        (cell, dt_ms, 'count_n', None, float(n)),
        (cell, dt_ms, 'count_sum', None, float(n)),
        (cell, dt_ms, 'count_sumsq', None, float(n)),
    ]


T9 = datetime(2026, 6, 10, 9, 5, tzinfo=timezone.utc)
T10 = datetime(2026, 6, 10, 10, 15, tzinfo=timezone.utc)
H9 = ms(datetime(2026, 6, 10, 9, tzinfo=timezone.utc))
H10 = ms(datetime(2026, 6, 10, 10, tzinfo=timezone.utc))

# Hour 9: three ST1 rides spread across every rider dim — two under raw
# id '101', one under the legacy id 'legacy-1' (both canonicalize to ST1;
# the leaves stay RAW, `c:ST1` is the separate identityRollup pass).
# Hour 10: one ST2 ride and one unmapped-sid ride (null coords → geo).
RIDES = [
    ride(T9, T9.replace(minute=15), start_sid='101', gender=1, user_type='Subscriber', bike_type='classic'),
    ride(T9, T9.replace(minute=25), start_sid='101', gender=2, user_type='Customer', bike_type='electric'),
    ride(T9, T9.replace(minute=35), start_sid='legacy-1', gender=None, user_type='Subscriber', bike_type='classic'),
    ride(T10, T10.replace(minute=20), start_sid='102'),
    ride(T10, T10.replace(minute=30), start_sid='999', start_lat=None, start_lng=None),
]
FALLBACK_L10 = s2cell.lat_lon_to_token(*GEO['999'], 10)


def test_identity_only_cell_dim_count_only(tl_pyramid):
    src = make_tl_source(tl_pyramid, {'202606': RIDES}, dims=['cell'], identity_only=True)
    assert src.identity_only is True
    assert read_sorted(src, JUN, JUL) == sorted(
        count_rows('s:101', H9, 2)
        + count_rows('s:legacy-1', H9, 1)
        + count_rows('s:102', H10, 1)
        + count_rows(FALLBACK_L10, H10, 1)
    )


def test_dims_and_metrics_default_to_the_pyramid_config(tl_pyramid):
    # `dims=None` reads the pyramid's declared dims (`[cell]`), metrics
    # always do; only `identity_only` is an explicit switch — without it
    # the vocab chain cells still land in `cell` (summed over rider dims),
    # and the fallback keys every non-vocab level.
    src = make_tl_source(tl_pyramid, {'202606': RIDES})
    assert src.identity_only is False
    fallback = [s2cell.lat_lon_to_token(*GEO['999'], lvl) for lvl in range(10, 16)]
    assert read_sorted(src, JUN, JUL) == sorted(
        count_rows('cell-a', H9, 3)
        + count_rows('s:101', H9, 2)
        + count_rows('s:legacy-1', H9, 1)
        + count_rows('cell-a', H10, 1)
        + count_rows('s:102', H10, 1)
        + [r for c in fallback for r in count_rows(c, H10, 1)]
    )


def test_real_rides_tl_configs_drive_the_source():
    # The checked-in `rides-tl-{start,end}.yaml`: no `geo` block, dims
    # `[cell]`, metrics `[count]`, the rides `identityRollup` with an
    # explicit `col` — the source built from them (as the Batch factories
    # do) emits exactly the leaf rows.
    for anchor in ('start', 'end'):
        cfg = parse_pyramid_yaml((CONFIG_DIR / f'rides-tl-{anchor}.yaml').read_text())
        assert cfg.geo is None
        assert [d.name for d in cfg.dims] == ['cell']
        assert [m.name for m in cfg.metrics] == ['count']
        assert cfg.keyTemplate == f'rides-tl/{anchor}/{{tier}}/{{shard}}/{{period}}.{{hash:12}}.parquet'
        assert (cfg.identity_rollup.col, cfg.identity_rollup.map, cfg.identity_rollup.canonicalPrefix) == (
            'cell', 'stations/station-canonicalize-map.json', 'c:',
        )
        pyramid = pyramid_from_config(cfg, MemStorage())
        src = make_tl_source(pyramid, {'202606': RIDES[:1]}, anchor=anchor, identity_only=True)
        cell = {'start': 's:101', 'end': 's:102'}[anchor]
        assert read_sorted(src, JUN, JUL) == count_rows(cell, H9, 1)


def test_missing_tile_empty_frame_matches_schema(tl_pyramid):
    # A window mixing a parsed tile and a missing one vstacks the parsed
    # frame with `empty_long` (cast to the count-only metric Enum).
    src = make_tl_source(tl_pyramid, {'202607': RIDES[3:4]}, identity_only=True)
    assert read_sorted(src, JUN, datetime(2026, 8, 1, tzinfo=timezone.utc)) == count_rows('s:102', H10, 1)
    assert src.coverage() == (2, ['normalized/202606.parquet'])


def test_dims_must_start_with_cell(tl_pyramid):
    with pytest.raises(ValueError, match=r"dims must start with 'cell', got \['gender', 'cell'\]"):
        make_tl_source(tl_pyramid, {}, dims=['gender', 'cell'])


def test_unknown_rider_dim_rejected(tl_pyramid):
    with pytest.raises(ValueError, match=r"unknown rider dims \['birth_year'\]"):
        make_tl_source(tl_pyramid, {}, dims=['cell', 'birth_year'])
