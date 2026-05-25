# Spec: port ctbk **avail** read path to `pyrmts` (histogram monoid)

> Status: **draft** (2026-05-24). Pyrmts milestone 5 (avail — `histogram`
> monoid, no geo). Replaces the now-defunct `avail-cascade-read-path.md`
> draft (which was scoped to sum-monoid cascade and only served `mean`).
>
> Pyrmts dependencies: shipped at `c5adcdc` (histogram monoid) +
> `e3beb70` (`pivotTallToHistogram` adapter). No further pyrmts
> changes required for v0.

## Goal

Replace `executeAvailTotalsQuery` (`gbfs/api/src/index.ts`) with a
pyrmts-served pipeline that reads the existing `avail/agg/{h1,d1,mo1}`
shards via the histogram monoid. Full reducer parity (`mean` / `min` /
`max` / `p05`–`p95` / `hist`) from day 1.

This is the **real port** — pyrmts' histogram monoid is 1:1 with
ctbk's state×minutes schema (just stored tall vs. wide-JSON).

## Schemas

**Legacy `avail/agg/<tier>/<period>.parquet`** (tall):
```
dt INT64  |  station_id STRING  |  metric STRING  |  state INT  |  minutes INT
```
One row per `(dt, station_id, metric, state)` cell. ~5 metrics ×
~capacity-distinct-states × stations × bins per shard.

**Pyrmts histogram monoid** (wide-JSON):
```
dt INT64  |  station_id STRING  |  <metric_a> JSON  |  <metric_b> JSON  | …
```
One row per `(dt, station_id)`. Each metric column is a sparse
`{state_str: count}` Map.

Both shapes encode the same information; the bridge is a per-shard
pivot.

## Approach: option (a) — TS-side pivot adapter (v0)

`pyrmts` ships `pivotTallToHistogram(rows, opts)` (commit `e3beb70`).
The CFW glue is:

```ts
import {
  fetchSegmentRows,
  pivotTallToHistogram,
  planQuery,
  stitch,
} from 'pyrmts'

const plan = planQuery(availPyramid, { range, binBudget, watermarks, filter })

const rawShards = await Promise.all(
  plan.segments.map(s => fetchSegmentRows(storage, s.keys)),
)

// Pivot each tall shard into wide-JSON. ctbk has 5 metrics per row —
// pivot once per metric, then merge by (dt, station_id).
const wideShards = rawShards.map(shard => pivotPerMetric(shard))

const result = stitch({ pyramid: availPyramid, plan, shardRows: wideShards })
```

where `pivotPerMetric` runs the pyrmts pivot once per `AVAIL_METRICS`
entry filtering to that metric's rows, then merges the per-metric
results on `(dt, station_id)`:

```ts
function pivotPerMetric(tallRows: Row[]): Row[] {
  const merged = new Map<string, Row>()
  for (const metricName of ['bikes', 'ebikes', 'docks', 'disabled', 'pending']) {
    const metricRows = tallRows.filter(r => r.metric === metricName)
    const widened = pivotTallToHistogram(metricRows, {
      histogramCol: metricName,
      categoryCol: 'state',
      countCol: 'minutes',
      groupBy: ['dt', 'station_id'],
    })
    for (const row of widened) {
      const key = `${row.dt}\x00${row.station_id}`
      const existing = merged.get(key)
      if (existing) Object.assign(existing, row)
      else merged.set(key, { ...row })
    }
  }
  return [...merged.values()]
}
```

(Or one fused pass over the tall rows — cheaper than 5 filter +
pivots. Optimize once we have a working version.)

## Pyramid config

```yaml
# gbfs/api/pyrmts/avail.yml — embedded in worker via vite-plugin-yaml
axis: time
binCol: dt

storage:
  type: r2
  bucket: ctbk
keyTemplate: 'avail/agg/{tier}/{period}.parquet'

dims:
  - { name: station_id, type: string }

metrics:
  - { name: bikes,    monoid: histogram }
  - { name: ebikes,   monoid: histogram }
  - { name: docks,    monoid: histogram }
  - { name: disabled, monoid: histogram }
  - { name: pending,  monoid: histogram }

tiers:
  - { name: mo1, bin: 1mo, shard: 1y }   # yearly shard, monthly bins
  - { name: d1,  bin: 1d,  shard: 1mo }  # monthly shard, daily bins
  - { name: h1,  bin: 1h,  shard: 1d }   # daily shard, hourly bins
```

(YAML can also be built in code if `vite-plugin-yaml` isn't already in
the worker — same data, just no `parsePyramidYaml` step.)

## Reducer dispatch (post-stitch)

`stitch` returns rows with histograms inline. Apply the requested
reducer to the merged histograms (essentially what `availFinalize`
does today, but reading the histogram from a JSON column instead of
a streaming fold over per-state rows):

```ts
function applyReducer(rows: Row[], metric: string, reducer: AvailAgg): unknown[] {
  switch (reducer) {
    case 'mean':
      return rows.map(r => ({ ...r, [metric]: histogramMean(r[metric]) }))
    case 'p05': case 'p25': case 'p50': case 'p75': case 'p95':
      return rows.map(r => ({ ...r, [metric]: histogramQuantile(r[metric], pctOf(reducer)) }))
    case 'min': return rows.map(r => ({ ...r, [metric]: histogramMin(r[metric]) }))
    case 'max': return rows.map(r => ({ ...r, [metric]: histogramMax(r[metric]) }))
    case 'hist': return rows.map(r => ({ ...r, [metric]: r[metric] }))  // pass through
  }
}
```

The reducer math (`histogramMean`/`Quantile`/`Min`/`Max`) is the same
shape as today's `availHistQuantile` in `gbfs/api/src/totals.ts:476` —
just reads from a Map instead of folding sparse rows. Probably ~30 LoC
of reused logic.

## Watermarks

ctbk's `avail/agg/<tier>` shards are built by `ctbk avail-agg-{h1,d1,mo1}`
(Python) — see `update.sh`. For pyrmts:

| Tier | Latest-complete-bin |
|---|---|
| h1 (hourly bins, daily shards) | end of *yesterday* UTC (today's `h1/<today>.parquet` is in-progress) |
| d1 (daily bins, monthly shards) | end of *previous calendar month* |
| mo1 (monthly bins, yearly shards) | end of *previous calendar year* |

Simplest first cut: hardcode these formulas (today − 1d / start-of-this-month
/ start-of-this-year). Future: read a `avail/agg/watermarks.json` written
by the build step.

For in-progress data past the h1 watermark, fall back to existing
`stitchInProgressDay` (reads today's WAL JSONs + h1 raw hourly shards
+ /day raw bundle). That path stays as-is.

## Worker integration

`/api/totals?kind=availability` is the call site. Two phases:

### Phase 1: shadow-mode

Run BOTH paths for every cascade-eligible request:
1. Legacy `executeAvailTotalsQuery` (returns result to client)
2. Pyrmts path (logged delta only)

Log shape:
```
avail-pyrmts-shadow tier=h1 periods=2 reducer=mean rows_legacy=12035 rows_pyrmts=12035
  exact_match=99.98% max_abs_diff=1e-7 fallback=0
```

Target before flipping: ≥1000 distinct queries, `exact_match ≥ 99.9%`,
`max_abs_diff ≤ 1e-6` for `mean`; for `p*`, `min`, `max`, exact match.

### Phase 2: cut-over

`/api/totals?kind=availability` calls pyrmts first; legacy fallback on
pyrmts read error. After ≥1 week stable, delete the legacy path.

### Phase 3: cascade deprecation

The sum-monoid cascade (`gbfs/avail/agg=*/cons=*/...`) becomes redundant
once pyrmts is serving everything from the histogram-shape shards. The
cascade write path (cascade worker + loader) can be deprecated:
- Stop the cascade worker's cron.
- Loader can keep running if `1m@1m` shards are useful for something
  else (e.g. backfilling daily compactions); otherwise also stop.
- Existing cascade shards stay on R2 indefinitely (free; no consumer
  reads them).

## BC + safety

- **`/1min` poller**: untouched. Pyrmts reads `avail/agg/<tier>` shards
  only; never the WAL JSONs.
- **Legacy `executeAvailTotalsQuery`**: kept through Phase 1+2. Only
  removed after pyrmts has been serving cleanly for ≥1 week.
- **Histogram reducer math**: today's `availHistQuantile`/`availFold`
  logic is correct; we just port it to read from a JSON-column histogram
  instead of streaming sparse rows. Same numerical outputs (modulo
  pivot reordering, which doesn't affect histogram contents).
- **Today's in-progress hour**: pyrmts can't serve today's `h1`
  shard (it's incomplete). Watermark stops at end-of-yesterday-UTC.
  For today's data, fall back to existing `stitchInProgressDay`.

## Why this is "better" than the avail-cascade-read-path I scrapped

That earlier draft tried to wire `/api/totals` onto the **sum-monoid
cascade** (`gbfs/avail/agg=*/cons=*/...`), which only serves `mean`.
This draft wires it onto the **legacy histogram shards** via pyrmts'
new histogram monoid — full reducer parity, no schema redesign
needed. The cascade infrastructure (originally built for "real
pyramid serving") becomes redundant + retire-able.

## Sequencing

1. **`pnpm add pyrmts` in `gbfs/api/`**. Verify imports.
2. **Pyramid config**: write `avail.yml` (or build in code).
3. **Sanity check `planQuery`**: same tier selection as today's
   `pickAvailAggTier` for representative inputs.
4. **Pivot adapter** (`pivotPerMetric`): write + unit-test.
5. **Reducer dispatch**: port `availHistQuantile`/`mean`/`min`/`max`
   to read from JSON-column histograms. Unit tests against the same
   fixture inputs as today's `availFold` tests.
6. **Shadow mode**: dual-run. Log delta. No client-visible change.
7. **Verify** (≥1k requests, exact-or-near-exact match).
8. **Cut over**. Pyrmts path becomes primary; legacy is fallback.
9. **Delete** legacy path + start cascade deprecation.

Steps 1–6 are ~2–3 days of focused work. Steps 7–9 happen organically
over a week of real traffic.

## Non-goals (this spec)

- `/api/query` (multi-scale time-series) for avail. Same wire-up
  pattern would apply; out of scope here.
- Geo extension. Avail-with-geo is pyrmts milestone 5 / +geo —
  separate spec when `pyrmts-geo` ships.
- Trips. Trips port is `specs/pyrmts-trips-port.md`; uses sum/count
  monoid; independent timeline. (Likely better to do trips first
  since the schema bridge is column-rename only, simpler test bed.)

## References

- `~/c/pyrmts/SPEC.md` — pyrmts design
- `c5adcdc` (pyrmts) — histogram monoid impl
- `e3beb70` (pyrmts) — `pivotTallToHistogram` adapter
- `gbfs/api/src/totals.ts` — current `AvailHistRow`, `availFold`,
  `availFinalize`, `availHistQuantile`
- `gbfs/api/src/index.ts` § `executeAvailTotalsQuery` — call site
- `specs/done/avail-perf-pass.md` — original cascade design (now redundant)
