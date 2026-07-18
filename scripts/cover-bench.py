#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["click", "s2cell", "shapely"]
# ///
"""Cover-cardinality benchmark for `specs/drop-luc-station-keys.md`.

Builds the ragged station-containment graph (descend while a cell holds
more than T stations; leaves are station IDs), runs the optimal pos/neg
cover DP for every polygon in a geojson gallery (e.g. NYC NTA 2020
neighborhoods), and reports per-region ± term counts per candidate T —
the tradeoff data for choosing the ragged level-upper-bound.

    scripts/cover-bench.py -r tmp/station-luc-e.json -g tmp/nta2020.geojson
"""
import json
import sys
from collections import defaultdict
from functools import partial
from statistics import mean, quantiles

import s2cell
from click import command, option
from shapely.geometry import Point, shape
from shapely.prepared import prep

err = partial(print, file=sys.stderr)

BASE_LEVEL = 10
MAX_LEVEL = 20


def build_graph(stations: dict[str, tuple[float, float]], t: int):
    """Ragged containment graph. Returns `(roots, children)` where
    `children[token] -> [child tokens]`; station leaves are `s:<name>`."""
    children: dict[str, list[str]] = {}

    def recurse(cells: dict[str, list[str]], lvl: int) -> None:
        nxt: dict[str, list[str]] = defaultdict(list)
        for tok, sns in cells.items():
            if len(sns) <= t or lvl >= MAX_LEVEL:
                children[tok] = [f's:{sn}' for sn in sns]
            else:
                kids = defaultdict(list)
                for sn in sns:
                    lat, lng = stations[sn]
                    kids[s2cell.lat_lon_to_token(lat, lng, lvl + 1)].append(sn)
                children[tok] = list(kids)
                for ktok, ksns in kids.items():
                    nxt[ktok] = ksns
        if nxt:
            recurse(nxt, lvl + 1)

    base: dict[str, list[str]] = defaultdict(list)
    for sn, (lat, lng) in stations.items():
        base[s2cell.lat_lon_to_token(lat, lng, BASE_LEVEL)].append(sn)
    recurse(dict(base), BASE_LEVEL)
    return list(base), children


def cover_terms(roots: list[str], children: dict[str, list[str]], in_set: set[str]) -> int:
    """Optimal ± term count expressing `in_set` (station leaf ids) over
    the vocabulary — linear two-function DP on the containment graph."""
    pos: dict[str, int] = {}
    neg: dict[str, int] = {}

    def visit(node: str) -> None:
        if node.startswith('s:'):
            inside = node in in_set
            pos[node], neg[node] = (1, 0) if inside else (0, 1)
            return
        kids = children[node]
        for k in kids:
            visit(k)
        sum_pos = sum(pos[k] for k in kids)
        sum_neg = sum(neg[k] for k in kids)
        # `node − complement` / `complement of (node − set)` forms use the
        # CHILDREN's opposite-function sums (not this node's own value,
        # which would be circular).
        pos[node] = min(sum_pos, 1 + sum_neg)
        neg[node] = min(sum_neg, 1 + sum_pos)

    total = 0
    for r in roots:
        visit(r)
        total += pos[r]
    return total


@command()
@option('-g', '--gallery', required=True, help='Geojson of polygons (e.g. NTA 2020).')
@option('-n', '--name-prop', default='ntaname', show_default=True, help='Feature property to label regions by.')
@option('-r', '--registry', required=True, help='Station registry json (by_short_name -> {lat, lng}).')
@option('-T', '--thresholds', default='2,4,8', show_default=True, help='Comma-separated leaf-occupancy thresholds to compare.')
def main(gallery: str, name_prop: str, registry: str, thresholds: str) -> None:
    reg = json.load(open(registry))['by_short_name']
    stations = {sn: (e['lat'], e['lng']) for sn, e in reg.items()}
    feats = json.load(open(gallery))['features']

    region_sets: list[tuple[str, set[str]]] = []
    for f in feats:
        poly = prep(shape(f['geometry']))
        sns = {f's:{sn}' for sn, (lat, lng) in stations.items() if poly.contains(Point(lng, lat))}
        if sns:
            region_sets.append((f['properties'][name_prop], sns))
    err(f'{len(region_sets)} regions with ≥1 station (of {len(feats)})')

    for t in (int(x) for x in thresholds.split(',')):
        roots, children = build_graph(stations, t)
        n_cells = len(children)
        terms = [(name, cover_terms(roots, children, sns), len(sns)) for name, sns in region_sets]
        counts = [c for _, c, _ in terms]
        q = quantiles(counts, n=100)
        worst = max(terms, key=lambda x: x[1])
        print(f'T={t}: vocab={n_cells} cells (+{len(stations)} ids) | terms/region: '
              f'mean={mean(counts):.1f} p50={q[49]:.0f} p95={q[94]:.0f} max={worst[1]} '
              f'({worst[0]!r}, {worst[2]} stations)')


if __name__ == '__main__':
    main()
