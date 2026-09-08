"""Engine raw-ingest source for the `smg-v1` pyramid (`specs/avail-smg-pyramid.md`):
station-minute state histograms.

Reads `gbfs/smg/<YYYY-MM-DD>.parquet` — one row per (live station, UTC wall-minute)
with two categorical columns, `state` (raw) and `state_ff` (nullish minutes
forward-filled), written by `ctbk gbfs smg build` / `ctbk gbfs empty build` from the
daily status parquet + cron heartbeats — and emits long-form histogram rows
`(s2_cell, dt, metric, state, count)`: for each metric, the histogram over state ids
*is* the per-state station-minute count. Same `TiledSource` contract as
`DailyStatusSource` (`raw_source.py`): one tile per UTC day, `chains` = frozen-vocab
ancestor cells + `s:<short_name>` identity keys per station.

A missing day parquet is a missing tile (strict `max_missing_source` ⇒ build error),
which doubles as the watermark guard: don't build past the last day the daily job
has classified.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from io import BytesIO

import polars as pl

from pyrmts import Pyramid, shard_periods_covering
from pyrmts_engine.source import Tile, TiledSource

SMG_PREFIX = 'gbfs/smg'
SMG_METRICS = ('state', 'state_ff')


class SmgDailySource(TiledSource):
    def __init__(self, pyramid: Pyramid, chains: dict[str, list[str]]) -> None:
        super().__init__(pyramid)
        self._chains = pl.DataFrame(
            {'station_id': list(chains), 's2_cell': list(chains.values())},
            schema={'station_id': pl.Utf8, 's2_cell': pl.List(pl.Utf8)},
        )

    def tile_at(self, at: datetime) -> Tile:
        p = shard_periods_covering(at, at + timedelta(milliseconds=1), '1d')[0]
        return Tile(key=f'{SMG_PREFIX}/{p.start:%Y-%m-%d}.parquet', period=p)

    def parse(self, blob: bytes, tile: Tile) -> pl.DataFrame:
        df = pl.read_parquet(BytesIO(blob), columns=['station_id', 'dt', *SMG_METRICS])
        # `value_name` must NOT be one of the `on` columns: the source columns
        # are literally `state`/`state_ff`, so unpivoting them into a value
        # column also named `state` collides — polars ≥ 1.44 raises
        # `DuplicateError` (1.41 tolerated it, which is why this slipped
        # through until the base image drifted to 1.44). Unpivot to a temp
        # name, then rename to the long-form `state` (the histogram bucket id).
        long = (
            df
            .unpivot(index=['station_id', 'dt'], on=list(SMG_METRICS), variable_name='metric', value_name='_state')
            .with_columns(pl.col('_state').cast(pl.Int32).alias('state'))
            .drop('_state')
            .join(self._chains, on='station_id', how='inner')
            .explode('s2_cell')
        )
        return long.group_by(['s2_cell', 'dt', 'metric', 'state']).agg(pl.len().alias('count'))
