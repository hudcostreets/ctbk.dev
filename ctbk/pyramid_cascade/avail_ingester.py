"""Avail-v3 base-tier ingester.

Reads `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` source rows for a
given time range, materializes each station's observations at LUC +
ancestor cells, and returns a Polars LazyFrame in the avail-v3 base-tier
schema:

  s2_cell : Utf8       S2 hex token
  dt      : Int64      bucket-start unix ms
  bikes   : Utf8       histogram JSON {state_str: observation_count}
  ebikes  : Utf8
  docks   : Utf8
  disabled: Utf8
  pending : Utf8

For the /1m base tier, "observation_count" is just 1 per station — the
LUC-ancestor expansion means each station contributes one row per cell
level per minute. Coarser tiers aggregate via the pyramid-cascade
engine.
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import json
from datetime import datetime, timedelta, timezone

import polars as pl
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
    """Avail-v3 1m base-tier ingester.

    Reads all per-minute source shards in `[block_from, block_to)` and
    materializes each station's observations at L<coarsest_level>..LUC.

    Returns a LazyFrame with the avail-v3 base-tier schema. Histograms
    are encoded as JSON strings of `{state: count}` per metric. For the
    base /1m tier each (cell, dt, metric) histogram has count=1 per
    contributing station.

    Internally uses a thread pool to fetch minute shards in parallel
    (R2 I/O bound). The LUC chain per UUID is precomputed once.
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

    # Enumerate minute keys in [block_from, block_to). Source shards are
    # named `gbfs/avail/agg=1m/cons=1m/YYYY-MM-DD/HHMM.parquet`.
    keys: list[str] = []
    cur = block_from
    while cur < block_to:
        date_str = cur.strftime('%Y-%m-%d')
        h, m = cur.hour, cur.minute
        keys.append(f'{SRC_PREFIX}/{date_str}/{h:02d}{m:02d}.parquet')
        cur = cur + timedelta(minutes=1)

    # Parallel fetch + decode. Each call returns a pa.Table or None.
    with cf.ThreadPoolExecutor(max_workers=fetch_concurrency) as pool:
        tables = list(pool.map(lambda k: read_minute_shard(cli, k), keys))

    # Materialize (cell, dt_ms, metric, state) rows for each station in
    # each minute. Polars LazyFrame from a row generator is fine at our
    # scale (~60 minutes × ~2400 stations × ~6 levels × 5 metrics per
    # source hour ≈ 4 M rows).
    rows: list[dict] = []
    missing_sids: set[str] = set()
    for tab in tables:
        if tab is None:
            continue
        cols_needed = ['station_id', 'dt'] + [f'{m}_sum' for m in AVAIL_METRICS]
        d = tab.select(cols_needed).to_pydict()
        sids = d['station_id']
        dts = d['dt']
        metric_vals = {m: d[f'{m}_sum'] for m in AVAIL_METRICS}
        for i, sid in enumerate(sids):
            chain = uuid_cell_chain.get(sid)
            if chain is None:
                missing_sids.add(sid)
                continue
            dt_sec = int(dts[i])
            dt_ms = dt_sec * 1000
            for m in AVAIL_METRICS:
                v = metric_vals[m][i]
                if v is None:
                    continue
                state_s = str(int(v))
                hist_json = json.dumps({state_s: 1}, separators=(',', ':'))
                for cell in chain:
                    rows.append({
                        's2_cell': cell,
                        'dt': dt_ms,
                        'metric': m,
                        'hist_json': hist_json,
                    })

    if not rows:
        # Return empty LazyFrame in the wide schema.
        return pl.DataFrame(
            schema={
                's2_cell': pl.Utf8,
                'dt': pl.Int64,
                **{m: pl.Utf8 for m in AVAIL_METRICS},
            },
        ).lazy()

    # Build wide-schema DataFrame. The cascade engine expects ONE row per
    # (cell, dt) with N metric columns, each containing a histogram JSON.
    # For /1m base, each (cell, dt, metric) has its own row to start; sum
    # across stations contributing to the same (cell, dt, metric, state).
    long_df = pl.DataFrame(rows, schema={
        's2_cell': pl.Utf8,
        'dt': pl.Int64,
        'metric': pl.Utf8,
        'hist_json': pl.Utf8,
    })

    # Combine histograms per (cell, dt, metric) — when N stations land in
    # the same cell at the same minute for the same metric, sum their
    # observations per state. We keep `hist_json` as a Utf8 string
    # throughout (Polars can't pl.Struct an arbitrary-keys JSON object)
    # and merge in Python via map_elements.
    combined = (
        long_df
        .group_by(['s2_cell', 'dt', 'metric'])
        .agg(pl.col('hist_json').alias('hist_jsons'))
        .with_columns(
            pl.col('hist_jsons').map_elements(
                lambda jsons: json.dumps(
                    _sum_hist_jsons(jsons), separators=(',', ':')
                ),
                return_dtype=pl.Utf8,
            ).alias('hist_json')
        )
        .drop('hist_jsons')
    )

    # Pivot to wide: (cell, dt) → row with N hist_json metric cols.
    wide = combined.pivot(
        on='metric',
        index=['s2_cell', 'dt'],
        values='hist_json',
    )
    # Make sure every metric col exists in the right order.
    for m in AVAIL_METRICS:
        if m not in wide.columns:
            wide = wide.with_columns(pl.lit(None, dtype=pl.Utf8).alias(m))
    wide = wide.select(['s2_cell', 'dt', *AVAIL_METRICS])
    return wide.lazy()


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
    # Sort by integer state for byte-stable diffs.
    return dict(sorted(out.items(), key=lambda kv: int(kv[0])))
