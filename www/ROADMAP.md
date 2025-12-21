# ctbk.dev Roadmap

## Overview

This roadmap covers major feature areas for ctbk.dev, organized by dependencies and complexity.

---

## Phase 1: Foundation & Quick Wins

### 1.1 Hotkeys Integration
**Complexity:** Low | **Dependencies:** None

Add keyboard shortcuts using `@rdub/use-hotkeys`:

**Home page:**
- `1-5` / `a` - Date range buttons (1y, 2y, 3y, 4y, 5y, All)
- `r` - Cycle regions
- `s` - Cycle stack-by options
- `y` - Toggle Y axis (Rides/Minutes)
- `l` - Toggle legend
- `?` - Show shortcuts modal

**Stations page:**
- `←/→` - Previous/next month
- `Esc` - Deselect station
- `m` - Open month selector dropdown

**Implementation:**
```bash
pnpm add @rdub/use-hotkeys
```
- Wrap app in `KeyboardShortcutsProvider`
- Define hotkey map similar to awair
- Add `ShortcutsModal` component

### 1.2 Month Selector Dropdown
**Complexity:** Low | **Dependencies:** None

Replace text month display with dropdown on /stations:
- Dropdown of all available months (from manifest)
- Optionally: month range selector for aggregated views

### 1.3 Screenshots Package Refactor
**Complexity:** Low | **Dependencies:** `@rdub/screenshots` package

Replace local `screenshots.js` with shared package.

---

## Phase 2: Station Harmonization

### 2.1 Station Identity Mapping
**Complexity:** High | **Dependencies:** None (pipeline work)

Build a mapping from "canonical station ID" to historical appearances:

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

### 2.2 Per-Station Pages
**Complexity:** Medium | **Dependencies:** 2.1

Route: `/stations/:canonicalId`

Features:
- Same plot controls as homepage
- Filter data to rides starting/ending at this station
- Station metadata (name, coords, first/last seen)
- Link to map view centered on station

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

### 6.1 GBFS Scraper
**Complexity:** High | **Dependencies:** Backend infrastructure

Citi Bike publishes GBFS (General Bikeshare Feed Specification):
- `station_status.json` - real-time bike/dock availability
- Updated every ~1 minute

**Pipeline:**
1. Lambda/cron job scrapes every minute
2. Append to time-series parquet files
3. Aggregate hourly/daily summaries

**Storage estimate:**
- ~2000 stations × 1440 minutes/day × 365 days = ~1B rows/year
- Partitioned by date, compressed: ~10-50GB/year

### 6.2 Availability Visualization
**Complexity:** Medium | **Dependencies:** 6.1

- Heatmap: bike availability over time
- Station-level charts: availability patterns
- Alerts: stations frequently empty/full

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
