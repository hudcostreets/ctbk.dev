# Spec: GBFS Station Availability Scraper

## Problem

Citi Bike publishes real-time station availability via [GBFS] (General Bikeshare Feed Specification), updated every 60 seconds. Nobody maintains a public archive of this data. The tripdata CSVs only record completed trips — they don't capture availability patterns (which stations are full/empty when, how bikes redistribute over time, seasonal capacity patterns).

## Goal

Archive Citi Bike `station_status` snapshots every minute. Make the data queryable for analysis and visualization on ctbk.dev (e.g., availability heatmaps, empty/full alerts, time-of-day patterns).

## GBFS Endpoints

Discovery URL: `https://gbfs.citibikenyc.com/gbfs/gbfs.json` (redirects to `gbfs.lyft.com/gbfs/1.1/bkn/...`)

| Feed | Size | Update Freq | Archive? |
|------|------|-------------|----------|
| `station_status.json` | 887 KB | TTL 60s | **Yes** — core data |
| `station_information.json` | 1.3 MB | Rarely | Daily snapshot only |
| Other 10 feeds | <1 KB each | Rarely | No |

### Station ID Join

`station_id` is consistent across `station_status` and `station_information` — **2,360/2,360 direct match**. IDs are a mix of UUIDs (`3371df76-39db-...`) and numeric strings (`1860190006584693708`).

The `short_name` field in `station_information` maps to tripdata station IDs (e.g., `"6789.20"`, `"HB410"`). Of 2,360 GBFS stations, **2,336 match** existing tripdata IDs. The 24 GBFS-only are likely new stations not yet in any tripdata release.

### Columns to Archive (station_status)

| Column | Type | Notes |
|--------|------|-------|
| `station_id` | str | Join key (UUID or numeric) |
| `num_bikes_available` | int | Classic bikes |
| `num_ebikes_available` | int | E-bikes |
| `num_docks_available` | int | Empty docks |
| `num_bikes_disabled` | int | Out-of-service bikes |
| `num_docks_disabled` | int | Out-of-service docks |
| `is_installed` | int | 0/1 |
| `is_renting` | int | 0/1 |
| `is_returning` | int | 0/1 |
| `last_reported` | int | Unix timestamp of station's last report |

Drop: `legacy_id`, `eightd_has_available_keys`, `num_scooters_*` (sparse/irrelevant).

### Station Activity

From a snapshot at 2026-04-06:
- 2,311 installed, 49 not installed
- 2,175 have at least one bike available
- ~50 completely empty (no bikes, no docks — likely decommissioned)
- Per the existing `www/gbfs/README.md` research: ~15-17% of stations change availability each minute

## Storage Architecture

### Daily stacked parquet (recommended)

Accumulate snapshots in memory (or append to local file), write one parquet per day:

```
gbfs/status/YYYY-MM-DD.parquet
```

Each daily file: ~1,440 snapshots × 2,360 stations = ~3.4M rows.

**Size estimates** (from actual data):

| Granularity | Raw (per-snapshot parquets) | Stacked daily parquet |
|-------------|----------------------------|----------------------|
| Per snapshot | 82 KB | — |
| Daily | 115 MB | **2.3 MB** |
| Monthly | 3.5 GB | **69 MB** |
| Yearly | 41 GB | **831 MB** |

The 50× compression from stacking comes from parquet's columnar encoding: `station_id` and boolean columns compress extremely well with dictionary/RLE encoding when repeated across 1,440 snapshots.

### Station information snapshots

Archive `station_information.json` once daily (or on detected changes):

```
gbfs/info/YYYY-MM-DD.parquet
```

This captures station additions, removals, renames, and capacity changes over time. ~2,360 rows per snapshot, negligible storage.

## Infrastructure

### Option A: Lambda + EventBridge (recommended)

```
EventBridge (every 1 min) → Lambda → accumulate in /tmp → flush to R2/S3 daily
```

**Problem**: Lambda has a 15-minute max execution time. Can't keep a process running all day.

**Workaround**: Each Lambda invocation:
1. Fetch `station_status.json` (887 KB, ~200ms)
2. Extract slim columns, write as one-row-per-station CSV/JSON to a staging prefix
3. A separate daily Lambda (or the minute-Lambda detecting midnight) reads all staging files, stacks into one parquet, writes final output, deletes staging

**Staging format**: `gbfs/staging/YYYY-MM-DD/HH-MM.json` (~50 KB each, compressed)

### Option B: EC2/cron (simplest)

A cron job on this EC2 instance:
```bash
* * * * * /path/to/gbfs-poll.py >> /var/log/gbfs-poll.log 2>&1
```

- Append each snapshot to a local daily parquet (using pyarrow append or pandas concat)
- At midnight, upload completed daily parquet to R2/S3
- Upload `station_information` once daily

**Pros**: Simplest, no Lambda cold starts, can accumulate in memory/disk easily
**Cons**: Depends on this EC2 instance staying up; no automatic retry on failure

### Option C: Hybrid — EC2 scraper + R2 storage

Run the scraper on EC2 (Option B), but write directly to R2 as staging files. A daily compaction job (Lambda or cron) reshapes into final parquets.

This gives resilience (staging files survive EC2 restarts) with simplicity (no Lambda per-minute orchestration).

### Recommendation: Option B for MVP, migrate to A/C later

Start with a simple cron script on EC2. Get data flowing. Optimize infrastructure once we've validated the data is useful and understand access patterns.

## Storage Backend

### Cloudflare R2 (recommended)

| | R2 | S3 | Wasabi |
|---|---|---|---|
| Storage/GB/mo | $0.015 | $0.023 | $0.007 |
| PUT/1K | $0.0045 | $0.005 | Free |
| Egress | **Free** | $0.09/GB | Free |
| Free tier | 10 GB + 1M ops | — | — |
| Year 1 cost | ~$0 (free tier) | ~$12 | $6.99/mo min |

R2's free egress is key for a public dataset. Can serve parquets directly to DuckDB-WASM in browser.

For MVP, write to local disk + S3 (existing infra). Migrate to R2 when we want public access.

## Implementation Plan

### Phase 1: MVP scraper (EC2 cron)

**`gbfs/poll.py`** — standalone script, run via cron every minute:

```
1. Fetch station_status.json
2. Extract slim columns + add timestamp
3. Append to daily buffer file: gbfs/data/staging/YYYY-MM-DD.jsonl
4. On first run after midnight: compact previous day's .jsonl → .parquet, upload
```

Dependencies: `requests`, `pandas`, `pyarrow` (already in venv).

**`gbfs/compact.py`** — daily compaction (called by poll.py or separate cron):

```
1. Read gbfs/data/staging/YYYY-MM-DD.jsonl
2. Stack into DataFrame, write parquet
3. Upload to S3/R2
4. Delete staging file
```

### Phase 2: Station information tracking

Daily cron to snapshot `station_information.json`:
- Diff against previous day
- Log new/removed/changed stations
- Write daily parquet

### Phase 3: Visualization on ctbk.dev

- Availability heatmap per station (time-of-day × day-of-week)
- "Station health" dashboard (frequently empty/full stations)
- Integration with existing `/stations` page (overlay current availability)
- DuckDB-WASM queries against parquets served from R2

## Files to Create

| File | Purpose |
|------|---------|
| `gbfs/poll.py` | Cron-driven scraper script |
| `gbfs/compact.py` | Daily JSONL→parquet compaction |
| `gbfs/data/` | Local data directory (gitignored) |

## Open Questions

- **Backfill**: Should we try to get historical data from macwright's archive or NYCComptroller's repo?
- **Failure handling**: If cron misses a minute (or several), should we log the gap or attempt catch-up?
- **Public access**: When do we start publishing parquets publicly? What format/schema should we commit to?
- **Retention**: Keep raw JSONL staging files for how long after compaction? (Suggest: 7 days)

[GBFS]: https://gbfs.org/specification/reference/
