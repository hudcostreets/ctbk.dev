# Spec: GBFS Station Availability Scraper (Done)

## What was built

Real-time Citi Bike station availability archiving via Cloudflare Worker + R2 + GHA compaction.

### Components

| Component | Location | Role |
|-----------|----------|------|
| `ctbk-gbfs-poller` | CF Worker, cron `* * * * *` | Polls GBFS `station_status` every minute, writes per-minute JSON to R2 |
| `gbfs-compact.yml` | GHA, cron `15 0 * * *` | Daily: pulls WAL JSONs from R2, compacts to parquet via pyarrow, uploads |
| `compact-r2.py` | Python script | Downloads WAL JSONs via `aws s3 sync`, compacts to parquet, uploads. Idempotent. |
| `gbfs.yml` | GHA, on push to `gbfs/worker/**` | Auto-deploys poller Worker |

### R2 Layout (`ctbk` bucket)
```
gbfs/status/YYYY-MM-DD/HH-MM.json    — per-minute WAL snapshots (~568 KB each)
gbfs/status/YYYY-MM-DD.parquet        — daily compacted parquet (~12-18 MB)
gbfs/info/YYYY-MM-DD.json             — daily station_information snapshot (~1.2 MB)
```

### Data Profile
- ~2,360 stations, 10 columns per station per snapshot
- ~1,440 snapshots/day (99.8% coverage, ~3-7 GBFS API errors/day)
- ~3.4M rows/day in compacted parquet
- ~12-18 MB/day parquet, ~800 MB/day raw JSON WAL
- Per-minute JSONs retained for 60+ days (< $1/mo R2 storage)

### What changed vs spec
- **Infra**: CF Worker + R2 instead of EC2 cron (spec recommended EC2 for MVP)
- **Compaction**: Attempted hourly parquet compaction in CF Worker (hyparquet-writer), hit 128MB memory limit on daily merge. Settled on GHA + pyarrow for daily compaction.
- **No staging JSONL**: Per-minute JSONs go directly to R2 as individual objects (WAL pattern), not appended to a local file.
- **AWS CLI for R2**: `compact-r2.py` uses `aws s3 --profile cf` (R2's S3-compat API) instead of wrangler.

### AWS profile for R2
```ini
# ~/.aws/credentials
[cf]
aws_access_key_id = <R2 key>
aws_secret_access_key = <R2 secret>

# ~/.aws/config
[profile cf]
endpoint_url = https://<account_id>.r2.cloudflarestorage.com
region = auto
```

### GHA secrets needed
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — R2 S3-compat credentials
- `CLOUDFLARE_ACCOUNT_ID` — for endpoint URL
- `CLOUDFLARE_API_TOKEN` — for Worker deployment (gbfs.yml)

## Still TODO (in other specs)
- Station detail pages with availability visualizations → `specs/station-detail-pages.md`
- D1 backend for queryable availability data → `specs/d1-backend.md`
- GC automation for old WAL files (currently manual via `compact-r2.py` or `aws s3 rm`)
