"""Build h3-cell-keyed avail shards for pyrmts-geo serving.

Reads existing `avail/agg/{h1,d1,mo1}/<period>.parquet` shards (tall format:
`dt, station_id, metric, state, minutes`) plus the latest station info
(GBFS `info/<date>.json` for lat/lng) and produces wide-JSON shards keyed
by `(h3_cell, dt)` with one histogram column per metric.

Output schema (per `pyrmts-geo`'s expectations — pyrmts time-axis uses ms):

    h3_cell : STRING       e.g. '892a1072117ffff'
    dt      : INT64        bucket-start unix **milliseconds** (pyrmts convention)
    bikes   : STRING       JSON {state_str: minutes}
    ebikes  : STRING       JSON
    docks   : STRING       JSON
    disabled: STRING       JSON
    pending : STRING       JSON

Rows for every materialized resolution live in the SAME shard, sorted by
`(h3_cell, dt)` — h3 cell IDs encode resolution in high bits so the sort
naturally clusters rows by resolution → spatial locality (per pyrmts-geo
shard contract).

Storage key template: `avail-geo/{tier}/{period}.parquet`.
"""
from __future__ import annotations

import json
from collections import defaultdict
from os.path import basename
from typing import Iterator

import h3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from click import argument, option
from utz import err
from utz.cli import flag

from ctbk.cli.base import ctbk

AVAIL_METRICS: tuple[str, ...] = ('bikes', 'ebikes', 'docks', 'disabled', 'pending')

# h3 resolutions to materialize. Finest first (pyrmts convention).
#   res 9 ≈ 174m edge — each station ≈ unique cell (~2,409 stations → ~2,400 cells)
#   res 7 ≈ 1.2km     — neighborhood-ish (~500 cells)
#   res 5 ≈ 8.5km     — borough-ish (~30 cells)
DEFAULT_RESOLUTIONS: tuple[int, ...] = (9, 7, 5)


def load_station_geo(info_path: str) -> dict[str, tuple[float, float]]:
    """Parse `gbfs/info/<date>.json` → {station_id: (lat, lng)}."""
    info = json.load(open(info_path))
    out: dict[str, tuple[float, float]] = {}
    for s in info['data']['stations']:
        sid = s.get('station_id')
        if sid is None: continue
        lat, lng = s.get('lat'), s.get('lon')
        if lat is None or lng is None: continue
        out[sid] = (float(lat), float(lng))
    return out


def build_geo_shard(
    tall: pd.DataFrame,
    station_geo: dict[str, tuple[float, float]],
    resolutions: tuple[int, ...] = DEFAULT_RESOLUTIONS,
) -> pa.Table:
    """Build a wide-JSON h3-keyed table from a tall-format avail shard.

    `tall` columns: dt, station_id, metric, state, minutes.
    Stations not in `station_geo` are dropped (with a warning count).
    """
    missing = sum(1 for s in tall['station_id'].unique() if s not in station_geo)
    if missing:
        err(f"build_geo_shard: dropping rows for {missing} stations missing from station_geo")

    # Pre-compute station → h3_cell at each resolution (saves repeated h3 lookups).
    sids = tall['station_id'].unique()
    station_cells: dict[int, dict[str, str]] = {}  # res → {station_id: cell}
    for res in resolutions:
        m: dict[str, str] = {}
        for sid in sids:
            if sid not in station_geo: continue
            lat, lng = station_geo[sid]
            m[sid] = h3.latlng_to_cell(lat, lng, res)
        station_cells[res] = m

    # Accumulator: (h3_cell, dt, metric) → {state: minutes}
    accum: dict[tuple[str, int, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))

    # One sweep over the tall rows; for each row, add to its h3_cell at every materialized res.
    for sid, dt, metric, state, mins in zip(
        tall['station_id'].values,
        tall['dt'].values,
        tall['metric'].values,
        tall['state'].values,
        tall['minutes'].values,
        strict=True,
    ):
        sid_s = str(sid)
        dt_i = int(dt)
        state_s = str(int(state))
        mins_i = int(mins)
        if mins_i == 0: continue
        for res in resolutions:
            cell = station_cells[res].get(sid_s)
            if cell is None: continue
            accum[(cell, dt_i, str(metric))][state_s] += mins_i

    # Pivot: per (h3_cell, dt) row, one JSON column per metric.
    rows_by_key: dict[tuple[str, int], dict[str, str]] = {}
    for (cell, dt, metric), hist in accum.items():
        key = (cell, dt)
        row = rows_by_key.setdefault(key, {})
        # JSON-encode with sorted keys for byte-reproducibility.
        row[metric] = json.dumps(dict(sorted(hist.items(), key=lambda kv: int(kv[0]))))

    # Build columnar arrays.
    keys = sorted(rows_by_key.keys())  # sort by (cell, dt) — cell sort clusters by resolution
    h3_cell_col = [k[0] for k in keys]
    # Convert dt from unix-seconds (ctbk source convention) to ms (pyrmts convention).
    dt_col = [k[1] * 1000 for k in keys]
    metric_cols: dict[str, list[str | None]] = {m: [] for m in AVAIL_METRICS}
    for k in keys:
        r = rows_by_key[k]
        for m in AVAIL_METRICS:
            metric_cols[m].append(r.get(m))  # missing metrics → None (no observations)

    arrays = [
        pa.array(h3_cell_col, type=pa.string()),
        pa.array(dt_col, type=pa.int64()),
    ]
    names = ['h3_cell', 'dt']
    for m in AVAIL_METRICS:
        arrays.append(pa.array(metric_cols[m], type=pa.string()))
        names.append(m)
    return pa.table(arrays, names=names)


def iter_tall_h1_chunks(parquet_path: str) -> Iterator[pd.DataFrame]:
    """Stream a single h1 shard's tall rows. h1 shards are small enough to
    fit fully in memory (~225K rows × 5 cols × ~24 bytes ≈ 27 MB), but the
    streaming pattern keeps memory bounded if we later move to d1/mo1
    shards (millions of rows)."""
    pf = pq.ParquetFile(parquet_path)
    for batch in pf.iter_batches(batch_size=100_000):
        yield batch.to_pandas()


@ctbk.command('avail-geo-build', help="Build one h3-cell-keyed avail-geo shard from an existing tall avail/agg shard + station info.")
@option('-i', '--input', 'input_path', required=True, help="Tall avail/agg/<tier>/<period>.parquet")
@option('-s', '--station-info', 'info_path', required=True, help="gbfs/info/<date>.json")
@option('-o', '--output', 'output_path', required=True, help="Output avail-geo/<tier>/<period>.parquet")
@option('-r', '--resolution', 'resolutions', multiple=True, type=int, default=DEFAULT_RESOLUTIONS,
        help="h3 resolutions to materialize (finest first). Default: 9,7,5.")
def avail_geo_build(input_path: str, info_path: str, output_path: str, resolutions: tuple[int, ...]):
    """Read tall avail shard + station info → write h3-cell-keyed wide-JSON shard."""
    err(f"Loading station geo from {info_path}")
    station_geo = load_station_geo(info_path)
    err(f"  {len(station_geo)} stations with lat/lng")

    err(f"Reading tall input from {input_path}")
    tall = pd.concat(iter_tall_h1_chunks(input_path), ignore_index=True)
    err(f"  {len(tall):,} rows, {tall['station_id'].nunique()} stations, {tall['dt'].nunique()} dt buckets, {tall['metric'].nunique()} metrics")

    err(f"Building geo shard with resolutions={list(resolutions)}")
    table = build_geo_shard(tall, station_geo, tuple(resolutions))
    err(f"  {table.num_rows:,} output rows ({table.num_rows // tall['dt'].nunique()} rows/bucket × {tall['dt'].nunique()} buckets ≈ Σ_res cells/res × buckets)")

    err(f"Writing to {output_path}")
    # snappy: hyparquet (the CFW parquet reader) supports snappy/gzip/none
    # but not zstd. Snappy is the safe default for fast decode in-worker.
    pq.write_table(table, output_path, compression='snappy')
    sz = pq.ParquetFile(output_path).metadata.serialized_size
    err(f"  wrote ({sz:,} byte footer; total ≈ {open(output_path, 'rb').seek(0, 2)} bytes)")
