"""Avail-v3 base-tier ingester (streaming, Polars-native).

Reads `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` source rows for a
given time range, materializes each station's observations at LUC +
ancestor cells via a Polars join+explode (NO per-row Python dict
materialization), and returns a Polars LazyFrame in the avail-v3
base-tier schema:

  s2_cell : Utf8       S2 hex token
  dt      : Int64      bucket-start unix ms
  bikes   : Utf8       histogram JSON {state_str: observation_count}
  ebikes  : Utf8
  docks   : Utf8
  disabled: Utf8
  pending : Utf8

For the /1m base tier, "observation_count" per (cell, dt, metric, state)
is the # of stations whose value at that minute equals `state`.

Memory profile: bounded by the source Arrow columnar size, ~1–2 GB per
day-block instead of the ~10 GB the previous Python-dict version
materialized.
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import json
from datetime import datetime, timedelta, timezone

import polars as pl
import pyarrow.parquet as pq
import s2cell

from ctbk.avail_v3 import (
    AVAIL_METRICS,
    COARSEST_LEVEL,
    SRC_PREFIX,
    R2_BUCKET,
    load_station_luc,
    r2_client,
    read_minute_shard,
)


def avail_ingest_1m(
    block_from: datetime,
    block_to: datetime,
    *,
    coarsest_level: int = COARSEST_LEVEL,
    fetch_concurrency: int = 16,
) -> pl.LazyFrame:
    """Avail-v3 1m base-tier ingester (Polars-native, no Python dict loop).

    Pipeline:
      1. Read each per-minute source shard as a Polars DataFrame.
      2. Concat into one frame.
      3. Join with a small LUC-chain frame (uuid → list of cells) on uuid.
      4. Explode `cells` → one row per (cell × source-station × dt).
      5. Unpivot the metric columns to long format
         (cell, dt, metric, state).
      6. Group by (cell, dt, metric, state) + count → state observation counts.
      7. Group again by (cell, dt, metric) → list of {state, count} structs.
      8. Map to JSON-string hist per (cell, dt, metric).
      9. Pivot wide → one row per (cell, dt) with N metric:hist columns.
    """
    cli = r2_client()
    luc = load_station_luc()
    by_short_name = luc['by_short_name']
    by_uuid = luc['by_uuid']

    # UUID → ordered chain of cells (L<coarsest_level> .. LUC).
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
        return _empty_wide_lf()

    # Build the LUC-chain DataFrame once: (station_id, cells).
    luc_df = pl.DataFrame({
        'station_id': list(uuid_cell_chain.keys()),
        'cells': list(uuid_cell_chain.values()),
    }, schema={'station_id': pl.Utf8, 'cells': pl.List(pl.Utf8)})

    # Enumerate minute keys in [block_from, block_to).
    keys: list[str] = []
    cur = block_from
    while cur < block_to:
        date_str = cur.strftime('%Y-%m-%d')
        h, m = cur.hour, cur.minute
        keys.append(f'{SRC_PREFIX}/{date_str}/{h:02d}{m:02d}.parquet')
        cur = cur + timedelta(minutes=1)

    # Parallel fetch each source minute as a Polars DataFrame.
    def _fetch_polars(key: str) -> pl.DataFrame | None:
        tab = read_minute_shard(cli, key)
        if tab is None:
            return None
        # Project to just the columns we need; convert pa.Table → Polars.
        cols_needed = ['station_id', 'dt'] + [f'{m}_sum' for m in AVAIL_METRICS]
        try:
            tab = tab.select(cols_needed)
        except KeyError:
            return None
        return pl.from_arrow(tab)

    with cf.ThreadPoolExecutor(max_workers=fetch_concurrency) as pool:
        minute_dfs = [df for df in pool.map(_fetch_polars, keys) if df is not None]

    if not minute_dfs:
        return _empty_wide_lf()

    # Single Polars frame of all source minutes.
    src = pl.concat(minute_dfs, how='vertical_relaxed')

    # dt in source is unix seconds; convert to ms for the output schema.
    # Also: drop any rows whose station_id isn't in our LUC chain.
    metric_sum_cols = [f'{m}_sum' for m in AVAIL_METRICS]
    joined = (
        src.with_columns((pl.col('dt') * 1000).alias('dt'))
        .join(luc_df, on='station_id', how='inner')
        .explode('cells')
        .rename({'cells': 's2_cell'})
    )

    # Long-form: (s2_cell, dt, metric, state). Drop nulls (any metric not
    # reported by a station for some minute).
    long = (
        joined.unpivot(
            on=metric_sum_cols,
            index=['s2_cell', 'dt'],
            variable_name='metric_col',
            value_name='state',
        )
        .filter(pl.col('state').is_not_null())
        .with_columns(
            # Strip the `_sum` suffix → bare metric name (bikes, ebikes, ...).
            pl.col('metric_col').str.strip_suffix('_sum').alias('metric'),
            # Histogram keys are stringified state values; cast int → str
            # via `state` column.
            pl.col('state').cast(pl.Int64).cast(pl.Utf8).alias('state'),
        )
        .drop('metric_col')
    )

    # Group + count per (cell, dt, metric, state).
    counted = long.group_by(['s2_cell', 'dt', 'metric', 'state']).agg(pl.len().alias('count'))

    # Build a {state: count} dict per (cell, dt, metric) and serialize to JSON.
    per_metric = (
        counted.sort('state')
        .group_by(['s2_cell', 'dt', 'metric'])
        .agg(pl.struct(['state', 'count']).alias('hist_structs'))
        .with_columns(
            pl.col('hist_structs').map_elements(
                _hist_structs_to_json, return_dtype=pl.Utf8,
            ).alias('hist_json')
        )
        .drop('hist_structs')
    )

    # Pivot to wide. pivot is eager.
    wide = per_metric.pivot(
        on='metric',
        index=['s2_cell', 'dt'],
        values='hist_json',
    )

    # Ensure all metric cols exist.
    for m in AVAIL_METRICS:
        if m not in wide.columns:
            wide = wide.with_columns(pl.lit(None, dtype=pl.Utf8).alias(m))

    return wide.select(['s2_cell', 'dt', *AVAIL_METRICS]).lazy()


def _empty_wide_lf() -> pl.LazyFrame:
    return pl.DataFrame(
        schema={
            's2_cell': pl.Utf8,
            'dt': pl.Int64,
            **{m: pl.Utf8 for m in AVAIL_METRICS},
        },
    ).lazy()


def _hist_structs_to_json(structs) -> str:
    """Serialize a Polars Series of `{state, count}` structs to a sorted
    `{state: count}` JSON string. Polars hands one row's list-value over
    as a Series of structs."""
    if structs is None:
        return json.dumps({}, separators=(',', ':'))
    if hasattr(structs, 'to_list'):
        structs = structs.to_list()
    # Each entry is {'state': '5', 'count': 12} (already int-cast state→str).
    d: dict[str, int] = {}
    for s in structs:
        if s is None:
            continue
        state = s.get('state')
        count = s.get('count')
        if state is None or count is None:
            continue
        d[str(state)] = int(count)
    # Sort by integer state for byte-stable diffs.
    d_sorted = dict(sorted(d.items(), key=lambda kv: int(kv[0])))
    return json.dumps(d_sorted, separators=(',', ':'))


# Internal helper kept for back-compat — the orchestrator's `_merge_long`
# imports `_sum_hist_jsons` from this module to fold partials.
def _sum_hist_jsons(jsons) -> dict[str, int]:
    """Combine a list of `{state: count}` JSON strings into one dict.

    Polars passes per-row list values as a Series — materialize via
    `.to_list()`.
    """
    out: dict[str, int] = {}
    if jsons is None:
        return out
    if hasattr(jsons, 'to_list'):
        jsons = jsons.to_list()
    for s in jsons:
        if not s:
            continue
        d = json.loads(s)
        for k, v in d.items():
            if v is None:
                continue
            out[k] = out.get(k, 0) + int(v)
    return dict(sorted(out.items(), key=lambda kv: int(kv[0])))
