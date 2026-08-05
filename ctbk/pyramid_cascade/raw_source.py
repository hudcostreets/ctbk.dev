"""Engine raw-ingest source: base-tier rows from the daily status
parquets (pyrmts `specs/engine-raw-ingest.md`; attribution per
`specs/lu-attribution.md`).

Reads `gbfs/status/<YYYY-MM-DD>.parquet` (the GHA daily compaction — the
canonical raw archive: per-row `ts` = the feed's `last_updated`) and
emits LU-attributed long-form rows, so the engine builds every rung
including `/1m` — no Lambda fan-out phase. The parse hook mirrors
`_fill_hole_raw` (`lambda_exec.py`) except attribution: `dt` comes from
`ts`, never from the WAL key / poll minute.

Coverage: the chassis records a missing day-parquet as a missing tile,
and the engine's strict `max_missing_source` default turns that into a
build error — which doubles as the watermark guard (don't build past the
last compacted day; the tip belongs to the Lambda tick). Missing minutes
*within* a present day are legitimate (upstream skips, jitter, old cron
shed) and simply yield no rows.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from io import BytesIO

import polars as pl

from pyrmts import Pyramid, shard_periods_covering
from pyrmts_engine.source import Tile, TiledSource

DAILY_STATUS_PREFIX = 'gbfs/status'

# Raw status column per pyramid metric — mirrors `AVAIL_METRICS` in
# `gbfs/lib/avail-monoid.ts` (the loader), including its `?? 0`
# null-coalescing.
METRIC_SRC = {
    'bikes': 'num_bikes_available',
    'ebikes': 'num_ebikes_available',
    'docks': 'num_docks_available',
    'disabled': 'num_bikes_disabled',
    'pending': 'num_docks_disabled',
}


class DailyStatusSource(TiledSource):
    """One tile per UTC day. `chains` maps station UUID → key rows
    (frozen-vocab ancestor cells + `s:<short_name>`, or legacy LUC
    chains — whatever `lambda_exec._chains` yields for the config's
    `chains:` mode); stations absent from it are dropped, matching
    `_fill_hole_raw`."""

    def __init__(self, pyramid: Pyramid, chains: dict[str, list[str]]) -> None:
        super().__init__(pyramid)
        self._chains = pl.DataFrame(
            {'station_id': list(chains), 's2_cell': list(chains.values())},
            schema={'station_id': pl.Utf8, 's2_cell': pl.List(pl.Utf8)},
        )

    def tile_at(self, at: datetime) -> Tile:
        p = shard_periods_covering(at, at + timedelta(milliseconds=1), '1d')[0]
        return Tile(key=f'{DAILY_STATUS_PREFIX}/{p.start:%Y-%m-%d}.parquet', period=p)

    def parse(self, blob: bytes, tile: Tile) -> pl.DataFrame:
        df = pl.read_parquet(
            BytesIO(blob), columns=['station_id', 'ts', *METRIC_SRC.values()],
        )
        # One snapshot per (station, LU minute): max-`ts` wins ("state as
        # of end of bin", `specs/lu-attribution.md` § binning model). This
        # also collapses the pre-v2 poller's exact-duplicate re-records
        # (same LU under consecutive poll-minute keys — byte-identical, so
        # which copy survives is immaterial).
        df = (
            df
            .with_columns((pl.col('ts') // 60).alias('_min'))
            .sort('_min', 'station_id', 'ts')
            .unique(subset=['_min', 'station_id'], keep='last', maintain_order=True)
        )
        df = (
            df
            .with_columns((pl.col('_min') * 60_000).alias('dt'))
            .rename({src: m for m, src in METRIC_SRC.items()})
        )
        long = (
            df
            .unpivot(
                index=['station_id', 'dt'],
                on=list(METRIC_SRC),
                variable_name='metric',
                value_name='state',
            )
            .with_columns(pl.col('state').fill_null(0).cast(pl.Int32))
            .join(self._chains, on='station_id', how='inner')
            .explode('s2_cell')
        )
        return (
            long
            .group_by(['s2_cell', 'dt', 'metric', 'state'])
            .agg(pl.len().alias('count'))
        )
