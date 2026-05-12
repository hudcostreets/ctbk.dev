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

#### Phase A.1 — writer dual-write [DONE, commit `b2af3233`]

Both writers `put()` to the old key AND its `gbfs/`-prefixed twin in
parallel. Additive; reversible by dropping the new puts.

- `gbfs/lib/cascade.ts`: new `gbfsKey(oldKey)` helper.
- `gbfs/cascade/src/index.ts`: `attemptCons` + `attemptAgg`
  `Promise.all([r2.put(outKey, ...), r2.put(gbfsKey(outKey), ...)])`.
- `gbfs/loader/src/index.ts`: `writeAvailShard` does the same for
  `pqKey` and `gbfsKey(pqKey)`.

**To deploy A.1**:
```
cd gbfs/cascade && pnpm deploy
cd gbfs/loader  && pnpm deploy
```
Verify next tick: `aws s3 ls s3://ctbk/gbfs/avail/agg=1m/cons=1m/<today>/ | tail`
should grow by ~1 file/minute. Same for the cascade outputs (5m, 15m,
1h, agg-self at each level) on their respective tick cadences.

#### Phase A.2 — historical copy + reader cut-over [code staged]

**Step 1 — historical copy** (user-gated, only after A.1 deploy is live
and confirmed dual-writing):
```
aws s3 cp s3://ctbk/avail/agg=1m/  s3://ctbk/gbfs/avail/agg=1m/  --recursive --profile cf
aws s3 cp s3://ctbk/avail/agg=5m/  s3://ctbk/gbfs/avail/agg=5m/  --recursive --profile cf
aws s3 cp s3://ctbk/avail/agg=15m/ s3://ctbk/gbfs/avail/agg=15m/ --recursive --profile cf
aws s3 cp s3://ctbk/avail/agg=1h/  s3://ctbk/gbfs/avail/agg=1h/  --recursive --profile cf
aws s3 cp s3://ctbk/avail/agg=1d/  s3://ctbk/gbfs/avail/agg=1d/  --recursive --profile cf
```
Skip `avail/agg/` (legacy daily-flat) — that's Phase B's problem.

**Step 2 — reader cut-over** [staged; deploy only after Step 1 is done]:
- `gbfs/lib/cascade.ts`: `consKey` now returns the `gbfs/`-prefixed
  path; `consKeyOld` retained for the dual-write.
- `gbfs/lib/avail-monoid.ts`: `availParquetKeyFromStatusKey` returns
  the `gbfs/`-prefixed path; `availParquetKeyOldFromStatusKey` retained
  for the dual-write.
- `gbfs/cascade`, `gbfs/loader`: dual-write `put(<new>)` + `put(<old>)`
  via the helpers above.
- `gbfs/api/src/health.ts:248`: probe prefix swapped to `gbfs/avail/agg=...`.
- `www/src/pages/Health.tsx`: "Today's cascade" link points at
  `/files/gbfs/avail/agg=1m/cons=1m/...`.

**Not in scope (deferred)**:
- `gbfs/api/src/planQuery.ts` does NOT yet consume the cascade pyramid
  (its `avail/region/...` paths are a different sub-tree, no writer);
  nothing to cut over there.
- `gbfs/api/src/index.ts:1352` file-tree allow-list keeps `'avail/'`
  until Phase C (when top-level `avail/` is empty).
- `gbfs/lib/ensureCell.ts` uses a separate `dt=` key format only
  consumed by the `gbfs` CLI's `ensure` cmd; not wired to live workers.

#### Phase A.3 — stop old writes

After A.2 deploy + ≥24h verifying readers happy, drop the old `put()`
calls (and the `consKeyOld` helper). Cascade + loader write only the
`gbfs/`-prefixed path.

#### Phase A.4 — delete old data (user-gated, destructive)

```
aws s3 rm s3://ctbk/avail/agg=1m/  --recursive --profile cf
aws s3 rm s3://ctbk/avail/agg=5m/  --recursive --profile cf
aws s3 rm s3://ctbk/avail/agg=15m/ --recursive --profile cf
aws s3 rm s3://ctbk/avail/agg=1h/  --recursive --profile cf
aws s3 rm s3://ctbk/avail/agg=1d/  --recursive --profile cf
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
