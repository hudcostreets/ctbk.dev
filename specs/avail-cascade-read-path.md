# Spec: wire `/api/totals` availability read path to the cascade pyramid

> Status: **draft** (2026-05-24). Companion to `specs/cascade-backfill.md`
> (write-path completion). Tier-by-tier roll-forward; legacy `avail/agg/{h1,d1,mo1}`
> path remains until full coverage + verification.

## Background

The cascade pyramid (`gbfs/avail/agg=*/cons=*/...`) has been built but
no consumer reads from it. `/api/totals` for `kind=availability` still
serves from the pre-cascade `gbfs/avail/{raw/day, h1, agg/{h1,d1,mo1}}/...`
shards via `executeAvailTotalsQuery` → `resolveAvailTier` → `availFold`.

## Schemas

| | Legacy avail rollups | Cascade pyramid |
|---|---|---|
| Shape | "long" histogram: one row per `(dt, station_id, metric, state)` with `minutes` weight | "monoid": one row per `(station_id, dt)` with per-metric `(n, sum, sum_sq)` columns |
| Path | `gbfs/avail/{raw/day, h1, agg/{h1,d1,mo1}}` | `gbfs/avail/agg=<A>/cons=<C>/...` |
| Granularity | Fixed: 1min raw → 1h hist → 1d hist → 1mo hist | Multi-axis: bin size × roll-up period (5 × 7 grid) |
| State distribution | ✅ preserved | ❌ collapsed into sum-monoid |

**Implication**: cascade can answer queries that only need
`(count, sum, sum_sq)` — `mean`, `stddev`, `variance`, `count`. It
**cannot** answer queries that need the state distribution —
`min`, `max`, percentile (`p05` / `p25` / `p50` / `p75` / `p95`),
or the raw histogram (`hist`).

Looking at `AvailAgg`:

```ts
type AvailAgg = 'mean' | 'min' | 'max' | 'p05' | 'p25' | 'p50' | 'p75' | 'p95' | 'hist';
```

- Cascade-compatible: `mean` (1 of 9 reducers, but likely the majority of
  real traffic — chart of mean-bikes-over-time is the canonical view).
- Legacy-only: `min`, `max`, percentiles, `hist` (8 of 9 reducers).

## Approach

Three phases. Each gated on the previous landing + dual-read verification.

### Phase 1: query classification + dual-read shadow mode

Add a `cascadeReadable(p: TotalsParams): boolean` predicate:

```ts
export function cascadeReadable(p: TotalsParams): boolean {
  return p.kind === 'availability' && (p.availAgg ?? 'mean') === 'mean';
}
```

When `cascadeReadable(p)` AND env flag `AVAIL_CASCADE_SHADOW === '1'`:
- Run the legacy read path (unchanged).
- *Also* run a parallel cascade read path that picks the appropriate
  `agg × cons` cell, decodes monoid rows, computes `mean` via
  `Σsum / Σn` per group.
- Compare the two results. Log delta (rows, exact-match %, max-abs-diff).
- Return the **legacy** result to the client.

This is dual-read shadow mode: zero user-facing impact, but every
cascade-eligible request emits comparable numbers to the worker logs
(via `console.log` → `wrangler tail`). Use a few days of real traffic
to verify cascade matches legacy within rounding error.

**Tier selection for cascade reads** — pick `(agg, cons)` from the
requested `binS` + window length:

| Request binS | Pyramid `agg` | Pyramid `cons` (depends on window) |
|---|---|---|
| < 1m | n/a — fall back to legacy raw | — |
| 1m – <5m | `1m` | `1h` if window ≤ 1h, else legacy (1m max cons is 1h) |
| 5m – <15m | `5m` | min cons ≥ window |
| 15m – <1h | `15m` | ditto |
| 1h – <1d | `1h` | ditto |
| ≥ 1d | `1d` | ditto |

If no cell exists for the requested (agg, cons) — e.g. asking for
`agg=5m` over a 10-day window when `5m × 5d` isn't deployed — fall
back to legacy. Don't synthesize across multiple cells in v1.

### Phase 2: read-path cut-over (cascade-first, legacy-fallback)

Flip the default: when `cascadeReadable(p)`, try cascade first.
On any of {missing cell, decode error, schema-unexpected}, fall back
to legacy. Keep shadow logging active for one more week.

This is `AVAIL_CASCADE_READ === '1'` (or rip the env flag once we trust it).

### Phase 3: feature-flag retirement + legacy write-path deprecation

Once cascade-first has been live for ≥ 1 week with no fallback events:
1. Drop the env flag — cascade-readable queries always go to cascade.
2. Keep legacy fallback for the non-`mean` reducers indefinitely (they
   *require* the histogram schema; only path forward there is a cascade
   schema extension, deferred to a v2 spec).
3. Stop running the legacy `avail/agg/{h1,d1,mo1}` *writers*. Existing
   shards stay on R2 for the histogram reducers; no new ones written.

## Non-goals (this spec)

- Histogram-reducer support from cascade. Requires schema extension
  (add a `state` column to monoid rows + adjust merge semantics). Defer.
- `/api/query` (the multi-scale time-series endpoint) is separate — it
  uses a different planner and already targets `avail/region/<r>/<ym>.parquet`,
  which is also pre-cascade legacy. Same wire-up pattern would apply
  but isn't covered here.
- Trips read path. Trips have their own rollups (`trips/agg/{h1,d1,mo1}`)
  that are unrelated to availability; out of scope.

## Backwards-compatibility / live-data safety

- **`/1min` JSON poller**: untouched. Cascade reads from `agg=1m/cons=1m`
  shards (written by loader on R2 event), never from the WAL JSONs.
- **Legacy writers** keep running through all 3 phases. Only retired in
  phase 3 step 3, after cascade-first has been verified.
- **Pre-2026-05-03 history**: cascade has zero coverage there. The
  `cascadeReadable` check needs to also verify `fromS >= 2026-05-03 00:00 UTC`
  (or fall back to legacy if any part of the window predates that).
- **Today's in-progress hour**: cascade's higher-cons cells lag the
  current bucket. For e.g. `cons=1d` queries that include "today",
  there's no `1d/today.parquet` yet — fall back to legacy raw stitching
  (`stitchInProgressDay` in `index.ts`). Same pattern as today.

## Verification

The shadow-mode log line (one per cascade-eligible request):

```
cascade-shadow tier=agg=5m/cons=1h period=2026-05-22 rows_legacy=12035 rows_cascade=12035
  exact_match=99.98% max_abs_diff=0.0001 fallback=0
```

If the cascade and legacy reads consistently match (within float epsilon
for `mean`), Phase 2 is safe to flip. Targets: `exact_match ≥ 99.9%` over
≥ 1000 distinct queries, `max_abs_diff ≤ 1e-6`.

## Open questions

1. **Filter dimensions**: TotalsParams supports filtering by `station_id`,
   `region`, `metric`. Cascade shards are pre-sorted by `station_id` (rg
   pruning works for station filter). Region requires a station→region
   map (already in the worker for legacy too) — should carry over.
2. **`scope=region`/`borough` group-by**: legacy histograms aggregate
   across all stations in a group then bucket by state. Cascade monoid
   trivially adds (n, sum, sum_sq) across stations — `mean` still works,
   `stddev` works via the pooled-variance formula. Verify in shadow mode.
3. **Today's in-progress data**: cascade's `agg=1m/cons=1m` shards land
   ~1s after the WAL JSON. For a "today" query at the minute scale,
   reading the just-landed 1m shards is fine; for higher-cons today
   queries (which don't have a current-bucket cell yet), fall back to
   stitch. Already handled by legacy.

## Sequencing relative to other work

- ✅ Cascade write path is sufficient (B.1 just landed; `5m × 1d` still
  broken but `mean`-with-`agg=5m` over multi-hour windows can use
  `5m × 1h` or `5m × 8h` instead).
- ❌ Spec doesn't depend on `5m × 1d` fix — that cell stays absent; the
  predicate just skips it.

## References

- `specs/done/avail-perf-pass.md` — original cascade design
- `specs/cascade-backfill.md` — write-path completion (B.1 just landed)
- `gbfs/api/src/totals.ts` — legacy read path + `AvailAgg` reducers
- `gbfs/api/src/index.ts` § `executeAvailTotalsQuery` — current dispatch
- `gbfs/lib/avail-monoid.ts` — cascade row schema
