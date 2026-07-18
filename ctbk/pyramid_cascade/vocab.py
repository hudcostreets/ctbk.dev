"""Ragged station-cell vocabulary (`specs/drop-luc-station-keys.md`).

The v4 pyramids key rows by a FROZEN vocabulary: S2 cells built by
"descend while a cell holds more than T stations" over the station
registry, plus one `s:<short_name>` identity row per station. The
vocabulary is generated offline (`ctbk gbfs vocab gen`), committed as
`configs/pyramids/station-vocab.json`, and bundled into the Lambda zip —
write paths never recompute it, so new stations can't churn existing
keys (the LUC failure mode). New stations still get their `s:` row
immediately; cells for brand-new AREAS appear at the next vocabulary
extension (append-only: extending backfills only the new cells, from
the `s:` rows).

Lambda-bundle constraint: polars/click/pandas-free (see `lite.py`).
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import s2cell

BASE_LEVEL = 10
MAX_LEVEL = 20
DEFAULT_T = 4


def build_vocab(
    stations: dict[str, tuple[float, float]],
    t: int = DEFAULT_T,
) -> set[str]:
    """Cell tokens of the ragged vocabulary: every occupied cell from
    `BASE_LEVEL` down, stopping below cells holding ≤ `t` stations.
    Closed under ancestors by construction."""
    vocab: set[str] = set()

    def recurse(cells: dict[str, list[str]], lvl: int) -> None:
        nxt: dict[str, list[str]] = defaultdict(list)
        for tok, sns in cells.items():
            vocab.add(tok)
            if len(sns) > t and lvl < MAX_LEVEL:
                for sn in sns:
                    lat, lng = stations[sn]
                    nxt[s2cell.lat_lon_to_token(lat, lng, lvl + 1)].append(sn)
        if nxt:
            recurse(dict(nxt), lvl + 1)

    base: dict[str, list[str]] = defaultdict(list)
    for sn, (lat, lng) in stations.items():
        base[s2cell.lat_lon_to_token(lat, lng, BASE_LEVEL)].append(sn)
    recurse(dict(base), BASE_LEVEL)
    return vocab


def station_chain(
    lat: float,
    lng: float,
    short_name: str,
    vocab: set[str],
) -> list[str]:
    """Write-path chain for one station: its ancestor cells that exist
    in the frozen vocabulary (a contiguous prefix, since the vocabulary
    is ancestor-closed) + its identity key."""
    chain = []
    for lvl in range(BASE_LEVEL, MAX_LEVEL + 1):
        tok = s2cell.lat_lon_to_token(lat, lng, lvl)
        if tok not in vocab:
            break
        chain.append(tok)
    chain.append(f's:{short_name}')
    return chain


def dump_vocab(vocab: set[str], t: int, n_stations: int) -> str:
    return json.dumps(
        {'T': t, 'n_stations': n_stations, 'cells': sorted(vocab)},
        indent=1,
    ) + '\n'


def load_vocab(path: Path) -> set[str]:
    return set(json.loads(path.read_text())['cells'])
