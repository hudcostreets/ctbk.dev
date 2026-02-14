#!/usr/bin/env python
"""Station harmonization: build a global station history with day-level granularity.

Maps all historical Citi Bike station IDs to canonical current IDs via union-find
on station name/location similarity, then extracts day-level spans from consolidated
parquets.

Outputs:
- station-history.parquet: one row per station "span" (id0, id, name, lat, lng, first, last)
- station-id-map.json: {historical_id: canonical_id}
- station-mappings.yaml: human-readable station history (comment-preserving via ruamel.yaml)
"""
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from math import radians, sin, cos, sqrt, atan2
from os.path import dirname, exists, join
from pathlib import Path

import click
import numpy as np
import pandas as pd
from click import option
from pandas import DataFrame
from utz import err

from ctbk.cli.base import ctbk, StableCommandOrder
from ctbk.paths import S3
from ctbk.util.constants import BKT

DIR = f'{BKT}/stations'
META_HIST_DIR = f'{BKT}/stations/meta_hists'

# Abbreviation normalization map: full → abbreviated
ABBREVS = {
    'Street': 'St',
    'Avenue': 'Ave',
    'North': 'N',
    'South': 'S',
    'East': 'E',
    'West': 'W',
    'Place': 'Pl',
    'Boulevard': 'Blvd',
    'Parkway': 'Pkwy',
    'Road': 'Rd',
    'Drive': 'Dr',
    'Court': 'Ct',
    'Lane': 'Ln',
    'Square': 'Sq',
    'Terrace': 'Ter',
}

# Compile regex for each abbreviation (match as whole words)
_ABBREV_PATTERNS = [
    (re.compile(rf'\b{re.escape(full)}\b'), abbr)
    for full, abbr in ABBREVS.items()
]

JUNK_PATTERNS = re.compile(
    r"Don't Use|Depot|Tech Shop|NYCBS|SYS\d|Charging|TEMP|test|Lab - NYC",
    re.IGNORECASE,
)


def normalize_name(name: str) -> str:
    """Normalize a station name for comparison.

    Collapses whitespace, strips, and normalizes common abbreviations.
    """
    if not isinstance(name, str):
        return ''
    # Collapse various whitespace chars
    name = re.sub(r'[\t\xa0\s]+', ' ', name).strip()
    # Normalize abbreviations (full → short)
    for pattern, abbr in _ABBREV_PATTERNS:
        name = pattern.sub(abbr, name)
    return name


def is_junk(name: str) -> bool:
    """Check if a station name is a junk/test/depot station."""
    if not isinstance(name, str) or not name.strip():
        return True
    return bool(JUNK_PATTERNS.search(name))


_NUMBERS_RE = re.compile(r'\d+')


def extract_numbers(name: str) -> list[str]:
    """Extract all numeric tokens from a station name."""
    return _NUMBERS_RE.findall(name)


def names_differ_only_by_number(name_a: str, name_b: str) -> bool:
    """Check if two names differ only in their numeric components.

    E.g. "W 63 St & Broadway" vs "W 67 St & Broadway" → True (different numbers).
    "E 17 St & Broadway" vs "E 17 St & Broadway" → False (identical).
    "Allen St & Hester St" vs "Allen St and Hester St" → False (non-numeric diff).
    """
    nums_a = extract_numbers(name_a)
    nums_b = extract_numbers(name_b)
    if nums_a == nums_b:
        return False  # same numbers (or both have none)
    # Strip all numbers and compare the "template"
    template_a = _NUMBERS_RE.sub('#', name_a)
    template_b = _NUMBERS_RE.sub('#', name_b)
    return template_a == template_b


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance in meters between two lat/lng points."""
    R = 6371000  # Earth radius in meters
    lat1, lng1, lat2, lng2 = map(radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


@dataclass
class UnionFind:
    parent: dict[str, str] = field(default_factory=dict)

    def find(self, x: str) -> str:
        if x not in self.parent:
            self.parent[x] = x
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]  # path compression
            x = self.parent[x]
        return x

    def union(self, x: str, y: str):
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[rx] = ry


def load_meta_hists(root: str) -> tuple[DataFrame, DataFrame]:
    """Load all in_* and il_* meta_hist parquets.

    Returns:
        (df_in, df_il) where:
        - df_in has columns: ym, id, name, count
        - df_il has columns: ym, id, lat, lng, count
    """
    meta_hist_dir = join(root, META_HIST_DIR)
    in_path = Path(meta_hist_dir)
    in_files = sorted(in_path.glob('in_*.parquet'))
    il_files = sorted(in_path.glob('il_*.parquet'))

    if not in_files:
        raise click.ClickException(f"No in_*.parquet files found in {meta_hist_dir}")

    in_dfs = []
    for f in in_files:
        ym = f.stem.replace('in_', '')
        df = pd.read_parquet(f)
        df['ym'] = ym
        df['id'] = df['id'].astype(str)
        in_dfs.append(df)
    df_in = pd.concat(in_dfs, ignore_index=True)

    il_dfs = []
    for f in il_files:
        ym = f.stem.replace('il_', '')
        df = pd.read_parquet(f)
        df['ym'] = ym
        df['id'] = df['id'].astype(str)
        il_dfs.append(df)
    df_il = pd.concat(il_dfs, ignore_index=True) if il_dfs else pd.DataFrame(columns=['id', 'lat', 'lng', 'count', 'ym'])

    return df_in, df_il


def build_id_summaries(
    df_in: DataFrame,
    df_il: DataFrame,
) -> DataFrame:
    """Build per-ID summary: primary name (by count), all names, weighted-avg lat/lng, first/last YM."""
    # Primary name per ID (mode by total count)
    name_counts = df_in.groupby(['id', 'name'])['count'].sum().reset_index()
    idx = name_counts.groupby('id')['count'].idxmax()
    primary_names = name_counts.loc[idx].set_index('id')['name'].rename('primary_name')

    # All names per ID
    all_names = name_counts.groupby('id').apply(
        lambda g: list(g.sort_values('count', ascending=False)['name']),
        include_groups=False,
    ).rename('all_names')

    # First/last YM per ID
    ym_range = df_in.groupby('id')['ym'].agg(['min', 'max']).rename(columns={'min': 'first_ym', 'max': 'last_ym'})

    # Total count per ID
    total_count = df_in.groupby('id')['count'].sum().rename('total_count')

    # Weighted-avg lat/lng per ID (from il_ data)
    if not df_il.empty:
        def wavg_ll(g):
            w = g['count'].values
            total = w.sum()
            if total == 0:
                return pd.Series({'lat': np.nan, 'lng': np.nan})
            return pd.Series({
                'lat': np.average(g['lat'].values, weights=w),
                'lng': np.average(g['lng'].values, weights=w),
            })
        lls = df_il.groupby('id').apply(wavg_ll, include_groups=False)
    else:
        lls = pd.DataFrame(columns=['lat', 'lng'])
        lls.index.name = 'id'

    summary = pd.concat([primary_names, all_names, ym_range, total_count, lls], axis=1)
    summary.index.name = 'id'
    return summary


def build_union_find(summary: DataFrame) -> dict[str, str]:
    """Build union-find mapping: id → canonical id (id0).

    Pass 1: Exact normalized name match → union.
    Pass 2: Fuzzy name + nearby coords + temporal adjacency → union.
    """
    uf = UnionFind()
    ids = summary.index.tolist()

    # Pre-compute normalized names
    norm_names = {
        sid: normalize_name(summary.loc[sid, 'primary_name'])
        for sid in ids
    }

    # Filter out junk stations
    non_junk_ids = [sid for sid in ids if not is_junk(summary.loc[sid, 'primary_name'])]
    junk_ids = set(ids) - set(non_junk_ids)
    if junk_ids:
        err(f"Filtered {len(junk_ids)} junk station IDs")

    # Initialize all IDs in union-find
    for sid in ids:
        uf.find(sid)

    # Pass 1: Exact normalized name → union
    name_to_ids: dict[str, list[str]] = defaultdict(list)
    for sid in non_junk_ids:
        nn = norm_names[sid]
        if nn:
            name_to_ids[nn].append(sid)

    exact_unions = 0
    for nn, group_ids in name_to_ids.items():
        if len(group_ids) > 1:
            for sid in group_ids[1:]:
                uf.union(group_ids[0], sid)
                exact_unions += 1
    err(f"Pass 1 (exact name): {exact_unions} unions across {len(name_to_ids)} unique names")

    # Pass 2: Fuzzy name + nearby coords + temporal adjacency
    fuzzy_unions = 0
    # Only attempt fuzzy matching between IDs that weren't already unioned
    # Build list of component representatives
    components: dict[str, list[str]] = defaultdict(list)
    for sid in non_junk_ids:
        components[uf.find(sid)].append(sid)

    reps = list(components.keys())
    for i, rep_a in enumerate(reps):
        ids_a = components[rep_a]
        nn_a = norm_names[ids_a[0]]
        if not nn_a:
            continue
        lat_a = summary.loc[ids_a[0], 'lat'] if 'lat' in summary.columns else np.nan
        lng_a = summary.loc[ids_a[0], 'lng'] if 'lng' in summary.columns else np.nan

        for rep_b in reps[i + 1:]:
            if uf.find(rep_a) == uf.find(rep_b):
                continue

            ids_b = components[rep_b]
            nn_b = norm_names[ids_b[0]]
            if not nn_b:
                continue

            # Name similarity
            ratio = SequenceMatcher(None, nn_a, nn_b).ratio()
            if ratio <= 0.7:
                continue

            # Reject if names differ only by street number
            # (e.g. "W 63 St & Broadway" vs "W 67 St & Broadway")
            if names_differ_only_by_number(nn_a, nn_b):
                continue

            # Location proximity (if we have coords)
            lat_b = summary.loc[ids_b[0], 'lat'] if 'lat' in summary.columns else np.nan
            lng_b = summary.loc[ids_b[0], 'lng'] if 'lng' in summary.columns else np.nan

            if not (np.isnan(lat_a) or np.isnan(lat_b)):
                dist = haversine(lat_a, lng_a, lat_b, lng_b)
                if dist > 100:
                    continue
            # If no coords available, require near-exact name similarity
            elif ratio < 0.95:
                continue

            # Temporal adjacency: check if one's last_ym is near other's first_ym
            last_a = max(summary.loc[sid, 'last_ym'] for sid in ids_a)
            first_a = min(summary.loc[sid, 'first_ym'] for sid in ids_a)
            last_b = max(summary.loc[sid, 'last_ym'] for sid in ids_b)
            first_b = min(summary.loc[sid, 'first_ym'] for sid in ids_b)

            # Check for temporal overlap or adjacency (within 6 months gap)
            def ym_diff(ym1, ym2):
                """Months between two YYYYMM strings."""
                y1, m1 = int(ym1[:4]), int(ym1[4:])
                y2, m2 = int(ym2[:4]), int(ym2[4:])
                return (y2 - y1) * 12 + (m2 - m1)

            # Check: A ends before B starts, or B ends before A starts
            gap_ab = ym_diff(last_a, first_b)  # positive means gap, negative means overlap
            gap_ba = ym_diff(last_b, first_a)
            min_gap = min(gap_ab, gap_ba)

            # Allow overlap or gap up to 6 months
            if min_gap > 6:
                continue

            uf.union(rep_a, rep_b)
            fuzzy_unions += 1

    err(f"Pass 2 (fuzzy): {fuzzy_unions} additional unions")

    # Assign canonical IDs: most recent active ID per component
    components_final: dict[str, list[str]] = defaultdict(list)
    for sid in ids:
        components_final[uf.find(sid)].append(sid)

    id_map: dict[str, str] = {}
    for root, group_ids in components_final.items():
        # Pick canonical ID: prefer most recent last_ym, then largest total_count
        best = max(
            group_ids,
            key=lambda sid: (summary.loc[sid, 'last_ym'], summary.loc[sid, 'total_count']),
        )
        for sid in group_ids:
            id_map[sid] = best

    return id_map


def extract_day_observations(parquet_path: Path) -> DataFrame:
    """Extract station observations at day level from a consolidated parquet.

    Returns DataFrame with columns: date, id, name, lat, lng
    where date is YYMMDD string, and lat/lng are rounded to 4 decimal places.
    """
    df = pd.read_parquet(parquet_path, columns=[
        'Start Time', 'Start Station ID', 'Start Station Name',
        'Start Station Latitude', 'Start Station Longitude',
        'Stop Time', 'End Station ID', 'End Station Name',
        'End Station Latitude', 'End Station Longitude',
    ])

    observations = []
    for prefix, time_col in [('Start', 'Start Time'), ('End', 'Stop Time')]:
        obs = pd.DataFrame({
            'date': df[time_col].dt.strftime('%y%m%d'),
            'id': df[f'{prefix} Station ID'].astype(str),
            'name': df[f'{prefix} Station Name'].astype(str),
            'lat': df[f'{prefix} Station Latitude'],
            'lng': df[f'{prefix} Station Longitude'],
        })
        observations.append(obs)

    combined = pd.concat(observations, ignore_index=True)
    # Drop rows with missing station info
    combined = combined.dropna(subset=['id', 'name', 'lat', 'lng'])
    combined = combined[combined['id'].str.strip() != '']

    # Group by (date, id, name), compute mean lat/lng, round to 4 decimals
    grouped = combined.groupby(['date', 'id', 'name']).agg(
        lat=('lat', 'mean'),
        lng=('lng', 'mean'),
    ).reset_index()
    grouped['lat'] = grouped['lat'].round(4)
    grouped['lng'] = grouped['lng'].round(4)

    return grouped


def build_spans(
    observations: DataFrame,
    id_map: dict[str, str],
) -> DataFrame:
    """Build station spans from day-level observations.

    Each span = a period where a station had consistent (id, name, ~location).

    Returns DataFrame with columns: id0, id, name, lat, lng, first, last
    """
    if observations.empty:
        return pd.DataFrame(columns=['id0', 'id', 'name', 'lat', 'lng', 'first', 'last'])

    # For each (id, name) pair: first_date, last_date, mean lat/lng
    spans = observations.groupby(['id', 'name']).agg(
        first=('date', 'min'),
        last=('date', 'max'),
        lat=('lat', 'mean'),
        lng=('lng', 'mean'),
    ).reset_index()
    spans['lat'] = spans['lat'].round(4)
    spans['lng'] = spans['lng'].round(4)

    # Assign id0 from union-find
    spans['id0'] = spans['id'].map(id_map)
    # IDs not in the map keep themselves as id0
    spans['id0'] = spans['id0'].fillna(spans['id'])

    # Reorder columns
    spans = spans[['id0', 'id', 'name', 'lat', 'lng', 'first', 'last']]
    spans = spans.sort_values(['id0', 'first', 'id']).reset_index(drop=True)

    return spans


def build_spans_from_meta_hists(
    summary: DataFrame,
    id_map: dict[str, str],
) -> DataFrame:
    """Build station spans from meta_hist summary (month-level granularity).

    Fallback when consolidated parquets aren't available — uses first/last YM
    from meta_hists instead of day-level dates.
    """
    rows = []
    for sid, row in summary.iterrows():
        id0 = id_map.get(sid, sid)
        lat = row.get('lat', np.nan)
        lng = row.get('lng', np.nan)
        if not np.isnan(lat):
            lat = round(lat, 4)
        if not np.isnan(lng):
            lng = round(lng, 4)
        rows.append({
            'id0': id0,
            'id': sid,
            'name': row['primary_name'],
            'lat': lat,
            'lng': lng,
            'first': row['first_ym'],
            'last': row['last_ym'],
        })
    spans = DataFrame(rows)
    spans = spans.sort_values(['id0', 'first', 'id']).reset_index(drop=True)
    return spans


def write_id_map_json(id_map: dict[str, str], path: str):
    """Write station-id-map.json."""
    parent = dirname(path)
    if not exists(parent):
        Path(parent).mkdir(parents=True, exist_ok=True)
    # Sort by key for deterministic output
    sorted_map = dict(sorted(id_map.items()))
    with open(path, 'w') as f:
        json.dump(sorted_map, f, indent=2)
        f.write('\n')
    err(f"Wrote {path} ({len(sorted_map)} entries)")


def write_mappings_yaml(spans: DataFrame, path: str):
    """Write station-mappings.yaml with ruamel.yaml (comment-preserving)."""
    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.default_flow_style = False

    # Load existing file to preserve comments
    existing = None
    if exists(path):
        with open(path) as f:
            existing = yaml.load(f)

    # Build station data from spans
    stations = {}
    for id0, group in spans.groupby('id0'):
        group = group.sort_values('first')
        # Use most recent span's name/lat/lng as current
        latest = group.iloc[-1]
        ids = {}
        for _, row in group.iterrows():
            last = row['last'] if pd.notna(row['last']) else ''
            ids[str(row['id'])] = f"{row['first']}-{last}"
        station = {
            'name': latest['name'],
            'lat': float(latest['lat']) if pd.notna(latest['lat']) else None,
            'lng': float(latest['lng']) if pd.notna(latest['lng']) else None,
            'first': str(group['first'].min()),
            'ids': ids,
        }
        stations[str(id0)] = station

    data = {'stations': stations}

    # Merge with existing data to preserve comments
    if existing and 'stations' in existing:
        for sid, station_data in data['stations'].items():
            if sid in existing['stations']:
                # Update values but existing CommentedMap preserves comments
                for key, val in station_data.items():
                    existing['stations'][sid][key] = val
            else:
                existing['stations'][sid] = station_data
        # Remove stations no longer present
        for sid in list(existing['stations'].keys()):
            if sid not in data['stations']:
                del existing['stations'][sid]
        output = existing
    else:
        output = data

    parent = dirname(path)
    if not exists(parent):
        Path(parent).mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        yaml.dump(output, f)
    err(f"Wrote {path} ({len(stations)} stations)")


def compute_stats(
    id_map: dict[str, str],
    spans: DataFrame,
    summary: DataFrame,
):
    """Print summary statistics."""
    # Canonical station count
    canonical_ids = set(id_map.values())
    multi_id = {
        id0: [sid for sid, cid in id_map.items() if cid == id0]
        for id0 in canonical_ids
    }
    multi_id_stations = {id0: ids for id0, ids in multi_id.items() if len(ids) > 1}

    total_ids = len(id_map)
    n_canonical = len(canonical_ids)
    n_multi = len(multi_id_stations)
    junk_count = sum(1 for sid in summary.index if is_junk(summary.loc[sid, 'primary_name']))

    err(f"\n=== Station Harmonization Stats ===")
    err(f"Total unique station IDs: {total_ids}")
    err(f"Canonical stations (id0s): {n_canonical}")
    err(f"Multi-ID stations: {n_multi}")
    err(f"Junk/excluded stations: {junk_count}")
    if not spans.empty:
        err(f"Total spans: {len(spans)}")
        last_max = spans['last'].dropna().max() if spans['last'].notna().any() else '(all active)'
        err(f"Date range: {spans['first'].min()} - {last_max}")

    # Largest clusters
    if multi_id_stations:
        err(f"\nLargest clusters (top 10):")
        largest = sorted(multi_id_stations.items(), key=lambda x: len(x[1]), reverse=True)[:10]
        for id0, ids in largest:
            name = summary.loc[id0, 'primary_name'] if id0 in summary.index else '?'
            err(f"  {id0} ({name}): {len(ids)} IDs → {ids}")


class StationHarmonize:
    """Station harmonization: global computation (not per-month)."""
    NAMES = ['station_harmonize', 'sh']

    def __init__(self, root: str | None = None):
        self.root = root or S3

    @property
    def history_url(self) -> str:
        return join(self.root, DIR, 'station-history.parquet')

    @property
    def id_map_url(self) -> str:
        return join(self.root, DIR, 'station-id-map.json')

    @property
    def yaml_url(self) -> str:
        return join(self.root, DIR, 'station-mappings.yaml')

    def output_urls(self) -> list[str]:
        return [self.history_url, self.id_map_url, self.yaml_url]

    def create(self):
        root = self.root
        err(f"Loading meta_hists from {root}...")
        df_in, df_il = load_meta_hists(root)
        err(f"Loaded {len(df_in)} in_ rows, {len(df_il)} il_ rows")

        err("Building per-ID summaries...")
        summary = build_id_summaries(df_in, df_il)
        err(f"  {len(summary)} unique station IDs")

        err("Building union-find (station ID mapping)...")
        id_map = build_union_find(summary)

        # Try to build day-level spans from consolidated parquets
        norm_dir = Path(join(root, f'{BKT}/normalized'))
        cons_parquets = sorted(norm_dir.glob('??????.parquet'))
        if cons_parquets:
            err(f"Extracting day-level observations from {len(cons_parquets)} consolidated parquets...")
            obs_dfs = []
            for p in cons_parquets:
                err(f"  Processing {p.name}...")
                obs = extract_day_observations(p)
                obs_dfs.append(obs)
            all_obs = pd.concat(obs_dfs, ignore_index=True)
            err(f"  {len(all_obs)} total observations")
            spans = build_spans(all_obs, id_map)
        else:
            err("No consolidated parquets found; using meta_hist month-level spans")
            spans = build_spans_from_meta_hists(summary, id_map)

        # Merge: use day-level spans where available, fill with meta_hist spans for other IDs
        if cons_parquets:
            day_ids = set(spans['id'].unique())
            missing_ids = set(summary.index) - day_ids
            if missing_ids:
                err(f"  {len(missing_ids)} IDs only in meta_hists (no consolidated data)")
                mh_spans = build_spans_from_meta_hists(
                    summary.loc[summary.index.isin(missing_ids)],
                    id_map,
                )
                spans = pd.concat([spans, mh_spans], ignore_index=True)
                spans = spans.sort_values(['id0', 'first', 'id']).reset_index(drop=True)

        # Determine which spans are "still active" (last seen in most recent month)
        most_recent = spans['last'].max()
        spans.loc[spans['last'] == most_recent, 'last'] = None

        # Write outputs
        err(f"\nWriting {self.history_url}...")
        parent = dirname(self.history_url)
        if not exists(parent):
            Path(parent).mkdir(parents=True, exist_ok=True)
        spans.to_parquet(self.history_url, index=False)
        err(f"  {len(spans)} spans")

        write_id_map_json(id_map, self.id_map_url)
        write_mappings_yaml(spans, self.yaml_url)

        compute_stats(id_map, spans, summary)


# --- CLI ---

class HarmonizeCommandGroup(StableCommandOrder):
    ALIASES = StationHarmonize.NAMES


@ctbk.group('station-harmonize', cls=HarmonizeCommandGroup, help="Station harmonization: map all historical IDs to canonical current IDs, build day-level station history.")
def station_harmonize():
    pass


@station_harmonize.command(help="Print output URLs")
def urls():
    sh = StationHarmonize()
    for url in sh.output_urls():
        print(url)


@station_harmonize.command(help="Create station history outputs (parquet, JSON, YAML)")
def create():
    sh = StationHarmonize()
    sh.create()


@station_harmonize.command(help="Print summary statistics from existing outputs")
def stats():
    sh = StationHarmonize()
    history_path = sh.history_url
    id_map_path = sh.id_map_url

    if not exists(history_path):
        raise click.ClickException(f"No station-history.parquet found at {history_path}. Run `create` first.")

    spans = pd.read_parquet(history_path)
    with open(id_map_path) as f:
        id_map = json.load(f)

    # Rebuild summary minimally for stats
    df_in, df_il = load_meta_hists(S3)
    summary = build_id_summaries(df_in, df_il)
    compute_stats(id_map, spans, summary)
