# ctbk Pipeline Architecture

This document describes the data pipeline stages and their dependencies.

## Pipeline Stages

The `ctbk` CLI provides 8 core pipeline stages, each processing Citi Bike trip data:

| Stage | CLI aliases | Description | Parameterized |
|-------|-------------|-------------|---------------|
| `TripdataZips` | `zip` | Import from s3://tripdata | by month |
| `TripdataCsvs` | `csv` | Extract and gzip CSVs | by month |
| `NormalizedMonth` | `normalized`, `norm`, `n` | Normalize & merge regions | by month |
| `ConsolidatedMonth` | `consolidated`, `cons`, `con` | Consolidate by end month | by month |
| `AggregatedMonth` | `aggregated`, `agg`, `a` | Histogram aggregations | by month + keys |
| `StationMetaHist` | `station-meta-hist`, `smh` | Station metadata histograms | by month + keys |
| `ModesMonthJson` | `station-modes-json`, `sm`, `smj` | Canonical station info | by month |
| `StationPairsJson` | `station-pairs-json`, `spj` | Station pair JSONs | by month |

Plus utility stages:
- `YmrgtbCdJson` (`ymrgtb-cd`): Dashboard aggregation (cross-month)
- `YmdgtbCdJson` (`ymdgtb-cd`): Per-station monthly trip aggregations (see *Per-Station Trips*, below)
- `Partition` (`partition`): v0 data splitting utility

## Per-Station Trips (`ymdgtb`)

`/s/:slug` renders a monthly trips chart filtered to a single station. The underlying
data is produced by running `agg` with a per-station group key:

- `agg -g ymsgtb -acd` — counts + durations keyed by (year, month, start station, gender, user type, bike type)
- `agg -g ymegtb -acd` — same, keyed by *end* station

The `YmdgtbCdJson` stage (`ymdgtb-cd`) fans these per-station aggregates into one JSON
per canonical station under `s3/ctbk/stations/ymdgtb/<short_name>.json` (DVX-tracked
via `s3/ctbk/stations/ymdgtb.dvc`).

Web side, `www/scripts/gen-ymdgtb-index.js` runs at `prebuild` time and emits
`public/ymdgtb-index.json`:

```json
{ "dir_md5": "...", "files": { "<short_name>": "<md5>" } }
```

which maps each station's short_name to the content-addressed URL of its per-station
JSON on S3 (served via the DVX cache). The `useStationTrips` hook uses this index to
lazy-fetch one station's JSON on demand — no per-station static pages, no backend.

## Station Identity & Aliases

Citi Bike renumbers stations over time; the same physical station may appear under
several `short_name`s across its history (e.g. `HB106` today, `HB609` pre-2025-06).
`s3/ctbk/stations/station-mappings.yaml` records the canonical record and the full
set of aliases with their active date ranges. `station-id-map.json` is the derived
lookup: `{ alias: canonical }` for every known identifier.

Per-station `ymdgtb` JSONs are keyed by **canonical** short_name (one file per
physical station, combining all historical ID appearances). The web-side index
enriches this with alias entries — each alias gets the canonical's md5 — so
client lookups by either form resolve to the same file.

## GBFS Availability Pipeline

Orthogonal to the trip-data pipeline above. Polls Citi Bike's GBFS feed every minute:

| Stage | Where | Purpose |
|-------|-------|---------|
| Poll | `gbfs/worker` (Cloudflare Worker cron) | Fetch station_status, append row per station to D1 day-table `availability_YYYYMMDD` |
| Serve | `gbfs/api` (Cloudflare Worker) | `/api/stations/:id/{info,range}` — D1 for hot (≤ `HOT_DAYS_RETAIN`=7d), R2 parquet fallback for cold |
| Compact | `gbfs/compact-r2.py` (GHA daily) | Drop aged-out D1 day-tables, merge into daily system-wide parquet `gbfs/parquet/YYYY-MM-DD.parquet`, slice into per-station monthly parquets `gbfs/stations/<gbfs_uuid>/<YYYY-MM>.parquet` |

Consumed by `StationDetail`'s availability chart (`uPlot`) via `useStationRange`.

See `specs/multiscale-timeseries-backend.md` for the planned rollup-pyramid extension
(minute → 5-min → hour → day → month tiers for both trips and availability).

## Dependency Graph

```
                                    ┌─────────────────────────────────────┐
                                    │         s3://tripdata               │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────────────────┐
                                    │       ZIP (TripdataZips)            │
                                    │         per month                   │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────────────────┐
                                    │       CSV (TripdataCsvs)            │
                                    │         per month                   │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────────────────┐
                                    │      NORM (NormalizedMonth)         │
                                    │   per month, split by src/end       │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────────────────┐
                                    │     CONS (ConsolidatedMonth)        │
                                    │   single parquet per end-month      │
                                    └──────────────┬──────────────────────┘
                                                   │
                       ┌───────────────────────────┼───────────────────────────┐
                       │                           │                           │
                       ▼                           ▼                           ▼
        ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
        │   AGG (AggregatedMonth)  │ │  SMH (StationMetaHist)   │ │   AGG (se, c)            │
        │   (ymrgtb, cd)           │ │   (in) + (il)            │ │   start+end, count       │
        └────────────┬─────────────┘ └────────────┬─────────────┘ └────────────┬─────────────┘
                     │                            │                            │
                     │                            ▼                            │
                     │             ┌──────────────────────────┐                │
                     │             │  AGG (e, c)              │                │
                     │             │  end station, count      │                │
                     │             └────────────┬─────────────┘                │
                     │                          │                              │
                     │                          ▼                              │
                     │             ┌──────────────────────────┐                │
                     │             │   SM (ModesMonthJson)    │◄───────────────┘
                     │             │   canonical station info │
                     │             └────────────┬─────────────┘
                     │                          │
                     │                          ▼
                     │             ┌──────────────────────────┐
                     │             │  SPJ (StationPairsJson)  │
                     │             │   station pair data      │
                     │             └──────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────┐
        │   YMRGTB_CD (dashboard)  │
        │   aggregates all months  │
        └──────────────────────────┘
```

## Stage Details

### Linear Pipeline (ZIP → CSV → NORM → CONS)

Each stage depends on the previous, processing one month at a time:

1. **ZIP**: Downloads `.csv.zip` files from `s3://tripdata`
2. **CSV**: Extracts and gzips individual CSV files
3. **NORM**: Normalizes columns, merges NYC/JC regions, splits by (source, start, end) months
4. **CONS**: Consolidates all records ending in a given month into a single parquet

### Parameterized Stages

**AggregatedMonth** supports multiple aggregation configurations:
- `-g/--group-by`: Grouping keys (e.g., `ymrgtb` = year, month, region, gender, type, bike)
- `-a/--agg-by`: Aggregation keys (e.g., `cd` = count, duration)

Common configurations:
- `agg -g ymrgtb -a cd`: Dashboard data (rides/minutes by various dimensions)
- `agg -g e -a c`: End-station counts (for station modes)
- `agg -g se -a c`: Start+end station pairs (for station pair JSONs)

**StationMetaHist** supports different metadata keys:
- `-g in`: Station ID + Name histogram
- `-g il`: Station ID + Lat/Lng histogram

### Station Sub-DAG

The station metadata pipeline forms its own dependency chain:

```
SMH(in) + SMH(il) + AGG(e,c) → SM → SPJ ← AGG(se,c)
```

- **SM (ModesMonthJson)**: Computes canonical station info by taking the mode (most common value) across the month
- **SPJ (StationPairsJson)**: Generates JSON files for station pair visualizations

### Cross-Month Stage

**YmrgtbCdJson** is unique: it aggregates `agg -g ymrgtb -a cd` outputs across ALL months into a single dashboard JSON file (`ymrgtb_cd.json`).

This is a "fan-in" pattern: ~150 monthly parquets → 1 JSON file.

**DVX Tracking Note**: Currently `www/public/assets/ymrgtb_cd.json` is Git-tracked but not DVX-tracked. Adding DVX tracking would complete the DAG visualization by showing how all monthly aggregated files flow into the final dashboard JSON. Unlike DVC (which uses `.dvc` as storage pointers), DVX `.dvx` files describe computation metadata and can coexist with Git-tracked outputs.

## Month Parameterization

All stages use `-d YYYYMM-YYYYMM` for date ranges:
- Default: `201306` (first Citi Bike data) to current month
- Single month: `-d 202401`
- Range: `-d 202401-202406`

## Stage-Level vs Instance-Level DAG

The `dvx dag` command shows the full instance-level DAG with ~150+ nodes (one per month per stage). A stage-level DAG abstracts this to show only the 8-10 stage types and their relationships, which is useful for understanding the pipeline architecture without the per-month complexity.

### Programmatic Stage DAG

Stage dependencies ARE inferable from the code. Each stage's `dep_artifacts()` method explicitly references upstream stage types:

```python
# From ModesMonthJson.dep_artifacts()
def dep_artifacts(self):
    smh_in = StationMetaHist(self.ym, 'in')
    smh_il = StationMetaHist(self.ym, 'il')
    agg_ec = AggregatedMonth(self.ym, 'e', 'c')
    return [smh_in.to_artifact(), smh_il.to_artifact(), agg_ec.to_artifact()]
```

To make this fully programmatic, options include:

1. **Class attribute** (recommended): Add `STAGE_DEPS` to each stage class:
   ```python
   class ModesMonthJson(MonthTask):
       STAGE_DEPS = [(StationMetaHist, {'in', 'il'}), (AggregatedMonth, {'e,c'})]
   ```

2. **Introspection**: Instantiate a sample task and inspect what types it references in `dep_artifacts()`

3. **Registry pattern**: Each stage registers itself and its dependencies with a central `StageRegistry`

A future `ctbk dag` command could:
1. Show the abstract stage-level DAG (this document's diagram)
2. Optionally expand to show parameterization options (e.g., `--params`)
3. Output formats: ASCII art, Mermaid, DOT/Graphviz
4. Link to `dvx dag` for full instance-level detail
