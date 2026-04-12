# Station Harmonize — EC2 Full Run

## Context

`ctbk station-harmonize` was implemented and tested locally with partial data:
- All 152 `in_*.parquet` meta_hists (station id+name) ✓
- Only 2 `il_*.parquet` meta_hists (station id+lat/lng) — 1,092 of 3,736 IDs lack coords
- Only 1 consolidated parquet (`202601.parquet`) — day-level spans only for Jan 2026

The incremental-harmonize spec is done — it caches observations in `station-observations.parquet` so subsequent runs only process new months.

## Prerequisites

### 1. Sync repo to latest `h/main`

The EC2 repo may be behind. Recent changes include:
- GBFS scraper/compactor work
- `compact-r2.py` rewrite (aws s3 instead of wrangler)
- `ctbk update` command (includes station-harmonize by default unless `-S`)
- Poller worker cleanup (compaction removed)

```bash
git fetch h && git merge --ff-only h/main
```

### 2. Check existing state

An earlier session on `e` may have already done partial work. Check:

```bash
# Are station-harmonize outputs already present?
ls -la s3/ctbk/stations/station-history.parquet
ls -la s3/ctbk/stations/station-id-map.json
ls -la s3/ctbk/stations/station-mappings.yaml

# Is the observations cache present? (from incremental-harmonize)
ls -la s3/ctbk/stations/station-observations.parquet

# How many consolidated parquets are pulled?
ls s3/ctbk/normalized/*.parquet 2>/dev/null | wc -l
```

If `station-observations.parquet` exists, the run will be incremental (only processing months not in the cache). If not, it will do a full scan of all consolidated parquets.

## What to do on EC2

### 1. DVC-pull the `il_*` parquets

```bash
# Pull all il_ meta_hist parquets (only 2 are local currently)
dvc pull s3/ctbk/stations/meta_hists/il_*.parquet.dvc
```

This gives coords for all station IDs, which:
- Improves union-find Pass 2 (fuzzy matching uses haversine distance)
- Fills in lat/lng for spans that currently show NaN

### 2. DVC-pull consolidated parquets (for day-level spans)

```bash
# Pull all consolidated parquets (~10.5GB total)
dvc pull s3/ctbk/normalized/??????.parquet.dvc
```

These are needed for day-level span extraction. Without them, spans fall back to month-level granularity from meta_hists.

**Note**: This is the main reason EC2 is needed — ~10.5GB of parquets won't fit comfortably on a laptop SSD alongside everything else.

### 3. Run the full harmonization

```bash
ctbk station-harmonize create
```

This will:
- Load meta_hists (id+name, id+lat/lng)
- Build summaries and run union-find (Pass 1: exact name, Pass 2: fuzzy)
- Scan consolidated parquets for day-level observations (or read from cache)
- Build spans and write outputs

If `station-observations.parquet` already exists, only new months are scanned.

### 4. Review outputs

```bash
# Quick stats
python3 -c "
import pandas as pd
df = pd.read_parquet('s3/ctbk/stations/station-history.parquet')
print(f'Spans: {len(df)}, Canonical stations: {df.id0.nunique()}')
print()
# E 17 St & Broadway (known multi-ID station)
print('E 17 St & Broadway:')
print(df[df.id0 == '5980.10'].to_string())
"
```

Expected improvements with full data vs partial run:
- More precise fuzzy matching (all IDs have coords → fewer false negatives)
- Day-level `first`/`last` dates (YYYYMMDD) instead of month-level (YYYYMM)
- More spans (stations may appear with different names across months)

### 5. Commit and push outputs

The generated files to commit:
- `s3/ctbk/stations/station-history.parquet`
- `s3/ctbk/stations/station-id-map.json`
- `s3/ctbk/stations/station-mappings.yaml`
- `s3/ctbk/stations/station-observations.parquet` (DVC-tracked, ~16MB)

```bash
git add -u s3/ctbk/stations/
dvc push  # if station-observations.parquet changed
git commit -m "Re-run station-harmonize with full consolidated data"
git push h main
```

## Local run results (for comparison)

```
Total unique station IDs: 3736
Canonical stations (id0s): 2641
Multi-ID stations: 963
Junk/excluded stations: 17
Total spans: 3736
Pass 1 (exact name): 1068 unions
Pass 2 (fuzzy): 27 unions
```

## Notes on the algorithm

- The `names_differ_only_by_number()` guard is important — without it, Broadway stations chain-merge into one giant cluster (39 stations) via fuzzy name similarity
- No-coords fuzzy threshold is 0.95 (very conservative); with-coords threshold is 0.7 + haversine < 100m
- Temporal adjacency: allows overlap or gap up to 6 months between merged components
- Canonical ID (`id0`): most recently active ID per component (by `last_ym`, then `total_count`)

## What this unblocks

- Station detail pages (`specs/station-detail-pages.md`) — need canonical IDs + history
- D1 backend (`specs/d1-backend.md`) — stations table populated from these outputs
- Fully automated monthly updates — `ctbk update` includes station-harmonize by default
