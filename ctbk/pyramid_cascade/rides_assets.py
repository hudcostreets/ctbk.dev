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
NORMALIZED_DIR = REPO / 's3' / 'ctbk' / 'normalized'
GEO_JSON_PATH = REPO / 'gbfs' / 'engine' / 'station-geo.json'


def rides_source_kwargs() -> dict:
    """Everything `MonthlyRidesSource` needs beyond (pyramid, anchor),
    composed from local assets."""
    vocab = load_vocab(VOCAB_PATH)
    luc = json.loads(STATION_LUC_PATH.read_text())
    chains = {
        short_name: station_chain(e['lat'], e['lng'], short_name, vocab)
        for short_name, e in luc['by_short_name'].items()
    }
    idm = json.loads(ID_MAP_PATH.read_text())
    merged = luc.get('merged', {})
    canonical = {sid: merged.get(canon, canon) for sid, canon in idm.items()}
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
