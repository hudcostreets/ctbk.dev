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
            pyrmts ladder refactor (in pyrmts repo, in flight)
                              │
                              ├─→  P2  ctbk pyrmts adoption (laptop)
                              │            │
                              │            ├─→ P3  D1 schema update (laptop)
                              │            ├─→ P4  CFW writer rewrite (laptop, deploy)
                              │            └─→ P5  R2 + D1 inventory rename (e)
                              │                     │
                              │                     ├─→ P6  api worker key-template bump (laptop)
                              │                     └─→ P7  intermediate-size backfill (e)
                              │                              │
                              │                              └─→ P8  FE flag flip + retire `totals` (laptop)
                              │
P1 /1m@1d historical backfill (e) ───────────────────────────────┘
   (independent of pyrmts; lands legacy path, renamed in P5)
```

P1 can run **today** in parallel with pyrmts. P2-P8 sequence behind
the pyrmts merge.

## Phase index

| # | Phase | Owner | Spec | Status |
|---|---|---|---|---|
| **P1** | `/1m@1d` historical backfill (2026-04-08..2026-06-28) | `e` | `specs/avail-v3-1m-backfill.md` | spec written |
| **P2** | ctbk pyrmts pin bump + adoption | laptop | inline below | not yet impl |
| **P3** | D1 schema update | laptop | inline below | not yet impl |
| **P4** | CFW writer rewrite (single per-tier loop) | laptop | inline below + sup. by `avail-v3-steady-state.md` Phase 3/4 (now superseded) | not yet impl |
| **P5** | R2 + D1 inventory rename | `e` | `specs/avail-v3-storage-rename.md` | spec to write |
| **P6** | api worker keyTemplate + watermark-grid update | laptop | inline below | not yet impl |
| **P7** | Intermediate-size historical backfill | `e` | `specs/avail-v3-intermediate-backfill.md` | spec to write |
| **P8** | FE flag default → `v3` + retire `/api/totals` | laptop | follow `availSrc=v3` flip (already done via flag) + sup. by `#108` | not yet impl |

## Phases

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

### P3 — D1 schema update

`pyramid_watermarks` and `pyramid_shards` schemas need a column
rename:

```sql
-- pyramid_watermarks: cadence column → shard_dur (rename)
-- pyramid_shards: cadence column → shard_dur (rename)
ALTER TABLE pyramid_watermarks RENAME COLUMN cadence TO shard_dur;
ALTER TABLE pyramid_shards RENAME COLUMN cadence TO shard_dur;
```

For the canonical sentinel (`cadence=''`): set existing rows to the
new tier's largest-`shards` entry. E.g. rows with
`pyramid='avail', tier='1m', cadence=''` get `shard_dur='1d'`. This
backfill is a one-shot SQL: for each (pyramid, tier) in watermarks
where shard_dur is empty after the rename, update to the configured
largest shard.

D1 migration via `wrangler d1 migrations` (per ctbk's existing
convention if any; otherwise direct execute).

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

- `~/c/pyrmts/specs/unified-shard-ladder.md` — pyrmts-side enabler
- `specs/avail-v3-1m-backfill.md` — P1
- `specs/avail-v3-storage-rename.md` — P5 (to be written)
- `specs/avail-v3-intermediate-backfill.md` — P7 (to be written)
- `specs/avail-v3-steady-state.md` — predecessor; phases 3-5 there
  are subsumed by P4-P8 here
- `specs/done/avail-v3-gap-fill.md` — recovery cascade that filled the
  largest-size layer for /2m..7d
