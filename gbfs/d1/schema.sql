-- D1 schema for ctbk-gbfs.
-- One table per day: availability_YYYYMMDD
-- The loader Worker creates the day's table on-demand if it doesn't exist.
-- The daily archival job DROPs old tables.

-- Template (per-day table, created dynamically by the loader Worker):
--
-- CREATE TABLE IF NOT EXISTS availability_YYYYMMDD (
--   station_id           TEXT    NOT NULL,
--   ts                   INTEGER NOT NULL,
--   polled_at            INTEGER NOT NULL,
--   num_bikes_available  INTEGER NOT NULL,
--   num_ebikes_available INTEGER NOT NULL,
--   num_docks_available  INTEGER NOT NULL,
--   num_bikes_disabled   INTEGER NOT NULL,
--   num_docks_disabled   INTEGER NOT NULL,
--   is_installed         INTEGER NOT NULL,
--   is_renting           INTEGER NOT NULL,
--   is_returning         INTEGER NOT NULL,
--   last_reported        INTEGER NOT NULL,
--   PRIMARY KEY (station_id, ts)
-- );

-- Helper table tracking which day-tables exist (so the API worker
-- doesn't have to query sqlite_master on every request).
CREATE TABLE IF NOT EXISTS day_tables (
  date TEXT PRIMARY KEY,           -- YYYY-MM-DD
  table_name TEXT NOT NULL,        -- availability_YYYYMMDD
  created_at INTEGER NOT NULL,     -- unix timestamp
  row_count INTEGER DEFAULT 0      -- updated by loader, optional
);

-- Stations table: union of all stations ever seen (additive-only).
-- Sources: station-history.parquet (tripdata corpus), GBFS info JSON.
-- Never delete — stations that disappear from GBFS still queryable.
CREATE TABLE IF NOT EXISTS stations (
  short_name TEXT PRIMARY KEY,     -- canonical, from station-harmonize / GBFS short_name
  gbfs_station_id TEXT UNIQUE,     -- GBFS UUID; null for tripdata-only historical
  name TEXT,                       -- current/latest name
  lat REAL,
  lon REAL,
  capacity INTEGER,                -- GBFS only
  station_type TEXT,               -- GBFS only ('classic' | 'electric')
  first_seen TEXT,                 -- YYYY-MM-DD (from station-harmonize)
  last_seen TEXT,
  in_gbfs INTEGER DEFAULT 0,       -- 1 if seen in latest GBFS feed
  updated_at INTEGER NOT NULL      -- unix timestamp of last upsert
);
CREATE INDEX IF NOT EXISTS idx_stations_gbfs_id ON stations(gbfs_station_id);

-- Per-station monthly trip counts and durations.
-- Loaded from `aggregated/ymrsgtb_cd_<ym>.parquet` (is_start=1) and
-- `aggregated/ymregtb_cd_<ym>.parquet` (is_start=0). Together: ~6M rows
-- across all months / dim combinations. Drives the /s/:slug trips chart.
CREATE TABLE IF NOT EXISTS station_trips_monthly (
  short_name TEXT NOT NULL,
  ym TEXT NOT NULL,            -- YYYYMM
  is_start INTEGER NOT NULL,   -- 1 = trip started here, 0 = trip ended here
  region TEXT,                 -- 'NYC' | 'JC'
  gender INTEGER,              -- 0/1/2 (unknown/male/female; sometimes missing)
  user_type TEXT,              -- 'Subscriber' | 'Customer'
  bike_type TEXT,              -- 'classic' | 'electric'
  trips INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  PRIMARY KEY (short_name, ym, is_start, region, gender, user_type, bike_type)
);
CREATE INDEX IF NOT EXISTS idx_trips_short_name ON station_trips_monthly(short_name, ym);

-- Tracks which (ym, side) batches have been loaded into station_trips_monthly,
-- so the loader can be incremental.
CREATE TABLE IF NOT EXISTS trips_loaded (
  ym TEXT NOT NULL,
  is_start INTEGER NOT NULL,
  loaded_at INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  PRIMARY KEY (ym, is_start)
);
