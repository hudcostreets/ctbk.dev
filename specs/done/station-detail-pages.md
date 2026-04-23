# Spec: Station Detail Pages

## Problem

ctbk.dev shows aggregate station data (maps, top stations by ridership) but has no per-station pages. Users can't drill into a specific station's history: when it opened, name changes, trip patterns over time, or real-time availability. The station-harmonize work provides canonical IDs and naming history, and the GBFS scraper is now collecting minute-level availability data — these need a frontend.

## Goal

Add `/stations/:id` pages to ctbk.dev showing a station's full history and current status, including interactive multi-resolution availability charts.

## Data Sources

### Existing (in S3/DVC)
- **Station metadata**: `station-history.parquet` (from station-harmonize) — canonical ID, name spans, lat/lng, first/last seen dates
- **Station ID map**: `station-id-map.json` — maps historical IDs → canonical ID
- **Trip aggregates**: `aggregated/se_c_*.parquet`, `aggregated/gse_c_*.parquet` — ride counts by station, station-pair

### GBFS (in R2)
- **Daily parquets**: `gbfs/status/YYYY-MM-DD.parquet` — minute-level bike/dock counts, all stations (~12-18 MB/day)
- **Per-station parquets**: `gbfs/stations/{station_id}/availability.parquet` — per-station slices, append-only (~20 MB/station/year) *(to be built)*
- **Station info snapshots**: `gbfs/info/YYYY-MM-DD.json` — capacity, location, station type

### Joining GBFS ↔ Tripdata
GBFS uses `station_id` (UUIDs/numeric), tripdata uses `short_name` (e.g. `"6789.20"`). The join goes through `station_information.json` which has both fields. Station-harmonize's ID map bridges these.

## Architecture: hyparquet + pltly (no TSDB)

### Key insight
The awair project (`$c/awair`) already solves multi-resolution time series visualization with the same data profile (~1 sample/minute, months-years of history). The pattern:

1. Store raw minute-level data as **static parquet files** (one per station)
2. Load in browser via **hyparquet** (pure JS parquet reader, ~100KB)
3. Aggregate on-the-fly via **pltly** based on visible time range and container width
4. Auto-select window size (1m → 2m → 5m → ... → 1d → 2d) to maintain ~200-400 visible points

**No pre-computed rollups, no TSDB, no D1 for availability data.** Client-side aggregation handles the full range from "zoom into 1 hour" (show per-minute) to "view 2 years" (show daily averages).

### Why this works for GBFS
- Per station: ~525K rows/year, ~20MB parquet — comparable to a single awair sensor
- hyparquet loads and parses this in the browser efficiently
- pltly's `aggregate()` handles windowing, mean/stddev/min/max per metric
- No server-side query infrastructure needed

### Data pipeline

```
Per-minute WAL JSONs (R2, from poller Worker)
  ↓  GHA daily (compact-r2.py)
Daily parquet (R2)                    ← archival, all stations
  ↓  GHA daily (new: slice step)
Per-station parquets (R2)             ← one per station, append-only
  ↓  browser fetch
hyparquet → pltly aggregation         ← auto window, no pre-rollups
```

### What this means for D1
D1 is **not** needed for availability data. D1 is only for:
- Station metadata (names, history, canonical IDs)
- Trip aggregates (monthly ridership, top pairs)
- Anything that needs cross-station queries

### Live map view
For the map view showing current availability across all stations: the poller already writes a ~581KB JSON snapshot every minute. The frontend can fetch the latest snapshot directly from R2 (or via a Worker that caches it). No D1 or per-station slicing needed for this view.

## Per-station parquet slicing

### Generation
Add a post-compaction step to `compact-r2.py` (or a separate script):
1. Read the daily parquet
2. Group by `station_id`
3. Append each group to `gbfs/stations/{station_id}/availability.parquet`

### Size estimates
- Per station: ~1,440 rows/day × 12 cols × 365 days ≈ 20 MB/year in parquet
- All stations: ~2,600 × 20 MB ≈ 50 GB/year (R2 storage cost: ~$0.75/year)
- Individual file loads in browser: 20 MB for a full year, less for recent data

### Partitioning strategy
After a few years, per-station files may get large (60+ MB). Options:
- Partition by year: `gbfs/stations/{id}/2026.parquet`, `gbfs/stations/{id}/2027.parquet`
- Let pltly load only the relevant partition(s) for the visible time range
- Defer this until files actually get too large

## Page Sections

### Header
- Station name (current), canonical ID
- Location (lat/lng on mini-map)
- Capacity (docks), station type (classic/electric)
- Open date, name history (from station-harmonize spans)

### Availability (from per-station parquet via hyparquet + pltly)
- Current status: bikes available, docks available, disabled
- Interactive time series chart: zoom from minutes to years
  - Default view: last 7 days
  - Metrics: bikes, ebikes, docks, disabled
  - Rolling averages + stddev bands (pltly built-in)
  - Gap detection for missing data (pltly built-in)
- Availability heatmap: time-of-day × day-of-week (computed client-side from raw data)

### Trip Patterns (from aggregated data, static JSON or D1)
- Monthly ridership (bar chart over time)
- Top destination stations (table/bar)
- Top origin stations (table/bar)
- Rider type breakdown (member vs casual)

## pltly factoring opportunity

awair, ctbk, and apvd ($c/apvd) all use pltly for client-side time series from static parquets. As we build this, look for patterns to factor into pltly or a companion library:
- hyparquet loading + pltly aggregation hooks (awair's `useDataAggregation`)
- Per-station/per-device data slicing patterns
- Parquet → pltly data shape conversion

## Dependencies

- Station-harmonize full run on EC2 (in progress) → canonical IDs, name history
- Per-station parquet slicing in GHA compaction pipeline
- pltly integration in ctbk.dev frontend

## Open Questions

- URL scheme: `/stations/:canonical_id` or `/stations/:short_name`?
- Should station pages be lazy-loaded routes or part of the main bundle?
- How far back should per-station parquets go? (From start of GBFS collection, Apr 2026)
- Should the station list page (`/stations`) also be reworked to show availability?
