# Station Harmonize — EC2 Full Run

## Context

`ctbk station-harmonize` was implemented and tested locally with partial data:
- All 152 `in_*.parquet` meta_hists (station id+name) ✓
- Only 2 `il_*.parquet` meta_hists (station id+lat/lng) — 1,092 of 3,736 IDs lack coords
- Only 1 consolidated parquet (`202601.parquet`) — day-level spans only for Jan 2026

The commit is on `main`: `7e9d9f54`.

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
# Pull all consolidated parquets
dvc pull s3/ctbk/normalized/??????.parquet.dvc
```

These are needed for Pass 2 (day-level span extraction). Without them, spans fall back to month-level granularity from meta_hists.

### 3. Run the full harmonization

```bash
ctbk station-harmonize create
```

### 4. Review outputs

```bash
# Quick stats
ctbk station-harmonize stats

# Check known transitions
python3 -c "
import pandas as pd
df = pd.read_parquet('s3/ctbk/stations/station-history.parquet')
print(f'Spans: {len(df)}, Canonical stations: {df.id0.nunique()}')
print()
# E 17 St & Broadway
print('E 17 St & Broadway:')
print(df[df.id0 == '5980.10'].to_string())
"
```

Expected improvements with full data vs local partial run:
- More precise fuzzy matching (all IDs have coords → fewer false negatives from the no-coords path)
- Day-level `first`/`last` dates (YYMMDD) instead of month-level (YYYYMM) for all months
- More spans (stations may appear with different names across months)

### 5. Commit outputs

The generated files to commit/DVC-track:
- `s3/ctbk/stations/station-history.parquet`
- `s3/ctbk/stations/station-id-map.json`
- `s3/ctbk/stations/station-mappings.yaml`

These are small enough to commit directly to git (parquet will be ~100KB-ish, JSON ~100KB, YAML ~500KB). Or DVC-track them if preferred.

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
