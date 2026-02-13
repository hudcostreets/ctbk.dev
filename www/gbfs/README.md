# Citi Bike GBFS Data Collection

Research notes for polling and archiving Citi Bike's GBFS (General Bikeshare Feed Specification) real-time data.

## GBFS Endpoints

| Endpoint | URL | Size | Update Frequency |
|----------|-----|------|------------------|
| Station Status | `https://gbfs.citibikenyc.com/gbfs/en/station_status.json` | ~880KB | TTL: 60s |
| Station Information | `https://gbfs.citibikenyc.com/gbfs/en/station_information.json` | ~1.5MB | Rarely (new stations) |
| System Regions | `https://gbfs.citibikenyc.com/gbfs/en/system_regions.json` | Small | Rarely |

## Regions

| Region ID | Name |
|-----------|------|
| 70 | JC District |
| 71 | NYC District |
| 185 | Bronx |
| 311 | Hoboken District |

## Example: Hoboken PATH Station

```bash
# Get station_id from station_information
curl -s 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json' | \
  jq -r '.data.stations[] | select(.name | test("Hoboken Terminal")) | .station_id'
# → cbc48689-7805-49dd-9669-5471f4b7b6fb

# Get current status
curl -s 'https://gbfs.citibikenyc.com/gbfs/en/station_status.json' | \
  jq '.data.stations[] | select(.station_id == "cbc48689-7805-49dd-9669-5471f4b7b6fb")'
```

## Data Change Analysis

From comparing two snapshots ~19 minutes apart:

| Field | Stations Changed | % |
|-------|------------------|---|
| `last_reported` | 2277 | 97.5% |
| `num_bikes_available` | 391 | 16.7% |
| `num_ebikes_available` | 326 | 14.0% |
| `num_docks_available` | 372 | 15.9% |
| `num_bikes_disabled` | 47 | 2.0% |

**Key insight**: `last_reported` changes constantly, but actual availability only changes ~15-17% of stations per minute.

## Storage Architecture Options

### Option 1: Raw Snapshots (Recommended)

Write one parquet file per minute containing all 2,335 stations.

```
s3://bucket/gbfs/snapshots/YYYY-MM-DD/HH-MM.parquet
```

- **Storage**: ~124 GB/year
- **PUTs**: 43,200/month
- **Pros**: Simple, preserves exact poll times, queryable with DuckDB
- **Cons**: Larger storage, need to scan multiple files for single-station queries

### Option 2: Station-Sharded (Don't update per-minute!)

Per-station monthly parquet files with RLE compression.

```
s3://bucket/gbfs/stations/{station_id}/YYYY-MM.parquet
```

- **Storage**: ~11 GB/year (RLE compresses repeated values)
- **PUTs**: 100M/month if updating per minute ❌
- **PUTs**: 70K/month if batching daily ✓

### Option 3: Hybrid

Write snapshots per-minute, reshape into station-shards daily via batch job.

- **Storage**: ~135 GB/year (both formats)
- **Best for**: Audit trail + fast single-station queries

## Cost Estimates (3 years)

| Architecture | S3 | R2 | Wasabi |
|--------------|-----|-----|--------|
| Raw snapshots only | $161 | $107 | $39 |
| Station-sharded (per-min) | $18,170 💀 | $16,350 💀 | $4 |
| Hybrid | $187 | $127 | $43 |

**Recommendation**: Raw snapshots on **Wasabi** (~$1/month) or **R2** (~$3/month).

- Both have zero egress fees
- R2: No minimum retention, 10GB free tier
- Wasabi: Cheapest, but 90-day minimum retention

## Existing Archives

| Source | Data | Public? |
|--------|------|---------|
| [Citi Bike tripdata](https://s3.amazonaws.com/tripdata/index.html) | Completed trips (CSV) | ✅ |
| [macwright's archive](https://macwright.com/2023/09/17/bikeshare-1) | GBFS every 5min since Jul 2023 | ❌ (R2, private) |
| [NYCComptroller template](https://github.com/NYCComptroller/citi-bike-gbfs) | DIY GitHub Actions | Template only |

**Nobody is publishing an ongoing public archive of real-time station availability.**

## Implementation Notes

Based on the [awair](https://github.com/runsascoded/awair) project architecture:

- Lambda triggered by EventBridge every minute
- Write to S3/R2/Wasabi with atomic updates
- Monthly sharding reduces write amplification
- Web dashboard reads parquet directly from object storage
