#!/usr/bin/env python3
"""Generate canonical human-readable slugs for stations.

Reads `station-history.parquet`, generates a slug per canonical id0
(based on current/latest name), resolves collisions, applies overrides
from `station-slugs-overrides.yaml`, writes `station-slugs.json` and
(optionally) upserts into D1.

Slug shape (v3, compact): an intersection name's `&`-sides joined by `+`,
each side with its street type dropped and numbered streets compressed:
"Lafayette Ave & Classon Ave" → `lafayette+classon`, "W 52 St & 11 Ave"
→ `w52+11`, "S 5th St & Kent Ave" → `s5+kent`. Sides that would end in
the same word keep compact types ("S 5 Pl & S 5 St" → `s5pl+s5st`), and a
slug is never all digits (short names are). Names without `&` (landmarks,
"Journal Square", "Grove St PATH") are just kebab-cased, types kept.

Collisions: the most recently active id of a colliding group keeps the
plain slug. The others add compact types on the fewest sides that make
them unique ("48 Ave & 5 St" → `48ave+5` beside `48+5`); identical names
(one site, several ids) and anything left get `-<id0>`.

Every slug a station has had stays resolvable: `aliases` in the JSON and
the D1 `station_slug_aliases` table (alias → short_name). The api worker
resolves aliases and the FE redirects to the current slug; `--prev`
JSONs (previous runs) feed the alias set.

Usage:
    load_station_slugs.py                # write JSON + push to D1
    load_station_slugs.py --dry-run      # JSON + report only, no D1 write
    load_station_slugs.py --json-only    # skip D1 push
    load_station_slugs.py --sql-only     # also write the D1 SQL files, don't run them
"""
import argparse
import json
import re
import subprocess
import sys
import time
from collections import defaultdict
from itertools import combinations
from pathlib import Path

import pandas as pd

D1_DB = 'ctbk-gbfs'
DEFAULT_HISTORY = Path('s3/ctbk/stations/station-history.parquet')
DEFAULT_OVERRIDES = Path('s3/ctbk/stations/station-slugs-overrides.yaml')
DEFAULT_OUT = Path('s3/ctbk/stations/station-slugs.json')
UPDATE_CHUNK = 100

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


# Street types dropped from intersection sides ("Lafayette Ave" →
# `lafayette`). Landmark-ish types (Square, Plaza, Circle, Way, …) are kept.
STREET_TYPES = {
    'av': 'ave', 'ave': 'ave', 'avenue': 'ave', 'blvd': 'blvd', 'boulevard': 'blvd',
    'ct': 'ct', 'court': 'ct', 'dr': 'dr', 'drive': 'dr', 'ln': 'ln', 'lane': 'ln',
    'pkwy': 'pkwy', 'parkway': 'pkwy', 'pl': 'pl', 'place': 'pl', 'rd': 'rd',
    'road': 'rd', 'st': 'st', 'str': 'st', 'street': 'st', 'ter': 'ter', 'terrace': 'ter',
}
DIRECTIONS = {'n', 's', 'e', 'w'}


def slugify(name: str) -> str:
    if not name:
        return ''
    s = name.translate(SLUG_REPLACE).lower()
    s = re.sub(r'[^a-z0-9\s-]+', '', s)
    s = re.sub(r'[\s-]+', '-', s).strip('-')
    return s


def slug_words(side: str) -> list[str]:
    return [w for w in slugify(side).split('-') if w]


def number(word: str) -> str | None:
    """`52` / `52nd` / `5th` → the digits."""
    m = re.fullmatch(r'(\d+)(?:st|nd|rd|th)?', word)
    return m.group(1) if m else None


def side_slug(words: list[str], typed: bool = False) -> str:
    """One intersection side: type dropped (or compact with `typed`),
    `[dir] N` compressed to `wN` / `N`."""
    typ = None
    if len(words) >= 2 and words[-1] in STREET_TYPES:
        typ, words = STREET_TYPES[words[-1]], words[:-1]
    if len(words) == 2 and words[0] in DIRECTIONS and number(words[1]):
        s = words[0] + number(words[1])
    elif len(words) == 1 and number(words[0]):
        s = number(words[0])
    else:
        s = '-'.join(words)
    if typed and typ:
        s = s + typ if s[-1].isdigit() else f'{s}-{typ}'
    return s


def compact_slug(name: str, typed: frozenset[int] = frozenset()) -> str:
    """See module doc; `typed`: side indices that keep compact types."""
    if not name:
        return ''
    if '&' not in name:
        return slugify(name)
    sides = [w for w in (slug_words(p) for p in name.split('&')) if w]
    ends = [side_slug(w).rsplit('-', 1)[-1] for w in sides]
    return '+'.join(
        side_slug(w, typed=i in typed or ends.count(e) > 1)
        for i, (w, e) in enumerate(zip(sides, ends))
    )


def side_types(name: str) -> list[str | None]:
    """Each `&`-side's (normalized) street type, or None."""
    sides = [w for w in (slug_words(p) for p in name.split('&')) if w]
    return [STREET_TYPES.get(w[-1]) if len(w) >= 2 else None for w in sides]


def resolve_slugs(canonical: dict, overrides: dict) -> dict[str, str]:
    """id0 → final slug, per the collision rules in the module doc."""
    base = {
        id0: overrides[id0] if id0 in overrides else compact_slug(c['name'])
        for id0, c in canonical.items()
    }
    by_slug = defaultdict(list)
    for id0, slug in base.items():
        if slug:
            by_slug[slug].append(id0)
    taken = set(by_slug)
    final = {}
    # Most recently active first: `last_seen` None = still active.
    recency = lambda id0: (canonical[id0]['last_seen'] or '9999', id0)
    for slug, ids in sorted(by_slug.items()):
        winner, *rest = sorted(ids, key=recency, reverse=True)
        final[winner] = slug
        for id0 in rest:
            name = canonical[id0]['name']
            cand = None
            if id0 not in overrides and name != canonical[winner]['name'] and '&' in name:
                # Type the sides whose type differs from the plain slug's
                # holder first ("Washington Ave & Park Pl" beside "…& Park
                # Ave" → `washington+park-pl`, not `washington-ave+park`).
                mine, theirs = side_types(name), side_types(canonical[winner]['name'])
                order = sorted(range(len(mine)), key=lambda i: (i < len(theirs) and mine[i] == theirs[i], i))
                for k in range(1, len(mine) + 1):
                    for sides in combinations(order, k):
                        c = compact_slug(name, frozenset(sides))
                        if c not in taken:
                            cand = c
                            break
                    if cand:
                        break
            final[id0] = cand or f'{slug}-{slugify(id0)}'
            taken.add(final[id0])
    return final


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
    ap.add_argument('--prev', type=Path, action='append', help='Previous run\'s JSON; its slugs + aliases become aliases (repeatable; default: --out)')
    ap.add_argument('--dry-run', action='store_true', help='No D1 write')
    ap.add_argument('--json-only', action='store_true', help='Write JSON only, skip D1')
    ap.add_argument('--sql-only', action='store_true', help='Also write the D1 migration/update SQL files, but don\'t run them')
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
            # An open era (`last` null) means still active.
            'last_seen': None if g['last'].isna().any() else parse_date(g['last'].max()),
        }

    print(f"Generating slugs for {len(canonical)} canonical stations", file=sys.stderr)

    # Determine "active" cutoff (12 months before latest in dataset)
    # Used for collision resolution: only currently-active stations get auto-disambig
    latest_dates = [c['last_seen'] for c in canonical.values() if c['last_seen']]
    latest_iso = max(latest_dates) if latest_dates else None
    print(f"Latest last_seen in data: {latest_iso}", file=sys.stderr)

    final_slugs = resolve_slugs(canonical, overrides)

    # Build output maps
    by_slug_out = {}
    by_short_name_out = {}
    deprecated_out = dict(explicit_deprecated)
    for id0, slug in final_slugs.items():
        if slug in by_slug_out and by_slug_out[slug] != id0:
            raise SystemExit(f"slug collision survived disambig: {slug} -> {id0} vs {by_slug_out[slug]}")
        by_slug_out[slug] = id0
        by_short_name_out[id0] = slug
    # Every earlier slug (previous runs' slugs + their aliases) → alias.
    aliases = {}
    for prev in args.prev or [args.out]:
        if not prev.exists():
            continue
        data = json.loads(prev.read_text())
        for old, id0 in [*data.get('aliases', {}).items(), *((v, k) for k, v in data.get('by_short_name', {}).items())]:
            if id0 in final_slugs and final_slugs[id0] != old:
                aliases.setdefault(old, id0)
    # An old slug that's now another station's slug: the current one wins.
    shadowed = {a: i for a, i in aliases.items() if a in by_slug_out}
    aliases = {a: i for a, i in aliases.items() if a not in by_slug_out}

    # Sort outputs for deterministic JSON
    output = {
        'by_slug': dict(sorted(by_slug_out.items())),
        'by_short_name': dict(sorted(by_short_name_out.items())),
        'deprecated': dict(sorted(deprecated_out.items())),
        'aliases': dict(sorted(aliases.items())),
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
    print(f"  Id-suffixed (collisions): {sum(1 for id0, s in final_slugs.items() if s.endswith('-' + slugify(id0)))}", file=sys.stderr)
    print(f"  Aliases: {len(aliases)} ({len(shadowed)} dropped: now another station's slug)", file=sys.stderr)
    lens = sorted(len(s) for s in final_slugs.values())
    print(f"  Length: median {lens[len(lens) // 2]}, max {lens[-1]}", file=sys.stderr)
    print(f"  Long slugs (>60 chars): {sum(1 for s in final_slugs.values() if len(s) > 60)}", file=sys.stderr)

    # A new slug equal to another station's *current* D1 slug would trip
    # the unique index mid-batch; refuse rather than order the updates.
    # D1's unique slug index would trip mid-batch if a new slug were still
    # another station's current (pre-update) slug.
    if shadowed:
        raise SystemExit(f"new slugs reuse other stations' earlier slugs: {shadowed}")

    if args.dry_run or args.json_only and not args.sql_only:
        return

    # D1: a `station_slug_aliases` table (not a `slug_prev` column): a
    # station can accumulate several old forms, each an indexed PK lookup,
    # and future renames need no schema change. Per station, today's D1
    # slug is copied into it before being replaced, so whatever is live
    # resolves even if it's missing from the JSONs.
    sql_dir = args.out.parent
    schema_sql = sql_dir / 'slug_aliases_schema.sql'
    schema_sql.write_text(
        'CREATE TABLE IF NOT EXISTS station_slug_aliases (\n'
        '  alias TEXT PRIMARY KEY,\n'
        '  short_name TEXT NOT NULL,\n'
        '  created_at INTEGER NOT NULL\n'
        ');\n'
        'CREATE INDEX IF NOT EXISTS idx_station_slug_aliases_short_name ON station_slug_aliases(short_name);\n'
    )
    now = int(time.time())
    stmts = [
        f"INSERT OR IGNORE INTO station_slug_aliases (alias, short_name, created_at) "
        f"SELECT slug, short_name, {now} FROM stations WHERE short_name = {lit(id0)} AND slug IS NOT NULL AND slug != {lit(slug)};\n"
        f"UPDATE stations SET slug = {lit(slug)} WHERE short_name = {lit(id0)} AND slug IS NOT {lit(slug)};\n"
        for id0, slug in sorted(final_slugs.items())
    ] + [
        f"INSERT OR IGNORE INTO station_slug_aliases (alias, short_name, created_at) VALUES ({lit(a)}, {lit(i)}, {now});\n"
        for a, i in sorted(aliases.items())
    ] + ["DELETE FROM station_slug_aliases WHERE alias IN (SELECT slug FROM stations WHERE slug IS NOT NULL);\n"]
    # Chunked: `wrangler d1 execute --file` runs a file as one batch, and
    # ~1k statements trips SQLITE_TOOBIG (seen locally).
    for old in sql_dir.glob('update_slugs_*.sql'):
        old.unlink()
    update_sqls = []
    for i in range(0, len(stmts), UPDATE_CHUNK):
        f = sql_dir / f'update_slugs_{i // UPDATE_CHUNK:02d}.sql'
        f.write_text(''.join(stmts[i:i + UPDATE_CHUNK]))
        update_sqls.append(f)
    print(f"  Wrote {schema_sql} + {len(update_sqls)} × {sql_dir}/update_slugs_NN.sql", file=sys.stderr)
    if args.sql_only:
        return

    print(file=sys.stderr)
    print("Pushing slugs to D1...", file=sys.stderr)
    d1 = lambda f, **kw: subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', D1_DB, '--remote', '--file', str(f.resolve())],
        cwd='gbfs/loader', **kw,
    )
    d1(schema_sql, check=True)
    for f in update_sqls:
        result = d1(f, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"D1 update failed at {f}:\n{result.stderr}", file=sys.stderr)
            sys.exit(1)
    print("OK", file=sys.stderr)


if __name__ == '__main__':
    main()
