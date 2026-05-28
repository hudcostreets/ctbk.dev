# Spec: `/api/totals?kind=availability` TTFB investigation

> Status: **draft** (2026-05-27). Investigation spec for task #64-1b.
> Single-station avail queries hit 2-2.8s TTFB cold, dragging the
> station-detail render even after FE-side `prefetchStationDetail`
> + spinner overlay (#64-1a, #64-2) landed.

## Where we are

#64-1a + #64-2 reduced the *perceived* sluggishness for cross-station
nav:
- Hover-based prefetch warms the cache 80ms before click
  (`stations.ts:prefetchStationDetail`)
- Spinner overlay on stale chart while new query in flight
  (`StationDetail.tsx`)

But the underlying BE call is still 2-2.8s p50 cold. With CFW edge
cache (60s TTL closed-window, 24h immutable past-window), warm
requests are ~10ms — so the issue is concentrated on cold first-load,
which hits every "open station I haven't visited recently."

Hover-prefetch reduces the visible cost but doesn't eliminate it: any
click without a 80ms+ hover (mobile tap, keyboard nav, search bar
selection) eats the full TTFB.

## What we know

From `index.ts:1213-1214` comment:
> *the avail-totals path is expensive (~7s for a 7-day station query).
> With a 60s TTL, the first user pays the cost; everyone else sees
> ~10ms.*

That comment predates v2 rebuild + read-side pruning. Current measure:
~2-2.8s p50 for default ranges (`6h`-tier, ~few-day window). Still too
slow for "click a station → see chart" UX.

## Hypotheses (prioritized)

### H1: Tall-shard pivot dominates wall time

`avail_pyrmts.ts:pivotPerMetric` pivots 5 metrics in 5 sequential
passes over the tall rows. For a 7-day single-station query at h1
tier, that's ~168 hours × 5 metrics × ~10 states ≈ 8400 tall rows
pivoted into ~840 wide rows. The 5x scan is a known smell flagged in
the source comment.

**Validate**: log timings around `pivotPerMetric` calls. Compare to
total request time.

### H2: Decode dominates (RG-prune not hitting)

Shadow path (and legacy?) might be decoding more row-groups than
needed. v2 rebuild added `row_group_size=8192` + `(dt, station_id)`
sort + arbitrary-col `filters` — but does the *legacy* path (still in
prod for `/api/totals`) benefit? It reads the same shards but through
a different code path.

**Validate**: surface `rg_count_total / rg_count_decoded` via pyrmts
debug output. If legacy reads more RGs than pyrmts for the same
query, switching to pyrmts (#60 cutover) is the perf win.

### H3: R2 GET latency per shard

Each tier-shard fetch is one R2 GET. h1 tier with 1d shards over 7
days = 7 GETs. Mo1 tier with 1y shards = 1 GET. Are GETs serialized
or parallelized? CFW has ~100ms p50 R2 GET latency, so 7 serial GETs
= ~700ms baseline before any decode.

**Validate**: log per-GET timing. Check `Promise.all` is actually
parallel and not constrained by some `subrequest`-limiting wrapper.

### H4: hyparquet decoder cost on wide histograms

Each row is `{state: count}` over ~10-20 buckets. JSON-encoded
histograms aren't free to parse. If the schema stores them as
struct-of-arrays vs string-encoded JSON, decoder cost varies wildly.

**Validate**: inspect shard schema (`pqs avail/agg/h1/<date>.parquet`)
+ measure decode-only time on a representative shard.

### H5: stitch/reducer overhead

`stitch` merges per-shard outputs and applies the reducer (mean,
percentiles). For percentile reducers, this involves histogram
arithmetic across multiple histograms. Could be allocation-heavy.

**Validate**: time `stitch` separately from fetch+decode+pivot.

## 1. Instrumentation patch (do first)

Wrap each phase of `executeAvailViaPyrmts` (and `executeAvailTotalsQuery`
for legacy comparison) in `performance.now()` brackets, log a phase
breakdown:

```ts
const t0 = performance.now();
const shardData = await fetchShardData(/* ... */);
const t1 = performance.now();
const pivoted = pivotPerMetric(shardData);
const t2 = performance.now();
const stitched = stitch(pivoted, /* ... */);
const t3 = performance.now();
const reduced = applyReducer(stitched, reducer);
const t4 = performance.now();
console.log('avail-totals-perf', JSON.stringify({
  path: 'pyrmts', tier, n_shards: paths.length, n_rg_decoded: /* ... */,
  ms_fetch: t1 - t0, ms_pivot: t2 - t1, ms_stitch: t3 - t2, ms_reduce: t4 - t3,
  ms_total: t4 - t0,
}));
```

Ship to prod, scrape via `wrangler tail` for 10-20 representative
queries. The phase that dominates is the optimization target.

## 2. Cause-specific fixes

### If H1 (pivot dominates)

Fuse the 5 metric pivots into a single scan over tall rows. Sketch:

```ts
function pivotFused(tallRows: Row[]): Row[] {
  const byKey = new Map<string, Row>();
  for (const r of tallRows) {
    const key = `${r.dt}\x00${r.station_id}`;
    let wide = byKey.get(key);
    if (!wide) {
      wide = { dt_ms: r.dt * 1000, station_id: r.station_id };
      METRICS.forEach(m => { wide![m] = {} });
      byKey.set(key, wide);
    }
    (wide[r.metric] as Record<string, number>)[r.state] = r.minutes;
  }
  return Array.from(byKey.values());
}
```

Expected: 5× scan → 1× scan. ~5x speedup on pivot phase.

### If H2 (decode dominates, RG-prune not hitting)

Two angles:
1. Cut over `/api/totals?kind=availability` to pyrmts path (gated on
   #60 parity — see `specs/avail-pyrmts-parity-debug.md`).
2. If pyrmts path is *also* slow on decode, audit RG-prune coverage:
   are `filters` actually triggering page skip? Probe with `pqm` or
   pyrmts-side stats.

### If H3 (GET latency dominates)

- Verify shard fetches go through `Promise.all` (or pyrmts equivalent),
  not serial.
- Consider larger shard sizing: 1d-shard h1 → 1mo-shard h1 cuts GET
  count 30× but bloats per-GET payload. Worth measuring.
- Edge-cache shards themselves (R2 GET via `caches.default`)? CFW R2
  binding doesn't natively cache; would need explicit `caches.default`
  layer.

### If H4 (decoder cost on histograms)

- Audit `avail/agg/<tier>/<period>.parquet` schema. If histograms
  serialize as JSON strings, switch to native map/struct columns
  (rebuilds avail-v2 with stronger typing).
- Worth a separate spec; cross-reference `specs/avail-pyramid-v2.md`.

### If H5 (stitch/reducer)

Low-hanging if it shows up: cache stitched results per `(tier, period,
filter)` tuple, since the same shard often serves many queries with
the same window. The CFW response cache (60s TTL) already does this
at the response level, but intra-request stitch caching would help on
multi-window dashboards.

## 3. Acceptance criteria

- p50 TTFB for default station-detail query (3-day window at h1):
  **< 800ms cold, < 50ms warm**.
- p95 < 1.5s cold.
- Memory headroom: no OOM regressions vs current state.

## 4. Out of scope

- FE-side prefetch tuning (#64-1a, already shipped).
- Spinner UX (#64-2, already shipped).
- Cutover decision for `/api/totals?kind=availability` legacy → pyrmts
  (covered by `specs/avail-pyrmts-parity-debug.md`).

## References

- `gbfs/api/src/avail_pyrmts.ts:pivotPerMetric` — current 5x scan
- `gbfs/api/src/totals.ts` — legacy `executeAvailTotalsQuery`
- `gbfs/api/src/index.ts:1213` — edge-cache wrapper + perf comment
- `specs/avail-pyrmts-parity-debug.md` — parallel investigation,
  output of which gates the legacy → pyrmts cutover
