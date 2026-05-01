# Spec: unified availability read API

Status: **done** (2026-05-01). Worker accepts any positive `bin` and
routes sub-hour bins through a new `raw` tier (`/day raw` bundles +
today-WAL stitch). FE drops the `useRaw` fork; `useStationAvailability`
always calls `/api/totals`. Live refresh in Latest mode is a TSQ
`refetchInterval: 60_000`. `useStationRange` removed from the FE; the
worker's `/api/stations/:id/range` endpoint stays for direct-access use.

Notes / known gaps:
- Cold latency on the 7d × 5min query is ~3s (spec target ≤ 1s);
  tracked as a `_write_sorted_parquet` rg-size tightening — see
  `specs/multiscale-timeseries-v2.md` (rg=1440 = 1 station/day per rg
  vs. current ~10 stations/rg).

Closes the gap left by `specs/multiscale-timeseries-v2.md`: that spec
covered the storage layout but didn't fully specify the client-facing
API contract, which left the FE picking between `/range` (raw minute
polls) and `/api/totals` (binned agg) based on window size. This spec
collapses those into one path.

## Goal

The client asks for **availability over an arbitrary window at an
arbitrary bin size** via a single endpoint. The worker handles all
storage-layer concerns:

- Which tier file(s) to read.
- Stitching in-progress periods (today, current month, current decade)
  by falling through tier → tier → per-minute polls.
- **Sub-hour binning** (bin < 1h) by reading per-minute polls and
  bucketing on the fly.
- Capacity controls (concurrency, projection, rg-pruning) — internal.

After this lands:
- FE makes one call shape regardless of window/bin: `GET /api/totals?
  kind=availability&from=<S>&to=<S>&bin=<S>&filter.station_id=<UUID>&...`.
- FE has no `pickAvailBinMode` "useRaw vs useTotals" branch.
- Worker has no `bin >= 3600` rejection.
- `/api/stations/:id/range` is repurposed (paginated raw minute polls
  for the rides-table-style use case) or deleted entirely if no caller.

## Dependencies

This spec assumes `specs/avail-day-raw.md` (Phase 3 of v2) is
implemented first — without `/day raw` bundles, sub-hour multi-day
queries would require reading 24 h1-raw shards per day, which is too
many R2 GETs (~720 for a 30d × 5min query).

Order:
1. `e` ships `specs/avail-day-raw.md` — Python compactor + GHA cron +
   backfill.
2. We do the worker + FE work in this spec.

## Worker changes (`gbfs/api`)

### 1. Drop the `bin < HOUR_S` rejection

`gbfs/api/src/totals.ts:parseTotalsParams`:

```ts
// REMOVE:
if (b < HOUR_S) {
    throw new Error(`bin must be ≥ ${HOUR_S}s (avail-agg tier minimum); got ${b}`);
}
```

The worker resolves any positive `bin` to a source — agg files for bin
that match a tier's natural granularity, or per-minute polls for sub-hour
bins (rebucketed on the fly).

### 2. Extend `pickAvailAggTier` for sub-hour bins

```ts
export function pickAvailAggTier(fromS, toS, binS?): AggTier {
    if (binS !== undefined) {
        if (binS >= MONTH_S) return 'mo1';
        if (binS >= DAY_S)   return 'd1';
        if (binS >= HOUR_S)  return 'h1';
        return 'raw';                       // NEW: sub-hour
    }
    // ... existing span-based defaults
}
```

`AggTier` gains `'raw'` (or rename — `'h0'` if we want to keep "agg" as
a name for binned tiers).

### 3. Extend `resolveAvailTier` to handle `tier='raw'`

For `tier='raw'`:
- For each day in `daysIn(fromS, toS)`:
  - If day is closed: read `gbfs/avail/raw/day/<YYYY-MM-DD>.parquet`
    (the new /day raw bundle from `avail-day-raw.md`), rg-prune by
    station_id, fold into `groups` via `pollRowsToHistRows + availFold`.
  - If day is today: stitch via existing `stitchInProgressDay`
    (h1-raw shards + WAL JSONs).
  - If day is past + the /day raw file is missing (backfill gap): fall
    back to reading the 24 h1-raw shards (`gbfs/avail/h1/<date>/<HH>.parquet`).

### 4. Capacity / rg-pruning

The /day raw files are sorted by `(station_id, ts)` with rg ~10
stations per group (per `avail-day-raw.md`). Per-station queries
decode 1 row group of ~5 KB per file. A 30d × 5min query → 30 R2 GETs
+ ~150 KB decoded. Concurrency 6 → ≤ 1s cold, sub-100ms warm.

## FE changes (`www`)

### 1. Drop `pickAvailBinMode` "useRaw" branch

`www/src/query/stations.ts`:

```ts
// REMOVE
const RAW_THRESHOLD_S = 86400
if (spanS <= RAW_THRESHOLD_S) {
    return { binS: 60, useRaw: true }
}
```

`useStationAvailability` now always calls `/api/totals` with whatever
bin the user (or auto-picker) chose. The `useRaw` field disappears.

### 2. Drop `/range` chart usage

The chart's data source becomes single-shape (`/api/totals`'s response
+ `totalsRowsToAvailabilityRows` reshape). The `/range`-vs-`/totals`
fork in `useStationAvailability` collapses.

`/range` endpoint either:
- (a) Stays for paginated raw-rides-table use cases (separate from
  charts).
- (b) Deleted if no caller remains.

Audit before deciding.

### 3. Ungate sub-hour bin options

`www/src/pages/StationDetail.tsx:availDisabledBins`:

```ts
// REMOVE the `< HOUR_MS && rangeMs > DAY_MS` rule.
// Sub-hour bins now valid for any range.
```

### 4. Auto-picker behavior at sub-hour

`pickAvailBinMode` should be renamed to `pickAvailBinAuto(spanS,
viewportPx)` and now returns just `binS` (no `useRaw`). When `spanS <=
24h && viewportPx-target says binS < 3600`, return e.g. 60s or 5min
based on viewport — same formula, just unconstrained at the bottom.

## Migration / cutover

The new path is additive on the worker:
1. Deploy worker change (drops the bin floor; adds raw-tier handling
   that gracefully falls through to existing in-progress stitch when
   /day raw missing).
2. Build /day raw files (per `avail-day-raw.md` + backfill).
3. FE simplification can ship before or after (2) — cold-path latency
   for sub-hour multi-day queries will be slow until /day raw exists,
   but functionally correct.

Once shipped, delete:
- `bin < HOUR_S` rejection code path (worker).
- `pickAvailBinMode`'s `useRaw` branch (FE).
- `useStationAvailability`'s `/range` fork (FE).
- `/range` chart-side usage (decide whether to keep endpoint).

## Acceptance

- [ ] Worker accepts `bin=60` on a 7d window for a station and returns
      24×7 = 168 cells (5min binning would also work).
- [ ] Sub-hour bin options on the FE Bin selector ungate for all
      ranges.
- [ ] `/api/stations/:id/range` is removed from chart code paths
      (still callable for direct-access use cases unless deleted).
- [ ] Cold latency for 7d × 5min query: ≤ 1s.
- [ ] Cold latency for 30d × 5min query: ≤ 2s.
- [ ] Querying ranges that span "today" returns data through `now`,
      not last closed agg period.

## Out of scope

- Smoothing query param. Stacked-area charts have constant total per
  bin so smoothing is meaningless; will reconsider if/when a
  lines-mode toggle lands (separate spec).
- Variance / percentile reducers on the raw-tier path. The /day raw
  bundle preserves enough state to compute these via the histogram
  monoid; not currently exposed via FE so deferring.
- Trips-side analog (sub-hour binning for `/api/totals?kind=trips`).
  Spec separately if needed.
