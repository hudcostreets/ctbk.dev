# Spec: avail-pyrmts shadow-mode parity debug

> Status: **draft** (2026-05-27). Investigation spec for task #60.
> Shadow-mode dual-read is in production logging `rowsLegacy=3575 vs
> rowsPyrmts=167` for representative single-station queries — ~20×
> divergence that blocks cutting `/api/totals?kind=availability` over
> to the pyrmts path. This spec frames the investigation runbook +
> likely hypotheses; intent is for EC2 to chase it down using
> `wrangler tail` + pyrmts-side debug.

## Where we are

- `gbfs/api/src/avail_pyrmts.ts` — shadow reader, fully implemented.
- `gbfs/api/src/index.ts:1230` — shadow harness, fires `executeAvailViaPyrmts`
  in parallel with legacy and logs `shadowDelta`. Pure observation, no
  client-visible effect.
- `shadowDelta` (`avail_pyrmts.ts:302`) reports
  `{ rowsLegacy, rowsPyrmts, exactMatchPct, maxAbsDiff }`.
- Earlier work: read-side `binCol+range` pruning landed (`c466d71d`),
  then arbitrary-col `filters` via pyrmts §2 landed (`705106e2`), which
  fixed shadow-mode OOM. Parity, however, remains divergent.

The earlier sessions saw cases like `rowsLegacy=3575 vs rowsPyrmts=167`
for a `/api/totals?kind=availability&filter.station_id=<uuid>` request
over multiple days. Need to localize the cause.

## Hypotheses (prioritized)

### H1: Metric-fan-out asymmetry (most likely)

Legacy `executeAvailTotalsQuery` likely returns one row per
`(dt, station_id, metric)` for `metric=all` requests (5 metrics →
~5× row count). Pyrmts path may return one row per `(dt, station_id)`
with all metrics inlined (5× fewer rows for the same data).

- 3575 / 5 = 715 → still not 167. So metric fan-out alone doesn't
  explain it, but check if 167 × 5 = 835 ≈ partial coverage.
- Check: `legacy.rows[0]` keyset vs `pyrmts.rows[0]` keyset.

**Validate**: log both sample rows in `shadowDelta` (one-shot
debugging patch — wrap behind `AVAIL_PYRMTS_DEBUG=1`).

### H2: State-fan-out in legacy path

Legacy shards are tall: `(dt, station_id, metric, state, minutes)`.
Each `(dt, station_id, metric)` tuple has multiple `state` rows (one
per histogram bucket). If legacy emits raw rows pre-aggregation, that
adds ~10–20× fan-out on top of metric fan-out.

3575 / 5 / 4 = 178.75 ≈ 167. **Plausible.** If legacy returns
per-state rows and pyrmts returns aggregated mean/p50/etc, that
matches the order of magnitude.

**Validate**: inspect a sample legacy row's keyset. Look for `state`
column in the legacy `TotalsResponse.rows`.

### H3: Bin-mismatch from planner divergence

Legacy uses ctbk's bin picker (`pickBin` in `totals.ts`); pyrmts uses
`planQuery` with its own tier selection. Could pick different tiers
for the same `(from, to)` window, yielding different bin counts.

- 715 raw bins vs 167 raw bins ≈ 4.3× — could be a tier mismatch
  (e.g. legacy at h1 = 24/day × 30 days = 720; pyrmts at d1 = 30 bins;
  shape doesn't match cleanly, but worth checking).

**Validate**: shadow log already includes `tier`. Cross-check against
the legacy planner's chosen tier (need to add `legacy.tier` to the
shadow log payload).

### H4: Filter divergence

Recent `filters: [{ col: 'station_id', values: [...] }]` work
(`705106e2`) prunes by row-group. Legacy filters per-row after read.
If filter semantics diverge (e.g. station-ID encoding, normalization,
case sensitivity), legacy could match many rows pyrmts doesn't.

**Validate**: probe a single shard with both paths and compare
filtered row counts directly (no aggregation).

## 1. Diagnostic patch (do first, throwaway)

Land a one-commit debug patch on `avail_pyrmts.ts:shadowDelta` behind
`env.AVAIL_PYRMTS_DEBUG === '1'`:

```ts
if (env.AVAIL_PYRMTS_DEBUG === '1') {
  const legacySample = legacy.rows[0];
  const pyrmtsSample = pyrmts.rows[0];
  const legacyKeys = legacySample ? Object.keys(legacySample) : [];
  const pyrmtsKeys = pyrmtsSample ? Object.keys(pyrmtsSample) : [];
  console.log('avail-pyrmts-shadow-debug', JSON.stringify({
    legacyKeys, pyrmtsKeys,
    legacySample, pyrmtsSample,
    legacyTier: (legacy as any).tier,  // surface legacy planner choice
    legacyDistinctDt: new Set(legacy.rows.map((r: any) => r.dt)).size,
    pyrmtsDistinctDt: new Set(pyrmts.rows.map(r => r.dt)).size,
  }));
}
```

Deploy + ship one representative query through `wrangler tail`. The
distinct-`dt` counts will pinpoint whether fan-out (H1/H2) or bin-count
(H3) is the cause.

## 2. Cause-specific fixes

### If H1 (metric fan-out)

Update `shadowDelta` to bucket legacy rows by `(dt, station_id)` and
sum-aggregate metric columns before keyspace comparison. Pyrmts path
already returns wide rows; comparison currently compares cardinality
of fundamentally different shapes.

### If H2 (state fan-out)

Same bucketing as H1 but also aggregate per-state minutes into the
reducer output (`mean`, `p50`, etc.) before comparison. This is
already what `pivotPerMetric` does — but `shadowDelta` is comparing
legacy *pre-pivot* shape to pyrmts *post-pivot* shape.

### If H3 (tier mismatch)

Either:
- Align ctbk's `pickBin` with pyrmts `planQuery` tier selection
  (preferred — single source of truth for tier choice).
- Force shadow path to read at legacy's chosen tier.

### If H4 (filter divergence)

Audit `filters` plumbing in `avail_pyrmts.ts`. Specifically: are we
passing the same UUID format both paths receive? Is there any
normalization (e.g. lowercase) one side does the other doesn't?

## 3. Parity acceptance criteria

Before cutting `/api/totals?kind=availability` over to pyrmts:

- `exactMatchPct >= 0.999` for `reducer=mean` on representative
  queries spanning:
  - single-station, single-day (h1 tier)
  - single-station, single-month (d1 tier)
  - single-station, single-year (mo1 tier)
  - all-station rollup, single-day (h1 tier)
- `maxAbsDiff < 1e-4` for `mean`/percentile reducers
- Exact match for `min`/`max`/`count`/`hist` reducers

## 4. Cutover plan (post-parity)

- Flip `executeAvailTotalsQuery` → `executeAvailViaPyrmts` in
  `index.ts:1224`.
- Leave shadow harness wired but reverse it: legacy as observer for a
  week.
- Once stable, remove legacy `executeAvailTotalsQuery` path.

## 5. Out of scope

- Cutover (this spec is debug-only; cutover is the immediate followup).
- Removing shadow harness (separate cleanup PR).
- Performance regressions or improvements (see
  `specs/avail-totals-perf.md`).

## References

- `gbfs/api/src/avail_pyrmts.ts` — shadow reader
- `gbfs/api/src/index.ts:1227-1247` — shadow harness
- `specs/pyrmts-avail-port.md` — original port plan
- `specs/avail-pyramid-v2.md` §5 — shadow-mode design
