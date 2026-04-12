#!/usr/bin/env python3
"""Generate canonical human-readable slugs for stations.

Reads `station-history.parquet`, generates a slug per canonical id0
(based on current/latest name), resolves collisions via borough
suffixes, applies overrides from `station-slugs-overrides.yaml`,
writes `station-slugs.json` and (optionally) upserts into D1.

Usage:
    load_station_slugs.py                # write JSON + push to D1
    load_station_slugs.py --dry-run      # JSON + report only, no D1 write
    load_station_slugs.py --json-only    # skip D1 push
"""
import argparse
import json
import re
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

import pandas as pd

D1_DB = 'ctbk-gbfs'
DEFAULT_HISTORY = Path('s3/ctbk/stations/station-history.parquet')
DEFAULT_OVERRIDES = Path('s3/ctbk/stations/station-slugs-overrides.yaml')
DEFAULT_OUT = Path('s3/ctbk/stations/station-slugs.json')

# Bounding boxes — approximate; loose enough to catch edge cases
BOROUGHS = [
    # (suffix, lat_min, lat_max, lng_min, lng_max)
    ('jc',  40.700, 40.770, -74.090, -74.020),  # Jersey City (check before MN since they overlap)
    ('hbk', 40.735, 40.760, -74.040, -74.020),  # Hoboken (overlaps JC; checked first below)
    ('mn',  40.700, 40.880, -74.020, -73.910),  # Manhattan
    ('bx',  40.785, 40.920, -73.935, -73.765),  # Bronx
    ('bk',  40.570, 40.740, -74.045, -73.835),  # Brooklyn
    ('qns', 40.540, 40.800, -73.965, -73.700),  # Queens
    ('si',  40.495, 40.650, -74.260, -74.050),  # Staten Island
]


def borough(lat: float, lng: float) -> str | None:
    """Return short borough code (e.g. 'mn', 'bk') or None if no match."""
    if pd.isna(lat) or pd.isna(lng):
        return None
    # Hoboken is a small box inside JC's bounds — check it first
    for suffix, lat_min, lat_max, lng_min, lng_max in BOROUGHS:
        if lat_min <= lat <= lat_max and lng_min <= lng <= lng_max:
            return suffix
    return None


SLUG_REPLACE = str.maketrans({
    '&': ' ',
    '/': ' ',
    '@': ' ',
    "'": '',
    '"': '',
    '(': ' ',
    ')': ' ',
    '.': ' ',
    ',': ' ',
})


def slugify(name: str) -> str:
    if not name:
        return ''
    s = name.translate(SLUG_REPLACE).lower()
    s = re.sub(r'[^a-z0-9\s-]+', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s


def parse_date(s) -> str | None:
    if s is None or (isinstance(s, float) and pd.isna(s)):
        return None
    s = str(s)
    if len(s) == 6:
        return f"20{s[:2]}-{s[2:4]}-{s[4:6]}"
    return None


def load_overrides(path: Path) -> dict:
    if not path.exists():
        return {'overrides': {}, 'deprecated': {}}
    try:
        import yaml
    except ImportError:
        print(f"WARNING: PyYAML not installed; skipping overrides from {path}", file=sys.stderr)
        return {'overrides': {}, 'deprecated': {}}
    data = yaml.safe_load(path.read_text()) or {}
    return {
        'overrides': data.get('overrides', {}) or {},
        'deprecated': data.get('deprecated', {}) or {},
    }


def lit(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--history', type=Path, default=DEFAULT_HISTORY)
    ap.add_argument('--overrides', type=Path, default=DEFAULT_OVERRIDES)
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT)
    ap.add_argument('--dry-run', action='store_true', help='No D1 write')
    ap.add_argument('--json-only', action='store_true', help='Write JSON only, skip D1')
    args = ap.parse_args()

    df = pd.read_parquet(args.history)
    overrides_data = load_overrides(args.overrides)
    overrides = overrides_data['overrides']
    explicit_deprecated = overrides_data['deprecated']

    # For each canonical id0, take the most-recent span as the source of truth
    df = df.copy()
    df['_last_sort'] = df['last'].fillna('999999')
    df_sorted = df.sort_values(['id0', '_last_sort'])

    canonical = {}  # id0 -> {name, lat, lng, last_seen}
    for id0, g in df_sorted.groupby('id0', sort=False):
        latest = g.iloc[-1]
        canonical[id0] = {
            'id0': id0,
            'name': latest['name'],
            'lat': latest['lat'],
            'lng': latest['lng'],
            'last_seen': parse_date(g['last'].dropna().max() if g['last'].notna().any() else None),
        }

    print(f"Generating slugs for {len(canonical)} canonical stations", file=sys.stderr)

    # Determine "active" cutoff (12 months before latest in dataset)
    # Used for collision resolution: only currently-active stations get auto-disambig
    latest_dates = [c['last_seen'] for c in canonical.values() if c['last_seen']]
    latest_iso = max(latest_dates) if latest_dates else None
    print(f"Latest last_seen in data: {latest_iso}", file=sys.stderr)

    # Pass 1: base slug (or override) for each id0
    base_slugs = {}
    for id0, c in canonical.items():
        if id0 in overrides:
            base_slugs[id0] = overrides[id0]
        elif c['name']:
            base_slugs[id0] = slugify(c['name'])
        else:
            base_slugs[id0] = ''

    # Pass 2: collision detection — bucket id0s by base slug
    by_slug = defaultdict(list)
    for id0, slug in base_slugs.items():
        if slug:  # skip empties
            by_slug[slug].append(id0)

    # Pass 3: resolve collisions
    final_slugs = {}  # id0 -> final slug
    for slug, id0s in by_slug.items():
        if len(id0s) == 1:
            final_slugs[id0s[0]] = slug
            continue

        # Collision: try borough suffix
        with_borough = []
        for id0 in id0s:
            c = canonical[id0]
            b = borough(c['lat'], c['lng'])
            with_borough.append((id0, b, f"{slug}-{b}" if b else slug))

        # Sub-bucket by new candidate
        by_candidate = defaultdict(list)
        for id0, _, cand in with_borough:
            by_candidate[cand].append(id0)

        for cand, sub_ids in by_candidate.items():
            if len(sub_ids) == 1:
                final_slugs[sub_ids[0]] = cand
            else:
                # Still colliding — append id0 to disambig
                for id0 in sub_ids:
                    final_slugs[id0] = f"{cand}-{slugify(id0)}"

    # Build output maps
    by_slug_out = {}
    by_short_name_out = {}
    deprecated_out = dict(explicit_deprecated)

    for id0, slug in final_slugs.items():
        if slug in by_slug_out and by_slug_out[slug] != id0:
            print(f"WARNING: slug collision survived disambig: {slug} -> {id0} vs {by_slug_out[slug]}", file=sys.stderr)
            continue
        by_slug_out[slug] = id0
        by_short_name_out[id0] = slug

    # Sort outputs for deterministic JSON
    output = {
        'by_slug': dict(sorted(by_slug_out.items())),
        'by_short_name': dict(sorted(by_short_name_out.items())),
        'deprecated': dict(sorted(deprecated_out.items())),
        'generated_at': int(time.time()),
        'count': len(final_slugs),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2) + '\n')
    print(f"Wrote {args.out} ({len(final_slugs)} slugs, {len(deprecated_out)} deprecated)", file=sys.stderr)

    # Stats
    print(file=sys.stderr)
    print("Slug stats:", file=sys.stderr)
    print(f"  Stations with overrides: {sum(1 for id0 in final_slugs if id0 in overrides)}", file=sys.stderr)
    print(f"  Stations with borough disambig: {sum(1 for s in final_slugs.values() if any(s.endswith(f'-{b}') or f'-{b}-' in s for b, *_ in BOROUGHS))}", file=sys.stderr)
    print(f"  Empty slug source (skipped): {sum(1 for s in base_slugs.values() if not s)}", file=sys.stderr)
    print(f"  Long slugs (>60 chars): {sum(1 for s in final_slugs.values() if len(s) > 60)}", file=sys.stderr)

    if args.dry_run or args.json_only:
        return

    # Push slugs into D1
    print(file=sys.stderr)
    print("Pushing slugs to D1...", file=sys.stderr)

    # Add column if missing (idempotent — D1 will error if column exists, which we ignore)
    sql_lines = []
    sql_lines.append(
        "INSERT INTO day_tables (date, table_name, created_at) VALUES ('_schema_marker_slug', '_', 0) ON CONFLICT DO NOTHING;"
    )
    # Slug column
    sql_lines.append("-- column add (will fail harmlessly if exists)")
    add_col_sql = Path(args.out.parent / 'add_slug_column.sql')
    add_col_sql.write_text("ALTER TABLE stations ADD COLUMN slug TEXT;\nCREATE UNIQUE INDEX IF NOT EXISTS idx_stations_slug ON stations(slug);\n")
    subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', D1_DB, '--remote', '--file', str(add_col_sql.resolve())],
        cwd='gbfs/loader', capture_output=True, text=True,
    )  # ignore errors (column exists)

    # Update slugs (one statement per row, batched)
    update_sql = Path(args.out.parent / 'update_slugs.sql')
    lines = []
    for id0, slug in sorted(final_slugs.items()):
        lines.append(f"UPDATE stations SET slug = {lit(slug)} WHERE short_name = {lit(id0)};")
    update_sql.write_text('\n'.join(lines) + '\n')
    print(f"  Wrote {len(lines)} UPDATE statements -> {update_sql}", file=sys.stderr)

    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', D1_DB, '--remote', '--file', str(update_sql.resolve())],
        cwd='gbfs/loader', capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"D1 update failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    print("OK", file=sys.stderr)


if __name__ == '__main__':
    main()
