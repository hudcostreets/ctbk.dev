# Spec: Incremental `station-harmonize`

## Problem

`station-harmonize create` currently re-scans all consolidated parquets (153 and growing) to extract day-level station observations before building spans. This takes ~30 minutes and is the slowest step in `update.sh`. It's O(all months) when it should be O(1 new month).

## Goal

Make `station-harmonize create` incremental: when existing outputs exist, only process the new month's parquet and merge with cached data. Full rebuild should remain available via a flag.

## Current Flow

```
load meta_hists → build summaries → union-find → scan ALL parquets → build spans → write outputs
```

The expensive part is `extract_day_observations()` called on each of 153 parquets (~5.3M observations total).

## Proposed Flow

### 1. Cache observations

After extracting day-level observations, save them as a single parquet:

```
s3/ctbk/stations/station-observations.parquet  (~5M rows, cols: date, id, name, lat, lng)
```

### 2. Incremental update

On subsequent runs:
1. Load cached `station-observations.parquet`
2. Determine which consolidated parquets are new (compare against `last` date in cached observations, or track processed months in a metadata sidecar)
3. Extract observations only from new parquets
4. Concat with cached observations
5. Save updated cache
6. Proceed with union-find + spans as before

### 3. CLI interface

```bash
# Incremental (default when cache exists)
ctbk station-harmonize create

# Force full rebuild
ctbk station-harmonize create --full

# Just update observations cache without rebuilding spans
ctbk station-harmonize update-obs 202602
```

## Implementation

### In `harmonize.py`

Add `observations_url` property:
```python
@property
def observations_url(self) -> str:
    return join(self.root, DIR, 'station-observations.parquet')
```

Modify `create()`:
```python
def create(self, full: bool = False):
    ...
    # Try incremental
    obs_path = self.observations_url
    if not full and exists(obs_path):
        cached_obs = pd.read_parquet(obs_path)
        cached_months = set(cached_obs['date'].str[:4].unique())  # YYMM prefixes
        new_parquets = [p for p in cons_parquets if p.stem not in cached_months_yyyymm]
        if new_parquets:
            new_obs = concat([extract_day_observations(p) for p in new_parquets])
            all_obs = concat([cached_obs, new_obs])
        else:
            all_obs = cached_obs
    else:
        # Full rebuild
        all_obs = concat([extract_day_observations(p) for p in cons_parquets])

    # Save cache
    all_obs.to_parquet(obs_path, index=False)
    ...
```

### Month tracking

The observations have `date` in YYMMDD format. The consolidated parquets are named YYYYMM. To track which months are cached:
- Extract unique YYMM prefixes from cached `date` column
- Convert consolidated parquet names to YYMM format
- Diff to find new months

Alternatively, store a simple JSON sidecar `station-observations-meta.json`:
```json
{"processed_months": ["201306", "201307", ..., "202601"]}
```

## Parallelization in `update.sh`

Separate from incremental harmonize, `update.sh` should parallelize independent steps:

```bash
# Sequential: norm → cons (depends on norm)
ctbk norm create $m
ctbk cons create $m

# Parallel: these all only need consolidated output
ctbk smh create -gil $m &
ctbk smh create -gin $m &
ctbk agg create -ge -ac $m &
ctbk agg create -gse -ac $m &
ctbk agg create -g ymrgtb -acd $m &
wait

# Sequential: these need meta_hists + aggregations
ctbk station-harmonize create  # incremental
ctbk sm create $m
ctbk spj create $m

# Parallel: JSON generation
ctbk ymrgtb-cd -f &
node www/scripts/gen-station-urls.js &
wait
```

This matches the dependency graph already expressed in `ci.yml` but isn't exploited in `update.sh`.

## Estimated Impact

| Step | Current | After |
|------|---------|-------|
| `station-harmonize create` | ~30 min (153 parquets) | ~15 sec (1 parquet + cache load) |
| `update.sh` total (serial) | ~35 min | ~5 min (parallelized + incremental) |

## Files Changed

| File | Change |
|------|--------|
| `ctbk/stations/harmonize.py` | Add observations cache, incremental logic, `--full` flag |
| `update.sh` | Parallelize independent steps |

## DVC Tracking

The observations cache (`station-observations.parquet`) will be large (~50-100MB). Options:
- Track with DVC like other large files
- Keep local-only (regenerable from consolidated parquets)
- `.gitignore` it and treat as a local cache

Recommendation: `.gitignore` it — it's a derived cache, not a primary output. The primary outputs (history, id-map, mappings, births) remain DVC-tracked.
