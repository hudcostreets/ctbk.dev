# ctbk Pipeline Architecture

This document describes the data pipeline stages and their dependencies.

> **Current serving (2026-08):** the trips ETL below produces content-addressed
> outputs in the DVX cache (`s3://ctbk/.dvc/files/md5/…`, migrating to R2 behind
> `data.ctbk.dev`). On top of them, the **pyrmts rollup-pyramid** serves every
> rides chart (homepage + `/s/:slug`) via the CF api worker (`/api/rides-v5` prod,
> `/api/rides-v3` per-station) — it superseded the `ymrgtb_cd.json` / per-station-JSON
> flow, which survives only as a `?tsrc=legacy` fallback. See `specs/rides-v5.md`.
> The `csv` extract stage is **orphaned**: `norm` reads `s3://tripdata` zips directly.

## Pipeline Stages

The `ctbk` CLI provides 7 core pipeline stages, each processing Citi Bike trip data:

| Stage | CLI aliases | Description | Parameterized |
|-------|-------------|-------------|---------------|
| `TripdataZips` | `zip` | Import from s3://tripdata | by month |
| `NormalizedMonth` | `normalized`, `norm`, `n` | Normalize & merge regions (reads zips directly) | by month |
| `ConsolidatedMonth` | `consolidated`, `cons`, `con` | Consolidate by end month | by month |
| `AggregatedMonth` | `aggregated`, `agg`, `a` | Histogram aggregations | by month + keys |
| `StationMetaHist` | `station-meta-hist`, `smh` | Station metadata histograms | by month + keys |
| `ModesMonthJson` | `station-modes-json`, `sm`, `smj` | Canonical station info | by month |
| `StationPairsJson` | `station-pairs-json`, `spj` | Station pair JSONs | by month |

Plus utility / legacy stages:
- `station-trips-json`: Per-station monthly trip JSONs — the `ymdgtb` artifact (see *Per-Station Trips*, below)
- `Partition` (`partition`): v0 data splitting utility
- `TripdataCsvs` (`csv`): **orphaned** as of ~Feb 2025 — `norm` now reads the `.csv.zip`s directly, so nothing depends on the extracted/gzipped CSVs. The stage class + CLI subcommand still exist but are not part of the live DAG (and are absent from the `/pipeline` diagram).

## Per-Station Trips (`ymdgtb`)

`/s/:slug` renders a monthly trips chart filtered to a single station. By default this
is served by the rides pyramid (`/api/rides-v3`); the per-station JSONs below are the
`?tsrc=legacy` fallback. They are (re)built each month by the `station-trips-json` stage
(`ctbk update` runs `station-trips-json -a -d`), a whole-history rebuild from the
`ymrgtb{s,e}_cd` aggregates — running `agg` with a per-station group key:

- `agg -g ymsgtb -acd` — counts + durations keyed by (year, month, start station, gender, user type, bike type)
- `agg -g ymegtb -acd` — same, keyed by *end* station

The `station-trips-json` stage fans these per-station aggregates into one JSON
per canonical station under `s3/ctbk/stations/ymdgtb/<short_name>.json` (DVX-tracked
via `s3/ctbk/stations/ymdgtb.dvc`).

Web side, `www/scripts/gen-ymdgtb-index.js` runs at `prebuild` time and emits
`public/ymdgtb-index.json`:

```json
{ "dir_md5": "...", "files": { "<short_name>": "<md5>" } }
```

which maps each station's short_name to the content-addressed URL of its per-station
JSON on S3 (served via the DVX cache). The `useStationTrips` hook uses this index to
lazy-fetch one station's JSON on demand — no per-station static pages, no backend.

> **`normalized/` plain-key mirror.** Besides the content-addressed DVX blobs, `norm`
> outputs are also mirrored to month-keyed plain keys (`s3://ctbk/normalized/YYYYMM.parquet`)
> because the rides pyramid's Batch factory discovers months by *listing* that prefix
> (content-addressed blobs aren't listable-by-month). This is the one live plain-key
> mirror; it moves to R2 alongside the pyramid engine (`specs/s3-to-r2-migration.md`).

## Station Identity & Aliases

Citi Bike renumbers stations over time; the same physical station may appear under
several `short_name`s across its history (e.g. `HB106` today, `HB609` pre-2025-06).
`s3/ctbk/stations/station-mappings.yaml` records the canonical record and the full
set of aliases with their active date ranges. `station-id-map.json` is the derived
lookup: `{ alias: canonical }` for every known identifier.

Per-station `ymdgtb` JSONs are keyed by **canonical** short_name (one file per
physical station, combining all historical ID appearances). The web-side index
enriches this with alias entries — each alias gets the canonical's md5 — so
client lookups by either form resolve to the same file.

## GBFS Availability Pipeline

Orthogonal to the trip-data pipeline above. Polls Citi Bike's GBFS feed every minute:

| Stage | Where | Purpose |
|-------|-------|---------|
| Poll | `gbfs/worker` (CFW, cron `* * * * *`) | Fetch `station_status.json`, write WAL JSON to R2 at `gbfs/status/YYYY-MM-DD/HH-MM.json` (~580 KB / file). Daily, also fetch `station_information.json` → `gbfs/info/YYYY-MM-DD.json`. |
| Load | `gbfs/loader` (CFW, R2-event queue consumer) | On each new WAL JSON: `INSERT OR REPLACE` ~2,360 rows into D1 day-table `availability_YYYYMMDD` (created on demand). Daily info → upsert into D1 `stations` table. |
| Serve | `gbfs/api` (CFW) | `/api/stations/:id/{today,range}`, `/api/query`, `/api/totals`, `/api/rides`. D1 for hot (≤ `HOT_DAYS_RETAIN`=7d), R2 parquet fallback for cold. Daily cron (`0 1 * * *`) drops D1 day-tables older than retention. |
| Compact | `gbfs/compact-r2.py` (GHA, cron `15 0 * * *`) | Pulls yesterday's WAL JSONs from R2, writes `gbfs/status/YYYY-MM-DD.parquet` (system-wide, ~12-18 MB), and slices into per-station files `gbfs/stations/<gbfs_uuid>/<YYYY-MM>.parquet`. |

Consumed by `StationDetail`'s availability chart (`uPlot`) via `useStationRange`.

> **Cost note (2026-04)**: the loader pattern writes ~2,360 rows × 1,440 polls/day = ~102MM logical inserts/month into D1. Billed at ~150MM rows-written/month (incl. `INSERT OR REPLACE` re-writes when GBFS `last_updated` repeats across polls + auto-PK index updates) ≈ **$100/mo** at $1/MM beyond the 50MM free tier. Migration plan: replace the D1 loader with hourly R2-side compaction, serve availability from R2 parquet only. See `specs/gbfs-r2-only.md`.

See `specs/multiscale-timeseries-backend.md` for the rollup-pyramid design
(minute → 5-min → hour → day → month tiers for both trips and availability). The **rides**
pyramid is shipped in prod (`/api/rides-v5`); the **availability** pyramid is being brought
up alongside the R2-only migration (`avail/n1/...` + `avail/agg/{tier}/...`).

## Dependency Graph

```
                                    ┌─────────────────────────────────────┐
                                    │         s3://tripdata               │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────────────────┐
                                    │       ZIP (TripdataZips)            │
                                    │         per month                   │
                                    └──────────────┬──────────────────────┘
                                                   │  (norm reads zips directly;
                                                   ▼   the CSV extract stage is orphaned)
                                    ┌─────────────────────────────────────┐
                                    │      NORM (NormalizedMonth)         │
                                    │   per month, split by src/end       │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────────────────┐
                                    │     CONS (ConsolidatedMonth)        │
                                    │   single parquet per end-month      │
                                    └──────────────┬──────────────────────┘
                                                   │
                       ┌───────────────────────────┼───────────────────────────┐
                       │                           │                           │
                       ▼                           ▼                           ▼
        ┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
        │   AGG (AggregatedMonth)  │ │  SMH (StationMetaHist)   │ │   AGG (se, c)            │
        │   (ymrgtb, cd)           │ │   (in) + (il)            │ │   start+end, count       │
        └────────────┬─────────────┘ └────────────┬─────────────┘ └────────────┬─────────────┘
                     │                            │                            │
                     │                            ▼                            │
                     │             ┌──────────────────────────┐                │
                     │             │  AGG (e, c)              │                │
                     │             │  end station, count      │                │
                     │             └────────────┬─────────────┘                │
                     │                          │                              │
                     │                          ▼                              │
                     │             ┌──────────────────────────┐                │
                     │             │   SM (ModesMonthJson)    │◄───────────────┘
                     │             │   canonical station info │
                     │             └────────────┬─────────────┘
                     │                          │
                     │                          ▼
                     │             ┌──────────────────────────┐
                     │             │  SPJ (StationPairsJson)  │
                     │             │   station pair data      │
                     │             └──────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────┐
        │   YMRGTB_CD (dashboard)  │
        │   aggregates all months  │
        │   (legacy: ?tsrc=legacy) │
        └──────────────────────────┘
```

This is the *logical* stage DAG (and, like `ctbk dag`'s ASCII/Mermaid output, is
hand-maintained — see *Stage-Level vs Instance-Level DAG*, below, for what's actually
derived from `dvx`). Note the live rides serving path — the pyrmts rollup-pyramid built
from CONS tiles — is **not** in
this graph: it writes to R2 only (no DVX artifacts), so it has no `.dvc` provenance to
appear here. `YMRGTB_CD` is the pyramid's serving-superseded predecessor (still built +
tracked, served only under `?tsrc=legacy`).

## Stage Details

### Linear Pipeline (ZIP → NORM → CONS)

Each stage depends on the previous, processing one month at a time:

1. **ZIP**: `.csv.zip` files published at `s3://tripdata`
2. **NORM**: Reads the zips **directly** (the separate `CSV` extract stage is orphaned as of ~Feb 2025), normalizes columns, merges NYC/JC regions, splits by (source, start, end) months
3. **CONS**: Consolidates all records ending in a given month into a single parquet — this is the tile source for the rides pyramid

   A ride spanning two months is published in **both** the start-month and end-month tripdata dumps, occasionally with drifted attributes (last-ULP lat/lng noise, station-ID fixups). Since CONS globs every `20*/20*_<M>.parquet` (all source dumps whose rides end in `M`), both copies are read. `resolve_cross_dump_dups` (`ctbk/consolidated.py`) keeps the copy from the **latest** source dump — keyed exactly as `dedupe_sort` (`Ride ID` from 2020 on, else `Bike ID`) — before the uniqueness assert. This makes CONS reproducible regardless of which source dumps happen to be materialized locally. (The lone `201306/201307_201307.parquet` skip is a separate hardcoded precedent for the same class of issue.)

### Parameterized Stages

**AggregatedMonth** supports multiple aggregation configurations:
- `-g/--group-by`: Grouping keys (e.g., `ymrgtb` = year, month, region, gender, type, bike)
- `-a/--agg-by`: Aggregation keys (e.g., `cd` = count, duration)

Common configurations:
- `agg -g ymrgtb -a cd`: Dashboard data (rides/minutes by various dimensions)
- `agg -g e -a c`: End-station counts (for station modes)
- `agg -g se -a c`: Start+end station pairs (for station pair JSONs)

**StationMetaHist** supports different metadata keys:
- `-g in`: Station ID + Name histogram
- `-g il`: Station ID + Lat/Lng histogram

### Station Sub-DAG

The station metadata pipeline forms its own dependency chain:

```
SMH(in) + SMH(il) + AGG(e,c) → SM → SPJ ← AGG(se,c)
```

- **SM (ModesMonthJson)**: Computes canonical station info by taking the mode (most common value) across the month
- **SPJ (StationPairsJson)**: Generates JSON files for station pair visualizations

## Month Parameterization

All stages use `-d YYYYMM-YYYYMM` for date ranges:
- Default: `201306` (first Citi Bike data) to current month
- Single month: `-d 202401`
- Range: `-d 202401-202406`

## Stage-Level vs Instance-Level DAG

The `dvx dag` command shows the full instance-level DAG with ~150+ nodes (one per month per stage). A stage-level DAG abstracts this to show only the 8-10 stage types and their relationships, which is useful for understanding the pipeline architecture without the per-month complexity.

### Programmatic Stage DAG

Stage dependencies ARE inferable from the code. Each stage's `dep_artifacts()` method explicitly references upstream stage types:

```python
# From ModesMonthJson.dep_artifacts()
def dep_artifacts(self):
    smh_in = StationMetaHist(self.ym, 'in')
    smh_il = StationMetaHist(self.ym, 'il')
    agg_ec = AggregatedMonth(self.ym, 'e', 'c')
    return [smh_in.to_artifact(), smh_il.to_artifact(), agg_ec.to_artifact()]
```

The `ctbk dag` command (`ctbk/stage_dag.py`) renders this stage-level abstraction — but
mind which formats are authoritative:

- `ctbk dag -f json` — **derived from `dvx dag --json`**: shells out to it and collapses the instance-level graph (~150+ nodes, one per month per stage) down to the stage types. This is the ground truth (and the shape `www/public/assets/dag.json` is built from). `-i <file>` reformats a saved `dvx dag --json` dump instead of re-running it; `-o <file>` writes to a file.
- `ctbk dag` / `ctbk dag -f ascii` — a **hardcoded string literal**.
- `ctbk dag -f mermaid` — rendered from a **hand-maintained `STAGE_DEPS` dict** in `stage_dag.py`.

So ascii/mermaid (and this document's graph) are documentation mirrors that can drift; only `-f json` reflects the recorded provenance. To sanity-check the mirrors, diff their edges against `ctbk dag -f json`.
