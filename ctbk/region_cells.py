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
from pathlib import Path

import h3
import pyarrow.parquet as pq
from click import option

from ctbk.cli.base import ctbk
from utz import err

DEFAULT_INPUT = 's3/ctbk/normalized/202604.parquet'
DEFAULT_OUTPUT = 'www/public/assets/region-cells.json'
DEFAULT_RES = 9

# Normalized parquet uses 'HB' for Hoboken; the FE / static
# `ymrgtb_cd.json` use 'HOB'. Mirror the FE convention in the asset.
REGION_RENAME = {'HB': 'HOB'}


@ctbk.command('region-cells', help="Precompute h3 cells per region (NYC/JC/HOB) for FE region stacking.")
@option('-i', '--input', 'input_path', default=DEFAULT_INPUT, help=f'Normalized parquet to read (default: {DEFAULT_INPUT}).')
@option('-o', '--output', 'output_path', default=DEFAULT_OUTPUT, help=f'Output JSON path (default: {DEFAULT_OUTPUT}).')
@option('-r', '--resolution', type=int, default=DEFAULT_RES, help=f'h3 resolution (default: {DEFAULT_RES}).')
def region_cells_cmd(input_path: str, output_path: str, resolution: int):
    src = Path(input_path)
    if not src.exists():
        err(f"input not found: {src}")
        sys.exit(1)

    err(f"reading {src} (cols: Start Station Latitude/Longitude/Region)…")
    t = pq.read_table(src, columns=['Start Station Latitude', 'Start Station Longitude', 'Start Region'])
    df = t.to_pandas().rename(columns={
        'Start Station Latitude': 'lat',
        'Start Station Longitude': 'lng',
        'Start Region': 'region',
    }).dropna(subset=['lat', 'lng', 'region'])

    # Each ride is one signal. Count how many rides land each (cell, region)
    # tuple; assign each cell to the region holding the most rides in it.
    # Prevents a border cell from being claimed by 2+ regions (which would
    # double-count rides at region-stacked queries downstream).
    cell_region_counts: dict[str, Counter] = defaultdict(Counter)
    for row in df.itertuples(index=False):
        cell = h3.latlng_to_cell(row.lat, row.lng, resolution)
        region = REGION_RENAME.get(row.region, row.region)
        cell_region_counts[cell][region] += 1

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
