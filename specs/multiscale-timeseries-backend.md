# Spec: Multi-scale time-series backend

Status: design, implementation pending. Supersedes earlier revisions of this
file; incorporates decisions from the 2026-04-23/24 design thread.

## Motivation

Both the ride-count chart (`/` + `/s/:slug`) and the availability chart
(`/s/:slug`) need to span minute → multi-year scales on the same page
without separate pipelines. Today:

- Ride counts are monthly-only (`ymrgtb_cd.json` / per-station `ymdgtb_cd.json`).
- Availability is minute-only, served via D1 hot cache (7 d) with R2 parquet
  fallback for older dates. Queries beyond ~14 d feel slow.

The same pattern is needed in awair / apvd. Factor the common infra out of
ctbk into a `use-rollups` library (phase 3 below).

## Design principles

1. **One serving format, one place.** Parquet in R2. No D1 on the serving path.
2. **Sort by `dt` in every file.** Parquet row-group min/max stats act as a
   free dt index — readers skip row groups outside the query window with no
   external index structure.
3. **Shard so closed shards are immutable.** Year-sharding at hour-level,
   month-sharding at minute-level. Once a shard's time window closes it
   never changes, which means:
   - Long CDN `Cache-Control`, cheap edge caching.
   - No append-rewrite churn for historical data.
   - Trivial content-addressing if we ever want it.
4. **Pre-compute only what can't be derived fast.** Per-station queries work
   on raw ride records (projection + zone-map skipping keep them cheap);
   system-wide rollups exist only at two tiers (`h1`, `n1`), and month/day
   bins are derived by the Worker.
5. **Worker owns the query-routing.** Client API takes `{station XOR region(s),
   bin size, time range}` and doesn't know the storage layout. Moving files
   around, adding tiers, swapping D1 for a DO — all invisible to the client.

## Terminology

- **Bin**: one x-axis data point on a plot (width = bin size). Replaces
  "window" from earlier drafts.
- **Agg-key characters** (used in pipeline stage names):
  `y` year · `m` month · `d` day · `h` hour · **`n` minute** · `r` region ·
  `s` start station · `e` end station · `g` gender · `t` user type ·
  `b` bike type · `c` count · `D` duration-seconds.
- **Tier**: a pre-aggregated bin size. We have at most two system-wide
  tiers: `h1` (1-hour) and `n1` (1-minute).
- **Region**: `nyc` · `jc` · `hob`. Sharded as separate files — **not** a
  column — because they align with the UI's region filter and the three
  regions have wildly different volume (NYC ~95% of rides).

---

## Storage layout

### Trips

```
trips/stations/<short_name>.parquet              # raw records, dt-sorted; side column {start, end}
trips/region/<region>/h1/<YYYY>.parquet          # hour-level, year-shard
trips/region/<region>/n1/<YYYYMM>.parquet        # minute-level, month-shard
```

Per-station files contain every ride touching the station, with a `side`
column distinguishing starts from ends (so a ride A→B appears once in
A.parquet with `side=start` and once in B.parquet with `side=end`). A
`counterpart_short_name` column records the *other* end of each ride,
which powers pair-filtering ("rides from A→B") and the paginated rides
table (see *Future Extensions*). It's low-cost to include at phase-1
write time; retro-fitting later would mean rewriting every
per-station file.

Per-region pre-aggs have the full `gtb_cD` dim cross (gender × user type ×
bike type × count × duration) per time bucket.

### Availability

```
avail/stations/<short_name>.parquet              # raw minute polls, dt-sorted
avail/region/<region>/<YYYY-MM>.parquet          # raw minute polls (system-wide-by-region), month-shard
```

No rollup tier in v1. Raw availability is small enough — ~20 float/int
columns × typically < 500k rows per station — that a Worker scan of the
raw is fast for any reasonable query. If per-station queries at multi-year
scales prove slow we add an `h1` tier later.

### Immutability

All time-sharded parquets are **immutable once their shard is closed**:
- `h1/<YYYY>.parquet` closes at the first write after year rollover.
- `n1/<YYYYMM>.parquet` closes at the first write after month rollover.
- `avail/region/<region>/<YYYY-MM>.parquet` same.

In-flight (current period) shards may be rewritten or appended-via-flush.
Closed shards carry `Cache-Control: public, max-age=31536000, immutable`;
in-flight shards use a short TTL.

Per-station raw files are **not** time-sharded — one file per station for
the whole history. Rewrite cadence is bounded (monthly for trips, hourly
for availability) and files are small (10s of MB), so rewrite churn is
acceptable. An alternative is to year-shard per-station files too; defer
until measurement argues for it.

---

## Worker query routing

One endpoint:

```
GET /api/query
  ?kind=trips|availability
  &station=<short_name>          # XOR
  &region=nyc,jc,hob             # XOR
  &from=<unix-s>&to=<unix-s>
  &bin=<ms>                      # or:
  &targetPxPerBin=<px>           # for auto-tier
  &fields=...                    # projection
  &dims=r,g,t,b                  # which dim cols to return broken-out
  &side=start|end                # per-station only
→ { tier, binMs, rows: [{dt, ...aggs}] }
```

Routing logic:

```ts
function pickFiles(q: Query): R2Path[] {
  if (q.station) {
    // per-station: one file, bin on the fly
    return [`${q.kind}/stations/${q.station}.parquet`]
  }
  // region(s)
  const regions = q.regions ?? ['nyc', 'jc', 'hob']
  if (q.kind === 'availability') {
    // no rollup tier; monthly shards
    return monthsIn(q.from, q.to)
      .flatMap(ym => regions.map(r => `avail/region/${r}/${ym}.parquet`))
  }
  // trips: h1 if bin ≥ 1h, n1 otherwise
  const tier = q.binMs >= HOUR_MS ? 'h1' : 'n1'
  const windows = tier === 'h1' ? yearsIn(q.from, q.to) : monthsIn(q.from, q.to)
  return regions.flatMap(r => windows.map(w => `trips/region/${r}/${tier}/${w}.parquet`))
}
```

Worker reads all paths in parallel (`Promise.all`), filters (column projection
+ `dt`-range), bins to `q.binMs`, merges across regions (sum same-`dt` rows),
returns JSON.

**Cost at scale:** widest realistic query — NYC per-station lifetime trips at
year-bins — reads ~20 MB projected, bins 1 M rows in-worker, returns 12 rows.
Sub-second. Widest system-wide minute query — "last month across all regions"
— reads 3 × ~250 MB files in parallel; probably under the Worker CPU/memory
budget but worth measuring. Fallback: raise target bin size to `h1` for
super-wide-minute queries.

---

## Client API

### `useRollupQuery(...)` hook

```ts
const { rows, isPending, tier, binMs } = useRollupQuery({
  kind: 'trips' | 'availability',
  station?: string,
  regions?: Region[],
  end: Date | null,                 // null = "Latest"
  duration: number,                 // ms
  binMs?: number,                   // explicit, OR
  targetPxPerBin?: number,          // auto (Worker picks coarsest fitting)
  fields?: string[],
  side?: 'start' | 'end',
})
```

TSQ-backed. The query key is `(kind, station|regions.join, end.getTime, duration,
binMs|auto, fields, side)`. Range is quantized to the bin grid so drag-pan
within a bin doesn't re-trigger fetches.

### `<BinSelect />` component

Standard unit table (from awair, lightly trimmed):

```
Minute:  1n · 2n · 5n · 10n · 15n · 20n · 30n
Hour:    1h · 2h · 3h · 4h · 6h · 8h · 12h
Day:     1d · 2d · 3d · 7d · 14d
Month+:  1mo · 2mo · 3mo · 6mo · 1y
```

Plus **"auto"** (default) — drives `targetPxPerBin ≈ 3`. Manual override is
exposed as a dropdown in chart settings.

### `<RangePicker />` component

`{timestamp, duration}` model (already in ctbk's `time-range.ts`). End +
duration, with "Latest" as `timestamp=null`. Picker UX:

- Slider / presets for duration (1d, 7d, 30d, 1y, All, …).
- Explicit "end at" control (calendar / "now"). Defaults to Latest.
- No separate start — `start = end - duration`.

This replaces the `{start, end}` widget on the Home page's ride-count chart
(unified with the availability chart).

---

## Ingest

### Trips

Existing pipeline produces monthly-grain outputs. New stages:

1. `ctbk agg -g ymdhgtb -acD`: hour-level system → region `h1` year-shards.
2. `ctbk agg -g ymdhngtb -acD`: minute-level system → region `n1` month-shards.
3. `ctbk trips-per-station`: re-emit ride records partitioned by canonical
   short_name (both sides, dt-sorted) → `trips/stations/*.parquet`.

Runs monthly after tripdata arrives. Shards close at year/month rollover.

### Availability

**Current:** Worker cron polls GBFS each minute → D1 day-table → daily
compaction to R2.

**Target:** D1 (or DO) as **ingest staging only**. Compaction cadence
goes from daily to **hourly**: at hour rollover, the hour's D1 rows append
into the active month's `avail/region/<region>/<YYYY-MM>.parquet` and each
touched station's `avail/stations/<short_name>.parquet`. Serving path reads
R2 only.

**Two migration paths, in order:**

1. **Step 1 (smaller):** keep D1, reduce retention from 7 d to ~2 h, switch
   serving API to always read R2. D1 is just an ingest WAL.
2. **Step 2 (larger, optional):** replace D1 with a Durable Object that
   batches polls in memory and flushes hourly. Removes D1 dependency entirely.
   Defer until step 1 ships.

Confidence test: with step 1 done, "is R2 serving good enough?" is the only
remaining question — no cache to hide perf issues.

---

## Phase plan

| Phase | Scope | Unlocks |
|---|---|---|
| 1 | Trips: per-station raw + region `h1`/`n1` pre-aggs; Worker + client API | Hour/minute binning on `/s/:slug` trips chart and Home chart; unified range picker |
| 2 | Availability: compact hourly; serving path reads R2 only | Full-history availability at any bin size, no D1 cache |
| 3 | Extract `use-rollups` (Python CLI + Worker template + React hooks + chart helpers) | awair / apvd reuse |
| 4 | Map pies + per-station availability stats (see Future Extensions) | Visual use of the availability infra |

Phase 1 is the spike — it validates the layout, routing, and client API on
the more-complex trips side (larger files, dim cross, two sides). Phase 2
is a mechanical restructuring of existing infrastructure.

---

## Future extensions

### Map circles as pies/donuts (phase 4+)

Render each station circle as a pie/donut with a **toggleable** encoding,
showing either:

- **Availability** (bike / ebike / dock / disabled shares): at current
  moment, or time-weighted over a user-chosen window.
- **Trips**: proportion of starts vs ends over the window. At many stations
  these skew strongly by time-of-day (residential → commute AM starts,
  PM ends; employment centers the inverse). Showing this on the map
  surfaces the flow pattern at-a-glance.

The toggle, combined with the existing time-range picker, also lets users
see how start/end balance (or availability distribution) shifts across
dayparts — e.g. "AM rush at this station is 80% starts; PM is 70% ends."

Additional stats for the on-click / hover detail:

- Avg bikes / ebikes / docks available over the range.
- **Fraction of time at zero bikes** (+ zero docks, zero ebikes). The most
  interesting signal — stations that starve, or stations that never empty.
- Ride counts split start/end over the range.
- Daily / hourly histogram of state distributions (phase 4.5).

Data sources, both already built by earlier phases:
- Availability pies: `avail/stations/<short_name>.parquet`. "Time at zero"
  = `count(rows where bikes == 0) / count(rows)` over the window — raw
  scan.
- Trips pies: `trips/stations/<short_name>.parquet`, grouped by `side`
  over the window.

If multi-station "rank by starvation / rank by imbalance" queries become a
thing, we'd add `zero_bikes_minutes`, `starts_count`, `ends_count` etc. as
pre-aggregated tier columns; defer until then.

### Paginated raw-rides table per station (phase 4+)

On `/s/:slug`, below the chart, a paginated table of individual ride
records:

- **Columns:** timestamp, side (start / end), counterpart station, rider dim
  cols (gender / user type / bike type), duration.
- **Sortable** on every column; dt is the natural default.
- **Filterable** on date range (inherits the page's range picker),
  counterpart station (single-station pair filter), dim columns, duration.
- **Searchable** by counterpart station name — full-text-ish. At ~500k
  rides/station this is fast enough as a linear scan inside the Worker;
  no FTS index needed v1.
- **Paginated** (e.g. 50 rows/page). Worker returns `{ page, rows,
  totalRows }`.

Data source: `trips/stations/<short_name>.parquet` (built in phase 1). No
new storage needed. The parquet needs a **`counterpart_short_name`** column
alongside `side` — added to the phase-1 schema so this feature comes for
free later.

#### Per-station D1/SQLite alternative (considered, not chosen)

Per-station SQLite DBs (one per station, or one DB with per-station
tables) with FTS5 indices for snappy search. Downsides:
- 3000 × ~50 MB/station with indices ≈ 150 GB — way over D1's 10 GB cap.
- Workers don't bind multiple D1 DBs dynamically; each named binding is
  fixed at deploy time.
- One combined DB grows faster than 10 GB even without FTS.

Parquet + Worker scan hits the same UX (page loads in ~100 ms for a
50-row page) without the cap / provisioning problem. If at some point the
Worker's in-memory scan becomes the bottleneck — e.g. multi-criteria FTS
on dim + counterpart name — we spin up a per-station `.sqlite` sidecar as
a static R2 artifact (read in the browser via `sql.js` or by the Worker
with a WASM binding). Same data, different query engine. Deferred.

### Pair-filtered rides (drill-in via map brushing)

Related to the rides-table above: when a station is selected and the map
draws its destination fan, clicking/brushing a specific edge should filter
the rides table to *only rides between that pair* (direction respected).
Two semantics:

- **This-station → other**: rides where `short_name = current` and
  `counterpart_short_name = other`, `side = start`.
- **Other → this-station**: reversed.

Implemented as additional params on the rides-table query
(`counterpart=<short_name>&side=<start|end>`). Filter applied Worker-side
post-scan, cheap. UI: clicking a fan edge toggles the pair-filter; a chip
above the table shows the active pair.

### System-wide "All regions" pre-agg

Currently a 3-region query is three parallel reads + merge — cheap. If
measurement shows "all regions" is the dominant query shape and the merge
cost is material, emit a 4th file per tier combining all regions. Storage
dup cost is ~30% (NYC is 95% of volume; JC+HOB combined rounds up to full).
Skip until measured.

### DuckDB-WASM as a client-side engine

For ad-hoc multi-station or cross-cutting queries ("which 20 stations spend
the most time at zero bikes in Q2?") the per-station / per-region parquet
layout is already DuckDB-compatible — no format change needed. Ship
DuckDB-WASM lazily (~15 MB) behind an "advanced queries" UI surface.

### Per-station year-sharding

Defer. Only worth it if data refresh cadence becomes an issue, or if Penn
Station-scale stations produce a single parquet large enough to slow
client-side reads. Current projected sizes (~50 MB worst case) are fine.

---

## Open questions

1. **Which Worker runtime reads parquet?** Current gbfs api uses `hyparquet`
   — small and works, but hasn't been stressed at `n1` scale (250 MB single
   file, reading one row-group at a time). Alternative: `@duckdb/duckdb-wasm`
   in Workers, or a Rust-compiled parquet reader via WASM. Measure `hyparquet`
   first.
2. **Station raw file rewrite frequency.** For trips, monthly is natural —
   new month of tripdata arrives → rewrite every touched station file. For
   availability, hourly rewrite of per-station files means ~3000 file
   rewrites/hour = ~25M writes/year, ~100K$/yr at R2 pricing (class A ops
   dominate). **Fix**: batch — only rewrite the `avail/region/...` monthly
   shard hourly (one file/hour/region = 24 ops/day/region); rewrite
   `avail/stations/...` daily or weekly. Per-station queries stitch the
   region file's recent data onto the stale per-station file.
3. **Query-key quantization for drag-pan smoothness.** Inherited from the
   current availability chart's `bufferedBounds`. Worth generalizing as a
   hook utility in `use-rollups`.
4. **Back-compat for existing URL params.** `?d=…` (date-range), `?r=…`
   (range, on StationDetail) have existing encodings. New unified picker
   should decode legacy values for old shared links.
5. **What about the `t` axis for "touched at all" rollups?** Some stations
   have days with zero rides. Current `ymrgtb_cd` rows at a sparse station
   can be missing months. Worth defining: do we emit zero rows for "nothing
   happened" bins, or leave gaps? Affects chart rendering (line-break on
   null vs. hold-at-zero).

---

## Related / superseded specs

- `specs/d1-backend.md` — the original availability backend spec. Partly
  built (what's live today); this spec supersedes the "serving architecture"
  sections. When phase 2 ships, move to `specs/done/`.
- `specs/multi-scale-ts-library.md` — original library-extraction sketch.
  Subsumed by phase 3 of this spec.
- `specs/station-zoom-subdaily.md` — ride-count zoom idea. Subsumed by
  phase 1.
- `specs/station-trips-serving.md` — trips API design. Merge into phase 1
  and move to done/.
