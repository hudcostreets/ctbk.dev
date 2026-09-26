"""Audit of the `cons` trailing-zero id corruption (`specs/station-id-trailing-zero.md`).

Until `f9218866`, `cons` rewrote an integer station id `N` to `N0` whenever
both appeared in a month, folding two unrelated stations under `N0`. Names
and coordinates were untouched, so the station meta_hists (`in_`: id × name
visit counts; `il_`: id × position) still say which rows were really `N`.

- `detect_pairs`: the corrupted `(N, N0)` pairs, from `in_` alone.
- `uncorrupt`: move each pair's rows back to `N` (by name in `in_`, by
  position in `il_`) — the meta_hists a regenerated `cons` will produce.
- `repairs`: per pair, the monthly visits of each station and where the
  rides pyramid placed them before (the old id-map's canonical for `N0`)
  vs after (each station's own canonical), with regions.

`ctbk station-trailing-zero-audit` writes `station-trailing-zero-repairs.json`
(the `/merge-review` page's repair items) and prints the regional impact.
Counts are station visits (starts + ends)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt

import pandas as pd

# A corrupted row keeps its own position; within this many meters of `N`'s
# clean-month position it's `N`'s.
POSITION_MATCH_M = 150


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((la2 - la1) / 2) ** 2 + cos(la1) * cos(la2) * sin((lo2 - lo1) / 2) ** 2
    return 2 * 6_371_000 * asin(sqrt(h))


@dataclass(frozen=True)
class Pair:
    n: str          # the real id `N`, rewritten away in corrupted months
    n0: str         # `N0`: its own station, plus `N`'s rows in corrupted months
    names: frozenset[str]  # `N`'s names (the rows to move back)


def detect_pairs(din: pd.DataFrame) -> list[Pair]:
    """`(N, N0)` integer pairs where `N0` carries rows named like `N` AND rows
    of its own names — two stations under one id. `din`: `id, name, ym,
    count` (station meta_hist `in_`)."""
    names = din.groupby('id')['name'].agg(set)
    out = []
    for n0 in sorted(i for i in names.index if re.fullmatch(r'\d{1,3}0', i)):
        n = n0[:-1]
        if n not in names.index:
            continue
        own = names[n0] - names[n]
        if own and names[n0] & names[n]:
            out.append(Pair(n, n0, frozenset(names[n])))
    return out


def _weighted_pos(dil: pd.DataFrame, sid: str) -> tuple[float, float] | None:
    g = dil[(dil['id'] == sid) & dil['lat'].notna() & (dil['lat'] != 0)]
    if g.empty:
        return None
    w = g['count']
    return float((g['lat'] * w).sum() / w.sum()), float((g['lng'] * w).sum() / w.sum())


def uncorrupt(din: pd.DataFrame, dil: pd.DataFrame, pairs: list[Pair]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Copies of `din`/`dil` with each pair's corrupted rows moved back to
    `N`: `in_` rows under `N0` bearing one of `N`'s names (and none of `N0`'s
    own), `il_` rows under `N0` within `POSITION_MATCH_M` of `N`'s position."""
    din, dil = din.copy(), dil.copy()
    for p in pairs:
        n0_rows = din['id'] == p.n0
        din.loc[n0_rows & din['name'].isin(p.names), 'id'] = p.n
        pos = _weighted_pos(dil, p.n)
        if pos is None:
            continue
        cand = dil[(dil['id'] == p.n0) & dil['lat'].notna()]
        near = [i for i, la, lo in zip(cand.index, cand['lat'], cand['lng']) if haversine_m(pos, (la, lo)) <= POSITION_MATCH_M]
        dil.loc[near, 'id'] = p.n
    return din, dil


def region_at(pos: tuple[float, float] | None, stations: dict[str, dict]) -> str | None:
    """Region (NYC/JC/HOB) of the nearest `stations-regional.json` station."""
    if pos is None:
        return None
    best = min(stations.values(), key=lambda s: haversine_m(pos, (s['lat'], s['lng'])))
    return best['region']


def repairs(
    din_before: pd.DataFrame,
    din_after: pd.DataFrame,
    dil_after: pd.DataFrame,
    pairs: list[Pair],
    idm_before: dict[str, str],
    idm_after: dict[str, str],
    stations: dict[str, dict],
) -> list[dict]:
    """One record per pair: monthly visits of `N` and `N0` after the fix (the
    before-fix served id `N0` carried their sum), and each side's canonical /
    position / region before (everything placed at `idm_before[N0]`) and
    after."""
    pos = lambda sid: _weighted_pos(dil_after, sid)  # noqa: E731
    out = []
    for p in pairs:
        months = din_before[din_before['id'] == p.n0].groupby('ym')['count'].sum()
        after = din_after[din_after['id'].isin([p.n, p.n0])].groupby(['ym', 'id'])['count'].sum().unstack(fill_value=0)
        series = {
            ym: [int(after.at[ym, p.n]) if p.n in after.columns and ym in after.index else 0,
                 int(after.at[ym, p.n0]) if p.n0 in after.columns and ym in after.index else 0]
            for ym in months.index
        }
        moved = {ym: v for ym, v in series.items() if v[0]}
        if not moved:
            continue
        canon_before = idm_before.get(p.n0, p.n0)
        sides = {}
        for sid in (p.n, p.n0):
            canon = idm_after.get(sid, sid)
            at = pos(canon) or pos(sid)
            sides[sid] = {'canon': canon, 'pos': at, 'region': region_at(at, stations)}
        before_pos = pos(canon_before)
        out.append({
            'n': p.n,
            'n0': p.n0,
            'names': {sid: sorted(din_after[din_after['id'] == sid]['name'].unique().tolist()) for sid in (p.n, p.n0)},
            'before': {'canon': canon_before, 'pos': before_pos, 'region': region_at(before_pos, stations)},
            'after': sides,
            'months': sorted(moved),
            'series': series,  # ym → [N visits, N0 visits]; served before as N0 = sum
        })
    return out


def regional_impact(reps: list[dict]) -> pd.DataFrame:
    """Per (ym, region): visits placed there before vs after the fix, over the
    repaired pairs only (everything else is unchanged)."""
    rows = []
    for r in reps:
        for ym, (vn, vn0) in r['series'].items():
            rows.append({'ym': ym, 'region': r['before']['region'], 'before': vn + vn0, 'after': 0})
            rows.append({'ym': ym, 'region': r['after'][r['n']]['region'], 'before': 0, 'after': vn})
            rows.append({'ym': ym, 'region': r['after'][r['n0']]['region'], 'before': 0, 'after': vn0})
    df = pd.DataFrame(rows).groupby(['ym', 'region'])[['before', 'after']].sum()
    df['delta'] = df['after'] - df['before']
    return df


def load_json(path) -> dict:
    with open(path) as f:
        return json.load(f)
