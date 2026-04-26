# Spec: Cloudflare D1 Backend for ctbk.dev

> **Status (2026-04)**: Partially superseded. The "Out of scope: availability time series" claim below was contradicted by `specs/done/live-minute-refresh.md`, which adopted a D1 hot-cache for the last 7 days of GBFS availability. That hot-cache is now the dominant D1 cost (~$100/mo) and is being removed; see `specs/gbfs-r2-only.md`. Station-metadata + trip-aggregate use-cases in this spec remain valid and unaffected.

## Problem

ctbk.dev is a static site that pre-generates all data as JSON/parquet files. This works for aggregate views (monthly ridership charts) but doesn't scale for:
- Per-station detail pages (2,600+ stations × trip history)
- Cross-station queries (top stations by ridership, station search)
- Station metadata that changes over time (names, capacity)

## Scope — what D1 is (and isn't) for

### In scope: station metadata + trip aggregates
D1 stores queryable structured data that the frontend needs for station pages and search.

### Out of scope: availability time series
GBFS availability data is served as **static per-station parquet files** from R2, loaded directly in the browser via hyparquet, and aggregated client-side via pltly. No D1 involvement. See `specs/station-detail-pages.md` for that architecture.

### Out of scope: live availability
Current station availability (for map overlays etc.) comes directly from the per-minute GBFS snapshot (~581 KB JSON), fetched from R2 or cached by a Worker. No D1 involvement.

## Architecture

```
Station-harmonize outputs  →  GHA  →  D1 (stations, spans)
Aggregated parquets        →  GHA  →  D1 (trips, pairs)
                                       ↓
                              Worker API (ctbk-api)
                                       ↓
                                   Frontend
```

## What goes in D1

| Table | Source | Update Freq | Rows (est.) |
|-------|--------|-------------|-------------|
| `stations` | station-harmonize | Monthly | ~2,600 |
| `station_spans` | station-history.parquet | Monthly | ~3,700 |
| `station_trips_monthly` | aggregated parquets | Monthly | ~2,600/month |
| `station_pairs_monthly` | station-pair JSONs | Monthly | ~50K/month |

Total size estimate: <100 MB after years. Well within D1 limits.

## D1 Schema

```sql
CREATE TABLE stations (
  id TEXT PRIMARY KEY,              -- canonical station ID (short_name)
  name TEXT NOT NULL,               -- current name
  lat REAL, lng REAL,
  capacity INTEGER,
  station_type TEXT,                -- 'classic' | 'electric'
  first_seen TEXT,                  -- YYYY-MM-DD
  last_seen TEXT,
  gbfs_station_id TEXT              -- UUID from GBFS, for availability join
);

CREATE TABLE station_spans (
  id TEXT NOT NULL,                 -- canonical station ID
  historical_id TEXT NOT NULL,      -- ID during this span
  name TEXT NOT NULL,
  lat REAL, lng REAL,
  first_date TEXT,                  -- YYYY-MM-DD
  last_date TEXT,
  FOREIGN KEY (id) REFERENCES stations(id)
);
CREATE INDEX idx_spans_id ON station_spans(id);

CREATE TABLE station_trips_monthly (
  station_id TEXT NOT NULL,
  ym TEXT NOT NULL,                 -- YYYYMM
  start_count INTEGER DEFAULT 0,   -- rides starting here
  end_count INTEGER DEFAULT 0,     -- rides ending here
  PRIMARY KEY (station_id, ym),
  FOREIGN KEY (station_id) REFERENCES stations(id)
);

CREATE TABLE station_pairs_monthly (
  start_id TEXT NOT NULL,
  end_id TEXT NOT NULL,
  ym TEXT NOT NULL,                 -- YYYYMM
  count INTEGER NOT NULL,
  PRIMARY KEY (start_id, end_id, ym)
);
CREATE INDEX idx_pairs_start ON station_pairs_monthly(start_id, ym);
CREATE INDEX idx_pairs_end ON station_pairs_monthly(end_id, ym);
```

## Implementation Phases

### Phase 1: Station metadata
- Create D1 database, deploy `ctbk-api` Worker
- Load stations + spans from station-harmonize outputs
- Worker API: `GET /api/stations`, `GET /api/stations/:id`
- Frontend: station list page, station detail header/history

### Phase 2: Trip data
- Monthly load after `ctbk update`: parse aggregated parquets, insert into D1
- Worker API: `GET /api/stations/:id/trips`, `GET /api/stations/:id/pairs`
- Frontend: trip pattern charts on station detail pages

### Phase 3: Search + cross-station queries
- Full-text search on station names
- Top stations by ridership (queryable from D1)
- Nearest stations (by lat/lng, using bounding box query)

## Relation to existing infra

- **R2 bucket `ctbk`**: Stores GBFS parquets (availability) and per-station slices. D1 does NOT read from R2.
- **`ctbk-gbfs-poller` Worker**: Unchanged, writes to R2.
- **`gbfs-compact.yml` GHA**: Produces daily parquets + per-station slices. No D1 interaction.
- **New `ctbk-api` Worker**: Serves D1 queries. Lives in this repo at `api/` or `workers/api/`.
- **Frontend**: Fetches station metadata from `ctbk-api`, availability parquets from R2.

## Precedent: crashes project

The crashes project (`$c/hccs/crashes`) uses D1 successfully:
- Crash data loaded into D1 via Worker
- Frontend queries D1 for filtered/aggregated views
- Follow the same patterns for Worker structure, D1 bindings, auth

## Open Questions

- Should the API Worker live in this repo (`api/`) or separate?
- D1 database name/binding conventions — follow crashes pattern?
- Auth for write operations (GHA → D1): shared secret header, or D1 HTTP API directly?
- Same D1 database as crashes, or separate? (Probably separate — different data domains)
