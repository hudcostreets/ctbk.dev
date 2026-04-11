# Spec: Cloudflare D1 Backend for ctbk.dev

## Problem

ctbk.dev is a static site that pre-generates all data as JSON/parquet files. This works for aggregate views (monthly ridership charts) but doesn't scale for:
- Per-station detail pages (2600+ stations × growing availability history)
- Querying availability data (3.4M rows/day, ~12MB parquet/day in R2)
- Interactive filtering/aggregation that can't be pre-computed

## Goal

Add a Cloudflare D1 (edge SQLite) backend for queryable station data. The crashes project (`hccs/crashes`) already uses this pattern — a D1 database populated by a Worker or GHA, queried by the frontend via a Worker API.

## Architecture

```
R2 (parquets) → GHA/Worker (ETL) → D1 (SQLite) → Worker API → Frontend
```

### What goes in D1

| Table | Source | Update Freq | Rows (est.) |
|-------|--------|-------------|-------------|
| `stations` | station-harmonize outputs | Monthly | ~2,600 |
| `station_spans` | station-history.parquet | Monthly | ~3,700 |
| `station_availability_hourly` | GBFS daily parquets (aggregated) | Daily | ~57K/day |
| `station_trips_monthly` | aggregated parquets | Monthly | ~2,600/month |
| `station_pairs_monthly` | station-pair JSONs | Monthly | ~50K/month |

### What stays in R2/S3
- Raw per-minute GBFS WAL JSONs (archival, too granular for D1)
- Full daily GBFS parquets (available for DuckDB-WASM deep-dive if needed)
- Consolidated trip parquets (source of truth, too large for D1)

### Key: Aggregate before loading
Don't put 3.4M rows/day into D1. Pre-aggregate availability to hourly resolution:
- Per station per hour: avg/min/max bikes, docks, ebikes; minutes empty; minutes full
- ~2,360 stations × 24 hours = 56,640 rows/day = ~20M rows/year
- D1 free tier: 5GB, paid: 5GB included + $0.75/GB. Hourly aggregates fit comfortably.

## Implementation Phases

### Phase 1: Station metadata in D1
- `stations` table: canonical ID, current name, lat/lng, capacity, open date
- `station_spans` table: name/ID history from station-harmonize
- Worker API: `GET /api/stations`, `GET /api/stations/:id`
- Frontend: station list page, station detail header

### Phase 2: Availability data in D1
- GHA job (daily, after compaction): read daily parquet from R2, aggregate to hourly, insert into D1
- `station_availability_hourly` table
- Worker API: `GET /api/stations/:id/availability?from=&to=`
- Frontend: availability heatmaps, trend charts on station detail pages

### Phase 3: Trip data in D1
- Monthly load after `ctbk update`: insert per-station monthly trip counts, top pairs
- `station_trips_monthly`, `station_pairs_monthly` tables
- Worker API: `GET /api/stations/:id/trips`
- Frontend: trip pattern charts on station detail pages

## D1 Schema (Phase 1)

```sql
CREATE TABLE stations (
  id TEXT PRIMARY KEY,           -- canonical station ID (short_name)
  name TEXT NOT NULL,            -- current name
  lat REAL, lng REAL,
  capacity INTEGER,
  station_type TEXT,             -- 'classic' | 'electric'
  first_seen TEXT,               -- YYYY-MM-DD
  last_seen TEXT,
  gbfs_station_id TEXT           -- UUID from GBFS, for availability join
);

CREATE TABLE station_spans (
  id TEXT NOT NULL,              -- canonical station ID
  historical_id TEXT NOT NULL,   -- ID during this span
  name TEXT NOT NULL,
  lat REAL, lng REAL,
  first_date TEXT,               -- YYYY-MM-DD
  last_date TEXT,
  FOREIGN KEY (id) REFERENCES stations(id)
);
CREATE INDEX idx_spans_id ON station_spans(id);
```

## Relation to Existing Infra

- **R2 bucket `ctbk`**: already exists, stores GBFS data. D1 reads from here.
- **`ctbk-gbfs-poller` Worker**: unchanged, writes to R2.
- **`gbfs-compact.yml` GHA**: produces daily parquets. Add a post-compaction step to load into D1.
- **New Worker**: `ctbk-api` — serves D1 queries to the frontend.
- **Frontend**: Add fetch calls to `ctbk-api` Worker for station data.

## Open Questions

- Should the API Worker live in this repo (`gbfs/api/`) or a separate repo?
- D1 database name/binding conventions (follow crashes project pattern?)
- Auth for write operations (GHA → D1): use Worker with shared secret, or D1 HTTP API?
- Should we use the same D1 database as crashes, or separate? (Probably separate — different data domains.)
