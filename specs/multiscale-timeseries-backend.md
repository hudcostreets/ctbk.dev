# Spec: Multi-scale time-series backend

Status: design, implementation pending. Supersedes earlier revisions of this
file; incorporates decisions from the 2026-04-23/24/26 design thread.

## Motivation

Both the ride-count chart and the availability chart need to span minute → multi-year
scales on the same page without separate pipelines. Beyond the per-station
detail page, the same access pattern serves:

- **Map circle pies** (per-station start/end split, or per-station availability
  distribution, both over a chosen window).
- **Paginated raw-rides table** with date / counterpart / dim filters.
- **Geographic rollups** (e.g. neighborhood = H3 hex) — future.
- **Cross-project reuse** (awair, apvd) via a `use-rollups` library.

The unifying observation: every panel in the UI is a query over a *time window*
for a *metric* defined by a CRDT-shaped (monoidal) aggregate. The serving
infrastructure should expose semantic queries; the storage should be a
multi-resolution pyramid that the backend stitches.

## Design principles

1. **Metrics are values in a commutative monoid.** Each metric has a value
   type, an identity, and an associative+commutative combiner. This is the
   universal precondition for tier-stitched aggregation.
2. **One serving format, one place.** Parquet in R2. AWS S3 stays as the
   data-lake archive; nothing is served from it.
3. **Sort by `dt` in every file.** Parquet row-group min/max stats act as a
   free dt index — readers skip row groups outside the query window with no
   external index structure.
4. **Shard so closed shards are immutable.** Time-bucketed shards close
   at calendar boundaries; immutable shards get long `Cache-Control` headers,
   no append-rewrite churn for historical data.
5. **Pre-compute pyramid tiers; tier-stitch at query time.** A query for
   `[from, to]` reads coarse tiers in the middle and finer tiers at the
   edges (worst case bounded by `2 × (n_tiers − 1) + n_coarse_shards`).
6. **Worker owns the query planner.** Client API is `(metric, scope,
   window, group-by)`; everything else is invisible to the client.

---

## Metrics as monoids

Every metric exposed by the API is a triple `(Type, identity, ⊕)`:

| Metric family | Value type | Identity | Combiner |
|---|---|---|---|
| `count` (rides started/ended) | `int` | `0` | `+` |
| `duration_sum` (ride-seconds) | `int` | `0` | `+` |
| `state_histogram` (bikes / ebikes / docks / disabled / pending available) | `Map<int, int>` (state → minutes-at-state) | `{}` (empty map) | merge (sum bucket counts on key) |

The histogram lets us answer not only mean / min / max / quantiles but also
the user-relevant questions:
- "How often did this station have **zero** bikes?" → `hist[0] / Σ hist`
- "How often was it **near-full**?" → `Σ_{k ≥ 0.9N} hist[k] / Σ hist`
- Full distribution plot → `hist` itself.

### Joint vs marginal histograms

For each per-minute observation we have a 5-tuple
`(bikes, ebikes, docks, disabled, pending)`. Two storage choices:

- **Joint**: one histogram keyed by the 5-tuple. Captures correlations
  (e.g. "both bikes and docks at zero simultaneously"). Cardinality
  bound is N₅(C+5) where C is capacity, but practical cardinality is
  much smaller because Σmetrics = capacity (so the 5-tuple lives on a
  4-simplex), and most stations have `disabled` and `pending` = 0 most
  of the time, collapsing to ~3 active dimensions and ≤ (C+2 choose 2)
  realized states.
- **Marginal × 5**: five separate 1-D histograms, ~`C+1` buckets each.
  Loses correlations.

Tradeoff: keep joint if cardinality measurements show it's tractable
(<~1k distinct keys per station per shard); fall back to 5 marginals
if any station blows up. **EDA pending — see "Open EDA" section.**
The data-model design supports either; the pipeline writes whichever
we settle on.

### Why three families is enough

`trips` queries (start/end counts, durations, dim breakdowns) compose by
sum. `availability` queries (mean, median, percentile, time-at-zero,
distribution) all derive from the histogram. No other metric families
emerge from the use-cases we've listed.

---

## Storage layout

All paths are R2-resident. The local filesystem mirror at `r2/ctbk/...`
exists for ergonomic build-then-sync.

```
trips/n0/stations/<short_name>.parquet           # raw ride records, dt-sorted, side-keyed
trips/agg/<tier>/<window>.parquet                # all-stations × dt × side × dims → count, duration_s

avail/n1/stations/<short_name>.parquet           # raw 1-min polls, dt-sorted
avail/agg/<tier>/<window>.parquet                # all-stations × dt × state-histogram per metric
```

`<tier>` ∈ `{h1, d1, mo1}`; `<window>` is the natural calendar boundary
of the tier (`YYYY-MM-DD` for `h1`, `YYYY-MM` for `d1`, `YYYY` for `mo1`).

`trips/agg/<tier>/<window>.parquet` schema (long-format, one row per
fact, all stations co-located):

```
dt              int64   unix seconds at bucket start
short_name      string  canonical
side            string  "start" | "end"
gender          int8
user_type       string  "Subscriber" | "Customer" | ...
rideable_type   string  "classic_bike" | "electric_bike" | ...
region          string  "NYC" | "JC" | "HB"
count           int64   sum
duration_s      int64   sum
```

`avail/agg/<tier>/<window>.parquet` schema:

```
dt              int64
short_name      string
metric          string  "bikes" | "ebikes" | "docks" | "disabled" | "pending"
state           int16   value of the metric (e.g. # bikes available)
minutes         int32   time spent in that state during this bucket
```

Long-format (one row per `(dt, short, metric, state)` cell, sparse —
states with zero minutes are not stored). Trivial to merge across tiers
(sum on key). If joint histogram wins after EDA, swap the `(metric, state)`
columns for a single `state_tuple` int-array column (still long-format).

### Tier ladder

Total span: 1 minute → ~12.5 years ≈ 6.6 M minutes.

We pick **n=4 tiers** at calendar boundaries: `n1/n0 → h1 → d1 → mo1`.
The scale-ups are 60×, 24×, 30× — geometric mean ~33×, vs. theoretical
optimum of 6.6M^(1/3) ≈ 188 for n=4 tiers, or ~53 for n=5.

Why depart from the theoretical optimum:
- Worker query latency is dominated by R2 first-byte (~50 ms), not bytes
  scanned. 4 reads per query vs 6 doesn't materially change wall-clock.
- Calendar-aligned shards close cleanly at month/year boundaries → easy
  immutable Cache-Control + no append churn. A 53× tier needs synthetic
  windows.
- Operationally easier: "is this tier's shard complete?" maps to "did the
  calendar bucket close?" Trivially.
- Display alignment: when the UI asks "this month" or "last year" the
  query hits a single shard.

Adding a `y1` tier costs ~10 MB total (per-metric per-station); skip until
queries spanning >5 years prove slow. Easy add later.

### Query worst case

For `[from, to]` spanning multiple years at minute resolution:
- Two `n0` partial shards at the edges (the start and end days)
- Two `d1` partial shards (the start and end months)
- N `mo1` shards covering the full years/months in the middle

Worst case ≈ `2 × (n_tiers − 1) + n_coarse_shards`. For our 4 tiers and a
12-year query: `2 × 3 + 12 = 18` reads. All in parallel from the Worker;
typical wall-clock ~1s.

### Boundary subtraction trick (deferred optimization)

For sum-aggregable metrics, prefix-sum representations let the Worker
compute `value(end) − value(start)` without scanning intermediate buckets.
Histogram metrics also support this (histograms are pointwise additive).
Adds storage cost (cumulative columns) and query complexity. Not needed
at our scale; flag as a phase-5+ optimization.

### Geographic rollups (H3) — design-compatible, deferred

Adding an `h3_<res>` string column to agg parquets makes the same query
infrastructure trivially answer per-hex queries: `GROUP BY h3_<res>` in
place of `GROUP BY short_name`. Per-hex aggregates are derivable from
the per-station agg by a final `GROUP BY` step at query time, or
materialized in a parallel set of files at write time if needed.

Defer: not in v1, not blocking. The schema accommodates whenever we want it.

---

## Worker query API

One endpoint, one shape:

```
GET /api/totals
  ?kind=trips|availability
  &metric=count|duration_s|bikes|ebikes|docks|disabled|pending
  &from=<unix-s>&to=<unix-s>
  &scope=stations|regions|all          # what to GROUP BY
  &filter.short_name=A,B,C             # optional restrict
  &filter.region=nyc,jc                # optional
  &filter.side=start|end               # trips only
  &dims=side,user_type                 # optional break-out keys
  &agg=sum|mean|p05|p95|hist           # for availability: which reducer
→ { metric, binMs, rows: [{...keys, ...values}, ...] }
```

The Worker:
1. **Tier selection.** From `[from, to]`, pick coarsest tier whose shards
   align cleanly. Build the read list (boundary fine + middle coarse).
2. **Parallel R2 reads.** Project only the columns needed
   (`dt + short_name + filter cols + metric cols`).
3. **Filter** by `dt` window + optional dim filters.
4. **Group + reduce** by `(scope, ...dims)`. For trips, sum. For
   availability, merge histograms; if `agg` is mean/quantile/etc., compute
   from the merged histogram.
5. Return JSON (rows, plus the final `binMs` decided).

Streaming considerations: we never return raw minute-level data over
this endpoint; the response is always aggregated to `(scope × dims)`,
so payloads are bounded by viewport-station-count × dims-cardinality.

### Existing endpoints' fate

`/api/query`, `/api/rides`, `/api/stations/:id/{info,range}` stay as-is for
v1. The new `/api/totals` is the canonical path forward; we'll port
features off the old endpoints as we re-plumb the client.

---

## Client API

### `useTotalsQuery({...})` — one hook for all panels

```ts
const { rows, isPending, binMs } = useTotalsQuery({
  kind: 'trips' | 'availability',
  metric: 'count' | 'duration_s' | 'bikes' | 'ebikes' | 'docks' | ...,
  scope: 'stations' | 'regions' | 'all',
  from: number, to: number,            // unix seconds; or {end, duration} computed
  filter?: {short_name?: string[], region?: Region[], side?: Side},
  dims?: string[],
  agg?: 'sum' | 'mean' | 'p05' | 'p95' | 'hist',
})
```

TSQ-keyed on the param shape; range quantized to the chosen tier's bin grid
so drag-pan within a bin is a cache hit; `placeholderData: keepPreviousData`.

### `<BinSelect />` (existing) drives only the *display* axis

`<BinSelect />` is purely a chart-axis decision (how many bars to show).
It maps to a `binMs` the Worker tier-stitches to. The user-facing tiers
in the picker can stay at human-aligned values (1m, 5m, 1h, 1d, 1mo, 1y);
the Worker decides which storage tier to read.

### `<RangePicker />` — already consolidated on `{end, duration}`

Time selection model unified across all panels.

---

## Pipeline

### Source data
- `trips/n0/stations/<short_name>.parquet` — already exists; one row per
  ride per side, dt-sorted, with canonical short_name + counterpart.
- `avail/n1/stations/<short_name>.parquet` — already exists; one row per
  minute poll, dt-sorted.

### New stages

`ctbk trips-agg`:
- Reads all `trips/n0/stations/*.parquet`.
- Aggregates by `(year, month, day, hour, short_name, side, dim cross)`
  to produce `trips/agg/h1/<YYYY-MM-DD>.parquet`.
- Then aggregates `h1` → `d1` (group by day) → `mo1` (group by month).
  Coarser tiers consume finer ones, so we only re-scan raw on the finest
  level + once per existing tier.

`ctbk avail-agg`:
- Reads all `avail/n1/stations/*.parquet`.
- For each tier (`h1`, `d1`, `mo1`) and each metric in
  `{bikes, ebikes, docks, disabled, pending}`, emits long-format histograms
  `(dt, short_name, metric, state, minutes)`.
- If joint histogram wins after EDA: emits one histogram column with
  `state_tuple` keys instead of per-metric rows.

### Run cadence

- **Trips**: monthly, after new tripdata arrives. Affects only the new
  month's `h1` shards + the rolling-month `d1`/`mo1` shards.
- **Availability**: daily (continuous), after `compact-r2.py` finalizes
  the day's per-station parquet. Updates that day's `h1` shard +
  appends to the rolling-month `d1`/`mo1` shards.

### Output cadence + immutability

- `h1/<YYYY-MM-DD>.parquet` → immutable once the day closes.
- `d1/<YYYY-MM>.parquet` → immutable once the month closes.
- `mo1/<YYYY>.parquet` → immutable once the year closes.

In-flight shards get `Cache-Control: max-age=60` (poll-friendly);
closed shards get `max-age=31536000, immutable`.

---

## Open EDA (pre-implementation)

Decisions to lock down before building the agg pipeline:

### 1. Joint histogram cardinality (per station, per shard)

Run on `e` (R2 + per-station availability already there):

```bash
# pick a few stations of varying capacity + activity
for s in HB101 5980.10 6450.12 5847.01 grove-st-path; do
  python -c "
import pandas as pd
df = pd.read_parquet('r2/ctbk/avail/stations/${s}.parquet')
print('${s}:', len(df), 'rows')
print('  distinct 5-tuples:', df.groupby(['num_bikes_available', 'num_ebikes_available', 'num_docks_available', 'num_bikes_disabled', 'num_docks_disabled']).size().shape[0])
print('  distinct 3-tuples (b/eb/dock):', df.groupby(['num_bikes_available', 'num_ebikes_available', 'num_docks_available']).size().shape[0])
print('  capacity (max bikes+ebikes+docks):', (df.num_bikes_available + df.num_ebikes_available + df.num_docks_available).max())
"
done
```

Decide:
- If max distinct 5-tuples per station ≤ ~1000 → joint histogram is fine.
  Single `state_tuple` column, smaller storage, captures correlations.
- If much higher → marginal × 5. Slightly larger storage, no correlations
  but answers all stated questions.

Document findings; lock the schema choice in the spec.

### 2. Tier validation

Before backfilling all-time, run the pipeline for one month at all four
tiers (`n0`, `h1`, `d1`, `mo1`); verify Worker tier-stitching produces
identical results across tiers for sanity queries. Sized as a smoke test.

### 3. h1 storage size

12 years × 365 days × 24 hours × 5 metrics × ~50 distinct states × 2,609
stations is the upper bound; sparse rows + dict encoding will compress
heavily. Estimate empirically from the smoke-test month.

---

## Phase plan

| Phase | Scope | Unlocks |
|---|---|---|
| 0 | EDA on `e` (cardinality + tier sanity) | Lock schema choices |
| 1 | `trips-agg` pipeline + `/api/totals` for trips | Pies, RidesTable variants, region totals |
| 2 | `avail-agg` pipeline + `/api/totals` for availability | Multi-scale availability charts, time-at-zero stats, availability pies |
| 3 | Migrate existing client paths to `/api/totals` | Retire `/api/query` + `/api/rides` legacy endpoints |
| 4 | `use-rollups` library extraction | awair / apvd reuse |
| 5+ | H3 geo-rollups, prefix-sum trick, year-tier if measured-needed | TBD |

R2-canonical: lands organically by phase 1 — all new agg outputs go to
R2 only; AWS-S3 retains raw normalized/consolidated for the data-lake.

---

## Future extensions (preserved from prior versions)

### Map circles as pies/donuts (phase 2/4)

Render station circles as toggleable pies showing:
- **Trips**: starts vs ends share (phase 1 data: `/api/totals?kind=trips&scope=stations&dims=side`)
- **Availability**: time-share by state (phase 2 data: `/api/totals?kind=availability&metric=bikes&agg=hist&scope=stations`)

ONE Worker call per pies-render covers all visible stations. No
per-station fan-out; the all-stations agg parquet is read once.

### Paginated raw-rides table (phase 1 already partially built)

Backed by the existing `trips/n0/stations/<short_name>.parquet` files.
Worker scans + paginates. Pair filter via `counterpart_short_name`
column (already in the schema).

### Map-edge → pair-filter wiring (phase 3+)

Click a destination polyline on `<StationMap>` → set `?rt_pair=<short>`
on the URL → rides table re-queries with `counterpart_short_name`
filter. Click empty map → clear pair filter.

### DuckDB-WASM as ad-hoc query escape hatch (phase 5+)

Same parquet files; lazy-load DuckDB-WASM (~15 MB) for cross-station
ad-hoc SQL ("which 20 stations spend the most time at zero bikes in
Q2?"). Storage format unchanged.

---

## Open questions

1. **Backend compute capacity ceiling.** Worker (1 GB Unbound, 30s CPU)
   should comfortably handle the queries described. If we hit a wall on
   wide minute-tier scans of avail/agg, fallback is Lambda or a small
   Fargate worker. No infra change today.
2. **Pipeline runner.** Trips agg every month, avail agg every day.
   Reuse existing GHA workflow + DVX, or a separate cron Worker that
   triggers it? The existing GHA pattern (`gbfs-compact.yml`) works; lean
   on it.
3. **D1 future.** With availability raw-tier on R2, D1 becomes purely an
   ingest staging buffer (1-hour retention). Possibly removable in favor
   of a Durable Object that batches polls in memory and flushes hourly.
   Defer until measurable benefit; D1 isn't hurting today.
4. **Schema versioning.** Eventually we'll want a schema-version field
   in shards so the Worker can detect mismatches across pipeline updates.
   Cheap to add; do it at phase-1 write time.
5. **Failure modes for `/api/totals` mid-tier-stitch.** If one shard
   read 404s (e.g. a finer tier hasn't been written yet), the Worker
   could fall back to a coarser tier covering that range. Or 503. TBD.

---

## Related / superseded specs

- `specs/d1-backend.md` — the original availability backend spec. Partly
  built. Move to `specs/done/` when phase 2 retires D1 from the serving
  path.
- `specs/multi-scale-ts-library.md` — original library-extraction sketch.
  Subsumed by phase 4.
- `specs/station-zoom-subdaily.md` — ride-count zoom idea. Subsumed.
- `specs/station-trips-serving.md` — trips API design. Merge here.
- The earlier spec revision (commit 52d9ff25) — design with `h1`/`n1`
  per-region tiers, sum-only availability binning, per-station fan-out
  for pies. **This rewrite supersedes it** based on the CRDT/monoid
  framing + EDA-driven histogram decisions in the 2026-04-26 thread.
