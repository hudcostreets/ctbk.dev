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

from .vocab import load_vocab, station_chain

REPO = Path(__file__).parents[2]
CONFIG_DIR = REPO / 'configs' / 'pyramids'
VOCAB_PATH = CONFIG_DIR / 'station-vocab.json'
STATION_LUC_PATH = REPO / 'www' / 'public' / 'assets' / 'station-luc.json'
ID_MAP_PATH = REPO / 's3' / 'ctbk' / 'stations' / 'station-id-map.json'
CANONICALIZE_MAP_PATH = REPO / 's3' / 'ctbk' / 'stations' / 'station-canonicalize-map.json'
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


def rides_source_kwargs() -> dict:
    """Everything `MonthlyRidesSource` needs beyond (pyramid, anchor),
    composed from local assets."""
    vocab = load_vocab(VOCAB_PATH)
    luc = json.loads(STATION_LUC_PATH.read_text())
    chains = {
        short_name: station_chain(e['lat'], e['lng'], short_name, vocab)
        for short_name, e in luc['by_short_name'].items()
    }
    canonical = effective_canonical()
    geo = {
        sid: (lat, lng)
        for sid, (lat, lng) in json.loads(GEO_JSON_PATH.read_text()).items()
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
