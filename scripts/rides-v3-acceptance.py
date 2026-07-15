#!/usr/bin/env -S uv run -q
# /// script
# requires-python = ">=3.11"
# dependencies = ["click", "requests"]
# ///
"""Compare per-station monthly ride counts: legacy `ymdgtb` JSONs vs
`/api/rides-v3?cells=<LUC>` (`specs/rides-v3-luc.md` acceptance).

For each station, sums legacy `Count` by (Year, Month, Docking) from
`s3/ctbk/stations/ymdgtb/<short_name>.json`, queries the v3 API once per
anchor (monthly bins via `bin_budget`), and reports per-month deltas.

Merged docks: pass `SURVIVOR+LOSER` (e.g. `3501.01+3477`) — legacy
series are summed across the `+`-joined names; the v3 cell comes from
the first (survivor) name.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

import requests
from click import argument, command, option

err = partial(print, file=sys.stderr)

ANCHORS = ('start', 'end')


def legacy_series(legacy_dir: Path, short_name: str) -> dict[tuple[int, int, str], int]:
    rows = json.loads((legacy_dir / f'{short_name}.json').read_text())
    out: dict[tuple[int, int, str], int] = defaultdict(int)
    for r in rows:
        out[(r['Year'], r['Month'], r['Docking'])] += r['Count']
    return out


def v3_series(
    api_base: str,
    cell: str,
    lat: float,
    lng: float,
    frm: str,
    to: str,
    backend: str | None,
) -> dict[tuple[int, int, str], int]:
    bbox = f'{lat - 0.02},{lng - 0.02},{lat + 0.02},{lng + 0.02}'
    out: dict[tuple[int, int, str], int] = defaultdict(int)
    for anchor in ANCHORS:
        res = requests.get(f'{api_base}/api/rides-v3', params={
            'anchor': anchor,
            'cells': cell,
            'bbox': bbox,
            'from': frm,
            'to': to,
            'bin_budget': '200',
            **({'backend': backend} if backend else {}),
        })
        res.raise_for_status()
        for r in res.json()['records']:
            d = datetime.fromtimestamp(r['dt'] / 1000, tz=timezone.utc)
            out[(d.year, d.month, anchor)] += r['count']
    return out


@command()
@option('-a', '--api-base', default='https://ctbk-gbfs-api.ryan-0dc.workers.dev', help='rides-v3 API base URL')
@option('-b', '--backend', default=None, help='`backend=` override (e.g. `parquet` to bypass D1 hybrid)')
@option('-d', '--denorm', 'denorm_path', default='www/public/assets/station-luc.json', help='station-luc denorm JSON path')
@option('-f', '--from', 'frm', default='2013-06-01T00:00:00Z', help='query window start')
@option('-l', '--legacy-dir', default='s3/ctbk/stations/ymdgtb', help='dir of legacy ymdgtb per-station JSONs')
@option('-t', '--to', default=None, help='query window end (default: now)')
@option('-v', '--verbose', is_flag=True, help='print every month, not just mismatches')
@argument('stations', nargs=-1, required=True)
def main(
    api_base: str,
    backend: str | None,
    denorm_path: str,
    frm: str,
    legacy_dir: str,
    to: str | None,
    verbose: bool,
    stations: tuple[str, ...],
):
    """Assert legacy ymdgtb == rides-v3 per station-month. STATIONS are
    short_names, optionally `SURVIVOR+LOSER[+...]` for merged docks."""
    denorm = json.loads(Path(denorm_path).read_text())['by_short_name']
    ldir = Path(legacy_dir)
    to = to or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    failed = False

    for spec in stations:
        names = spec.split('+')
        survivor = names[0]
        entry = denorm.get(survivor)
        if not entry:
            err(f'{spec}: no denorm entry for {survivor!r}')
            failed = True
            continue

        legacy: dict[tuple[int, int, str], int] = defaultdict(int)
        for name in names:
            for k, v in legacy_series(ldir, name).items():
                legacy[k] += v
        v3 = v3_series(api_base, entry['cell'], entry['lat'], entry['lng'], frm, to, backend)

        keys = sorted(set(legacy) | set(v3))
        mismatches = [(k, legacy.get(k, 0), v3.get(k, 0)) for k in keys
                      if legacy.get(k, 0) != v3.get(k, 0)]
        n_months = len({(y, m) for y, m, _ in keys})
        total_l = sum(legacy.values())
        total_v = sum(v3.values())
        print(f'\n{spec} (cell={entry["cell"]}): {n_months} months, '
              f'legacy Σ={total_l:,} v3 Σ={total_v:,}')
        show = [(k, legacy.get(k, 0), v3.get(k, 0)) for k in keys] if verbose else mismatches
        for (y, m, anchor), lv, vv in show:
            d = vv - lv
            pct = f'{d / lv * 100:+.1f}%' if lv else 'n/a'
            print(f'  {y}-{m:02d} {anchor:5s}: legacy={lv:6d} v3={vv:6d} Δ={d:+d} ({pct})')
        if mismatches:
            failed = True
            print(f'  ✗ {len(mismatches)} mismatched (month, anchor) rows')
        else:
            print(f'  ✓ all {len(keys)} (month, anchor) rows match exactly')

    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
