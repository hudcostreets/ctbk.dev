# Spec: R2 storage layout cleanup — consolidate under `gbfs/`

> Status: **draft** (2026-05-12, v2). Settles the destination layout the
> health page targets. Physical migration sequenced after the page lands.

## Problem

Derived GBFS data is split across two top-level R2 prefixes (`gbfs/...`
and `avail/...`) with three+ generations of naming overlapping each
other. The split has no organizing principle — `avail/` ≠ "not GBFS";
it's just GBFS data at a different processing stage.

Surfaced when the file browser at `/files/*` showed `avail/` and `gbfs/`
as siblings: *"isn't this all GBFS data?"* Yes.

## Current state

```
gbfs/                                                     ← raw + some derived
├── status/<date>/<HH-MM>.json                            n0 — raw minute poll      [cron worker writes]
├── status/<date>.parquet                                 daily WAL bundle          [compact-r2.py writes]
├── stations/<uuid>/<yyyymm>.parquet                      per-station month slice   [compact-r2.py slice writes]
├── info/<date>.json                                      daily station info        [cron worker writes]
├── heartbeat/...                                         cron heartbeat            [cron worker writes]
└── avail/                                                ← already a derived sub-tree, just incomplete
    ├── raw/day/<date>.parquet                            d0 — raw daily bundle     [avail_raw_day.py writes]
    └── h1/<date>/<HH>.parquet                            h1 — hourly aggregate     [compactor CFW writes]

avail/                                                    ← should NOT be a top-level
├── agg/                                                  legacy daily-flat
│   ├── h1/<date>.parquet                                 hourly agg, file-per-day
│   ├── d1/<yyyymm>.parquet                               daily agg, file-per-month
│   └── mo1/<year>.parquet                                monthly agg, file-per-year
└── agg=<A>/cons=<C>/<period>.parquet                     multi-scale grid (current)
```

### Readers (blast radius)

| Path | Reader |
|------|--------|
| `gbfs/status/<date>/<HH-MM>.json` | loader CFW, daily compactor, api worker |
| `gbfs/status/<date>.parquet` | compactor downstream phases |
| `gbfs/stations/<uuid>/<yyyymm>.parquet` | api worker `getStationMonthFromR2` |
| `gbfs/info/<date>.json` | `load_gbfs_info.py` |
| `gbfs/avail/raw/day/<date>.parquet` | api worker `totals.ts:rawDayKey` |
| `gbfs/avail/h1/<date>/<HH>.parquet` | api worker `index.ts`, `ctbk/avail_agg.py` |
| `avail/agg/h1/<date>.parquet` | api `totals.ts:317` |
| `avail/agg/d1/<yyyymm>.parquet` | api `totals.ts:316` |
| `avail/agg/mo1/<year>.parquet` | api `totals.ts:315` |
| `avail/agg=A/cons=C/<period>.parquet` | api `planQuery.ts` (multi-scale path), cascade CFW, loader CFW, `/api/health` |

## End state — everything under `gbfs/`

```
gbfs/
├── status/<date>/<HH-MM>.json                            unchanged
├── status/<date>.parquet                                 unchanged
├── stations/<uuid>/<yyyymm>.parquet                      unchanged
├── info/<date>.json                                      unchanged
├── heartbeat/...                                         unchanged
└── avail/                                                ← single home for ALL derived availability
    ├── raw/day/<date>.parquet                            unchanged (already here)
    ├── h1/<date>/<HH>.parquet                            unchanged (already here)
    └── agg=<A>/cons=<C>/<period>.parquet                 ← moved from top-level `avail/agg=*/cons=*/`

(top-level `avail/` deleted)
```

Legacy daily-flat `avail/agg/{h1,d1,mo1}/` retire or relocate as part
of the migration (recommended: retire once cascade-pyramid coverage in
the multi-scale path is broad enough that `/api/totals` doesn't depend
on them — see `specs/cascade-backfill.md`).

Top-level becomes `{gbfs/, trips/, …}` with each top-level corresponding
to one upstream data source.

## Migration

Standard four-phase pattern, per user:

1. **Dual-write**: every writer pushes to both old and new keys.
2. **Reader cut-over**: each reader switches to the new key.
3. **Stop old writes**: once readers verified, drop the old write site.
4. **Delete old data**: `aws s3 rm --recursive` against the old prefix.

Each phase is reversible until the next. Phases 1-3 are code-only; phase
4 is destructive and user-gated.

### Phase A — cascade pyramid (`avail/agg=*/cons=*/` → `gbfs/avail/agg=*/cons=*/`)

This is the bulk of the migration — every-minute writes plus large
historical volume. Worth doing first because every other derived path
either already lives under `gbfs/avail/` or is low-traffic.

**Writers** to dual-write:
- `gbfs/loader/src/index.ts` — writes `avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`
  on each R2 event. Add a parallel `gbfs/avail/agg=1m/cons=1m/...` put.
- `gbfs/cascade/src/index.ts` — `attemptCons` (line 116) and `attemptAgg`
  put outputs derived from `consKey(agg, cons, bucketStartMin)` in
  `gbfs/lib/cascade.ts`. Cleanest fix: update `consKey` to prefix
  `gbfs/`. With one source-of-truth helper, all writers + readers
  using it move atomically. But that breaks compat for readers still on
  the old path — so instead, add a `consKeyOld` returning the
  unprefixed path, dual-write to both, then swap `consKey` to the new
  path when readers are ready.

**Readers** to cut over (after writers dual-writing for a few cycles):
- `gbfs/api/src/planQuery.ts` (multi-scale path) — derives keys via
  `consKey`. Cut over by swapping the import target.
- `gbfs/api/src/health.ts` (`/api/health`) — derives keys for the
  cascade-cell probe. Update prefix.
- `gbfs/api/src/index.ts` (`/api/files/*` R2Store) — extend allow-list
  from `['gbfs/', 'avail/']` to just `['gbfs/']` once `avail/` is empty.
- Local test fixtures + `gbfs/cli/src/store.test.ts` — update test
  paths.

**Historical copy** (user-gated):
```
aws s3 cp s3://ctbk/avail/ s3://ctbk/gbfs/avail/ --recursive --profile cf
```
(Filter to skip `avail/agg/` legacy if retiring rather than moving.)

**Delete old** (user-gated, after a grace window):
```
aws s3 rm s3://ctbk/avail/agg=1m/ --recursive --profile cf
# ... and for each other agg level
```

### Phase B — legacy daily-flat (`avail/agg/{h1,d1,mo1}/`)

Two options:
- **B.1 Retire**: `/api/totals` switches to cascade-pyramid reads.
  Requires cascade coverage to be broad enough (`specs/cascade-backfill.md`).
- **B.2 Relocate**: move to `gbfs/avail/legacy/{h1,d1,mo1}/`. Same
  dual-write pattern.

Recommendation: B.1 once cascade coverage is sufficient. Until then: do
nothing (these are low-traffic GHA-written shards; leaving them at
`avail/agg/...` doesn't block Phase A which targets `avail/agg=*/`).

### Phase C — verify + drop top-level `avail/`

Once Phase A complete and Phase B resolved, top-level `avail/` should
be empty. Verify:
```
aws s3 ls s3://ctbk/avail/ --recursive --profile cf | head
```
Then drop the file-browser allow-list entry (`['gbfs/']` only) and
remove `avail/` references from docs.

## Out of scope (this spec)

- `trips/` tree migration — separate top-level concern.
- Renaming the cascade-pyramid's internal `agg=A/cons=C/<period>.parquet`
  format — Hive-style is stable; only the parent prefix changes.
- DVC-tracked `s3/ctbk/...` paths.

## Open questions

- **`consKey` swap vs. dual-key**: simpler to dual-write via two
  parallel `put()` calls (no source-of-truth helper churn) until
  ready, then swap. Recommended: explicit dual-`put` in each writer.
- **Worker memory**: dual-writes double each `put()` cost — small
  (~200KB to ~6MB per shard), negligible compared to the input read +
  parquet encode work. No risk.
- **R2 event consumers**: loader is a queue consumer. When it dual-writes,
  does the queue need to fire twice? No — `r2.put` doesn't trigger our
  own queue; only PutObject events from the original WAL write do.

## References

- `specs/cascade-backfill.md` — gates Phase B
- `specs/done/avail-perf-pass.md` — cascade design (`consKey` source)
- `specs/done/gbfs-r2-only.md` — introduced `gbfs/avail/h1/`
- `gbfs/lib/cascade.ts` `consKey` — single helper used by all
  cascade-pyramid writers/readers
