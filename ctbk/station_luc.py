"""Build `station-luc.json` — the station_id → LUC denorm.

For each active station in the current `gbfs/info` snapshot, compute its
LUC (Lowest-resolution Uniquely-containing S2 Cell): the coarsest S2
level at which the station's cell contains no other station. The output
JSON powers per-station queries against the v3 pyramids and the FE-side
polygon point-in-region filtering.

See `specs/per-station-luc-v3.md` for architecture.

Output schema:
  {
    "<gbfs_station_id>": {
      "lat":   40.7505,
      "lng":  -73.9505,
      "cell":  "89c25901",     # LUC cell token (variable-length hex)
      "level": 15,             # LUC S2 level (typically 13..19)
    },
    ...
  }

The CLI writes to two destinations:
  - Local: `www/public/assets/station-luc.json` (committed; FE fetches)
  - R2:    `s3://ctbk/station-luc.json` (worker reads via env.R2)

Usage:
  ctbk station-luc-build                    # use today's gbfs/info snapshot
  ctbk station-luc-build -d 2026-06-16     # use a specific snapshot
  ctbk station-luc-build --no-r2           # skip R2 upload (laptop testing)
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import date as Date, datetime, timezone

import s2cell
from click import option
from utz import err
from utz.cli import flag

from ctbk.avail_v3 import R2_BUCKET, r2_client
from ctbk.cli.base import ctbk

OUTPUT_KEY = 'station-luc.json'                          # R2 key
LOCAL_PATH = 'www/public/assets/station-luc.json'        # FE-fetched

# Range of S2 levels to consider for LUC. L10 is the coarsest level the
# pyramids materialize (also the `coarsestLevel` cap on `minimalCover`).
# L20 is well past any observed collision (empirically max LUC = L19 at
# 2026-06-16; +1 buffer).
LUC_MIN_LEVEL = 10
LUC_MAX_LEVEL = 20


def load_station_geo(cli, date_str: str) -> dict[str, tuple[float, float]]:
    """Read `gbfs/info/<date>.json` → {station_id: (lat, lng)}."""
    key = f'gbfs/info/{date_str}.json'
    obj = cli.get_object(Bucket=R2_BUCKET, Key=key)
    info = json.loads(obj['Body'].read())
    out: dict[str, tuple[float, float]] = {}
    for s in info['data']['stations']:
        sid = s.get('station_id')
        if sid is None: continue
        lat, lng = s.get('lat'), s.get('lon')
        if lat is None or lng is None: continue
        out[sid] = (float(lat), float(lng))
    return out


def compute_luc(station_geo: dict[str, tuple[float, float]]) -> dict[str, dict]:
    """For each station, find the coarsest S2 level where its cell is
    unique among the station set. Returns {sid: {lat, lng, cell, level}}.
    """
    # Pre-compute cells at every candidate level (cheap: ~2400 × 11 levels).
    cells_at: dict[int, dict[str, str]] = {
        lvl: {sid: s2cell.lat_lon_to_token(lat, lng, lvl) for sid, (lat, lng) in station_geo.items()}
        for lvl in range(LUC_MIN_LEVEL, LUC_MAX_LEVEL + 1)
    }
    # Occupancy count per cell per level.
    occupancy_at: dict[int, Counter] = {
        lvl: Counter(cells_at[lvl].values())
        for lvl in cells_at
    }

    out: dict[str, dict] = {}
    no_luc_found: list[str] = []
    for sid, (lat, lng) in station_geo.items():
        for lvl in range(LUC_MIN_LEVEL, LUC_MAX_LEVEL + 1):
            cell = cells_at[lvl][sid]
            if occupancy_at[lvl][cell] == 1:
                out[sid] = {'lat': lat, 'lng': lng, 'cell': cell, 'level': lvl}
                break
        else:
            no_luc_found.append(sid)

    if no_luc_found:
        raise RuntimeError(
            f"{len(no_luc_found)} stations still share their L{LUC_MAX_LEVEL} cell "
            f"with at least one other; bump LUC_MAX_LEVEL. Sample: {no_luc_found[:3]}"
        )
    return out


def luc_distribution_summary(luc: dict[str, dict]) -> str:
    counts = Counter(v['level'] for v in luc.values())
    n = len(luc)
    lines = [f'  L{lvl:<3} {counts[lvl]:6d}  {100*counts[lvl]/n:5.1f}%' for lvl in sorted(counts)]
    return '\n'.join(lines)


@ctbk.command('station-luc-build', help="Build station-luc.json (station_id → LUC denorm) from the current gbfs/info snapshot.")
@option('-d', '--date', 'date_str', default=None, help="Snapshot date (YYYY-MM-DD; default: today UTC).")
@flag('-R', '--no-r2', help="Skip R2 upload; write local file only.")
def station_luc_build_cmd(date_str: str | None, no_r2: bool):
    if date_str is None:
        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    err(f"station-luc-build: date={date_str}")

    cli = r2_client()
    station_geo = load_station_geo(cli, date_str)
    err(f"  loaded {len(station_geo)} stations from gbfs/info/{date_str}.json")

    luc = compute_luc(station_geo)
    err(f"  LUC distribution:")
    err(luc_distribution_summary(luc))

    body = json.dumps(luc, sort_keys=True, separators=(',', ':')).encode('utf-8')
    err(f"  output: {len(body):,} bytes")

    with open(LOCAL_PATH, 'wb') as f:
        f.write(body)
    err(f"  wrote {LOCAL_PATH}")

    if not no_r2:
        cli.put_object(
            Bucket=R2_BUCKET,
            Key=OUTPUT_KEY,
            Body=body,
            ContentType='application/json',
        )
        err(f"  wrote s3://{R2_BUCKET}/{OUTPUT_KEY}")
    else:
        err(f"  (skipped R2 upload — --no-r2)")
