"""Build the `neighborhoods.json` www asset: named multi-station sets with polygons.

Sources (fetched with a local cache under `tmp/nbhd/`):
- NYC: 2020 Neighborhood Tabulation Areas (NTAs), NYC Open Data `9nt8-h7nd`
  (262 polygons; partition of the city incl. park/special NTAs).
- JC: "Jersey City Neighborhoods" from data.jerseycitynj.gov (53 polygons,
  neighborhood-association level: Hamilton Park, Harsimus Cove, Van Vorst
  Park, ...), grouped into 6 `area`s (Downtown, Journal Square, ...).

Each source polygon becomes a selectable "set" for `/cells-debug`:
`{id, name, group, region, stations: [short_name...], polys}` where
`polys` is `[[ [lat,lng]... ] ...]` per polygon (outer ring + holes) —
Leaflet `Polygon`-ready. Stations are assigned by even-odd point-in-polygon
against the *unsimplified* rings, with a nearest-edge fallback (piers and
waterfront docks often sit just outside land polygons); polygons are then
Douglas-Peucker-simplified for the asset. Only sets with ≥1 station ship.
"""
import json
import sys
import urllib.request
from math import cos, radians
from pathlib import Path

from click import option

from ctbk.cli.base import ctbk
from utz import err

SOURCES = {
    'nta': 'https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=300',
    'jc': 'https://data.jerseycitynj.gov/api/explore/v2.1/catalog/datasets/jersey-city-neighborhoods/exports/geojson',
}

# Fix well-known typos in the JC source data.
JC_NAME_FIXES = {
    'Palus Hook': 'Paulus Hook',
    'Resorvior': 'Reservoir',
    'St.Joes': "St. Joe's",
}

# Stations within this distance of a set's boundary get assigned to it when
# strict point-in-polygon leaves them orphaned (piers, waterfront docks).
FALLBACK_M = 250

Ring = list[tuple[float, float]]  # [(lat, lng), ...]


def fetch(url: str, cache: Path) -> dict:
    if not cache.exists():
        err(f"fetching {url} → {cache}")
        cache.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'ctbk.dev asset builder'})
        with urllib.request.urlopen(req) as r:
            cache.write_bytes(r.read())
    return json.loads(cache.read_text())


def geom_rings(geom: dict) -> list[list[Ring]]:
    """GeoJSON geometry → per-polygon ring lists, coords flipped to (lat, lng)."""
    if geom['type'] == 'Polygon':
        polys = [geom['coordinates']]
    elif geom['type'] == 'MultiPolygon':
        polys = geom['coordinates']
    else:
        raise ValueError(f"unsupported geometry type {geom['type']!r}")
    return [[[(lat, lng) for lng, lat in ring] for ring in poly] for poly in polys]


def point_in_rings(lat: float, lng: float, polys: list[list[Ring]]) -> bool:
    """Even-odd ray cast across ALL rings (outer + holes together)."""
    inside = False
    for poly in polys:
        for ring in poly:
            j = len(ring) - 1
            for i in range(len(ring)):
                (yi, xi), (yj, xj) = ring[i], ring[j]
                if (xi > lng) != (xj > lng) and lat < (yj - yi) * (lng - xi) / (xj - xi) + yi:
                    inside = not inside
                j = i
    return inside


def dist_to_rings_m(lat: float, lng: float, polys: list[list[Ring]]) -> float:
    """Min distance (meters) from a point to any ring segment, equirectangular."""
    kx = 111320.0 * cos(radians(lat))
    ky = 110540.0
    best = float('inf')
    for poly in polys:
        for ring in poly:
            j = len(ring) - 1
            for i in range(len(ring)):
                (ay, ax), (by, bx) = ring[j], ring[i]
                dx, dy = (bx - ax) * kx, (by - ay) * ky
                px, py = (lng - ax) * kx, (lat - ay) * ky
                d2 = dx * dx + dy * dy
                t = 0.0 if d2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / d2))
                ex, ey = px - t * dx, py - t * dy
                best = min(best, (ex * ex + ey * ey) ** 0.5)
                j = i
    return best


def simplify_ring(ring: Ring, tol: float) -> Ring:
    """Douglas-Peucker in degree space; keeps ring closed, ≥4 points."""
    if len(ring) <= 4:
        return ring
    closed = ring[0] == ring[-1]
    pts = ring[:-1] if closed else ring
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True

    def seg_dist(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        (py, px), (ay, ax), (by, bx) = p, a, b
        dx, dy = bx - ax, by - ay
        d2 = dx * dx + dy * dy
        t = 0.0 if d2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / d2))
        ex, ey = px - ax - t * dx, py - ay - t * dy
        return (ex * ex + ey * ey) ** 0.5

    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        dmax, imax = -1.0, -1
        for i in range(lo + 1, hi):
            d = seg_dist(pts[i], pts[lo], pts[hi])
            if d > dmax:
                dmax, imax = d, i
        if dmax > tol:
            keep[imax] = True
            stack.append((lo, imax))
            stack.append((imax, hi))
    out = [p for p, k in zip(pts, keep) if k]
    if len(out) < 3:
        out = pts[:: max(1, len(pts) // 4)][:4]
    if closed:
        out = out + [out[0]]
    return out


def slug(s: str) -> str:
    return ''.join(c if c.isalnum() else '-' for c in s.lower()).strip('-').replace('--', '-')


# Manhattan's 60th St, as a line in (lng → lat). Manhattan's grid is rotated
# ~29° so a constant-latitude cut is wrong by ~1.5km across the island's
# width; this is fit through York Ave & 60th and 11th Ave & 60th, and checks
# out at Lexington (40.7630 vs 40.7625 actual), 5th (40.7653 vs 40.7644) and
# Columbus Circle (59th St, correctly just inside).
CRZ_LNG0, CRZ_LAT0, CRZ_SLOPE = -73.9585, 40.7594, -0.4125
# Governors/Ellis/Liberty Islands are Manhattan borough (they share an NTA
# with the Battery) but sit outside the zone — ferry-only, no tolled entry.
# The Battery's own docks are ≥40.701; the islands are ≤40.693.
CRZ_LAT_MIN = 40.698


def crz_contains(lat: float, lng: float) -> bool:
    """Inside the Congestion Relief Zone: Manhattan south of 60th St."""
    return CRZ_LAT_MIN < lat < CRZ_LAT0 + (lng - CRZ_LNG0) * CRZ_SLOPE


def composite_sets(out_sets: list[dict], stations: dict) -> list[dict]:
    """Derived sets that OVERLAP the source partition, so they're built from
    already-assigned members rather than competing for stations in the
    first-hit PIP loop.

    `Manhattan CBD` = the congestion-pricing zone (Manhattan below 60th St).
    Notable for `/cells-debug` as the worst realistic case for vocab-cover
    size: long, skinny, and dense, so its boundary clips many vocab cells and
    descends to per-station leaves along both waterfronts (~47 cover terms
    for ~520 stations, vs 5 for compact Jersey City).
    """
    members, polys = [], []
    for s in out_sets:
        if s['region'] != 'NYC' or s['group'] != 'Manhattan':
            continue
        inside = [sid for sid in s['stations'] if crz_contains(stations[sid]['lat'], stations[sid]['lng'])]
        if not inside:
            continue
        members.extend(inside)
        # Show the constituent NTAs; the 60th St cut is a station-level
        # predicate, so an NTA straddling it contributes its whole outline.
        polys.extend(s['polys'])
    if not members:
        return []
    return [{
        'id': 'composite/manhattan-cbd',
        'name': 'Manhattan CBD (congestion zone)',
        'group': 'Composite',
        'region': 'NYC',
        'stations': sorted(members),
        'polys': polys,
    }]


@ctbk.command('neighborhoods', help="Build `neighborhoods.json` (NYC NTA + JC neighborhood station-sets) for `/cells-debug`.")
@option('-c', '--cache-dir', default='tmp/nbhd', help='Raw source GeoJSON cache dir (default tmp/nbhd).')
@option('-o', '--output', 'output_path', default='www/public/assets/neighborhoods.json', help='Output JSON path.')
@option('-s', '--stations', 'stations_path', default='www/public/assets/stations-regional.json', help='Stations asset (id → {lat,lng,region}).')
@option('-t', '--tolerance', default=2e-4, help='Douglas-Peucker simplify tolerance in degrees (default 2e-4 ≈ 20m).')
def neighborhoods_cmd(cache_dir: str, output_path: str, stations_path: str, tolerance: float):
    cache = Path(cache_dir)
    stations = json.loads(Path(stations_path).read_text())

    raw_sets: list[dict] = []  # {id, name, group, region, polys(full-res)}
    nta = fetch(SOURCES['nta'], cache / 'nta2020.geojson')
    for f in nta['features']:
        p = f['properties']
        raw_sets.append({
            'id': f"nta/{p['nta2020']}",
            'name': p['ntaname'],
            'group': p['boroname'],
            'region': 'NYC',
            'polys': geom_rings(f['geometry']),
        })
    jc = fetch(SOURCES['jc'], cache / 'jc-nbhd.geojson')
    for f in jc['features']:
        p = f['properties']
        name = JC_NAME_FIXES.get(p['neighborho'], p['neighborho'])
        raw_sets.append({
            'id': f"jc/{slug(p['area'])}/{slug(name)}",
            'name': name,
            'group': p['area'],
            'region': 'JC',
            'polys': geom_rings(f['geometry']),
        })
    err(f"{len(raw_sets)} source polygons (NTA {len(nta['features'])} + JC {len(jc['features'])})")

    # Precompute bboxes for the PIP prefilter.
    for s in raw_sets:
        lats = [lat for poly in s['polys'] for ring in poly for lat, _ in ring]
        lngs = [lng for poly in s['polys'] for ring in poly for _, lng in ring]
        s['bbox'] = (min(lats), min(lngs), max(lats), max(lngs))

    # Assign stations: strict PIP first, then nearest-edge fallback (≤ FALLBACK_M).
    by_set: dict[str, list[str]] = {s['id']: [] for s in raw_sets}
    unassigned: list[tuple[str, dict]] = []
    pad = FALLBACK_M / 111000
    for sid, st in stations.items():
        lat, lng, region = st['lat'], st['lng'], st['region']
        hit = False
        for s in raw_sets:
            if s['region'] != region:
                continue
            b = s['bbox']
            if not (b[0] <= lat <= b[2] and b[1] <= lng <= b[3]):
                continue
            if point_in_rings(lat, lng, s['polys']):
                by_set[s['id']].append(sid)
                hit = True
                break
        if not hit:
            unassigned.append((sid, st))
    fell_back = 0
    for sid, st in unassigned:
        lat, lng, region = st['lat'], st['lng'], st['region']
        best_d, best_id = float('inf'), None
        for s in raw_sets:
            if s['region'] != region:
                continue
            b = s['bbox']
            if not (b[0] - pad <= lat <= b[2] + pad and b[1] - pad <= lng <= b[3] + pad):
                continue
            d = dist_to_rings_m(lat, lng, s['polys'])
            if d < best_d:
                best_d, best_id = d, s['id']
        if best_id is not None and best_d <= FALLBACK_M:
            by_set[best_id].append(sid)
            fell_back += 1
    n_assigned = sum(len(v) for v in by_set.values())
    err(f"assigned {n_assigned}/{len(stations)} stations ({fell_back} via ≤{FALLBACK_M}m edge fallback; "
        f"{len(stations) - n_assigned} unassigned)")

    out_sets = []
    for s in raw_sets:
        members = sorted(by_set[s['id']])
        if not members:
            continue
        polys = [
            [[(round(lat, 5), round(lng, 5)) for lat, lng in simplify_ring(ring, tolerance)] for ring in poly]
            for poly in s['polys']
        ]
        out_sets.append({
            'id': s['id'],
            'name': s['name'],
            'group': s['group'],
            'region': s['region'],
            'stations': members,
            'polys': polys,
        })
    err(f"{len(out_sets)} sets with ≥1 station "
        f"(dropped {len(raw_sets) - len(out_sets)} station-less source polygons)")
    composites = composite_sets(out_sets, stations)
    out_sets.extend(composites)
    out_sets.sort(key=lambda s: (s['region'], s['group'], s['name']))
    for c in composites:
        err(f"+ composite {c['id']}: {len(c['stations'])} stations")

    dst = Path(output_path)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({'sources': SOURCES, 'sets': out_sets}, separators=(',', ':')) + '\n')
    err(f"wrote {dst} ({dst.stat().st_size:,} B)")
    sys.exit(0)
