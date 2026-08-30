# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **ctbk.dev** - a data pipeline and visualization dashboard for NYC Citi Bike trip data. The project combines:
- Python CLI (`ctbk`) for ETL data processing 
- Next.js web dashboard at ctbk.dev
- Automated data ingestion via GitHub Actions
- DVC (Data Version Control) for data versioning with S3 backend

## Core Architecture

### Data Pipeline Flow
```
s3://tripdata (.csv.zip) → norm → cons ─┬→ agg (histograms: e_c, se_c, ymrgtb_cd, ymrgtbs_cd, ymrgtbe_cd)
                                        ├→ smh → sm → spj
                                        └→ station-trips-json (per-station ymdgtb JSONs)
```

The monthly driver is `ctbk update -S <YYYYMM>` (`ctbk/update.py`) — `norm` reads the `s3://tripdata` `.csv.zip`s **directly** (the old `csv` extract stage is orphaned). Stage outputs are content-addressed in the DVX cache (`s3://ctbk/.dvc/files/md5/…`, migrating to R2 behind `data.ctbk.dev`; see `specs/s3-to-r2-migration.md`).

Two serving stacks sit on top of these outputs:
- **Rides** (homepage + `/s/:slug` charts): the **pyrmts** rollup-pyramid — `normalized/*.parquet` tiles built on AWS Batch, registered in Cloudflare D1, served by the CF api worker (`/api/rides-v5` default, `/api/rides-v3` per-station). Superseded the legacy `ymrgtb_cd.json` / per-station-JSON flow (still reachable via `?tsrc=legacy`). The pyramid rebuild runs separately from `ctbk update` (R2-only writes).
- **Availability**: the GBFS subsystem under `gbfs/` (see below).

The pipeline processes raw Citi Bike `.csv.zip` files through multiple stages:
1. **Normalization**: Read `.csv.zip`s straight from `s3://tripdata`; merge NYC/JC regions, harmonize columns, split by (source, start, end) months
2. **Consolidation**: Combine all records ending in a given month into a single parquet
3. **Aggregation**: Generate histograms by various dimensions (time, station, user type, etc.)
4. **Station metadata**: Compute canonical station info and ride counts between station pairs

### Normalized vs Consolidated Structure
The `s3/ctbk/normalized/` directory contains two types of DVC-tracked outputs per month:

- **`YYYYMM/`** (directory): Output of `ctbk norm create`, contains parquet files split by source month
  - Example: `202006/202005_202006.parquet` = rides from May 2020 tripdata that ended in June 2020
  - Tracked by `YYYYMM.dvc`

- **`YYYYMM.parquet`** (single file): Output of `ctbk cons create`, the canonical consolidated month
  - Combines all records from any normalized directory that end in this month
  - Tracked by `YYYYMM.parquet.dvc`

**Special case**: Months 202001-202101 have additional "v0" input data (`normalized/v0/`) used for backfilling older columns (Gender, Birth Year, Bike ID) that were removed in 202102

### Key Directories
- `/ctbk/` - Python package with CLI and data processing logic
- `/www/` - Next.js frontend dashboard
- `/s3/` - Local mirror of S3 data structure with DVC tracking
- `/nbs/` - Jupyter notebooks for analysis
- `/gbfs/` - Real-time station availability subsystem (orthogonal to trips ETL)
  - `worker/` — CFW cron `* * * * *`, polls GBFS `station_status.json` → R2 WAL JSONs
  - `loader/` — CFW R2-event queue consumer, ingests WAL → D1 hot-cache (last 7 days)
  - `api/` — CFW serving `/api/stations/*`, `/api/query`, `/api/totals`, `/api/rides`
  - `compact-r2.py` — GHA daily compaction: WAL JSONs → daily/per-station parquet on R2
  - See `docs/pipeline.md` GBFS section + `specs/gbfs-r2-only.md` (migration in flight)

## Essential Commands

### Python CLI Setup
```bash
pip install -e .
```
This installs the `ctbk` command with CLI entry points.

### Python Data Processing
```bash
# Process a new month of data (using update.sh)
./update.sh 202506

# Generate "station-pairs-json" data, locally, for all months
ctbk station-pairs-json create

# Process specific date ranges for different stages
ctbk normalized -d 202206-202209 create
ctbk aggregated -g "ymd" -a "c" -d 202206-202209 create

# View URLs that would be processed
ctbk normalized -d 202206-202209 urls
```

The `ctbk` CLI has subcommands for each pipeline stage: `zip`, `csv`, `normalized`, `aggregated`, `station-meta-hist`, `station-modes-json`, `station-pairs-json`.

### Key CLI Options
Most `create` commands support:
- `-G, --no-git` - Skip git/DVC workflow integration
- `-e, --engine` - Parquet engine selection (for normalized)
- `-g, --group-by` - Grouping keys (for aggregated)
- `-a, --aggregate-by` - Aggregation keys (for aggregated)

### Frontend Development
```bash
cd www/
npm run dev         # Development server
npm run build       # Production build
npm run export      # Static site export
npm run lint        # ESLint
npm run tc          # TypeScript check
npm run scrns       # Generate screenshots
```

### Testing and Quality
- **Python**: `ctbk/tests/` (`test_csvs`, `test_rides_v3_luc`, `test_avail_v3_cascade`, `test_lambda_exec`) + `ctbk/pyramid_cascade/tests/` (rides-source, rebuild, engine-check, vocab, …). Run with `pytest`.
- **Frontend**: No unit tests configured, only linting/type checking
- **No CI test execution**: GitHub Actions focus on data processing and deployment
- **Linting**: Use `npm run lint` for frontend, no Python linting configured

## Data Processing Details

### Current Working Structure
- **Local data**: Stored under `s3/ctbk/` directory mirroring S3 structure
- **DVC integration**: All data files tracked with `.dvc` files for version control
- **Git workflow**: Commands automatically stage DVC changes unless `-G/--no-git` used

### Key CLI Patterns
- Use `-d YYYYMM-YYYYMM` for date ranges
- Each subcommand supports `urls` (preview paths) and `create` (generate data)
- Pipeline stages depend on predecessors (e.g., `aggregated` requires `normalized`)
- Data stored locally in `s3/ctbk/` with DVC tracking

### Storage and Versioning
- **Local development**: Data in `s3/ctbk/` with `.dvc` tracking files
- **Production**: Data synchronized to `s3://ctbk/` via DVC
- **Public access**: Datasets served content-addressed from the DVX cache (`s3://ctbk/.dvc/files/md5/…`), migrating to R2 behind `data.ctbk.dev` (`specs/s3-to-r2-migration.md`). The frontend already reads `data.ctbk.dev`; the browsable `ctbk.s3.amazonaws.com/index.html` listing remains on S3.

## Automation

### GitHub Actions
- **CI** (`.github/workflows/ci.yml`): Monthly data ingestion from s3://tripdata
- **Website** (`.github/workflows/www.yml`): Deployment to GitHub Pages on www branch
- **No test automation**: Actions focus on ETL and deployment only

### Monthly Data Updates
CI (`.github/workflows/ci.yml`) polls for new Citi Bike data monthly and runs the whole pipeline for the new month via a single driver, `ctbk update` (`ctbk/update.py`):

```bash
ctbk update -S <YYYYMM>        # -S skips station-harmonize (whole-history; CI runs it separately)
```

which runs, in order: `norm` → `cons` → `smh -gil` / `smh -gin` → `agg` ×5 (`-ge -ac`, `-gse -ac`, `-g ymrgtb -acd`, `-g ymrgtbs -acd`, `-g ymrgtbe -acd`) → `sm` → `spj` → `station-trips-json -a -d` (per-station ymdgtb JSONs) → `node www/scripts/gen-station-urls.js`. The rides rollup-pyramid rebuild (R2-only, no DVX artifacts) runs afterward as a separate best-effort CI step. The root `update.sh` is a thin deprecated pointer to this command.

## Development Notes

### Code Style
- Python uses Click for CLI framework
- Frontend uses Next.js 14 with TypeScript
- Data processing relies heavily on pandas/pyarrow
- Visualization uses Plotly.js and Leaflet maps

### Key Dependencies
- **Python**: pandas, pyarrow, boto3, s3fs, dvc-s3, plotly, click
- **Frontend**: Next.js, React, @mui/material, plotly.js, leaflet

### Configuration Files
- `setup.py` - Python package with `ctbk` and `yms` CLI entry points
- `www/package.json` - Frontend dependencies and scripts
- `requirements.txt` - Python dependencies
- ESLint/TypeScript configured for frontend code quality

### Data Version Control
The project uses DVC extensively:
- Data files tracked with `.dvc` files in git
- Remote storage in S3 (`s3://ctbk/`)
- Use `-G/--no-git` flag to skip DVC workflow during development
