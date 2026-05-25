# Spec: port ctbk **trips** read path to `pyrmts`

> Status: **draft** (2026-05-24). Pyrmts milestone 2 (ctbk trips —
> sum + count only, no geo dep). Companion to `~/c/pyrmts/SPEC.md`.

## Scope

Replace the ctbk trips serving code in `gbfs/api/` with calls into the
`pyrmts` (TS) library. Specifically the `/api/query?kind=trips` endpoint
(multi-scale time series — pyrmts native fit). `/api/totals?kind=trips`
is a downstream consideration (it's a single-bucket aggregate; pyrmts
needs `binBudget=1` semantics or a different abstraction).

`/api/totals?kind=availability` and `/api/query?kind=availability`
stay on the legacy histogram-schema path until pyrmts ships
`histogram` monoid + geo extension (milestone 5).

## Schemas

**ctbk `trips/agg/<tier>/<window>.parquet`** (`pqs` against
`trips/agg/d1/2024.parquet`):

```
dims: dt (INT64), short_name, side, region, gender (INT16), user_type, rideable_type
metrics: count (INT64), duration_s (INT64), duration_s_sq (INT64)
```

**Pyrmts `sum` monoid expects** (`monoids.ts:24`):

```
SUM_SUFFIXES = ['_n', '_sum', '_sumsq']
// metric `foo` → columns foo_n, foo_sum, foo_sumsq
```

**Mapping gap**: a metric `duration_s` declared with `monoid: sum`
expects columns `duration_s_n` / `duration_s_sum` / `duration_s_sumsq`,
but ctbk shards have `count` / `duration_s` / `duration_s_sq`.

(Note: ctbk's `count` and "n for duration_s" are the same number — one
observation per trip — so the schema is logically equivalent, just
spelled differently.)

## Mapping options

### A. Worker-side adapter (smallest blast radius — RECOMMENDED for v0)

Read shard rows via `fetchSegmentRows(storage, keys)`, run a per-row
adapter, then pass mapped rows to `stitch()`. Pyrmts library unchanged.

```ts
import { fetchSegmentRows, stitch, planQuery } from 'pyrmts'

const plan = planQuery(tripsPyramid, { range, binBudget, watermarks, filter })
const rawShards = await Promise.all(plan.segments.map(s => fetchSegmentRows(storage, s.keys)))
const mappedShards = rawShards.map(rows =>
  rows.map(r => ({
    dt: r.dt, short_name: r.short_name, side: r.side, region: r.region,
    gender: r.gender, user_type: r.user_type, rideable_type: r.rideable_type,
    count: r.count,
    duration_s_n: r.count,           // each trip is one observation of duration
    duration_s_sum: r.duration_s,
    duration_s_sumsq: r.duration_s_sq,
  })),
)
const stitched = stitch({ pyramid: tripsPyramid, plan, shardRows: mappedShards })
```

Pros: no pyrmts change; works today; can iterate on the YAML without
upstream coordination.
Cons: extra row-copy; per-consumer adapter — defeats some of the
"share the lib" benefit. Acceptable as the first port; clean up later.

### B. Pyrmts column-mapping extension (~30 LoC pyrmts PR)

Extend `Metric` with optional `columns` override:

```ts
interface Metric {
  name: string
  monoid: MonoidName
  columns?: Partial<Record<string, string>>  // suffix → actual column name
}
```

Then `Monoid.combine` looks up `metric.columns?.[suffix] ?? \`${name}${suffix}\``.

YAML:
```yaml
metrics:
  - { name: count, monoid: count }
  - name: duration_s
    monoid: sum
    columns: { _n: count, _sum: duration_s, _sumsq: duration_s_sq }
```

Pros: pluggable across consumers; awair/tomat could use it for similar
legacy schemas; ctbk's adapter goes away.
Cons: pyrmts API change; needs coordination with awair's in-flight
adoption.

### C. Rewrite ctbk shards in pyrmts naming

Regenerate `trips/agg/{h1,d1,mo1}` with renamed columns. Heaviest +
back-compat liability for any other consumer of those shards.

Punt.

## Pyramid config

```yaml
# ctbk-trips.yml
axis: time
binCol: dt

storage:
  type: r2
  bucket: ctbk
keyTemplate: 'trips/agg/{tier}/{period}.parquet'

dims:
  - { name: short_name,    type: string }
  - { name: side,          type: string }
  - { name: region,        type: string }
  - { name: gender,        type: int }
  - { name: user_type,     type: string }
  - { name: rideable_type, type: string }

metrics:
  - { name: count,      monoid: count }
  - { name: duration_s, monoid: sum }    # adapter maps ctbk cols → pyrmts suffixes

tiers:
  # Coarsest first per pyrmts convention.
  - { name: mo1, bin: 1mo, shard: 10y }  # decade-period
  - { name: d1,  bin: 1d,  shard: 1y  }
  - { name: h1,  bin: 1h,  shard: 1mo }
  # No `raw` tier — ctbk's raw trips live in `trips/stations/<short_name>.parquet`
  # (per-station bundles), which doesn't fit the `{tier}/{period}` template.
  # The per-station fallback in `tripsTotalsFallbackPaths` stays in
  # `executeTotalsQuery` for the station-scoped case.
```

Open question: pyrmts expects shard periods in named form (`'2024'`,
`'2024-04'`, `'2010'`). ctbk's d1 shards already use `2024.parquet`
(year-period from `yearsIn`), mo1 use `2010.parquet` (decade-period
from `decadesIn`), h1 use `2024-04.parquet` (month-period from
`monthsInDashed`). Need to verify pyrmts' `shardPeriodsCovering`
produces matching labels for `shard: 1mo / 1y / 10y`.

## Watermarks

Per pyrmts: each tier needs a `latest_complete_bin(tier) → instant`.
For ctbk trips:
- h1: complete through the end of the most recent imported month
  (`s3://tripdata` poll → `ctbk import` commits a new month → ci.yml
  runs `ctbk trips-agg-h1`). Determine via `aws s3 ls` head-of-list,
  or store a watermark JSON on R2.
- d1: complete through the end of the year *prior* to the most recent
  partial year. d1's 2026.parquet won't include in-progress 2026.
- mo1: same logic, decade-grained.

Simplest first cut: hardcode watermarks based on `now()` minus a
conservative slack (e.g. h1 watermark = start-of-this-month, d1 =
start-of-this-year, mo1 = start-of-this-decade). Future: write a
`trips/agg/watermarks.json` from `ctbk trips-agg-*` and read at request
time.

## Worker integration

Two paths:

1. **Use `pyrmts-cfw`'s `serveQuery`**: handles request parsing, plan +
   fetch + stitch, returns a Response. Cleanest, but `/api/query` has
   ctbk-specific request shape (kind/regions/station filter / synth-count)
   that doesn't fit `serveQuery`'s flat query params. Would need either
   to expose a pyrmts native shape OR wrap `serveQuery` lower-level.

2. **Call `planQuery` / `fetchSegmentRows` / `stitch` directly** from
   the existing `/api/query` handler. Keeps ctbk's request/response
   shape unchanged; pyrmts is the internal engine.

(2) is the BC-safe v0. (1) is a possible v2 once ctbk's API surface is
ready to align with pyrmts conventions.

## Sequencing

1. **Sanity-check `pyrmts.planQuery`** against ctbk's existing
   `planQuery` for kind=trips. Same inputs → same chosen tier? Same shard
   keys? Write a small comparison test.
2. **Adapter layer** (Option A above) in `gbfs/api/src/trips_pyrmts.ts`
   (new file). Self-contained.
3. **Dual-run / shadow mode**: for each `/api/query?kind=trips`,
   compute both via legacy path and via pyrmts adapter; log delta;
   return legacy. (Same shadow pattern from the avail spec, which is
   still a good pattern even if avail won't use it.)
4. **Verify** shadow output matches for a week of real traffic / a set
   of test queries.
5. **Cut over**: `/api/query?kind=trips` calls into pyrmts; legacy
   `planQuery.ts` trips branch can be deleted once stable.

`/api/totals?kind=trips` — defer to a follow-on spec (binBudget=1 vs.
a dedicated totals path is its own design question).

## BC + safety

- Pyrmts is internal to the worker. Public API shapes (`/api/query` /
  `/api/totals`) unchanged.
- Existing `trips/agg/{h1,d1,mo1}` shards keep working — pyrmts reads
  them via the adapter; no shard rewrite required.
- Trips raw (`trips/stations/<short_name>.parquet`) + per-region
  fallback (`trips/region/<r>/{h1,n1}/<window>.parquet`) stay on legacy
  paths — pyrmts doesn't need to handle them.
- Availability totally unaffected.
- Watermarks initial cut is conservative — under-reporting in-progress
  data is safer than over-reporting (and is what the legacy path
  already does via its in-progress fallback).

## Pyrmts changes (none required for v0)

If we go with Adapter (A): zero pyrmts changes. If we later move to
Option B (column-mapping), that's a separate `~/c/pyrmts/specs/`
spec + ~30 LoC PR.

## References

- `~/c/pyrmts/SPEC.md` — pyrmts design (ctbk listed as milestone 2 / 5)
- `~/c/pyrmts/js/packages/pyrmts/src/` — current TS impl (~2.5K LoC)
- `gbfs/api/src/planQuery.ts` — current ctbk planner (to be replaced)
- `gbfs/api/src/totals.ts` — current `tripsAggKeys` / tier picker
- `gbfs/api/src/index.ts` § `executeQuery` — call site
