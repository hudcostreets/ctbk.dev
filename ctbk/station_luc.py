"""Build `station-luc.json` — the canonical station → LUC denorm.

For each canonical station observed in any `gbfs/info/<date>.json`
snapshot in a chosen window, compute its LUC (Lowest-resolution
Uniquely-containing S2 Cell): the coarsest S2 level at which the
station's cell contains no other station.

The output is dual-indexed:

  - `by_short_name`: the authoritative LUC info per canonical short_name
    (e.g. `5033.01`). Includes stations decommissioned mid-window (their
    last-observed lat/lng) so the avail builder can still materialize
    their per-minute observations from WAL data that predates today.
  - `by_uuid`: every GBFS station_id (UUID) ever seen in the window,
    mapped to the canonical short_name that owned it at observation
    time. Lets the avail builder resolve a WAL row's UUID → short_name
    → LUC entry even if that UUID has since retired or been
    re-assigned.

See `specs/per-station-luc-v3.md` for architecture.

Output schema:
  {
    "by_short_name": {
      "<canonical_short_name>": {
        "lat":   40.7505,
        "lng":  -73.9505,
        "cell":  "89c25901",     # LUC cell token
        "level": 15,             # LUC S2 level
        "uuid":  "00284700-..."  # most-recently-seen UUID for this short_name
      },
      ...
    },
    "by_uuid": {
      "<gbfs_station_id_uuid>": "<canonical_short_name>",
      ...
    }
  }

Destinations:
  - Local: `www/public/assets/station-luc.json` (committed; FE fetches)
  - R2:    `s3://ctbk/station-luc.json` (worker reads via env.R2)

Usage:
  ctbk station-luc-build                              # default: union over the WAL window
  ctbk station-luc-build -f 2026-04-07 -T 2026-06-18  # explicit window
  ctbk station-luc-build --no-r2                      # write local file only
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import date as Date, datetime, timedelta, timezone

import s2cell
from click import option
from utz import err
from utz.cli import flag

from ctbk.avail_v3 import R2_BUCKET, r2_client
from ctbk.cli.base import ctbk

OUTPUT_KEY = 'station-luc.json'                          # R2 key
LOCAL_PATH = 'www/public/assets/station-luc.json'        # FE-fetched
HISTORY_PATH = 's3/ctbk/stations/station-history.parquet'  # id0-canonicalized eras

# Range of S2 levels to consider for LUC. L10 is the coarsest level the
# pyramids materialize (matches the `coarsestLevel` cap on
# `s2Index.minimalCover`). L20 is past any observed collision in
# practice (max LUC seen at 2026-06-16 was L19); +1 buffer.
LUC_MIN_LEVEL = 10
LUC_MAX_LEVEL = 20

# WAL parquets start here — gbfs/info snapshots covering the WAL period
# should be the default union range. See `gbfs/api/wrangler.toml` cron
# + `gbfs/compact-r2.py` for the actual ingest pipeline.
WAL_PERIOD_START = '2026-04-06'


def list_info_dates(cli, date_from: Date, date_to: Date) -> list[str]:
    """Enumerate `gbfs/info/<date>.json` keys with date in `[from, to)`.

    Returns the date_str values (no `gbfs/info/` prefix, no `.json` suffix)
    in chronological order.
    """
    paginator = cli.get_paginator('list_objects_v2')
    found: list[str] = []
    for page in paginator.paginate(Bucket=R2_BUCKET, Prefix='gbfs/info/'):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if not key.endswith('.json'):
                continue
            stem = key[len('gbfs/info/'):-len('.json')]
            try:
                d = Date.fromisoformat(stem)
            except ValueError:
                continue
            if date_from <= d < date_to:
                found.append(stem)
    return sorted(found)


def load_snapshot(cli, date_str: str) -> list[dict]:
    """Read `gbfs/info/<date>.json` → list of station dicts (raw GBFS shape)."""
    obj = cli.get_object(Bucket=R2_BUCKET, Key=f'gbfs/info/{date_str}.json')
    return json.loads(obj['Body'].read())['data']['stations']


def union_stations(cli, dates: list[str]) -> tuple[dict[str, dict], dict[str, str]]:
    """Union station-info across `dates` snapshots in chronological order.

    Returns:
      by_short_name — {short_name: {lat, lng, uuid}} — last-observed wins.
      by_uuid       — {uuid: short_name} — every UUID seen across the
                      window, mapped to the short_name it had at the
                      time of observation. (If a UUID maps to multiple
                      short_names over time, last-observed wins so the
                      reverse-lookup tracks the same view as
                      `by_short_name`.)
    """
    by_short_name: dict[str, dict] = {}
    by_uuid: dict[str, str] = {}
    for d in dates:
        for s in load_snapshot(cli, d):
            sn = s.get('short_name')
            uid = s.get('station_id')
            lat = s.get('lat')
            lng = s.get('lon')
            if sn is None or uid is None or lat is None or lng is None:
                continue
            by_short_name[sn] = {'lat': float(lat), 'lng': float(lng), 'uuid': uid}
            by_uuid[uid] = sn
    return by_short_name, by_uuid


def historical_stations(active: dict[str, dict]) -> dict[str, dict]:
    """Canonical (id0) stations from rides history absent from the
    active GBFS union, positioned at their most recent era (preferring
    the `id == id0` canonical-era row). Joining them into the LUC
    uniqueness pass means a dead station's rides can never impersonate
    an active station's per-station query (`specs/rides-v3-luc.md`)."""
    import pandas as pd
    h = pd.read_parquet(HISTORY_PATH)
    h = h.dropna(subset=['lat', 'lng'])
    h = h[(h['lat'] != 0.0) | (h['lng'] != 0.0)]
    h = h.assign(is_canon_era=(h['id'] == h['id0']).astype(int))
    last = h.sort_values(['is_canon_era', 'first']).groupby('id0').tail(1)
    return {
        r.id0: {'lat': float(r.lat), 'lng': float(r.lng)}
        for r in last.itertuples()
        if r.id0 not in active
    }


def merge_same_dock(stations: dict[str, dict]) -> dict[str, str]:
    """Collapse L20-cell (~10 m) collision clusters: same physical dock
    under renamed/renumbered canonical ids that `station-id-map` never
    joined (e.g. `3660` → `4651.02` "Clinton Ave & Myrtle Ave"). The
    active member survives (a station page carries its dock's full ride
    history); all-historical clusters keep the lexically-max id (these
    are numbered chronologically in practice, and both members are
    dead, so the choice only names the merged entity). Losers are
    removed from `stations`; returns `{loser: survivor}`."""
    from collections import defaultdict
    groups: dict[str, list[str]] = defaultdict(list)
    for sn, v in stations.items():
        groups[s2cell.lat_lon_to_token(v['lat'], v['lng'], LUC_MAX_LEVEL)].append(sn)
    merged: dict[str, str] = {}
    for cell, sns in groups.items():
        if len(sns) < 2:
            continue
        actives = [sn for sn in sns if stations[sn].get('active')]
        if len(actives) > 1:
            raise RuntimeError(
                f"L{LUC_MAX_LEVEL} cell {cell} holds {len(actives)} ACTIVE stations "
                f"{actives}; two live docks within ~10 m — resolve manually")
        survivor = actives[0] if actives else max(sns)
        for sn in sns:
            if sn != survivor:
                merged[sn] = survivor
                del stations[sn]
    return merged


def compute_luc(stations: dict[str, dict]) -> dict[str, dict]:
    """For each station, find the coarsest S2 level where its cell is
    unique among the station set. Mutates `stations` in place, adding
    `cell` + `level` per entry, and returns it.
    """
    cells_at: dict[int, dict[str, str]] = {
        lvl: {sn: s2cell.lat_lon_to_token(v['lat'], v['lng'], lvl) for sn, v in stations.items()}
        for lvl in range(LUC_MIN_LEVEL, LUC_MAX_LEVEL + 1)
    }
    occupancy_at: dict[int, Counter] = {
        lvl: Counter(cells_at[lvl].values())
        for lvl in cells_at
    }
    no_luc_found: list[str] = []
    for sn in list(stations.keys()):
        for lvl in range(LUC_MIN_LEVEL, LUC_MAX_LEVEL + 1):
            cell = cells_at[lvl][sn]
            if occupancy_at[lvl][cell] == 1:
                stations[sn]['cell'] = cell
                stations[sn]['level'] = lvl
                break
        else:
            no_luc_found.append(sn)
    if no_luc_found:
        raise RuntimeError(
            f"{len(no_luc_found)} stations still share their L{LUC_MAX_LEVEL} cell "
            f"with at least one other; bump LUC_MAX_LEVEL. Sample: {no_luc_found[:3]}"
        )
    return stations


def luc_distribution_summary(by_short_name: dict[str, dict]) -> str:
    counts = Counter(v['level'] for v in by_short_name.values())
    n = len(by_short_name)
    return '\n'.join(f'  L{lvl:<3} {counts[lvl]:6d}  {100*counts[lvl]/n:5.1f}%' for lvl in sorted(counts))


@ctbk.command('station-luc-build', help="Build station-luc.json (canonical short_name → LUC denorm): gbfs/info snapshot union + historical rides canonicals, joint uniqueness.")
@option('-f', '--date-from', 'date_from', default=WAL_PERIOD_START, help=f"Inclusive start (YYYY-MM-DD; default: {WAL_PERIOD_START}, matching the WAL period start).")
@flag('-H', '--no-history', help="Active GBFS stations only (pre-rides-v3-LUC behavior); skips station-history canonicals + same-dock merge.")
@option('-T', '--date-to', 'date_to', default=None, help="Exclusive end (YYYY-MM-DD; default: tomorrow UTC, so today's snapshot is included).")
@flag('-R', '--no-r2', help="Skip R2 upload; write local file only.")
def station_luc_build_cmd(date_from: str, no_history: bool, date_to: str | None, no_r2: bool):
    df = Date.fromisoformat(date_from)
    if date_to is None:
        dt = (datetime.now(timezone.utc).date() + timedelta(days=1))
    else:
        dt = Date.fromisoformat(date_to)

    err(f"station-luc-build: window [{df}, {dt})")
    cli = r2_client()

    dates = list_info_dates(cli, df, dt)
    err(f"  {len(dates)} gbfs/info snapshots in window")
    if not dates:
        raise SystemExit("no snapshots found in window; bail")

    by_short_name, by_uuid = union_stations(cli, dates)
    err(f"  union: {len(by_short_name)} short_names, {len(by_uuid)} uuids")

    merged: dict[str, str] = {}
    if not no_history:
        for v in by_short_name.values():
            v['active'] = True
        hist = historical_stations(by_short_name)
        for v in hist.values():
            v['active'] = False
        err(f"  historical-only canonicals: {len(hist)}")
        by_short_name.update(hist)
        merged = merge_same_dock(by_short_name)
        if merged:
            err(f"  same-dock merges: {len(merged)}")
            for loser, survivor in sorted(merged.items()):
                err(f"    {loser} -> {survivor}")

    # Churn report: active stations whose LUC moves vs the deployed
    # denorm (each requires re-keyed pyramid rows — gates the rebuild
    # sequencing in `specs/rides-v3-luc.md`).
    try:
        with open(LOCAL_PATH) as f:
            prev = json.load(f)['by_short_name']
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        prev = {}

    compute_luc(by_short_name)
    err(f"  LUC distribution:")
    err(luc_distribution_summary(by_short_name))

    if prev:
        moved = [
            sn for sn, v in by_short_name.items()
            if sn in prev and (v['cell'], v['level']) != (prev[sn]['cell'], prev[sn]['level'])
        ]
        err(f"  LUC churn vs {LOCAL_PATH}: {len(moved)} stations moved")
        for sn in sorted(moved)[:20]:
            err(f"    {sn}: L{prev[sn]['level']} {prev[sn]['cell']} -> L{by_short_name[sn]['level']} {by_short_name[sn]['cell']}")

    body = json.dumps(
        {'by_short_name': by_short_name, 'by_uuid': by_uuid, 'merged': merged},
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
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
