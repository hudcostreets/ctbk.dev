"""Avail-v3 streaming source ingester.

Yields per-hour `avail-v3/1m/YYYY-MM-DD/HH.parquet` shards in time order
for the cascade-streaming engine. These shards are the already-built 1m
base tier (LUC fan-out + per-minute aggregation done upstream by
`ctbk avail-v3-build tier=1m`), so the streaming pass over them is
purely roll-up arithmetic.

Schema per shard:

  s2_cell : Utf8       S2 hex token (varying length: L10..LUC)
  dt      : Int64      bucket-start unix ms (per-minute)
  bikes   : Utf8       histogram JSON `{state_str: count}` (or null)
  ebikes  : Utf8       ditto
  docks   : Utf8       ditto
  disabled: Utf8       ditto
  pending : Utf8       ditto

A ThreadPoolExecutor prefetches the next N hours of source while the
main loop accumulates the current one. Yields `(hour_start_ms, pa.Table)`
in submission (= chronological) order so the engine's period-rollover
invariant holds.
"""
from __future__ import annotations

import concurrent.futures as cf
import io
from datetime import datetime, timedelta
from typing import Iterator

import pyarrow as pa
import pyarrow.parquet as pq

from ctbk.avail_v3 import R2_BUCKET, r2_client


# Source layout: avail-v3/1m/YYYY-MM-DD/HH.parquet (= one hour of 1m-binned
# rows, LUC-exploded). Distinct from the new pyramid-cascade base tier
# definition (which is 1m@1d under avail-v3/...) — we're consuming the
# legacy 1m@1h layout because Task #80 already backfilled it.
SRC_KEY_TMPL = "avail-v3/1m/{date}/{hour:02d}.parquet"


def avail_stream_1m(
    range_from: datetime,
    range_to: datetime,
    *,
    prefetch: int = 16,
) -> Iterator[tuple[int, pa.Table]]:
    """Yield `(hour_start_unix_ms, table)` for each existing avail-v3/1m
    hourly shard in `[range_from, range_to)`, in chronological order.

    Missing shards are silently skipped (the engine handles gaps gracefully).
    """
    cli = r2_client()

    starts: list[datetime] = []
    cur = range_from
    while cur < range_to:
        starts.append(cur)
        cur += timedelta(hours=1)

    keys = [
        SRC_KEY_TMPL.format(date=s.strftime('%Y-%m-%d'), hour=s.hour)
        for s in starts
    ]

    def _fetch(key: str) -> pa.Table | None:
        try:
            obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
        except cli.exceptions.NoSuchKey:
            return None
        except cli.exceptions.ClientError as e:
            if e.response.get('Error', {}).get('Code') in ('NoSuchKey', '404'):
                return None
            raise
        return pq.read_table(io.BytesIO(obj['Body'].read()))

    with cf.ThreadPoolExecutor(max_workers=prefetch) as pool:
        futures = [pool.submit(_fetch, k) for k in keys]
        for s, fut in zip(starts, futures):
            tab = fut.result()
            if tab is None:
                continue
            yield (int(s.timestamp() * 1000), tab)
