# ctbk.dev Roadmap

## Overview

This roadmap covers major feature areas for ctbk.dev, organized by dependencies and complexity.

---

## Phase 1: Foundation & Quick Wins

### 1.1 Hotkeys Integration ✅
**Complexity:** Low | **Dependencies:** None | **Status:** Complete

Added keyboard shortcuts using `@rdub/use-hotkeys`:

**Home page:** ✅
- `1-5` / `a` - Date range buttons (1y, 2y, 3y, 4y, 5y, All)
- `n/r/u/g/b` - Stack by None/Region/User Type/Gender/Bike Type
- `i/m` - Y axis (Rides/Minutes)
- `l` - Toggle 12mo average
- `p` - Toggle stack %
- `?` / `⌘/` - Show shortcuts modal
- Shift+letter toggles for Region (J/H/N), User Type (A/D), Gender (M/W/U), Bike Type (C/E/O)

**Stations page:** ✅
- `←/→` - Previous/next month
- `Esc` - Deselect station
- `m` - Open month selector dropdown
- `?` / `⌘/` - Show shortcuts modal

### 1.2 Month Selector Dropdown ✅
**Complexity:** Low | **Dependencies:** None | **Status:** Complete

MUI Select dropdown on /stations with all available months from manifest.

### 1.3 Screenshots Package Refactor ✅
**Complexity:** Low | **Dependencies:** `@rdub/screenshots` package | **Status:** Complete

Using `@rdub/screenshots` package from GitLab.

---

## Phase 2: Station Harmonization

### 2.1 Station Identity Mapping ✅
**Complexity:** High | **Dependencies:** None (pipeline work) | **Status:** Complete

Built. See `s3/ctbk/stations/station-mappings.yaml` (canonical records + full
alias history with date ranges), derived `station-id-map.json` (`{alias: canonical}`
lookup), and `station-slugs.json` (canonical → URL slug).

Original idea below:

```python
# Example schema
canonical_stations = {
    "HB106": {
        "name": "River St & Newark St",
        "appearances": [
            {"months": "201509-", "id": "HB106", "lat": 40.7367, "lng": -74.0290},
        ]
    },
    "NYU": {
        "name": "Washington Sq E",
        "appearances": [
            {"months": "201307-201812", "id": "519", "lat": 40.7312, "lng": -73.9971},
            {"months": "201901-", "id": "5791.01", "lat": 40.7314, "lng": -73.9969},
        ]
    }
}
```

**Detection heuristics:**
- Same name, nearby coords (<50m), different ID → likely same station moved/renumbered
- Same ID, different name → renamed
- Nearby coords, similar name (fuzzy match) → likely same

**Pipeline stage:**
- New CLI: `ctbk station-harmonize`
- Output: `s3/ctbk/station-mappings.json`
- Manual override file for edge cases: `station-bridges.yaml`

### 2.2 Per-Station Pages ✅
**Complexity:** Medium | **Dependencies:** 2.1 | **Status:** Complete

Live at `/s/:slug` (or `/s/:short_name`). Features delivered:

- Monthly trips chart via per-station `ymdgtb-cd` aggregations (`start` / `end` /
  `both` radio, plus the full homepage filter palette: User Type, Gender, Bike Type,
  stack-by, rolling avg, date range).
- Live availability chart (bikes / docks / disabled by minute, 7d default, drag-pan,
  smart polling for new data, `uPlot`-rendered).
- Station metadata header (capacity, type, first-seen date, Google Maps link).
- Map view centered on station with destination spokes (shared `StationMap`).
- URL-encoded state for every control; deep-linkable.

Completed specs: `specs/done/station-detail-pages.md`,
`specs/done/station-trips-monthly.md`, `specs/done/station-slugs.md`,
`specs/done/live-minute-refresh.md`.

---

## Phase 3: Enhanced Map Features

### 3.1 Starts vs Ends Toggle
**Complexity:** Medium | **Dependencies:** Data already exists

Current: Shows only "ends" count per station.

Enhanced options:
- Toggle: Starts / Ends / Both
- "Both" view: bi-color circles (pie chart style)
- Spokes: two colors per spoke showing direction balance

Data changes:
- Already have start/end station in pairs data
- Surface both in station JSON

### 3.2 Viewport-Based Loading
**Complexity:** Medium | **Dependencies:** None

Current: Loads all stations for a month.

Improved:
- Load stations within viewport bounds + buffer
- Use spatial indexing (geohash or quadtree)
- Progressive loading: coarse → detailed on zoom

Options:
- **Tile-based:** Pre-compute station tiles (like map tiles)
- **Query-based:** DuckDB-WASM spatial queries on client
- **Server:** Lambda/Worker with PostGIS or DuckDB

### 3.3 Routed Spokes
**Complexity:** High | **Dependencies:** External API

Instead of straight-line spokes, show actual bike routes:

**Approach:**
1. Pre-compute routes between all station pairs (one-time)
2. Use OSRM (open source) or Google Directions API
3. Store as GeoJSON LineStrings in S3
4. Aggregate overlapping segments for Sankey-style thickness

**Considerations:**
- ~2000 stations × 2000 = 4M pairs (but most have 0 rides)
- Only compute for pairs with >N rides
- Cache aggressively

---

## Phase 4: Stations Over Time Visualization

### 4.1 Station Age/Creation Map
**Complexity:** Medium | **Dependencies:** 2.1 (harmonization)

Reproduce the `stations-by-creation-date.png` visualization:
- Color stations by first appearance date
- Gradient: yellow (oldest) → red (newest)
- Legend showing date ranges

### 4.2 Animated Timeline
**Complexity:** Medium | **Dependencies:** 4.1

Animate station network growth over time:
- Month-by-month playback
- Stations appear when first seen
- Color indicates age relative to current frame
- Export as video/GIF for sharing

---

## Phase 5: Data Access & Export

### 5.1 Browse-able Data Index
**Complexity:** Medium | **Dependencies:** None

Web interface for S3 data:
- List available parquet files by stage (normalized, consolidated, aggregated)
- Preview data (first N rows)
- Download links

### 5.2 Export Formats
**Complexity:** Medium | **Dependencies:** 5.1

- CSV download (converted from parquet)
- XLSX export
- Google Sheets integration (via Sheets API)

**Implementation options:**
- Client-side: DuckDB-WASM for parquet → CSV
- Serverless: Lambda/Worker for larger exports

---

## Phase 6: Real-time Availability Data

### 6.1 GBFS Scraper ✅
**Complexity:** High | **Dependencies:** Backend infrastructure | **Status:** Complete

Running in production. Cloudflare Worker (`gbfs/worker`) polls
`station_status.json` every minute and appends rows to D1 day-tables
`availability_YYYYMMDD`. Daily GHA (`gbfs/compact-r2.py`) evicts old D1 tables
and compacts the day into R2 parquet, then slices into per-station monthly files
under `gbfs/stations/<gbfs_uuid>/<YYYY-MM>.parquet`. `HOT_DAYS_RETAIN=7` keeps
D1 as a rolling hot cache; older reads fall back to R2.

### 6.2 Availability Visualization ✅
**Complexity:** Medium | **Dependencies:** 6.1 | **Status:** Complete

Shipped on `/s/:slug`:
- `uPlot` stacked-area chart of bikes (classic + ebike) / docks / disabled.
- Drag-to-pan with duration preservation, snap-to-latest.
- Smart polling (via `useSmartPolling`) refreshes in Latest mode only.
- Legend shows current values per series; tooltip with per-series + total readouts.

### 6.3 Multi-scale availability + rides (next)
**Complexity:** High | **Dependencies:** 6.1, 2.2 | **Status:** Spec only

Extend both availability (state data) and trips (flow data) to a rollup pyramid
(1m → 5m → 1h → 1d → 1mo). Parquet-in-R2 primary storage, optional Worker, optional
DuckDB-WASM upgrade for cross-station ad-hoc queries. Extract the shared pattern
into a reusable `use-rollups` library for awair / apvd / ctbk.

See `specs/multiscale-timeseries-backend.md`.

---

## Phase 7: Multi-City Expansion

### 7.1 Other Lyft Systems
**Complexity:** Medium | **Dependencies:** Pipeline refactoring

Lyft bikeshare systems with similar data formats:
- **Bay Wheels** (San Francisco)
- **Divvy** (Chicago)
- **Capital Bikeshare** (Washington DC)
- **Bluebikes** (Boston)
- **Nice Ride** (Minneapolis)

**Work needed:**
- Generalize pipeline for different S3 sources
- City-specific UI customization
- Unified schema across cities

---

## Phase 8: Civic Integration

### 8.1 District Boundaries
**Complexity:** Medium | **Dependencies:** None

Overlay legislative/municipal boundaries:
- City Council districts
- State Assembly/Senate districts
- Census tracts
- Community boards

**Data sources:**
- NYC OpenData
- Census TIGER/Line
- OpenStates

### 8.2 Elected Officials Directory
**Complexity:** Medium | **Dependencies:** 8.1

Point-in-polygon: which officials represent each station?

**Features:**
- Display official info on station click
- Contact links (email, social)
- "Request a station" template

**APIs:**
- Google Civic Information API
- OpenStates API

---

## Backend Architecture

### Serverless-First Approach

Goal: No 24/7 server costs for low-traffic site.

**Options by use case:**

| Use Case | Recommendation |
|----------|----------------|
| Static site hosting | GitHub Pages (current) |
| Dynamic queries | DuckDB-WASM (client-side) |
| Heavy computation | AWS Lambda / CloudFlare Workers |
| Real-time scraping | Lambda + EventBridge (cron) |
| Large exports | Lambda with S3 presigned URLs |

**awair model:**
- Multiple data sources: S3-direct (hyparquet), DuckDB-WASM, Lambda, CloudFlare Workers
- Client tries fastest first, falls back
- Smart polling based on Last-Modified headers

### DuckDB-WASM for Client-Side Queries

Many features can run entirely in browser:
```javascript
import * as duckdb from '@duckdb/duckdb-wasm'

// Query parquet directly from S3
const result = await conn.query(`
  SELECT * FROM 's3://ctbk/aggregated/202311.parquet'
  WHERE start_station_id = 'HB106'
`)
```

Benefits:
- Zero server cost
- Fast for moderate data sizes
- Works offline after initial load

---

## Priority Matrix

| Feature | Impact | Effort | Dependencies | Priority |
|---------|--------|--------|--------------|----------|
| Hotkeys | Medium | Low | None | **P1** |
| Month dropdown | Medium | Low | None | **P1** |
| Station harmonization | High | High | None | **P1** |
| Per-station pages | High | Medium | Harmonization | **P2** |
| Starts/ends toggle | Medium | Medium | None | **P2** |
| Station age map | Medium | Medium | Harmonization | **P2** |
| Viewport loading | Medium | Medium | None | **P3** |
| Routed spokes | High | High | External API | **P3** |
| Data export | Medium | Medium | None | **P3** |
| GBFS scraper | High | High | Backend | **P4** |
| Multi-city | High | High | Pipeline | **P4** |
| Civic integration | Medium | Medium | GeoJSON | **P4** |

---

## Next Steps

1. **Immediate:** Hotkeys + month dropdown (quick wins)
2. **Short-term:** Station harmonization (foundational for many features)
3. **Medium-term:** Per-station pages + enhanced map
4. **Long-term:** Real-time data + multi-city
