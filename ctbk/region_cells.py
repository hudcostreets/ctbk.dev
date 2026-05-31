"""Precompute h3 cell sets per region (NYC/JC/HOB) for FE region-stacked queries.

Phase 1b of the rides-v1 → homepage migration. The new homepage's
"Stack by Region" needs to fire one /api/rides-v1 call per region; each
call passes its region's h3 cell list as the `cells=` spatial filter.

This subcommand reads a recent normalized parquet (which carries
`Start Station Latitude / Longitude / Region`), buckets stations by
region, computes the h3 cell containing each station at the chosen
resolution, and writes the union per region to a JSON asset.

Default resolution is 7 (~5 km² hexes). At r7 the 3 regions fit in
~150 cells total — URL-bounded, sub-KB payload. r9 would be more
precise at borders but the cell lists balloon to ~5K (URL won't fit).
"""
import json
import sys
from collections import Counter, defaultdict
from glob import glob
from pathlib import Path

import h3
import pyarrow.parquet as pq
from click import argument, option

from ctbk.cli.base import ctbk
from utz import err

DEFAULT_INPUT_GLOB = 's3/ctbk/normalized/20*.parquet'
DEFAULT_OUTPUT = 'www/public/assets/region-cells.json'
DEFAULT_RES = 9

# Normalized parquet uses 'HB' for Hoboken; the FE / static
# `ymrgtb_cd.json` use 'HOB'. Mirror the FE convention in the asset.
REGION_RENAME = {'HB': 'HOB'}


@ctbk.command('region-cells', help="Precompute h3 cells per region (NYC/JC/HOB) for FE region stacking.")
@option('-o', '--output', 'output_path', default=DEFAULT_OUTPUT, help=f'Output JSON path (default: {DEFAULT_OUTPUT}).')
@option('-r', '--resolution', type=int, default=DEFAULT_RES, help=f'h3 resolution (default: {DEFAULT_RES}).')
@argument('inputs', nargs=-1)
def region_cells_cmd(output_path: str, resolution: int, inputs: tuple[str, ...]):
    """Read one or more normalized parquets, bucket stations into h3 cells by region,
    union across all inputs (so stations active in any input month are covered). With
    no INPUTS positional, defaults to `s3/ctbk/normalized/20*.parquet` (all on disk)."""
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
            cell = h3.latlng_to_cell(row.lat, row.lng, resolution)
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
    err(f"cells per region @ r{resolution}: " + ', '.join(f'{r}={len(cs)}' for r, cs in out.items()))
    if contested:
        err(f"  ({contested} cell(s) contested by ≥2 regions; assigned by majority ride count)")

    dst = Path(output_path)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(out, indent=2) + '\n')
    err(f"wrote {dst} ({dst.stat().st_size:,} B)")
