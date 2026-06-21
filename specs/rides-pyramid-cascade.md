# rides → pyramid-cascade migration

Port rides-v3 from the legacy pyrmts `cascade_tiers` path to the
unified `ctbk pyramid-cascade` engine (per `specs/pyramid-cascade.md`).
Same engine, schema, and tier layout that drove the avail-v3 cutover.

## Why

The medium-term FE roadmap is a **generic stations-collection page**:
the current station page (SP) becomes parameterizable by an arbitrary
set of stations (1 → all), with avail and rides both shown as
geo+time pyramids and the homepage falling out as the "all" instance.

Avail-v3 is already in the new shape (S2-cell LUC + pyramid-cascade
build, `avail-v3/<tier>/<period>.parquet`). Rides-v3 is already in
the **right data shape** (S2-cell LUC per #108), but the build still
runs the legacy per-level `pyrmts.cascade_tiers` path. Migration gets
us:

- Unified cascade engine — one ProcessPool-driven, chunked-pivot,
  reduce-staged build for both pyramids.
- Faster monthly incrementals (the current per-tier cascade is
  serial; parallel reduce should cut wall ~3-5×).
- Manifest emission (`_manifest.json`) so the worker can
  watermark-plan rides queries the same way it does avail.
- A common code path that's easier to extend (new tiers, schema
  evolution, S2 level changes).

Non-goal: the data **shape** is already right. This is an engine
migration, not a reshape.

## Current state

- Source: `s3/ctbk/normalized/<ym>.parquet` (rides), with v0
  backfill for 202001–202101 (Gender/Birth Year/Bike ID).
- Output today: `rides-v3/<anchor>/<tier>/<period>.parquet` (two
  sibling pyramids, `anchor ∈ {start, end}`).
- Cell column: `<anchor>_s2_cell` (S2 token, levels 10/12/14 LUC).
- Metrics (sum-monoid, per pyrmts-geo convention):
  - `count_n`, `count_sum`, `count_sumsq` — # rides
  - `duration_n`, `duration_sum`, `duration_sumsq` — duration_s
- Dimensions: `gender`, `user_type`, `bike_type`.
- Tier list: same shape as avail (1h@1mo base + cascade), shipped
  through `/3d, /7d` + calendar `/1mo, /3mo, /1y` (rides spans 13y
  so calendar tiers are real, not skipped like avail).
- Build entry point: `ctbk rides-v3-build` in `ctbk/rides_v1.py`
  (variant-parameterized — v1/v2/v3 share code).

## Blockers / scope

### 1. Engine generalization: vectorized cascade primitive in pyrmts

`ctbk/pyramid_cascade/engine.py:_build_tier_shard` is currently
hard-coded to histogram-monoid: groups by `(dims, dt_out, metric,
state)` then pivots `metric→hist_json`. That shape doesn't apply to
rides, where each metric is a single Int64 to sum-aggregate.

**Where this work belongs: pyrmts, not ctbk.** Two reasons:

1. **Monoid abstraction already lives in pyrmts.**
   `~/pyrmts/python/pyrmts/src/pyrmts/monoids.py` defines the `Monoid`
   ABC + `_Sum`, `_Count`, `_Histogram` impls. The dispatch is
   solved — ctbk's engine just doesn't consume it.
2. **Pyrmts already has a generic cascade primitive.**
   `pyrmts/cascade.py:cascade_tiers` is monoid-polymorphic but
   row-at-a-time (Python dicts). It's what rides-v3 uses today.
   The vectorized Polars rewrite is the natural **successor** to
   `cascade_tiers`, not a parallel implementation in ctbk.

**Clean split:**

- **pyrmts**: per-block vectorized cascade primitive. Takes a source
  `pl.LazyFrame` (or `pa.Table`) + `Pyramid` + `(t_block_from,
  t_block_to)`, yields `(tier_name, period, pa.Table)` shards.
  Monoid-dispatched group_by + reducer per tier. No ProcessPool,
  no staging, no R2. Replaces `cascade_tiers` over time (or sits
  beside it as the vectorized variant — bikeshed later).
- **ctbk**: orchestrator — block enumeration, ProcessPool,
  staging/reduce phase, manifest emission, ingester registry, R2
  storage config, CLI. Refactors `engine.py:_build_tier_shard` to
  call the pyrmts primitive instead of hand-rolling the per-tier
  group_by + pivot.

**Monoid handling in the new primitive:**

- `histogram` → group by `(dims, dt_out, metric, state)`, sum
  `count`, pivot `metric` to wide hist_json columns. (Existing
  ctbk behavior.)
- `sum` → group by `(dims, dt_out)`, sum each metric's
  state-columns (`_n`, `_sum`, `_sumsq` per `Monoid.state_suffixes`).
  Wide in, wide out. No pivot.
- `count` → like sum but single column per metric.

Ingester contract becomes monoid-typed:
- histogram ingester returns long-form `(dim_cols, dt, metric,
  state, count)` (current avail shape).
- sum/count ingester returns wide form `(dim_cols, dt,
  <metric>_n, <metric>_sum, <metric>_sumsq, ...)`.

The pyrmts primitive picks the right group_by/reducer based on
`pyramid.metrics[i].monoid`. ctbk's ingester registry adds a
`monoid` field per entry (or reads it from the YAML).

### 2. Rides ingester (`ctbk/pyramid_cascade/rides_ingester.py`)

Returns a Polars LazyFrame at the base tier (1h@1mo), one row per
`(s2_cell, dt, gender, user_type, bike_type)` with the six sum-monoid
columns. Built by:

- Read normalized rides for the block range, filter to anchor-relevant
  rides (per `_load_rides_for_anchor` in `rides_v1.py`).
- Drop nulls / join lat-lng fallback (per `ctbk/rides_v1.py:317`).
- Resolve historical short_name → canonical short_name → LUC chain
  (per `specs/rides-v3-luc.md`).
- Explode each ride to its LUC + ancestor cells.
- `group_by(s2_cell, dt_hour, gender, user_type, bike_type).agg(
    count_n=count, count_sum=count, count_sumsq=count,
    duration_n=count, duration_sum=duration_s.sum(),
    duration_sumsq=(duration_s**2).sum())`

Lazy end-to-end so the cascade engine can stream (per the lesson
from `eb723c2e` / `60491cfa`).

**Two pyramids** (one per anchor): the simplest deployment is two
ingester registrations (`rides-start`, `rides-end`) + two YAML
configs. Alternative: a single `rides` ingester that yields both,
plus engine support for multi-pyramid builds. → Take the simple path
(two registrations); per-anchor parallelism is already exposed via
running two `ctbk pyramid-cascade` invocations.

### 3. YAML configs

`configs/pyramids/rides-{start,end}.yaml`:

```yaml
storage:
  type: s3
  bucket: ctbk
  key: "rides-v3/{anchor}/{tier}/{period}.parquet"   # {anchor} = start | end

axis: time
binCol: dt

dims:
  - { name: s2_cell,   type: string }
  - { name: gender,    type: string }
  - { name: user_type, type: string }
  - { name: bike_type, type: string }

metrics:
  - { name: count_n,      monoid: sum, type: int64 }
  - { name: count_sum,    monoid: sum, type: int64 }
  - { name: count_sumsq,  monoid: sum, type: int64 }
  - { name: duration_n,   monoid: sum, type: int64 }
  - { name: duration_sum, monoid: sum, type: int64 }
  - { name: duration_sumsq, monoid: sum, type: int64 }

tiers:
  - { name: 1h,  bin: 1h,   shard: 1mo }   # base — built by rides-v3-build, not cascade
  - { name: 2h,  bin: 2h,   shard: 1mo }
  - { name: 3h,  bin: 3h,   shard: 1mo }
  - { name: 6h,  bin: 6h,   shard: 1y }
  - { name: 12h, bin: 12h,  shard: 1y }
  - { name: 1d,  bin: 1d,   shard: 1y }
  - { name: 3d,  bin: 3d,   shard: all }
  - { name: 7d,  bin: 7d,   shard: all }
  - { name: 1mo, bin: 1mo,  shard: all }
  - { name: 3mo, bin: 3mo,  shard: all }
  - { name: 1y,  bin: 1y,   shard: all }
```

Resolve `{anchor}` substitution either at the key-template level (one
YAML, two invocations with `-p`-like flag) or as two separate YAMLs.
The pyramid-cascade `-p/--prefix` flag added in `3e7ff95d` only swaps
the prefix — it doesn't substitute mid-template tokens like
`{anchor}`. Easiest: two YAMLs that differ only in the literal
`start`/`end`.

`-p` is still useful for staging — `-p rides-v3-test` redirects both
anchors' outputs.

## Phases

### Phase 1a: Pyrmts — vectorized cascade primitive

In `~/pyrmts/python/pyrmts/src/pyrmts/`:

- New module (e.g. `cascade_polars.py`) exposing a
  `cascade_block(source, pyramid, time_range) ->
  Iterator[(tier_name, period, pa.Table)]` primitive.
- Monoid dispatch using the existing `monoids.py` catalog
  (histogram: long-form group_by + pivot; sum/count: wide
  group_by + reducer).
- Chunked-pivot mitigation (lift the `PIVOT_CHUNKS = 16`
  hash-bucket pattern from `ctbk/pyramid_cascade/engine.py`).
- Unit tests in `~/pyrmts/python/pyrmts/tests/` covering both
  monoids, mirroring existing `test_cascade.py` shape.
- Dist build via `npm-dist`-equivalent (pyrmts has its own
  publish/dev workflow — confirm with maintainer).

### Phase 1b: Ctbk — refactor engine to call pyrmts primitive

- `engine.py:_build_tier_shard` calls the new pyrmts primitive
  instead of hand-rolling group_by/pivot.
- `orchestrator.py:_merge_long` similarly delegates to a pyrmts
  reduce primitive (or the same one applied to staging partials).
- Ingester contract: add `monoid` to `_INGESTERS` registry entries.
- Existing avail histogram tests must continue to pass (regression
  guard).

### Phase 2: Rides ingester

- Write `ctbk/pyramid_cascade/rides_ingester.py` for the 1h base tier.
- Register in `cli.py:_INGESTERS` as `rides-start`, `rides-end`.
- Unit test against a 1-month fixture (mirror
  `tests/test_engine.py`).

### Phase 3: YAML + smoke

- Add `configs/pyramids/rides-{start,end}.yaml`.
- Smoke on 1 month, 1 worker, `-p rides-v3-test`:
  ```bash
  ctbk pyramid-cascade -c configs/pyramids/rides-start.yaml \
      -i rides-start -r 2024-05-01/2024-06-01 -j 1 -t 1mo \
      -p rides-v3-test
  ```
- Verify 10 derived tiers written under `rides-v3-test/start/`.

### Phase 4: Full backfill

- 2013-06 → present, both anchors, against `rides-v3-test/`.
- Wall estimate: avail's 2-month full rebuild took ~30 min at -j 16
  on a c7a.16xlarge (chunked pivot + parallel reduce). Rides spans
  13 years × 12 months/year × 2 anchors = 312 month-blocks per anchor.
  At -t 1mo and -j 16, rough estimate: 3-6 hours per anchor.
- Watch RSS — rides shards are larger than avail's per-month
  (more rows once dims explode), may need to chunk pivot at
  finer granularity than `PIVOT_CHUNKS=16`.

### Phase 5: Concordance vs prod

- Use the same per-`(tier, period)` shard diff as avail
  (`scripts/concordance.py`). Adapt for sum-monoid: compare per-row
  numeric equality on each of the six metric columns instead of
  histogram JSON parsing.
- Acceptance: byte-identical or numerically exact across all
  shipped `(anchor, tier, period)` tuples.

### Phase 6: Cutover

- If concordance is perfect: `aws s3 sync rides-v3-test/ →
  rides-v3/` (analogous to `scripts/avail-v3-cutover.sh`).
- Emit `_manifest.json` for each anchor.
- Worker (`gbfs/api/src/rides_geo.ts` — if it exists yet) consumes
  the manifest like `avail_geo.ts` does.
- FE: rides queries already hit `/api/rides-v3?cells=…` per
  `specs/rides-v3-luc.md`; no FE change needed for this
  engine-swap (FE changes come later for the stations-collection
  generalization).

### Phase 7 (deferred — FE roadmap, separate spec): generic
stations-collection page

Out of scope for this spec. Once rides + avail are both on
pyramid-cascade + S2 LUC, the FE work is:
- URL state for "cells of interest" (single station, multi-select,
  region, all).
- Generic page component parameterized by cells (replacing
  station-specific SP).
- Homepage → "all cells" instantiation.

## Risks / open questions

- **Pyrmts coordination.** The vectorized primitive lives in pyrmts,
  so its release/dist cadence gates ctbk. Either iterate locally via
  `pds l pyrmts` then ship pyrmts + ctbk together, or land pyrmts
  first + bump ctbk's pinned pyrmts SHA.
- **Engine generalization scope.** Sum-monoid path is simpler than
  histogram (no pivot), but reduce-phase `_merge_long` is built around
  the long-form schema; need to inspect whether a wide sum-form
  passes through cleanly or needs a parallel reduce path.
- **Memory at -j 16 + multi-month task_size.** Rides has 6 metric
  cols + 3 categorical dims; per-block memory ≈ rows × cols × dtype.
  Worth a single-month single-worker dry-run first to size from.
- **historical short_name → canonical → LUC denorm.** Built once
  outside the engine (cf. `specs/rides-v3-luc.md`) and joined in
  the ingester. Already exists in `rides_v3.py`; just port the
  loader.
- **v0 backfill (202001-202101).** Existing rides-v3 build handles
  this via a separate input path. Ingester must respect it.
- **Calendar tiers (`1mo`, `3mo`, `1y`).** Avail skipped these
  (data too young); rides needs them. Pyrmts's `floor_to_span`
  refuses multi-unit calendar bins per
  `specs/pyramid-cascade.md` (#122). Single-unit (`1mo`, `1y`)
  works; verify `3mo` does too — may need `1mo` substitute until
  #122 lands.

## Pickup checklist

```bash
# In pyrmts (Phase 1a starts here)
cd ~/pyrmts
git pull
ls python/pyrmts/src/pyrmts/    # cascade.py (row-at-a-time), monoids.py (catalog)

# In ctbk (Phase 1b after pyrmts lands)
cd ~/ctbk
git pull
spd && uv sync
git log --oneline | head -20    # confirm prefix-config + cutover commits present
grep -n 'state\|pivot' ctbk/pyramid_cascade/engine.py | head
```
