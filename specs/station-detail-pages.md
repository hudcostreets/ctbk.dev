# Spec: Station Detail Pages

## Problem

ctbk.dev shows aggregate station data (maps, top stations by ridership) but has no per-station pages. Users can't drill into a specific station's history: when it opened, name changes, trip patterns over time, or real-time availability. The station-harmonize work provides canonical IDs and naming history, and the GBFS scraper is now collecting minute-level availability data — these need a frontend.

## Goal

Add `/stations/:id` pages to ctbk.dev showing a station's full history and current status.

## Data Sources

### Existing (in S3/DVC)
- **Station metadata**: `station-history.parquet` (from station-harmonize) — canonical ID, name spans, lat/lng, first/last seen dates
- **Station ID map**: `station-id-map.json` — maps historical IDs → canonical ID
- **Trip aggregates**: `aggregated/se_c_*.parquet`, `aggregated/gse_c_*.parquet` — ride counts by station, station-pair

### New (in R2)
- **Availability history**: `gbfs/status/YYYY-MM-DD.parquet` — minute-level bike/dock counts per station
- **Station info snapshots**: `gbfs/info/YYYY-MM-DD.json` — capacity, location, station type

### Joining GBFS ↔ Tripdata
GBFS uses `station_id` (UUIDs/numeric), tripdata uses `short_name` (e.g. `"6789.20"`). The join goes through `station_information.json` which has both fields. Station-harmonize's ID map should bridge these.

## Page Sections

### Header
- Station name (current), canonical ID
- Location (lat/lng on mini-map)
- Capacity (docks), station type (classic/electric)
- Open date, name history (from station-harmonize spans)

### Availability (from GBFS)
- Current status: bikes available, docks available, disabled
- Availability heatmap: time-of-day × day-of-week (avg bikes available)
- Recent trend: last 7 days line chart (bikes/docks/ebikes)
- Empty/full frequency: % of time with 0 bikes or 0 docks

### Trip Patterns (from aggregated data)
- Monthly ridership (bar chart over time)
- Top destination stations (table/bar)
- Top origin stations (table/bar)
- Rider type breakdown (member vs casual)

## Data Delivery

### Option A: Static JSON per station
Pre-generate JSON files during `ctbk update`, deploy with the site. Simple, no backend.
- Pro: No runtime infra, works with static hosting
- Con: Doesn't scale to availability history (growing daily), large deploy

### Option B: Cloudflare D1 backend
Load aggregated data into D1 (SQLite at the edge). Station pages query D1 via a Worker.
- Pro: Scales to availability history, fast edge queries, no pre-generation
- Con: More infra, need to keep D1 in sync with pipeline
- Note: crashes project already uses this pattern successfully

### Option C: DuckDB-WASM in browser
Query parquets directly from R2 (free egress). No backend.
- Pro: Zero backend, full SQL, parquets already in R2
- Con: Client-side perf, initial load time, parquet discovery

### Recommendation
Start with **Option B (D1)** for availability data (large, growing, needs aggregation). Use **Option A** for trip patterns (static, updated monthly). Evaluate D1 for trip data too once the pattern is proven.

## Dependencies

- Station-harmonize must be run with full data (EC2) to produce correct canonical IDs
- GBFS availability → D1 ingestion pipeline needed
- Trip aggregate → static JSON generation in `ctbk update`

## Open Questions

- URL scheme: `/stations/:canonical_id` or `/stations/:short_name`?
- Should station pages be SSR or client-side rendered?
- How far back should availability history go? (Full history vs rolling 30/90 days)
- Should the station list page (`/stations`) also be reworked?
