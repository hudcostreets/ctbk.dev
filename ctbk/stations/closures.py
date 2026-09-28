"""Mid-life station closures: stretches where a (canonical) station has no
rides at all, bracketed by activity on both sides (e.g. 8 Ave & W 33 St,
2024-01-13 → 2024-12-04). Read from `station-observations.parquet` (one row
per station id per day it appears as a start or end), so gaps are exact to the
day. Days with no observations system-wide (feed/data outages) never count as
closure days.
"""
from dataclasses import dataclass
from datetime import date

from pandas import DataFrame, to_datetime


@dataclass(frozen=True)
class Closure:
    station: str
    name: str
    #: First and last day with no rides.
    first: date
    last: date
    days: int


def closures(
    obs: DataFrame,
    canon: dict[str, str],
    min_days: int = 14,
    min_active: int = 60,
) -> list[Closure]:
    """Gaps of ≥ `min_days` system-active days in each canonical station's
    observed days, with ≥ `min_active` observed days before and after.
    `obs` has `date` (`YYMMDD`), `id`, `name`; `canon` maps `s:<id>` →
    `c:<canonical>` (unmapped ids are their own station). Longest first."""
    df = obs[['date', 'id', 'name']].copy()
    df['station'] = df['id'].map(lambda i: canon.get(f's:{i}', f'c:{i}'))
    df['day'] = to_datetime(df['date'], format='%y%m%d').dt.date
    system_days = sorted(set(df['day']))
    rank = {d: i for i, d in enumerate(system_days)}
    out: list[Closure] = []
    for station, g in df.groupby('station'):
        days = sorted(set(g['day']))
        name = g.sort_values('day')['name'].iloc[-1]
        for i in range(1, len(days)):
            gap = rank[days[i]] - rank[days[i - 1]] - 1
            if gap < min_days or i < min_active or len(days) - i < min_active:
                continue
            first = system_days[rank[days[i - 1]] + 1]
            last = system_days[rank[days[i]] - 1]
            out.append(Closure(station, name, first, last, gap))
    return sorted(out, key=lambda c: (-c.days, c.station))


def closures_by_id(
    found: list[Closure],
    canon: dict[str, str],
) -> dict[str, list[list[str]]]:
    """`{id: [[first, last], …]}` (ISO dates, chronological) for the FE: keyed
    by each closed station's canonical id and every raw id that maps to it, so
    a page looking up any of a station's ids finds its closures."""
    by_canon: dict[str, list[list[str]]] = {}
    for c in sorted(found, key=lambda c: (c.station, c.first)):
        by_canon.setdefault(c.station, []).append([c.first.isoformat(), c.last.isoformat()])
    out = {station.removeprefix('c:'): spans for station, spans in by_canon.items()}
    for raw, station in canon.items():
        if station in by_canon:
            out[raw.removeprefix('s:')] = by_canon[station]
    return dict(sorted(out.items()))
