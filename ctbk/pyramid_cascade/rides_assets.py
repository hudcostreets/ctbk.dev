"""Local composition of `MonthlyRidesSource` inputs (`specs/rides-v5.md`).

Laptop-side counterpart of the Batch factory (`gbfs/engine/
ctbk_engine_src.py::rides_{start,end}`): chains from the frozen vocab +
station registry, the canonical station-id map, the distilled geo
lookup, and a local-filesystem tile fetch over the DVC mirror
(`s3/ctbk/normalized/`).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .rides_source import station_positions
from .vocab import load_vocab, station_chain

REPO = Path(__file__).parents[2]
CONFIG_DIR = REPO / 'configs' / 'pyramids'
VOCAB_PATH = CONFIG_DIR / 'station-vocab.json'
STATION_LUC_PATH = REPO / 'www' / 'public' / 'assets' / 'station-luc.json'
ID_MAP_PATH = REPO / 's3' / 'ctbk' / 'stations' / 'station-id-map.json'
CANONICALIZE_MAP_PATH = REPO / 's3' / 'ctbk' / 'stations' / 'station-canonicalize-map.json'
EXTRA_STATIONS_PATH = REPO / 's3' / 'ctbk' / 'stations' / 'rides-extra-stations.json'
# Leaf-cell level for extra stations' `cell` (the api's vocab graph hangs a
# leaf under the nearest vocab ancestor of its cell; any fine level works).
EXTRA_CELL_LEVEL = 20
NORMALIZED_DIR = REPO / 's3' / 'ctbk' / 'normalized'
GEO_JSON_PATH = REPO / 'gbfs' / 'engine' / 'station-geo.json'


def effective_canonical() -> dict[str, str]:
    """Every raw reported station id → its effective canonical short_name:
    the harmonize `station-id-map.json` composed with the luc `merged` overlay
    (`merged.get(canon, canon)`). This is exactly the resolution
    `MonthlyRidesSource` uses to pick a station's coarse S2 cells, so a
    `c:<canonical>` rollup keyed off it lines up 1:1 with the coarse rows."""
    idm = json.loads(ID_MAP_PATH.read_text())
    merged = json.loads(STATION_LUC_PATH.read_text()).get('merged', {})
    return {sid: merged.get(canon, canon) for sid, canon in idm.items()}


def cluster_canonicalize_map(eff: dict[str, str]) -> dict[str, str]:
    """Pure rule: `{raw_id: canonical}` → `{s:<raw>: c:<canonical>}` over
    *merged* clusters only, sorted.

    Group raw ids by canonical and emit an entry for **every** member of a
    cluster with >1 raw id — including the member whose raw id equals the
    canonical, since its own `s:<canonical>` leaf is a real ingest leaf that
    must fold into the `c:` row (dropping it would undercount the canonical).
    A singleton (its own sole member) is omitted: no merge → no `c:` row, and
    its raw `s:` leaf serves directly (a `c:` row there would byte-duplicate
    one `s:` leaf). `recanonicalize_table` then keeps every raw leaf and sums
    the merged ones into one `c:<canonical>` row per (bin, canonical, dims)."""
    clusters: dict[str, list[str]] = {}
    for sid, canon in eff.items():
        clusters.setdefault(canon, []).append(sid)
    out: dict[str, str] = {}
    for canon, members in clusters.items():
        if len(members) < 2:
            continue
        for sid in members:
            out[f's:{sid}'] = f'c:{canon}'
    return dict(sorted(out.items()))


def canonicalize_id_map() -> dict[str, str]:
    """The pyrmts `identityRollup.map` for the rides pyramids' `cell` column:
    `{s:<raw>: c:<canonical>}` over merged clusters, derived from the local
    `effective_canonical()` (see `cluster_canonicalize_map`)."""
    return cluster_canonicalize_map(effective_canonical())


def write_canonicalize_id_map(path: Path = CANONICALIZE_MAP_PATH) -> int:
    """Materialize `canonicalize_id_map()` to `path` (default
    `s3/ctbk/stations/station-canonicalize-map.json`), the file the rides
    pyramids' `identityRollup.map` declares. Returns the entry count."""
    m = canonicalize_id_map()
    path.write_text(json.dumps(m, indent=2) + '\n')
    return len(m)


def _geo() -> dict[str, tuple[float, float]]:
    return {
        sid: (lat, lng)
        for sid, (lat, lng) in json.loads(GEO_JSON_PATH.read_text()).items()
    }


def _registry() -> dict[str, tuple[float, float]]:
    luc = json.loads(STATION_LUC_PATH.read_text())
    return {sn: (e['lat'], e['lng']) for sn, e in luc['by_short_name'].items()}


def rides_extra_stations() -> dict[str, dict]:
    """The canonicals `station_positions` adds beyond the registry, in
    `station-luc.json` `by_short_name` entry shape (`{lat, lng, cell}`).
    Published next to the canonicalize map so the api's rides vocab graph
    can emit their `s:` leaves in partial-cell covers — the serving-side
    counterpart of the build placing their rides in vocab cells."""
    import s2cell
    registry = _registry()
    extra = {
        sn: pos for sn, pos in station_positions(registry, effective_canonical(), _geo()).items()
        if sn not in registry
    }
    return {
        sn: {'lat': lat, 'lng': lng, 'cell': s2cell.lat_lon_to_token(lat, lng, EXTRA_CELL_LEVEL)}
        for sn, (lat, lng) in sorted(extra.items())
    }


def write_rides_extra_stations(path: Path = EXTRA_STATIONS_PATH) -> int:
    """Materialize `rides_extra_stations()` to `path`; returns the count."""
    d = rides_extra_stations()
    path.write_text(json.dumps(d, indent=2) + '\n')
    return len(d)


def rides_source_kwargs() -> dict:
    """Everything `MonthlyRidesSource` needs beyond (pyramid, anchor),
    composed from local assets."""
    vocab = load_vocab(VOCAB_PATH)
    canonical = effective_canonical()
    geo = _geo()
    registry = _registry()
    chains = {
        short_name: station_chain(lat, lng, short_name, vocab)
        for short_name, (lat, lng) in station_positions(registry, canonical, geo).items()
    }
    available = {
        m.group(1)
        for p in NORMALIZED_DIR.glob('*.parquet')
        if (m := re.fullmatch(r'(\d{6})\.parquet', p.name))
    }

    def fetch_local(key: str) -> bytes | None:
        path = REPO / 's3' / 'ctbk' / key
        return path.read_bytes() if path.exists() else None

    return dict(
        chains=chains,
        canonical=canonical,
        geo=geo,
        vocab_cells=frozenset(vocab),
        available_months=available,
        fetch_fn=fetch_local,
    )


def regen_geo_json() -> int:
    """Distill `station-observations.parquet` → `station-geo.json`
    (station_id → [lat, lng], most-recent non-null non-(0,0) observation
    per id) — the null-coordinate fallback fill, baked into the Batch
    engine image. Returns the station count."""
    import pandas as pd
    obs_path = REPO / 's3' / 'ctbk' / 'stations' / 'station-observations.parquet'
    obs = pd.read_parquet(obs_path, columns=['date', 'id', 'lat', 'lng'])
    obs = obs.dropna(subset=['lat', 'lng'])
    obs = obs[(obs['lat'] != 0.0) | (obs['lng'] != 0.0)]
    obs = obs.sort_values('date').drop_duplicates('id', keep='last')
    d = {sid: [round(float(la), 6), round(float(ln), 6)]
         for sid, la, ln in zip(obs['id'], obs['lat'], obs['lng'])}
    GEO_JSON_PATH.write_text(json.dumps(d, separators=(',', ':'), sort_keys=True) + '\n')
    return len(d)
