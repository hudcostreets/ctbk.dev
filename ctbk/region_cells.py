"""Precompute spatial cell sets per region (NYC/JC/HOB) for FE region-stacked queries.

Phase 1b of the rides-v1 → homepage migration. The new homepage's
"Stack by Region" needs to fire one /api/rides-v{1,2,3} call per region;
each call passes its region's cell list as the `cells=` spatial filter.

This subcommand reads a recent normalized parquet (which carries
`Start Station Latitude / Longitude / Region`), buckets stations by
region, computes the cell containing each station at the chosen
resolution/level, and writes the union per region to a JSON asset.

Supports H3 (default) and S2 indexes. Output goes to
`region-cells.json` for h3, `region-cells-s2.json` for s2 — separate
files keep the FE load path simple (one file per pyramid variant).

Default h3 resolution is 7 (~5 km² hexes); default s2 level is 11
(~20 km²). At those granularities the 3 regions fit in ~150 cells
total — URL-bounded, sub-KB payload. Finer levels balloon to ~5K
cells (URL won't fit); exact-parity coverage needs `minimalCover`,
deferred — single-level cells produce mild border bleed (~few %).
"""
import json
import sys
from collections import Counter, defaultdict
from glob import glob
from pathlib import Path
from typing import Literal

import h3
import pyarrow.parquet as pq
from click import BadParameter, argument, option

from ctbk.cli.base import ctbk
from utz import err

DEFAULT_INPUT_GLOB = 's3/ctbk/normalized/20*.parquet'

Index = Literal['h3', 's2']
INDEXES: tuple[Index, ...] = ('h3', 's2')

# Per-index defaults: chosen so the 3 regions fit in ~50-150 cells each.
DEFAULT_LEVEL_BY_INDEX: dict[Index, int] = {
    'h3': 7,    # ~5 km² hexes
    's2': 11,   # ~20 km² quads
}
DEFAULT_OUTPUT_BY_INDEX: dict[Index, str] = {
    'h3': 'www/public/assets/region-cells.json',
    's2': 'www/public/assets/region-cells-s2.json',
}

# Normalized parquet uses 'HB' for Hoboken; the FE / static
# `ymrgtb_cd.json` use 'HOB'. Mirror the FE convention in the asset.
REGION_RENAME = {'HB': 'HOB'}


def latlng_to_cell(index: Index, lat: float, lng: float, level: int) -> str:
    if index == 'h3':
        return h3.latlng_to_cell(lat, lng, level)
    if index == 's2':
        import s2cell
        return s2cell.lat_lon_to_token(lat, lng, level)
    raise BadParameter(f"unknown --index {index!r}; known: {INDEXES}")


@ctbk.command('region-cells', help="Precompute cells per region (NYC/JC/HOB) for FE region stacking.")
@option('-i', '--index', type=str, default='h3', help=f'Spatial index; one of {list(INDEXES)} (default h3).')
@option('-l', '--level', type=int, default=None, help='Cell level (h3 res 0-15 / s2 level 0-30). Default per index.')
@option('-o', '--output', 'output_path', default=None, help='Output JSON path; default depends on --index.')
@argument('inputs', nargs=-1)
def region_cells_cmd(index: str, level: int | None, output_path: str | None, inputs: tuple[str, ...]):
    """Read one or more normalized parquets, bucket stations into cells by region,
    union across all inputs (so stations active in any input month are covered). With
    no INPUTS positional, defaults to `s3/ctbk/normalized/20*.parquet` (all on disk)."""
    if index not in INDEXES:
        raise BadParameter(f"unknown --index {index!r}; known: {list(INDEXES)}")
    idx: Index = index  # type: ignore[assignment]
    if level is None:
        level = DEFAULT_LEVEL_BY_INDEX[idx]
    if output_path is None:
        output_path = DEFAULT_OUTPUT_BY_INDEX[idx]
    if not inputs:
        inputs = tuple(sorted(glob(DEFAULT_INPUT_GLOB)))
        if not inputs:
            err(f"no parquets matching {DEFAULT_INPUT_GLOB}")
            sys.exit(1)
    err(f"reading {len(inputs)} parquet(s): {inputs[0]} .. {inputs[-1]}")

    # `(cell, region) -> ride count` across all inputs. Each ride is one
    # signal; sum signals so a cell sees the same denominator regardless of
    # how many months it appears in.
    cell_region_counts: dict[str, Counter] = defaultdict(Counter)
    for ipath in inputs:
        src = Path(ipath)
        if not src.exists():
            err(f"  skip (not found): {src}")
            continue
        t = pq.read_table(src, columns=['Start Station Latitude', 'Start Station Longitude', 'Start Region'])
        df = t.to_pandas().rename(columns={
            'Start Station Latitude': 'lat',
            'Start Station Longitude': 'lng',
            'Start Region': 'region',
        }).dropna(subset=['lat', 'lng', 'region'])
        for row in df.itertuples(index=False):
            cell = latlng_to_cell(idx, row.lat, row.lng, level)
            region = REGION_RENAME.get(row.region, row.region)
            cell_region_counts[cell][region] += 1
        err(f"  {src.name}: {len(df):,} rides → {len(cell_region_counts):,} unique cells cumulative")

    # Border cells (claimed by ≥2 regions because hexes can straddle the
    # NYC/JC border etc.): assign to the region with the most rides in
    # the cell. Avoids double-counting in region-stacked downstream queries.
    by_region: dict[str, set[str]] = defaultdict(set)
    contested = 0
    for cell, counts in cell_region_counts.items():
        if len(counts) > 1:
            contested += 1
        winner = counts.most_common(1)[0][0]
        by_region[winner].add(cell)

    out = {r: sorted(by_region[r]) for r in sorted(by_region)}
    err(f"cells per region [{idx} @ lvl {level}]: " + ', '.join(f'{r}={len(cs)}' for r, cs in out.items()))
    if contested:
        err(f"  ({contested} cell(s) contested by ≥2 regions; assigned by majority ride count)")

    dst = Path(output_path)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, indent=2) + '\n')
    err(f"wrote {dst} ({dst.stat().st_size:,} B)")


@ctbk.command('stations-regional', help="Dump {station_id: {lat,lng,region,name?}} for `/cells-debug` viz.")
@option('-o', '--output', 'output_path', default='www/public/assets/stations-regional.json',
        help='Output JSON path.')
@argument('inputs', nargs=-1)
def stations_regional_cmd(output_path: str, inputs: tuple[str, ...]):
    """Read normalized parquets, dedup stations by (Start Station ID), tag each with
    its majority region. Used by the cells-debug page to visualize covers vs stations.

    Output: `{ station_id: { lat, lng, region, name? } }`. Uses majority-vote on
    region for stations appearing in multiple regions across months."""
    if not inputs:
        inputs = tuple(sorted(glob(DEFAULT_INPUT_GLOB)))
        if not inputs:
            err(f"no parquets matching {DEFAULT_INPUT_GLOB}")
            sys.exit(1)
    err(f"reading {len(inputs)} parquet(s): {inputs[0]} .. {inputs[-1]}")

    # `station_id -> { (lat, lng, region) -> ride_count }`. After all inputs,
    # pick most-common (lat, lng, region) per station.
    obs: dict[str, Counter] = defaultdict(Counter)
    name_obs: dict[str, Counter] = defaultdict(Counter)
    cols = [
        'Start Station ID', 'Start Station Name',
        'Start Station Latitude', 'Start Station Longitude', 'Start Region',
    ]
    for ipath in inputs:
        src = Path(ipath)
        if not src.exists():
            err(f"  skip (not found): {src}")
            continue
        t = pq.read_table(src, columns=cols)
        df = t.to_pandas().rename(columns={
            'Start Station ID': 'id',
            'Start Station Name': 'name',
            'Start Station Latitude': 'lat',
            'Start Station Longitude': 'lng',
            'Start Region': 'region',
        }).dropna(subset=['id', 'lat', 'lng', 'region'])
        for row in df.itertuples(index=False):
            sid = str(row.id)
            region = REGION_RENAME.get(row.region, row.region)
            obs[sid][(round(row.lat, 6), round(row.lng, 6), region)] += 1
            if isinstance(row.name, str) and row.name:
                name_obs[sid][row.name] += 1
        err(f"  {src.name}: {len(df):,} rides → {len(obs):,} unique stations cumulative")

    out: dict[str, dict] = {}
    for sid, c in obs.items():
        (lat, lng, region), _ = c.most_common(1)[0]
        entry: dict = {'lat': lat, 'lng': lng, 'region': region}
        if sid in name_obs:
            entry['name'] = name_obs[sid].most_common(1)[0][0]
        out[sid] = entry

    by_region = Counter(e['region'] for e in out.values())
    err("stations per region: " + ', '.join(f'{r}={n}' for r, n in by_region.most_common()))
    dst = Path(output_path)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, indent=2) + '\n')
    err(f"wrote {dst} ({dst.stat().st_size:,} B)")
