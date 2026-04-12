# Spec: Per-Station `ymdgtb_cd.json` Static Files

## Goal

Serve per-station monthly trip history as static JSON files, mirroring the
homepage's `ymrgtb_cd.json` pattern. One file per canonical station,
drop-in compatible with the existing homepage chart component.

Supersedes the D1-backed `station_trips_monthly` approach. That was
over-engineered for read-only monthly data that never changes.

## Naming

New dim letter: **`d`** for "docking/undocking" (i.e. whether the station
was a dock-in or dock-out for that row). Values: `'start' | 'end'`
(or `1/0` for compactness).

- Filename convention: **`ymdgtb_cd`** (year/month/docking/gender/type/bike,
  counts+durations).
- Drop `r` (region) since each station is in one region. Store region as
  file-level metadata if needed.

## File Format

One JSON file per canonical station:

```
s3://ctbk/stations/{short_name}/ymdgtb_cd.json
```

or equivalent R2 path. Each row:

```json
{
  "Year": 2023,
  "Month": 7,
  "Docking": "start",
  "Gender": 0,
  "User Type": "Annual",
  "Rideable Type": "classic",
  "Count": 124,
  "Duration": 987654
}
```

Sized: per-station files average ~100-500 rows × ~80 bytes ≈ 8-40 KB
(uncompressed), ~2-10 KB gzipped. 2,609 stations × ~5 KB gz ≈ ~15 MB
total.

Optional small companion `meta.json` per station with region,
capacity, name spans etc. (or just read this from the existing
`station-info` API).

## Generation

Python script, run as part of `ctbk update` (or as a separate ctbk
subcommand):

```bash
ctbk station-trips create
```

Reads all `s3/ctbk/aggregated/ymrgtbs_cd_<ym>.parquet` and
`ymrgtbe_cd_<ym>.parquet` files. For each canonical station, collects
rows from both sides (tagging `Docking` appropriately), writes one
compact JSON file per station.

### Incremental updates

When a new month's parquets arrive, we only need to update 2,609 files
by appending the new month's rows. For simplicity, can regen all files
each run — it's cheap (~15 MB total write).

## DVC Tracking

Going with **one `.dvc` for the whole directory** (`s3/ctbk/stations/ymdgtb/`)
rather than 2,609 individual `.dvc` files:

- Simpler: one tracked artifact, one push, one pull
- Each pipeline run rewrites the directory contents wholesale (or
  incrementally; either way DVC just re-hashes the dir)
- Git commit has one `.dvc` diff, not 2,609
- Still efficient for DVX (content-addressed chunks under the hood)

Schematically:

```
s3/ctbk/stations/
  ymdgtb/               # DVC-tracked dir (one .dvc file)
    00284700-.../ymdgtb_cd.json
    ...
```

Well — actually, dir-level tracking. But the stations are keyed by
short_name (canonical tripdata ID), not GBFS UUID. So:

```
s3/ctbk/stations/ymdgtb/
  6879.04.json
  5980.10.json
  ...
```

Flatter, easier.

## Serving

Option A: **www/public asset copy**. Copy the directory to `www/public/`
at build time; deployed alongside the site. Cache indefinitely via
`Cache-Control: public, max-age=31536000, immutable`.

Option B: **R2 with a pass-through domain**. Files live in R2, served
via a Worker or Cloudflare's R2 public-bucket feature. Client fetches
directly.

A is simplest. Go with A unless the asset size becomes an issue
(currently ~15 MB, well within reason).

## Frontend

The `StationDetail` page fetches
`/assets/ymdgtb/{short_name}/ymdgtb_cd.json` (adjusting path based on
deployment structure), passes rows to a refactored chart component
shared with the homepage.

The homepage chart component needs minor tweaks:
- Accept a `docking?: 'start' | 'end' | 'both'` filter (default 'both')
- The `StackBy` enum gains a `'Docking'` option

## D1 Cleanup

Drop the `station_trips_monthly` + `trips_loaded` tables from D1 (or
leave them; they cost almost nothing. But the loader script
(`load_station_trips_monthly.py`) is no longer part of the canonical
path. Mark it deprecated or delete.

## Migration / Back-Compat

The `/api/stations/:id/trips` endpoint can either:
1. **Redirect**: `302 → /assets/ymdgtb/<short_name>/ymdgtb_cd.json`
2. **Read static JSON**: fetch from R2/static, return same shape
3. **Remove**: ask frontend to fetch static directly (no API involvement)

I'd go with **#3**. One less CFW endpoint to maintain.

## Phases

1. Write `ctbk station-trips create` (or whatever name) to generate
   per-station JSONs from existing aggregated parquets
2. Add to `ctbk update`
3. Backfill all stations (EC2, one-time)
4. DVC-track the directory, push
5. Copy into `www/public/` at build time (vite config or a pre-build
   hook)
6. Update `StationDetail` to fetch from static
7. Drop or repurpose the D1 trips tables + loader

## Open Questions

- Gzip on R2 / served from `/public`? Vite handles gzip for assets at
  build; R2 supports `Content-Encoding: gzip` if pre-gzipped.
- Will 2,609 small files in `www/public/` slow down Vite's build?
  Probably worth verifying; if so, use dynamic fetch from R2 instead.
- Do we need a station index (slug → file path) or just assume the
  slug/short_name mapping?
