# Spec: Per-Station Monthly Trip Aggregates

## Goal

On the station detail page (`/s/:slug`), render a `ymrgtb_cd`-style time series filtered to that station, with two views:
- **Trips ending here** (existing `e` station-side aggregation)
- **Trips starting here** (new `s` station-side aggregation)

Reuse the homepage's `ymrgtb` plotting machinery, just with extra filters.

## Data Pipeline

### New aggregations

`ctbk agg create` already accepts arbitrary group keys. Add two new variants to `update.sh` / `ctbk update`:

```
agg create -g ymrgtbs -acd <ym>   # → ymrgtbs_cd_<ym>.parquet
agg create -g ymrgtbe -acd <ym>   # → ymrgtbe_cd_<ym>.parquet
```

Where:
- `s` = start station id, `e` = end station id (in tripdata)
- `gtb` = gender, type, bike (existing dims)
- `cd` = count + duration (existing aggregations)
- `r` = region (NYC vs JC)
- `ym` = year-month

Note: `ctbk agg` canonicalizes group-key ordering (`y,m,d,w,h,r,g,t,b,s,e`), so the output filename is always `ymrgtbs_…` / `ymrgtbe_…` regardless of the input flag order.

Output rows have shape:
```
ym | r | s_id (or e_id) | gender | type | bike | count | duration_s
```

Estimated row counts (ballpark):
- ~3000 stations × 150 months × ~6 dim combinations active per month ≈ ~3M rows per side
- Per side: ~50–100 MB parquet

### Load into D1

Two new tables:
```sql
CREATE TABLE station_trips_starts_monthly (
  short_name TEXT NOT NULL,
  ym TEXT NOT NULL,         -- YYYYMM
  region TEXT,              -- 'NYC' | 'JC'
  gender INTEGER,           -- 0/1/2
  user_type TEXT,           -- 'Subscriber' | 'Customer'
  bike_type TEXT,           -- 'classic' | 'electric'
  trips INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  PRIMARY KEY (short_name, ym, region, gender, user_type, bike_type)
);
CREATE INDEX idx_starts_short_name ON station_trips_starts_monthly(short_name, ym);

-- Same shape for ends.
CREATE TABLE station_trips_ends_monthly ( ... );
```

D1 size estimate: ~3M rows × 2 tables × ~80 bytes ≈ ~480 MB. Within D1's 10 GB limit.

### Loader

Two options:
1. **Python script** (`gbfs/d1/load_station_trips_monthly.py`): reads aggregated parquets, batch-inserts into D1 via wrangler. Run after `ctbk update`.
2. **R2 + Worker pipeline**: parquets land in R2 (already DVC-tracked, but DVC pushes to S3). Worker consumes events. Probably overkill for monthly batch loads.

Going with (1) — simpler, sufficient cadence (monthly).

### Idempotency

- Use `INSERT OR REPLACE` on the primary key
- One run loads all months currently in `aggregated/`; subsequent runs only need new months
- Maintain a `loaded_months` table to track what's in D1

## API

### `GET /api/stations/:id/trips`

Query params:
- `side`: `start` | `end` | `both` (default `both`)
- `dim`: comma-separated dims to keep (default `ym`)
- `since`: optional `YYYYMM` filter

Response:
```json
{
  "station_id": "6879.04",
  "side": "both",
  "rows": [
    { "ym": "201306", "starts": 12, "ends": 8, "starts_duration_s": 4321, "ends_duration_s": 2987 },
    ...
  ]
}
```

For `dim=ym,bike` we'd return rows broken down by bike type as well.

Cache: 1 day (`Cache-Control: public, max-age=86400`) — historical data doesn't change.

## Frontend

### Component

`StationTripsChart` — wraps a generic `ymrgtb` time series renderer (extracted from the homepage if useful, or rebuilt with uPlot for consistency with the availability chart).

Default view: monthly bars, starts (orange) + ends (blue), stacked or side-by-side.

Toggleable dim breakdowns (similar to homepage):
- By region (NYC vs JC)
- By user type (subscriber vs customer)
- By bike type (classic vs electric)
- By gender (when reported)

### Layout on `/s/:slug`

```
[ Title + metadata ]
[ Live availability chart (today) ]
[ Map (full neighborhood, month-switchable) ]
[ Monthly trips chart (new) ]   ← this spec
```

## Implementation Phases

1. Add `agg create -g ymrgtbs -acd` and `-g ymrgtbe -acd` to `ctbk update`
2. Backfill all months: `ctbk agg create -g ymrgtbs -acd -d 201306-202603` (and `-g ymrgtbe`)
3. Write `gbfs/d1/load_station_trips_monthly.py` Python loader
4. Add D1 schema + tables; load all data
5. Add `/api/stations/:id/trips` endpoint
6. Build `StationTripsChart` component (uPlot-based, themed like availability chart)
7. Wire into `/s/:slug` page below the map

## Controls (Resolved)

The per-station chart is "the homepage plot, filtered to one station" —
all the same dim toggles (region, user type, bike type, gender), date
range selector, stacking modes, y-axis, rolling avg, stack %. Factor
with Home.tsx as shared utilities (see `specs/ymrgtb-chart-factoring.md`
— to write).

- **Date range widget**: enhance beyond the current preset durations to
  support any-month-to-any-month. Eventually support zoom into sub-daily
  (day / hour) views for this station — see `specs/station-zoom-subdaily.md`.
- **Default zoom**: show all data by default; let the user zoom in. The
  improved date widget should make this painless.
- **Totals**: yes — small stat block above the chart: total starts, total
  ends, ratio, possibly avg trips/day.

## Data size sanity check

Homepage `ymrgtb_cd.json`: 1,681 rows across ~12 years × ~11 dim combos.
Blown out by station: `1681 × 2,609 stations × 2 sides` ≈ 8.8M upper bound,
realistically 3–5M (many cells empty). Comfortable in D1 (10 GB limit).
