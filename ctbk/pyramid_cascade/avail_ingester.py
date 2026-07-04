"""Avail-v3 base-tier ingester (long-form, Polars-native).

Reads `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` source rows for a
given time range, materializes each station's observations at LUC +
ancestor cells via a Polars join+explode, and returns a LazyFrame in the
cascade pipeline's **long form** — one row per
`(s2_cell, dt, metric, state)` with the observation count:

  s2_cell : Utf8       S2 hex token
  dt      : Int64      bucket-start unix ms
  metric  : Utf8       one of AVAIL_METRICS
  state   : Int64      bike/dock count value at that minute
  count   : Int64      # of stations at this (cell, dt, metric) with `state`

The engine layer floors `dt` per tier, sums `count` per (cell, dt_out,
metric, state), then builds the parquet-shard hist JSON only at write
time. Keeping data long-form in-process avoids the build-then-parse
round-trip that previously routed every row through Python `map_elements`
calls (10+ minute single-day smoke pre-vectorization).
"""
from __future__ import annotations

import concurrent.futures as cf
from datetime import datetime, timedelta

import polars as pl
import s2cell

from ctbk.avail_v3 import (
    AVAIL_GENESIS,
    AVAIL_METRICS,
    COARSEST_LEVEL,
    SRC_PREFIX,
    load_station_luc,
    r2_client,
    read_minute_shard,
)
from utz import err


def avail_ingest_1m(
    block_from: datetime,
    block_to: datetime,
    *,
    coarsest_level: int = COARSEST_LEVEL,
    fetch_concurrency: int = 16,
) -> pl.LazyFrame:
    """Pipeline:
      1. Parallel-fetch per-minute source shards as Polars DataFrames.
      2. Concat + dt-ms cast + LUC-chain join + explode (cell ancestry).
      3. Unpivot the per-metric `_sum` columns → long
         (s2_cell, dt, metric, state) rows.
      4. group_by(*) + count → long-form `(... , state, count)` LazyFrame.
    """
    import time
    t0 = time.time()

    if block_from < AVAIL_GENESIS:
        block_from = AVAIL_GENESIS
    if block_from >= block_to:
        return _empty_long_lf()

    cli = r2_client()
    luc = load_station_luc()
    by_short_name = luc['by_short_name']
    by_uuid = luc['by_uuid']

    uuid_cell_chain: dict[str, list[str]] = {}
    for uuid, sn in by_uuid.items():
        entry = by_short_name.get(sn)
        if entry is None:
            continue
        lat, lng = entry['lat'], entry['lng']
        luc_level, luc_cell = entry['level'], entry['cell']
        chain = [s2cell.lat_lon_to_token(lat, lng, lvl) for lvl in range(coarsest_level, luc_level)]
        chain.append(luc_cell)
        uuid_cell_chain[uuid] = chain

    if not uuid_cell_chain:
        return _empty_long_lf()

    luc_df = pl.DataFrame({
        'station_id': list(uuid_cell_chain.keys()),
        'cells': list(uuid_cell_chain.values()),
    }, schema={'station_id': pl.Utf8, 'cells': pl.List(pl.Utf8)})

    keys: list[str] = []
    cur = block_from
    while cur < block_to:
        date_str = cur.strftime('%Y-%m-%d')
        keys.append(f'{SRC_PREFIX}/{date_str}/{cur.hour:02d}{cur.minute:02d}.parquet')
        cur = cur + timedelta(minutes=1)

    metric_sum_cols = [f'{m}_sum' for m in AVAIL_METRICS]
    cols_needed = ['station_id', 'dt'] + metric_sum_cols

    def _fetch(key: str) -> pl.DataFrame | None:
        tab = read_minute_shard(cli, key)
        if tab is None:
            return None
        try:
            tab = tab.select(cols_needed)
        except KeyError:
            return None
        return pl.from_arrow(tab)

    err(f"  ingest: fetching {len(keys)} minute-shards "
        f"({block_from.isoformat()} → {block_to.isoformat()}) "
        f"@ {fetch_concurrency}-way")
    with cf.ThreadPoolExecutor(max_workers=fetch_concurrency) as pool:
        minute_dfs = [df for df in pool.map(_fetch, keys) if df is not None]
    err(f"  ingest: fetched {len(minute_dfs)}/{len(keys)} shards in {time.time() - t0:.1f}s")

    if not minute_dfs:
        return _empty_long_lf()

    # CRITICAL: build a lazy plan end-to-end. If we kept things eager here
    # the downstream `collect(engine='streaming')` is a no-op and the
    # explode+unpivot peak memory blows up (16 GB+ per 1d block observed).
    # Lazy concat + lazy joins + lazy unpivot + lazy group_by lets Polars's
    # streaming engine chunk the work to a bounded working set (~1-2 GB).
    src = pl.concat([df.lazy() for df in minute_dfs], how='vertical_relaxed')

    joined = (
        src.with_columns((pl.col('dt') * 1000).alias('dt'))
        .join(luc_df.lazy(), on='station_id', how='inner')
        .explode('cells')
        .rename({'cells': 's2_cell'})
    )

    # Long-form: (s2_cell, dt, metric, state). Drop nulls (any metric not
    # reported by a station for some minute). Keep state as Int64 so the
    # downstream sort is numeric (not lex).
    long = (
        joined.unpivot(
            on=metric_sum_cols,
            index=['s2_cell', 'dt'],
            variable_name='metric_col',
            value_name='state',
        )
        .filter(pl.col('state').is_not_null())
        .with_columns(
            pl.col('metric_col').str.strip_suffix('_sum').alias('metric'),
            pl.col('state').cast(pl.Int64).alias('state'),
        )
        .drop('metric_col')
    )

    return long.group_by(['s2_cell', 'dt', 'metric', 'state']).agg(pl.len().alias('count'))


def _empty_long_lf() -> pl.LazyFrame:
    return pl.DataFrame(
        schema={
            's2_cell': pl.Utf8,
            'dt': pl.Int64,
            'metric': pl.Utf8,
            'state': pl.Int64,
            'count': pl.Int64,
        },
    ).lazy()
