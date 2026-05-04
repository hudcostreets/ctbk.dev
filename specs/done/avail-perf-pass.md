# Spec: availability /api/totals — multi-scale grid pass

Status: **superseded** (2026-05-04) by `specs/avail-grid.md`, which
locks the v2 design (CLI-driven, D1 manifest, ShardStore abstraction).
Phase 0 (cron writes 1m@1m parquet via loader) and the initial cascade
compactor (`gbfs/cascade/`) from this spec are in production; the
remaining items follow the v2 spec.

Originally **open** (2026-05-02). Superseded the prior m15-only draft of
this spec (which targeted only the `30m`/`15m` bin gap). The framework
here is broader and addresses the same symptoms.

## Goal

Cut perceived load time of the per-station availability chart on the
default view (7d–14d × auto-bin) so it lands in the same ballpark as the
trips chart and the map (both static-asset-fast). Apply the same multi-scale
grid to availability that we want for trips going forward.

After this pass, target latencies (cold edge cache, single-station,
`metric=all`):

| query                  | current | target |
|------------------------|---------|--------|
| 7d × 1h   (h1 tier)    | 0.55s   | 0.5s   |
| **7d × 30m  (raw → m15)**  | **3.29s**   | **0.5s**   |
| **7d × 15m  (raw → m15)**  | **3.17s**   | **0.5s**   |
| 7d × 5m   (raw)        | 3.17s   | 1.0s   |
| **14d × 30m (raw → m15)**  | **3.66s**   | **0.6s**   |
| 14d × 1h  (h1 tier)    | 0.86s   | 0.6s   |

Repeat-load latency target: **< 100 ms** (browser disk cache hit) for
any query whose `to` is in the past.

The path to those targets is **not** a new tier between h1 and raw.
It's a denser, principled grid + write-time binning + a query planner
that reads ≤ ~25 files for any reasonable query.

## SUF budget framework

The current grid has wide step-up factors (SUFs):

| from   | to    | SUF |
|--------|-------|-----|
| 1m JSON | 1h@1m cons (h1 raw shard) | 60× |
| 1h@1m | 1d@1m (raw/day)            | 24× |
| 1h@1h (h1 agg) | 1mo@1h (… not present; falls to d1 at 1d) | — |
| 1d@1d (d1) | 1mo@1d              | 30× |
| 1mo@1mo (mo1) | 10y@1mo          | 120× |

The cost of a wide SUF: at agg level @A with cons levels {C₁ < C₂ < … < Cₙ},
a query of duration D at bin B≥A reads, worst-case:

- ⌈D / Cₙ⌉ files at the largest cons level (full coverage)
- Plus boundary fill: up to **Σᵢ (SUFᵢ − 1)** files where SUFᵢ = Cᵢ₊₁ / Cᵢ

So a 7d × 30m query today, routed to "raw" (sub-hour bins, no agg available):
6 × `raw/day` + 23 × `h1/<HH>` + 60 × `gbfs/status/…json` = **~89 file fetches**.

The framework:

1. **Cons SUF** (within an agg series) ≈ files touched in boundary fill.
2. **Agg SUF** (across agg levels) saves CPU for bins that are integer
   multiples of the agg size.
3. **Largest cons at agg @A** should be ≈ `1e3 × A` to `1e4 × A`, since
   max bins per query ≈ `1e3–1e4` (FE viewport ceiling). That sets the
   high end of each cons series.
4. Keep all SUFs in the range `~3–5×`. Then worst-case file count for
   any (D, B) is bounded by ~25 across all tiers combined.

**This budget is enforced by tests**, not just observed. See
"Budget tests" below.

## Grid

| agg @A | cons levels                              | use when           |
|--------|-------------------------------------------|--------------------|
| 1m     | {1m, 5m, 15m, 1h, 3h, 8h, 1d}             | bin < 5m           |
| 5m     | {5m, 15m, 1h, 3h, 8h, 1d}                 | 5m ≤ bin < 15m     |
| 15m    | {15m, 1h, 3h, 8h, 1d, 1w, 1mo}            | 15m ≤ bin < 1h     |
| 1h     | {1h, 1d, 1w, 1mo}                         | 1h ≤ bin < 4h      |
| 4h     | {4h, 1d, 1w, 1mo, 3mo}                    | 4h ≤ bin < 1d      |
| 1d     | {1d, 1w, 1mo, 3mo, 1y}                    | 1d ≤ bin < 1mo     |
| 1mo    | {1mo, 3mo, 1y, 10y}                       | 1mo ≤ bin          |

Notes:

- 1w doesn't divide 1mo cleanly. The planner handles the mismatch
  (greedy non-overlapping cover); cons files don't need to nest.
- 4 and 5 are coprime, so {1m, 4m, 5m, …} would in principle add
  distinct coverage for 4m/8m/12m bins. **Skipping @4m for v1** —
  no caller asks for those bin sizes (`pickAvailBinAuto` and the
  FE's `BinSelect` pick from {1m, 5m, 15m, 30m, 1h, 4h, 1d, …}).
  Add @4m only if a use case appears.
- Skipping `3d` cons. The transition `1d → 1w → 1mo` has SUFs (7, 4.3),
  both ≤ ~5. Adding 3d cuts the max-SUF boundary fill from ~9 → ~7
  files; not worth the extra tier for v1.

## Semantics: wall-clock bins, sum-monoid agg

We commit, **at the parquet layer**, to wall-clock-anchored binned rows.
This is a one-way decision relative to today's "h1 raw" shards (which
preserve per-poll rows with `polled_at`).

- A 1m@1m row at minute M = aggregate of all polls whose `polled_at` ∈
  `[M, M+1m)`, one row per `(station_id, M)`.
- A 5m@1m cons file for `[M, M+5m)` contains 5 such rows per station.
- A 5m@5m row at 5m-bucket M = aggregate over the same `[M, M+5m)` window
  but as a single row per `(station_id, M)`. The 5m@1m file aggregates
  the same data into 5 rows per station.
- All higher tiers cascade by sum-monoid merge of the next-finer tier.

Per-poll fidelity is **preserved only in the JSON layer**
(`gbfs/status/<date>/<HHMM>.json`). The raw `polled_at` and source `ts`
are still recoverable from JSON; the parquet path is binned-only.

Edge cases:

- 0 polls in a minute (cron failure): no row written for that
  `(station, minute)`. Higher cons compute means over actually-present
  samples; `sample_count` reflects truth honestly.
- 2+ polls in a minute (cron lag → catch-up): one row per `(station, M)`
  with `n=2` and means over both polls.
- Schema unification: per-poll `gbfs/avail/h1/<date>/<HH>.parquet`
  shards become 1m@1m cons writes after cutover. See "Migration" below.

## Monoid schema

Every parquet shard, at every (agg, cons) level:

```
{
  station_id:  STRING,        // dict-encoded
  dt:          INT64,          // unix-s, delta-encoded; bucket start
  n:           INT32,
  sum:         DOUBLE,
  sum_sq:      DOUBLE,
  samples:     LIST<DOUBLE>    // sorted, dedup'd, top-K ∪ bot-K
}
```

`samples` invariant: at write time, contains every distinct value if `n ≤ 2K`;
otherwise contains the K largest + K smallest, sorted. **K = 3 for v1.**

Monoid merge:

```
n      = a.n + b.n
sum    = a.sum + b.sum
sum_sq = a.sum_sq + b.sum_sq
samples = trim(sort_unique(a.samples ∪ b.samples), 2K)
```

where `trim` keeps the K largest and K smallest.

Per-metric: schema is repeated per metric (`bikes`, `ebikes`, `docks_avail`,
`docks_disabled`, `pending`). One column group per metric. Querying
`metric=bikes` projects only that group → minimal decode.

Why a single fixed schema (vs. conditional sparsity at low `n`):

- Merge code stays simple — no branchy "(full ⊕ sparse)" path.
- Querying `metric=mean` projects only `(n, sum)` → `samples` is never
  decoded. Free at query time even when stored.
- Storage cost is small after parquet dict + zstd. K=3 worst-case is
  9 doubles/row raw; n=1 rows compress hard (1-element samples list,
  often repeating across stations).
- Schema evolution stays straightforward (add `samples` later if we
  start with just (n, sum, sum_sq)).

## R2 key layout (Hive-style)

```
avail/agg=<A>/cons=<C>/<period>.parquet
```

Period encoding:

| cons | period format       | example                     |
|------|---------------------|-----------------------------|
| 1m   | `<date>/<HHMM>`     | `2026-05-02/1430`           |
| 5m   | `<date>/<HHMM>`     | `2026-05-02/1430` (HHMM aligned to 5m) |
| 15m  | `<date>/<HHMM>`     | `2026-05-02/1430`           |
| 1h   | `<date>/<HH>`       | `2026-05-02/14`             |
| 3h   | `<date>/<HH>`       | `2026-05-02/12` (HH aligned to 3h) |
| 8h   | `<date>/<HH>`       | `2026-05-02/08`             |
| 1d   | `<date>`            | `2026-05-02`                |
| 1w   | `<iso-week>`        | `2026-W18` (ISO 8601)       |
| 1mo  | `<ym>`              | `2026-05`                   |
| 3mo  | `<yQ>`              | `2026-Q2`                   |
| 1y   | `<year>`            | `2026`                      |
| 10y  | `<decade>`          | `2020`                      |

DuckDB / pyarrow / Athena auto-detect Hive partition paths and apply
filter pushdown for `agg=` and `cons=` predicates. The worker doesn't
care; it builds full keys directly.

## Architecture: who writes what

Two CFWs:

### Cron worker (`gbfs/worker/`, fires `* * * * *`)

Today: writes `gbfs/status/<date>/<HHMM>.json` (per-minute snapshot).

After: writes JSON **and** 1m@1m parquet, both in the same tick:

```ts
const record = { ts, polled_at, stations };
const jsonKey = `gbfs/status/${date}/${HHMM}.json`;
const pqKey   = `avail/agg=1m/cons=1m/${date}/${HHMM}.parquet`;

const jsonPut = bucket.put(jsonKey, JSON.stringify(record), ...);
ctx.waitUntil(jsonPut);
ctx.waitUntil(jsonPut.then(() => writeMinuteParquet(bucket, pqKey, record)));
```

JSON is the durable write (fires first; cron tick succeeds even if
parquet write fails). Parquet is best-effort; the cascade compactor's
existence-check barrier makes the cascade tolerant of occasional gaps,
and a periodic backfill job (run on `e` from JSON archive) repairs any
missing 1m@1m shards.

CPU/memory budget: a 3000-row parquet with hyparquet-writer is
~50–100ms CPU, ~few MB heap. Well clear of CFW limits.

### Cascade compactor (extend `gbfs/compactor/` or new worker)

Fires every minute at :30s offset (well past cron worker's :00s tick).
Each invocation does:

1. Determine wall clock minute `M`.
2. For each `(agg, cons)` level above 1m@1m, check if a bucket containing
   minute `M-1` just closed (i.e., `M` is the start of a new bucket at
   that level).
3. For each closed bucket: existence-check the **next** bucket's first
   shard at the underlying finer level. If it exists, the closed bucket's
   inputs are guaranteed-written → cons. Else skip; next tick retries.
4. Cascade upward: 5m@1m closes → 5m@5m closes → 15m@1m closes if 15-min
   boundary → etc.

Idempotent: same inputs → byte-identical output (sorted layout,
deterministic parquet config, deterministic monoid merge). Re-running
on a contested bucket is a no-op.

Existence-check barrier in code:

```ts
// Cons bucket [M, M+5m) into 5m@1m. Barrier: must see cons=1m for M+5m.
async function consBucket(r2, bucketStartMin, level) {
  const nextMin = bucketStartMin + level.size;
  const barrierKey = `avail/agg=1m/cons=1m/${dateOf(nextMin)}/${hhmm(nextMin)}.parquet`;
  if (!(await r2.head(barrierKey))) return;  // skip; next tick retries
  // ... read inputs, write cons
}
```

This is stateless — no event plumbing, no cursor. The barrier check is
one R2 HEAD per attempted cons (cheap).

## Manifest

Single R2 object: `avail/manifest.json`. Updated by the cascade compactor
on each successful write (atomic put). Read by the worker on each cold
query, cached in `caches.default` with 60s TTL.

Shape:

```json
{
  "version": 1,
  "updatedAtS": 1746210000,
  "shards": {
    "agg=1m,cons=1m":    { "first": "2026-05-02/1430", "last": "2026-05-02/1430" },
    "agg=1m,cons=5m":    { "first": "2026-05-02/1430", "last": "2026-05-02/1425" },
    ...
    "agg=1mo,cons=10y":  { "first": "2010", "last": "2020" }
  }
}
```

Per (agg, cons) entry stores the `first` and `last` extant shard period;
worker assumes contiguous coverage between `first` and `last` (compactor
guarantees this; no shard is ever deleted from the middle).

The worker uses the manifest to **prune fallthroughs** — if a query window
is entirely covered by a closed-period shard at the chosen tier, it goes
straight to the file. If the manifest says the file isn't there yet (in-progress
period), the worker falls through to the next-finer tier without an extra
round-trip.

Cold-query overhead: 1 manifest GET (~few KB, edge-cached) + the data GETs.

## Worker query plan

`planAvailQuery(D, B, T)` returns the optimal file set for duration `D`,
bin size `B`, at wall-clock time `T`. Algorithm:

1. Pick agg level `A` = largest agg level with `A ≤ B`.
2. Window `[fromS, toS]` = `[T - D, T]`.
3. Greedy cover the window with cons files at agg `A`, largest first:
   - For each cons level `C` (largest → smallest in the agg series):
     - While the next aligned `C`-bucket in the window is fully closed
       AND the manifest reports the shard exists: emit that shard, advance.
     - Stop when no more aligned `C`-buckets fit.
4. After the largest cons exhausts, recurse on the remainder with the
   next-smaller cons.
5. The final remainder (the in-progress period) falls through to a finer
   agg level `A' < A`, recursively.
6. Eventually reaches `agg=1m` and the in-progress minute, where the
   query plan terminates with a list of JSON keys to read for the
   open minute.

Output: `{ files: [{ key, agg, cons, period }], openMinuteJsonKeys: [...] }`.

The query executor reads files in parallel (with concurrency cap), folds
each into the running monoid map, and folds the open-minute JSON polls at
the end.

`pickAvailAggTier`-as-formula is replaced by this generic planner.

## Migration

Build new tiers alongside existing files. Cut over per-tier as new files
exist:

1. **Phase 0 (compactor wired)**: Cron worker writes 1m@1m alongside JSON.
   Cascade compactor stands up; writes 5m@1m, 15m@1m, 1h@1m, etc. Manifest
   begins reporting new shards.
2. **Phase 1 (worker reads new grid for in-progress windows)**: Worker
   `planAvailQuery` prefers new-grid shards when manifest reports them.
   Falls back to legacy `gbfs/avail/h1/<date>/<HH>.parquet` and
   `gbfs/avail/raw/day/<date>.parquet` for closed periods. Both paths
   produce identical query results (unit tests assert this).
3. **Phase 2 (backfill)**: On `e`, run the cascade compactor over JSON
   archive: 1m@1m shards for all minutes; 5m@1m/15m@1m/etc. cons files
   on top. Manifest extends back to start of GBFS archive.
4. **Phase 3 (cutover)**: Worker drops the legacy fallback. New grid
   only. Reaper job deletes the legacy `gbfs/avail/h1/<date>/<HH>.parquet`
   and `gbfs/avail/raw/day/<date>.parquet` files (or leaves them as
   archive — they're still readable via /api routes if we keep that
   code path).

Phases 1 and 2 are independent — Phase 1 ships as soon as the cascade
compactor stabilizes; Phase 2 chases backfill in the background.

## Quick wins (independent of grid work)

These compose with the grid migration and can ship in any order:

### 1. HTTP `Cache-Control` headers on closed-window responses

Worker `executeAvailTotalsQuery` currently caches via `caches.default`
(60s TTL) and emits no browser-cacheable headers. Add a header path:

```ts
const isClosedWindow = p.toS < (Date.now() / 1000) - 300; // 5min slack
const maxAge = isClosedWindow ? 86400 : 60;  // 24h vs 60s
resp.headers.set('Cache-Control', `public, max-age=${maxAge}, immutable`);
```

Effect: repeat loads (and panning into a previously-visited window) hit
browser disk cache → ~0 latency. Major UX win on revisit.

### 2. Strip `station_id` from rows when `filter.station_id` selects one station

When the query has exactly one station_id, the FE already knows it (it's
the URL slug). Stripping it from each row saves ~36 bytes × N. For 7d × 15m
× 5 metrics × 1 station = 3,360 rows: **~120 KB** saved (pre-gzip).

Implement on the worker side — drop `station_id` from each row when the
caller asks for a single station AND scope=stations. FE: tolerate missing
`station_id` and use the URL's known ID. Add a `station_id_implicit:
"<id>"` echo field at the response top level for safety.

### 3. Reshape `metric=all` from row-per-metric to wide row

Today `metric=all` returns 5 rows per `(dt, station)` (one per metric).
Flip to one row per `(dt, station)` with all metric values inline.
**5× fewer rows**, ~3–5× smaller pre-gzip; gzip narrows the gap but
parse time still wins.

This is a breaking response shape change. Behind a `?wide=1` flag for
one rollout cycle, then default-on; or a versioned response field
(`shape: "wide"`) the FE can branch on.

## Budget tests

Add `gbfs/api/src/planAvailQuery.budget.test.ts`. For each representative
`(D, B)` cell at a representative wall-clock `T`, assert that the file
plan size is bounded:

```ts
const T = '2026-05-02T14:30:00Z';
const cases = [
  { D: '7d',  B: '1h',  maxFiles: 12 },
  { D: '7d',  B: '30m', maxFiles: 25 },
  { D: '7d',  B: '15m', maxFiles: 25 },
  { D: '7d',  B: '5m',  maxFiles: 30 },
  { D: '14d', B: '1h',  maxFiles: 18 },
  { D: '14d', B: '30m', maxFiles: 30 },
  { D: '30d', B: '1h',  maxFiles: 20 },
  { D: '1y',  B: '1d',  maxFiles: 15 },
  { D: '1y',  B: '1mo', maxFiles: 5 },
];

for (const { D, B, maxFiles } of cases) {
  it(`D=${D}, B=${B} → ≤ ${maxFiles} files`, () => {
    const plan = planAvailQuery(parseDuration(D), parseBin(B), parseT(T));
    expect(plan.files.length + plan.openMinuteJsonKeys.length).toBeLessThanOrEqual(maxFiles);
  });
}
```

The maxFiles thresholds derive from the SUF budget. If a future
regression makes a query touch more files than budgeted, this test
fails fast — surfacing the issue before perf degradation hits prod.

## Out of scope (rejected)

### Per-station static snapshot files

Tempting because it makes the default view *feel* free. Rejected because
it's a side-channel around the multi-scale TS API:

- Defaults shift; the pre-baked file becomes a moving target.
- 3,000 files × (per-station, per-default-view, per-update-frequency)
  matrix grows unmanageably.
- Doesn't help anything *off* the default — pan/zoom/range-pick is still
  on the dynamic API, and feels suddenly slow by contrast.
- Worse: the multi-scale TS infra already covers this case; bypassing it
  splits the codebase's mental model.

### @4m agg series

Coprime with @5m, so adds distinct coverage for 4m/8m/12m bins. Rejected
for v1 — no caller requests those bin sizes. Add later if a use case
appears.

### 3d cons level

Cuts max-SUF in `1d → 1w → 1mo` from ~7 to ~5. Saves ~2 files/query in
that range. Rejected for v1: the 1w cons already keeps SUFs near target,
and the extra tier costs more than the savings.

### Per-h3-hex multi-scale shards

Not yet. When we add map-heatmap views aggregating across stations within
hex cells, the right answer is **separate hex-sorted shards** at each h3
resolution we serve, sorted `(hex_id, dt)` analogously to station-sorted
files. The same multi-scale grid applies; just a different sort key.
Defer until a heatmap UI lands.

## Implementation order

Ranked by ROI; each item independently shippable.

1. **Cache-Control header** (quick win; lines of code, big repeat-load win) — half a day.
2. **Cron worker writes 1m@1m parquet** alongside JSON. Standalone change;
   cascade compactor doesn't need to exist yet — half a day.
3. **Cascade compactor (cons-only path)**: 5m@1m, 15m@1m, 1h@1m, 1d@1m,
   1w@1m, 1mo@1m. Existence-check barrier. Manifest writes — 1 day.
4. **`planAvailQuery` + manifest reads**: replace `pickAvailAggTier` with
   the generic planner. Worker prefers new shards via manifest, falls
   back to legacy paths — 1 day.
5. **Cascade compactor (agg path)**: 5m@5m, 15m@15m, 1h@1h, 4h@4h, 1d@1d,
   1mo@1mo + their cons levels — 1 day.
6. **Budget tests** — half a day.
7. **Backfill on `e`**: cascade compactor over JSON archive — 1 day +
   wall-clock for compute. Run as a GHA matrix job by date range.
8. **Reshape `metric=all`** — half a day.
9. **`station_id` strip** — small, ship with #8.

Total: ~5–7 days of focused work + backfill wall-clock.

## Acceptance

- All budget-test cases pass with bounded file counts.
- `gbfs/api/ctbk-api smoke -S hoboken-terminal-...` shows 7d/14d × 15m
  and 7d/14d × 30m queries at < 1s (cold), including for windows that
  include the in-progress day.
- Manifest reports contiguous coverage at every (agg, cons) level for
  all closed periods after backfill.
- Repeat-load (warm browser cache) for any closed-window query: < 100 ms.
