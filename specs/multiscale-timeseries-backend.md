# Spec: Multi-Scale Time-Series Backend for Static Web Apps

Status: design proposal, feedback wanted. Supersedes / unifies:
- `specs/station-zoom-subdaily.md` (sub-daily ride counts)
- parts of `specs/station-trips-monthly.md` (per-station monthly ride counts)
- the implicit "availability for 14d is slow" problem on `/s/:slug`

## Motivation

Two current painpoints on `/s/:slug`:

1. **Availability chart is minute-granular only.** Queries for 7d already feel snappy (D1 hot cache); 14d+ touches the R2-per-station-month parquets and user sees lag; months / years of minute-resolution data is a non-starter (volume alone is prohibitive, and minute bins are noise at that scale anyway).
2. **Ride-count chart is monthly-only.** Monthly bars are good overview but obscure commute peaks, weekend effects, hour-by-hour patterns at a station. We want to zoom from month → day → hour when the visible window justifies it.

Both share the same shape: **a multi-scale time-series that needs to stream efficiently from static-ish storage into plots that auto-pick the right resolution for the visible window.** awair, apvd, and anything else I build later have the same need. The design should be lifted into a library.

## Non-goals (for now)

- Fully live/streaming updates at non-minute resolutions. Hot path stays minute-granular D1; rollups are batch / daily.
- Cross-station ad-hoc queries ("top 10 stations by volume in arbitrary window"). The pyramid is station-indexed. Ad-hoc slicing is a future extension (DuckDB-WASM or a dedicated OLAP store).
- Interactivity requiring the client to re-aggregate raw points on-demand. Client never sees per-minute data outside the 7d hot window.

---

## Storage model

### Current state (availability)

- **D1**: per-day tables `availability_YYYYMMDD` (UTC). Retained 7 days (`HOT_DAYS_RETAIN`).
- **R2**: daily system-wide parquet `gbfs/parquet/YYYY-MM-DD.parquet`, plus per-station monthly slices `gbfs/stations/<gbfs_uuid>/<YYYY-MM>.parquet`. Written by `compact-r2.py` after D1 eviction.
- **Worker**: picks D1 for recent dates (< cutoff), R2 per-station parquet for older.

This works up to ~month-scale queries at minute granularity, but reading 30 days × 1440 rows/station = 43k minute rows to render on a chart sized for a few hundred pixels is wasteful at best.

### Proposed: resolution pyramid in R2 + D1 ring buffer

Add precomputed **rollup tiers** alongside the per-station minute data. Each tier is a separate R2 layout (or D1 table, for the most-requested):

| Tier     | Bucket size | Retention      | Where                                             |
|----------|-------------|----------------|---------------------------------------------------|
| `raw`    | 1 min       | 7d (D1) / all (R2 monthly) | `availability_YYYYMMDD` D1 + `gbfs/stations/<uuid>/<YYYY-MM>.parquet` R2 |
| `m5`     | 5 min       | all            | `gbfs/stations/<uuid>/m5/<YYYY-MM>.parquet` R2    |
| `h1`     | 1 hour      | all            | `gbfs/stations/<uuid>/h1/<YYYY>.parquet` R2       |
| `d1`     | 1 day       | all            | `gbfs/stations/<uuid>/d1.parquet` R2 (single file per station) |
| `mo1`    | 1 month     | all            | `gbfs/stations/<uuid>/mo1.parquet` R2             |

Sizes (rough, 2500 stations, ~3 years history):
- `raw`: ~2500 × 1440 × 1100d ≈ 4 G rows total; ~50–100 GB compressed across per-station parquets. Already what we're doing.
- `m5`: 12× smaller than raw → ~5 GB.
- `h1`: 60× smaller → ~500 MB total.
- `d1`: 1440× smaller → ~20 MB total.
- `mo1`: tiny; in-memory scale.

The library / pipeline emits all tiers from the raw parquets via a single batch job (daily, after compaction). Tier files are immutable and perfectly cacheable.

### Aggregation semantics for availability

Availability numbers are **not additive** — you can't sum bikes-at-12:00 and bikes-at-12:01 to get a meaningful thing. Each rollup row needs a richer schema than "sum":

| Column pattern | Reason |
|---|---|
| `<field>_mean` | default line trace for "average bikes available in window" |
| `<field>_min`, `<field>_max` | envelope/whisker |
| `<field>_p05`, `<field>_p25`, `<field>_p50`, `<field>_p75`, `<field>_p95` | box-plot + confidence band |
| `<field>_last` | most-recent value in window; useful for legend "now" readouts that match coarse scales |
| `sample_count` | completeness / gap detection |
| `polled_at_start`, `polled_at_end` | exact window bounds (because sample cadence isn't perfectly minute-aligned) |

Fields with this schema: `num_bikes_available`, `num_ebikes_available`, `num_docks_available`, `num_bikes_disabled`, `num_docks_disabled`. That's 5 fields × 8 agg columns = ~40 columns per row. Parquet compresses well with dictionary + delta encoding; realistic size per rollup row ≈ 100 bytes uncompressed.

**Reuse across projects:** this same schema covers awair's sensor data (temp/humidity/CO2/VOC/PM). The library should let callers pass a list of fields + which aggs to compute per field — awair may want `mean`+`p05`+`p95` on temp but only `mean`+`max` on CO2.

**Smoothing:** awair applies a smoother on top of the raw samples. With the rollup pyramid, smoothing becomes implicit (the `mean` column at `m5` is an exponential-ish smoother already). If we want explicit additional smoothing for aesthetics, apply it client-side on the already-small returned rows.

---

## Ride counts multi-scale

Currently `ctbk agg create` with `-g ymrgtb -acd` produces monthly system-wide totals. For per-station, we have `ymrgtbs_cd` (starts) / `ymrgtbe_cd` (ends) from `station-trips-monthly.md` (per `/s/:slug` feature).

### Extend granularity on both

Add tiers analogous to availability:

| Tier   | Group keys                              | File layout                                       |
|--------|-----------------------------------------|---------------------------------------------------|
| `mo1`  | `ymrgtb`  (system) / `ymsgtb`  (per-station start) / `ymegtb` (per-station end) | existing; `s3/ctbk/aggregated/<ym>/...` |
| `d1`   | `ymdrgtb` / `ymdsgtb` / `ymdegtb`       | `gbfs/trips/system/d1/<YYYY>.parquet` etc.        |
| `h1`   | `ymdhrgtb` / `ymdhsgtb` / `ymdhegtb`    | `gbfs/trips/system/h1/<YYYY-MM>.parquet` etc.     |

Row count estimates (conservative, ~12 years):
- `d1` system-wide: 365 × 12 × 2 regions × ~6 dim-combos ≈ 50k rows. Trivial.
- `d1` per-station: 365 × 12 × 3000 stations × 2 sides × ~3 combos ≈ 80M rows total. Stored per-station, a given query is ~5k rows. Fine.
- `h1` system-wide: 24× of `d1` ≈ 1M rows. Still fine as one file per month.
- `h1` per-station: 24× → ~2 B rows across all stations in total. Per station ≈ 100k rows. Fine for parquet; avoid loading all at once client-side.

**Aggregation semantics for ride counts** is simpler than availability: sums compose. Per-row schema:

| Column | Notes |
|---|---|
| `ym` / `ymd` / `ymdh` | time key |
| dim columns | `r`/`g`/`t`/`b` per tier and side |
| `count` | number of rides |
| `duration_s` | total ride-seconds |

No percentile columns needed — sum aggregates faithfully at all scales.

### "Availability as an aggregation" question

User asked: can bike / dock availability be a "value" aggregation output the same way `c` / `d` are for ride counts? Short answer: **not directly, but related via the above rollup schema.** Ride counts are flow data (events); availability is state data (snapshots). You don't sum snapshots — you average them, or take quantiles.

I'd model it as a separate family: alongside `c`/`d` (count, duration, both additive over rides), introduce `a` for availability that emits the full `mean`/`min`/`max`/`p05..p95` column family. But the aggregation pipeline is wholly different (ingests `availability_YYYYMMDD` D1 rows, not ride records), so sharing the `ctbk agg` CLI surface may add confusion for not much gain.

**Recommendation:** keep availability rollups as their own pipeline (triggered by the same compaction job that already slices per-station monthlies). Don't try to fold into `ctbk agg`. If we extract a library, the library expresses both patterns via the same "field + agg ops" config — the fact that they run through different ingestion pipelines is an implementation detail.

---

## Serving layer

### API shape (library-ready)

```
GET /api/stations/:id/availability
  ?from=<unix-s>&to=<unix-s>
  &scale=auto|raw|m5|h1|d1|mo1
  &fields=bikes,ebikes,docks,disabled
  &aggs=mean,p05,p95          // subset of available aggs
→ { scale: "m5", fields: [...], rows: [{ ts, bikes_mean, bikes_p05, ... }, ...] }

GET /api/stations/:id/trips
  ?from=&to=
  &scale=auto|mo1|d1|h1
  &side=start|end
  &dims=r,g,t,b               // which dim columns to break out
→ { scale: "h1", rows: [{ ts, ..., count, duration_s }, ...] }

GET /api/system/trips
  ?from=&to=&scale=auto&dims=r,g,t,b
→ same shape but cross-station
```

`scale=auto`: worker picks the coarsest tier such that `ceil((to - from) / bucket_seconds)` is ≤ `maxPoints` (default ~500, configurable via query param). Falls back to finer if no data is available at that tier.

### Worker routing

- `raw` queries inside the D1 retention window → D1 per-day tables.
- `raw` queries outside → R2 `gbfs/stations/<uuid>/<YYYY-MM>.parquet` (existing).
- `m5` / `h1` / `d1` / `mo1` queries → R2 rollup parquets at the chosen tier.
- Cross-tier gaps: when a query crosses the D1/R2 boundary, stitch the two ranges server-side. Already doing this for `raw`.

Responses are deterministic for a given (tier, from, to, fields, aggs) — perfect for Cache API. Set long `Cache-Control` (`public, max-age=3600, s-maxage=86400`) on anything that's a complete immutable tier file read; shorter for `raw` at the edge of retention where data is still being appended.

### Static asset fallback (no-worker mode)

For projects that don't want a Worker tier, the library should also support a **purely static** mode: the rollup parquets live on any HTTP server / R2 / S3 / GH Pages, and the client issues Range Requests directly to read just the rows it needs. Tier metadata (list of available tiers, file paths, row-group indexes) lives in a small `manifest.json` — similar to what we do today for the `/stations` page's `station-urls.json`.

In practice, use a Worker when caching + CORS + header munging matters, and the static mode as a fallback / development convenience.

---

## Client library / hooks

Proposed package name: **`use-rollups`** (echoes `use-kbd` / `use-prms`).

### React hooks

```ts
const { data, isPending, scale } = useRollupQuery({
  endpoint: '/api/stations/{id}/availability',
  params: { id: '8-ave-w-33-st' },
  fromS, toS,
  fields: ['bikes', 'ebikes', 'docks'],
  aggs: ['mean', 'p05', 'p95'],
  targetPoints: 500,   // for auto scale
})
```

Behavior:
- Fires a TSQ query keyed on `(endpoint, params, scale_or_auto, from, to, fields, aggs)`.
- Snaps `fromS` / `toS` to the tier's bucket grid so keys are stable across small drag-pan motions.
- Widens the fetched window by a configurable buffer factor (match today's `bufferedBounds`) so drag-pan within buffer is instant.
- Returns the resolved `scale` so the caller can adjust rendering (e.g. bars vs lines, tooltip formatting).

### uPlot / Plotly helpers

A second surface in the library converts aggregated rows into chart traces:

```ts
const { lines, bands } = buildAvailabilityTraces(rows, scale, {
  fields: ['bikes', 'ebikes', ...],
  band: { lo: 'p05', hi: 'p95' }   // render p05/p95 as a filled confidence band
})
```

This keeps the chart components dumb — they receive `AlignedData`-shaped arrays + decorations and render. Reusable across awair / ctbk / apvd.

---

## Implementation phases

Each phase is independently valuable and commits as its own feature.

### Phase 1 — availability rollups (highest pain, smallest scope)

Pain point we close: "14d+ availability query is slow, and minute data past a week is silly."

1. Add `compact-r2.py rollup <date>` (or new script) that, for each station, reads the raw per-station parquets and writes `m5`, `h1`, `d1`, `mo1` rollup parquets. Schema per the "aggregation semantics" section above.
2. Backfill: run the rollup job once across all historical dates.
3. Daily backfill hook: the existing `gbfs-compact.yml` GHA job calls the rollup step after slicing per-station monthly files.
4. Worker: extend `/api/stations/:id/range` with an optional `scale` param (default `auto`) + serve from rollup R2 files when `scale > raw`.
5. Client `StationDetail`: replace the hardcoded minute query with a resolution-aware fetch. Show `mean` line; optionally `p05/p95` band (toggle or default-on when scale is coarser than `m5`).
6. Default range is now 7d (already landed); up to users whether we bump defaults higher once rollups land.

### Phase 2 — ride-count rollups

Pain point: monthly-only trips chart; can't see commute patterns.

1. Extend `ctbk agg create` to accept `-g ymd` / `-g ymdh` with appropriate group-key canonicalization.
2. Add `ymdsgtb_cd` + `ymdegtb_cd` (per-station day) and `ymdhsgtb_cd` + `ymdhegtb_cd` (per-station hour) variants.
3. Upload rollup parquets to R2 under `ctbk/trips/stations/<short_name>/<scale>/<window>.parquet` (name tbd).
4. Worker + API: `/api/stations/:id/trips?scale=auto` selects from mo1/d1/h1 tiers.
5. Client: replace monthly-only `StationTripsChart` / `YmrgtbChart` with a scale-aware version that re-queries on zoom. uPlot or Plotly — uPlot likely better for the tighter rendering budgets at `h1` tier with 10k+ points.

### Phase 3 — library extraction (`use-rollups`)

By phase 3 we have two concrete implementations and can factor out the common pieces:
- **Data-plane:** Python CLI that consumes raw parquet(s) + a tier config (field list, agg list, bucket size, file naming), emits rollup parquets.
- **Serving:** Cloudflare Worker template (or reusable Hono/TS module) that routes scale-aware queries across tiers + CORS + cache headers.
- **Client:** `useRollupQuery` hook + chart helpers.
- **Spec/config format:** single `rollups.yaml` per-project that describes fields, aggs, tiers, paths. Pipelines and Worker read the same file.

Scaffold the repo under `$js/use-rollups` (GitLab) with `pds` wiring for ctbk + awair as the first two consumers.

### Phase 4 — system-wide ride count + availability

Once phases 1–2 land, system-wide rollups are a small increment:
- Trips: `ymrgtb` already exists monthly; add `ymdrgtb` / `ymdhrgtb` with region dim. Storage in `gbfs/trips/system/...`.
- Availability: the daily system-wide parquet (`gbfs/parquet/YYYY-MM-DD.parquet`) already covers raw. Run the rollup pipeline over it too to produce system-wide tiers. Cross-station ad-hoc queries remain a phase-5+ concern.

---

## Open questions

1. **Where does the rollup job run?** Options: GHA runner (simplest, already have the workflow), Worker cron (complex — 30s CPU limit per invocation), external VM (most flexible, but cost). I'd lean GHA for now: ~10 min/day daily run is free tier.
2. **Partition sizing for rollup files.** Per-station per-scale: one file per month / year / all-time? Tradeoff: too many tiny files = R2 op-count costs; too-large files = read-amplification for short queries. Proposed layout above tries to keep a typical query to 1–2 files. Revisit after measuring.
3. **Worker CPU budget** for stitching + reading parquet row groups. `hyparquet` has been fine so far on `raw` per-station-month reads (~MB-scale); unclear how it scales at `mo1` with many-years-per-file. May need to chunk large reads or preindex row groups.
4. **Dim-column explosion for ride counts at `h1`.** A per-station per-hour row with `(r, g, t, b)` cross-product is mostly zeros at low-volume stations. Sparse-only storage (drop zero rows) keeps the file reasonable but complicates client-side aggregation across dim values. Proposal: store sparse + let the API optionally post-aggregate to a subset of dims.
5. **Response format: Parquet vs JSON.** JSON over the wire is easy but ~10× larger than parquet. For narrow-range queries (a few hundred rows) JSON is fine; for wider queries at `h1` with 10k+ rows, returning pre-columnar parquet (via `content-type: application/vnd.apache.parquet`) and having the client read it via `hyparquet` may be worth it. Phase 3 library default: JSON until benchmarks argue otherwise.
6. **`scale=auto` picking policy.** The `maxPoints = 500` heuristic is a starting point. Awair uses a different strategy. Library should let the caller pass a policy fn rather than baking one in.
7. **Versioning / schema evolution.** Rollup parquets include a schema-version column or a sidecar `meta.json` so the Worker can detect incompatible tier upgrades and refuse to serve.

---

## Effort estimate

| Phase | Effort | Lands |
|---|---|---|
| 1. Availability rollups | ~2–3 days (pipeline + worker + client) | week-1+ queries snappy; confidence bands |
| 2. Ride-count rollups | ~3–4 days (pipeline bigger than phase 1) | day/hour zoom on `/s/:slug` trips |
| 3. `use-rollups` library | ~2 days once 1+2 are stable | reusable in awair / apvd / next projects |
| 4. System-wide tiers | ~1 day | full-system zoomable charts |

Recommend landing Phase 1 first as a spike — it's the smallest end-to-end example of the pattern and validates the schema + routing choices before we scale out to ride counts and cross-project extraction.
