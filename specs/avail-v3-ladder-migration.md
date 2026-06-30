# avail-v3: unified-shard-ladder migration (umbrella)

Sequencing spec for moving ctbk's avail-v3 pyramid from the
canonical/partial dichotomy to the unified shard-duration ladder
defined in `~/c/pyrmts/specs/unified-shard-ladder.md`. Lists every
phase, their dependencies, where they run (`e` vs laptop), and which
sub-spec carries the detail.

Goal end-state: every avail-v3 tier `T` has a ladder
`T.shards: Shard[]` (e.g. `/1m: [5min..1d]`, `/15m: [30min..15d]`),
the writer compactor walks the ladder uniformly per tier, the planner
picks largest-shard-first via the cursor-aware walk, and every
declared `(tier, shard_dur)` has a complete historical tiling across
`[2026-04-08, present)`.

## Dependency graph

```
pyrmts JS ladder refactor (DONE, pushed)
            │
            └─→  PY  pyrmts Python ladder catch-up (DONE — 38175b1)
                        │
                        ├─→  P0  ctbk Python pyramid_cascade adoption (DONE — fab241bb)
                        │
                        └─→  P2  ctbk JS pin bump + avail.yaml rewrite (DONE — fab241bb)
                                  │
                                  │  ┌────────── DEPLOY CUTOVER (tightly sequenced) ──────────┐
                                  │  │                                                          │
                                  ├──┤  P5a  R2 COPY legacy → new (--no-delete, additive)       │
                                  │  │      │                                                   │
                                  │  │      └─→ P3   D1 ALTER cadence → shard_dur               │
                                  │  │             │  (breaks deployed cascade for ~minutes;    │
                                  │  │             │   step P4 must follow immediately)         │
                                  │  │             └─→ P4   Deploy new cascade + api workers    │
                                  │  │                       │                                  │
                                  │  │                       └─→ P5b  D1 row-value UPDATE       │
                                  │  │                              │  (canonical sentinel →    │
                                  │  │                              │   largest-rung; rewrite   │
                                  │  │                              │   pyramid_shards.key)     │
                                  │  │                              └─→ P5c  R2 DELETE legacy   │
                                  │  │                                       (after smoke-test) │
                                  │  └──────────────────────────────────────────────────────────┘
                                  │
                                  ├─→ P7  intermediate-size backfill (e, post-cutover)
                                  │         │
                                  │         └─→ P8  FE flag flip + retire `totals` (laptop)
                                  │
                                  └─→ P9  avail.yaml as source-of-truth + JS codegen (laptop)

P1 /1m@1d historical backfill (e) ──── (independent; lands legacy path, renamed in P5a)
```

PY done; P0 + P2 done (commit fab241bb, uncommitted-then-committed).
P1 can still run today in parallel with the deploy cutover.

**P3 is now positioned as a hard deploy gate**, not a follow-up.
Discovery during P5 spec work: the new pyrmts-cfw `D1ShardIndex`
class hard-codes `SELECT ... shard_dur ... FROM pyramid_shards`, so
the new cascade/api workers cannot read or write the current D1
(which has `cadence` column) until P3 ALTERs the column. Conversely
the deployed old cascade writes to `cadence`, so AFTER the ALTER it
fails until a redeploy. The deploy window is minutes; cron misses
1–2 ticks; no data loss (next tick resumes).

## Phase index

| # | Phase | Owner | Spec | Status |
|---|---|---|---|---|
| **PY** | pyrmts Python ladder catch-up (data model only; ShardIndex etc. deferred) | pyrmts repo | `~/c/pyrmts/specs/python-unified-ladder.md` | **done** (pyrmts 38175b1) |
| **P0** | ctbk Python `pyramid_cascade` adoption (largest-rung writer + path-format update) | laptop | inline below | **done** (commit `fab241bb`) — 9/9 tests pass |
| **P1** | `/1m@1d` historical backfill (2026-04-08..2026-06-28) | `e` | `specs/avail-v3-1m-backfill.md` | spec written |
| **P2** | ctbk JS pin bump + `avail.yaml` rewrite | laptop | inline below | **done** (commit `fab241bb`) — api/cascade/www tc + tests green |
| **P4** | CFW + api code in `fab241bb` (gbfs/cascade + gbfs/api committed; not deployed) | laptop | impl in `fab241bb`; deploy = step in P3/P5 cutover | code done; deploy pending P3+P5a |
| **P5a** | R2 COPY legacy → new (`--no-delete --r2-only`) | laptop | `specs/avail-v3-storage-rename.md` | spec ready; script TBD |
| **P3** | D1 `ALTER … RENAME COLUMN cadence TO shard_dur` (both tables) | laptop | inline below + cutover section in `specs/avail-v3-storage-rename.md` | not yet impl |
| **P4d** | Deploy new cascade + api (immediately follows P3) | laptop | wrangler deploy from `gbfs/cascade` + `gbfs/api` | gated by P3 |
| **P5b** | D1 row-value UPDATE (`cadence=''` → largest; rewrite `pyramid_shards.key`) | laptop | `specs/avail-v3-storage-rename.md` | spec ready; script TBD |
| **P5c** | R2 DELETE legacy paths (post-smoke) | laptop | `specs/avail-v3-storage-rename.md` | spec ready; script TBD |
| **P7** | Intermediate-size historical backfill | `e` | `specs/avail-v3-intermediate-backfill.md` | spec to write |
| **P8** | FE flag default → `v3` + retire `/api/totals` | laptop | follow `availSrc=v3` flip (already done via flag) + sup. by `#108` | not yet impl |
| **P9** | `avail.yaml` as source of truth + JS codegen | laptop | `specs/avail-yaml-source-of-truth.md` | spec written |

## Phases

### PY — pyrmts Python ladder catch-up

See `~/c/pyrmts/specs/python-unified-ladder.md`. Brings `python/pyrmts/`
to the unified-ladder data model: `Tier.shard: str` → `Tier.shards:
tuple[str, ...]`, YAML accepts new shape, `{shard}` keyTemplate
placeholder, `cascade_tiers` rewrites to per-tier ladder walk.

Scope deliberately narrow: only what's needed for materialization
(YAML parse, key substitution, cascade). `ShardIndex` /
`ManifestShardIndex` / per-(tier,cadence) earliest watermarks /
planner grid-walk are query-time concerns; deferred until a Python
query consumer needs them (none today).

This is the gating phase for every subsequent step except P1.

### P0 — ctbk Python `pyramid_cascade` adoption

After PY lands:

```bash
# Bump Python pin to the new pyrmts version
# (whichever dist mechanism pyrmts uses — PyPI / GH URL).
uv sync   # or equivalent
```

Update `ctbk/pyramid_cascade/` modules that call `cascade_tiers`:
- `cli.py`: probably no signature change at the CLI level, but verify.
- `engine.py`, `engine_streaming.py`, `orchestrator.py`: drop the
  `derive_from` parameter from `cascade_tiers` calls; the per-tier
  ladder lives in YAML now.
- `tests/test_engine.py`, `tests/test_orchestrator.py`: update
  fixtures + assertions to the new shape.

Also `ctbk/avail_v3.py` (`write_tier_parquet` callsite): pass the new
`shard_dur` argument.

Acceptance: `pytest ctbk/pyramid_cascade/tests` green. Run a
small-range cascade against a test bucket to verify end-to-end shape
parity with the JS-side writer.

### P1 — `/1m@1d` historical backfill

See `specs/avail-v3-1m-backfill.md`. Fills the only largest-size hole
(every tier except /1m already has its largest-size layer from the
06-19→06-28 recovery cascade). Lands at the legacy path
`avail-v3/1m/<date>.parquet`; will be renamed to
`avail-v3/1m/1d/<date>.parquet` during P5.

**Can run now** — independent of pyrmts. Output is what P5 will
rename and what P7 will split.

### P2 — ctbk pyrmts adoption

After pyrmts cuts a new version with the ladder refactor:

```bash
# Bump SHA pins in gbfs/{api,cascade,lib}/package.json + ctbk's pyrmts dep
pds gh -r <new-sha> pyrmts pyrmts-cfw pyrmts-geo
pds gh -r <new-sha> pyrmts  # Python pin in pyproject.toml

# Verify ctbk typechecks against new types (will surface every
# `shard:` / `partials:` / `partialKey:` / `cadence`-keyed reference).
cd gbfs/api && pnpm tc
cd gbfs/cascade && pnpm tc
cd www && pnpm tc
```

Rewrite `configs/pyramids/avail.yaml`:

```yaml
tiers:
  - { name: 1m,  bin: 1min,  shards: [5min, 10min, 30min, 1h, 3h, 12h, 1d] }
  - { name: 2m,  bin: 2min,  shards: [10min, 30min, 1h, 3h, 12h, 1d, 2d] }
  - { name: 3m,  bin: 3min,  shards: [30min, 1h, 3h, 12h, 1d, 3d] }
  - { name: 5m,  bin: 5min,  shards: [30min, 1h, 3h, 12h, 1d, 5d] }
  - { name: 10m, bin: 10min, shards: [30min, 1h, 3h, 12h, 1d, 10d] }
  - { name: 15m, bin: 15min, shards: [30min, 1h, 3h, 12h, 1d, 15d] }
  - { name: 30m, bin: 30min, shards: [30min, 1h, 3h, 12h, 1d, 1mo] }
  - { name: 1h,  bin: 1h,    shards: [1h, 3h, 12h, 1d, 1mo] }
  - { name: 2h,  bin: 2h,    shards: [12h, 1d, 1mo] }
  - { name: 3h,  bin: 3h,    shards: [3h, 12h, 1d, 1mo] }
  - { name: 6h,  bin: 6h,    shards: [12h, 1d, 1y] }
  - { name: 12h, bin: 12h,   shards: [12h, 1d, 1y] }
  - { name: 1d,  bin: 1d,    shards: [1d, 1y] }
  - { name: 3d,  bin: 3d,    shards: [3d, 120y] }    # 120y replaces 'all' per pyrmts spec
  - { name: 7d,  bin: 7d,    shards: [7d, 120y] }
```

Drop `partials:` and `partialKey:` from the YAML. `storage.key`
becomes the unified template:

```yaml
storage:
  type: s3
  bucket: ctbk
  key: "avail-v3/{tier}/{shard}/{period}.parquet"
```

Also update `gbfs/api/src/avail_geo.ts` and `gbfs/cascade/src/index.ts`
to construct the Pyramid object with `shards` arrays instead of
`shard` + `partials`.

### P3 — D1 column rename (deploy gate)

```sql
ALTER TABLE pyramid_watermarks RENAME COLUMN cadence TO shard_dur;
ALTER TABLE pyramid_shards     RENAME COLUMN cadence TO shard_dur;
```

**Tight-window operation.** The new pyrmts-cfw `D1ShardIndex` (used by
both the new cascade worker and any code calling `recordShard` /
`getWatermarks`) hard-codes `shard_dur` as the column name; the
deployed old code uses `cadence`. So:

- Before ALTER: new cascade can't `recordShard` (column missing).
- After ALTER: old cascade can't `recordShard` (column gone).

Sequence: run ALTER, immediately run `wrangler deploy` for both
gbfs/cascade and gbfs/api. Cron will miss 1–2 /5m ticks during the
gap; no data loss (next tick resumes; the missing minute is just
absent from the partial-rung shards — fillable via P7 if desired).

Row-value updates (canonical sentinel `''` → tier's largest shard,
plus `pyramid_shards.key` rewrites to new R2 paths) are P5b, run
**after** the deploy completes. Splitting these out keeps the ALTER
window minimal — it's a single DDL statement per table, not a bulk
UPDATE.

`pyramid-status.py` reads `cadence` via raw SQL; after this rename
it'll break until updated. Worth updating in the same commit that
runs the ALTER.

### P4 — CFW writer rewrite

`gbfs/cascade/src/avail3/cascade.ts` collapses to a single per-tier
loop, mirroring the pyrmts compactor contract:

```ts
for each tier T in pyramid.tiers:
  // 1. Always write at T.shards[0] for the just-closed smallest window
  await writeShard(T, T.shards[0], windowStart)

  // 2. Promote up the ladder where boundaries align
  for i in [1..T.shards.length-1]:
    if tickAlignsToBoundary(tickMs, T.shards[i]):
      const n = T.shards[i] / T.shards[i-1]
      const inputs = lastN(T, T.shards[i-1], n)
      await promoteShards(T, T.shards[i-1], T.shards[i], inputs)
```

Use pyrmts's `promote(tier, fromDur, toDur, boundary)` library
primitive (per `unified-shard-ladder.md` §Compactor).

Split point per the pyrmts spec: CFW handles the fast cascade
(`shards[0..K]` where K is configurable), heavier promotions
(e.g. `1d → 1mo`, `1mo → 1y`) move to a separate GHA cron job —
defer that decision until profiling shows CFW timeout risk.

`gbfs/cascade/src/index.ts` simplifies: no separate /1m-partials
loop vs midnight-promotion branch — same loop handles both.

Supersedes phases 3 + 4 of `specs/avail-v3-steady-state.md`. (Update
that spec to point here after this lands.)

### P5 — R2 + D1 inventory rename

See `specs/avail-v3-storage-rename.md` (to be written). One-shot
Python script run on `e`:

- **R2 rename:** for each tier T, for each existing shard:
  - Legacy canonical `avail-v3/<T>/<period>.parquet` → `avail-v3/<T>/<largest_dur>/<period>.parquet`
  - Legacy partial `avail-v3/<T>/p<dur>/<period>.parquet` → `avail-v3/<T>/<dur>/<period>.parquet`
  - Use R2 `CopyObject` (server-side) + `DeleteObject`. Atomic per shard.
- **D1 inventory rewrite:** for each row in `pyramid_shards`, derive
  new `shard_dur` from the old `cadence` (empty → largest, else
  cadence-as-shard-dur). Update `key` column (R2 path).
- **Manifest update:** rewrite `avail-v3/_manifest.json` to reflect
  new layout (or drop manifest entirely if all watermark info is in
  D1).

Pre-flight: snapshot R2 + D1 state before rename. Idempotent: if a
shard's new key already exists, skip the rename (in case of partial
retry).

Cutover ordering with P4 (CFW): P4 deploys NEW CFW code first (writing
to new paths), then P5 renames LEGACY paths to match. So briefly, R2
will have BOTH (legacy + new) — that's fine because the new CFW
writes only new, and the rename script reads legacy + writes new
without overwriting (when the new key already exists from CFW).

### P6 — api worker keyTemplate + watermark-grid update

`gbfs/api/src/avail_geo.ts`:

```ts
function makeBaseProps(bucket: R2Bucket): Omit<GeoPyramid, 'dims'> {
  return {
    storage: parquetBackend(r2Storage(bucket)),
    keyTemplate: 'avail-v3/{tier}/{shard}/{period}.parquet',  // unified
    // partialKey removed
    // partials removed (now per-tier in `shards`)
    tiers: TIERS_WITH_SHARDS,
    // ...
  }
}
```

`loadWatermarks` + `loadEarliestPerCadence` (now `loadEarliestPerShard`):
- Read from updated D1 (post-P3) — `shard_dur` keyed
- Return `Record<string, Date>` keyed `${tier}@${shard_dur}` (uniform)

Drop the `binBudget`-cap workaround (was for the ascending-effective
walk's edge case; new cursor-aware walk handles per-shard
existence correctly).

### P7 — Intermediate-size historical backfill

See `specs/avail-v3-intermediate-backfill.md` (to be written). For
each tier T and each non-largest `shard_dur ∈ T.shards`, ensure
historical coverage `[2026-04-08, now)`.

Per pyrmts spec approach (b): split existing largest-size shards into
intermediate sizes by reading the parquet row groups and writing N
sub-shards per parent. No re-fetch from raw needed.

Implementation: Python script using pyarrow's row-group APIs. Run on
`e`. Per pyramid:

```python
for tier in pyramid.tiers:
    for shard_dur in tier.shards:
        if shard_dur == tier.shards[-1]: continue   # skip largest (already there)
        for parent_shard in largest_size_shards_for_tier(tier):
            sub_shards = split_into_intermediate(parent_shard, shard_dur)
            for sub in sub_shards:
                upload_to_r2(sub)
                record_in_d1(pyramid, tier, shard_dur, sub)
```

Per the pyrmts spec retention contract — declare LSM-style retention
in `avail.yaml` so smaller shards expire post-promotion; OR keep-all
for max read-perf at cold-storage cost. Recommend keep-all initially
(storage is cheap, P7 already wrote them once).

Scale estimate: ctbk has ~500 largest-size shards across all tiers.
Each splits into 5-10 intermediate sizes × 5-30 sub-periods per size
= ~25k-150k new shards. R2 storage delta ~10-50 GB. R2 PUTs charged
per write but cheap at this scale.

### P9 — `avail.yaml` as source of truth + JS codegen

See `specs/avail-yaml-source-of-truth.md`. Replaces the hardcoded
`LADDERS` / `TIERS` constants in `gbfs/cascade/src/avail3/cascade.ts`
and `gbfs/api/src/avail_geo.ts` with imports from a generated
`gbfs/lib/src/ladders.generated.ts`, built from
`configs/pyramids/avail.yaml` at build time. CI drift-check fails the
build if the generated file is stale.

Belt-and-suspenders Python parity test asserts the parsed YAML matches
an embedded golden — catches YAML-side regressions independent of the
JS check.

Depends on P2 (YAML must already be in the new `shards: [...]`
format).

### P8 — FE flag default → `v3` + retire `/api/totals`

After P5+P7 leave the system in steady-state with full tilings
verified:
1. Re-flip `FlagsContext.availSrc.default` from `totals` to `v3`.
2. Deploy www → push to www branch.
3. Track `/api/totals` traffic over N days; once near-zero, remove the
   endpoint (sub. by `#108`).
4. Retire the legacy `gbfs/avail/agg=1m/cons=1m/...` raw pipeline if
   no other consumers depend on it.

## Cross-pyramid

`rides-v3` uses the same pyrmts API. Once pyrmts ships, rides-v3 gets
the same migration:
- YAML rewrite (`shards:` per tier)
- R2 rename script (cheap; rides-v3 has way fewer shards than avail)
- intermediate-size backfill (same script, different config)

Run rides-v3 migration as a follow-up after avail-v3 is stable. Spec
deferred until then.

## Acceptance

- Every `(tier, shard_dur)` pair in every tier's ladder has a
  complete historical tiling per `pyramid-status.py` (and per
  `_manifest.json` / D1 inventory listing).
- `scripts/avail-v3-heartbeat.sh` passes — every expected tier×shard
  shard for the current cron tick exists.
- `availSrc=v3` returns full coverage for all standard queries (1d,
  7d, 14d, 1mo, 3mo, 1y).
- `gbfs/cascade` is a single per-tier loop; the "partials vs
  canonical" code paths are removed.
- `gbfs/api` reads via uniform `{tier}/{shard_dur}/{period}`
  template; no more `partialKey` knob.

## Cross-reference

- `~/c/pyrmts/specs/unified-shard-ladder.md` — pyrmts JS enabler (done)
- `~/c/pyrmts/specs/python-unified-ladder.md` — pyrmts Python catch-up
  (PY, hard dep on every other phase except P1)
- `specs/avail-v3-1m-backfill.md` — P1
- `specs/avail-v3-storage-rename.md` — P5 (to be written)
- `specs/avail-v3-intermediate-backfill.md` — P7 (to be written)
- `specs/avail-yaml-source-of-truth.md` — P9
- `specs/avail-v3-steady-state.md` — predecessor; phases 3-5 there
  are subsumed by P4-P8 here
- `specs/done/avail-v3-gap-fill.md` — recovery cascade that filled the
  largest-size layer for /2m..7d
