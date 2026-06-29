# avail-v3 steady-state automation

## Goal

A unified, per-tier exp-backoff ladder of **partials → canonicals**, all
maintained automatically by the `gbfs/cascade` CFW. No human-in-the-loop
for steady state. `pyramid-cascade` retained for backfills + disaster
recovery only.

When complete, the steady-state picture for every tier `T` looks
identical:

```
/T@p5min      ────┐
/T@p10min     ────┤      → "freshness" partials, exponentially-spaced
/T@p30min     ────┤        up to T.canonical_shard
/T@p1h        ────┤
/T@p3h        ────┤        (only cadences C s.t. C % T.bin == 0
/T@p12h       ────┘          AND C < T.canonical_shard)
/T/<period>   ────┐
                  │      → closed canonical shards
/T/<period+1> ────┤        at T.canonical_shard boundaries
…             ────┘
```

— ALL written by the CFW on its `* * * * *` cron tick (per-cadence
gating already in `avail3Tick`).

## Background

### What's deployed today

| Component | Cron | Role |
|-----------|------|------|
| `gbfs/worker` | `* * * * *` | GBFS poll → WAL JSON in R2 |
| `gbfs/loader` | R2 PutObject queue consumer | WAL JSON → `gbfs/avail/agg=1m/cons=1m/<date>/HHMM.parquet` |
| `gbfs/cascade` (avail-v2 path) | `* * * * *` | cons/agg cascade chain for `gbfs/avail/...` |
| `gbfs/cascade` (avail-v3 path, `avail3Tick`) | `* * * * *` | **/1m partials only** (5min..12h) + **midnight /1m canonical promotion** |

### What's NOT auto-maintained

- **All derived-tier canonicals** (/2m, /3m, /5m, /10m, /15m, /30m, /1h,
  /2h, /3h, /6h, /12h, /1d, /3d, /7d). Built ad-hoc via Python
  `ctbk pyramid-cascade` on EC2.
- **All derived-tier partials** (e.g. /2m@p10min, /1h@p12h). Sketched in
  v2 scope of `specs/avail-v3-cascade-cfw.md`, never implemented.
- **Monitoring** of any of the above. The 2026-06-19→06-26 /1m canonical
  gap went unnoticed for 9 days.

### Recent incident (recovery completed 2026-06-29)

- /1m canonical missing for 2026-06-19..06-26 was reported as a
  "9-day gap"; the framing was wrong. **RC: pre-deployment, not runtime
  failure.** The avail-v3 cascade CFW (`avail3Tick`) was first deployed
  2026-06-27 ~15:35 UTC (`f73aaf9b`). Before that date, NO `avail-v3/1m`
  canonical existed for ANY date — `pyramid-cascade` writes derived
  tiers only, never /1m base. Only the most recent date (`2026-06-27`)
  exists as a /1m canonical today.
- Three hours after deployment (2026-06-27 21:25 UTC), avail3Tick
  silently stalled because the `tickMs % (5*60_000) !== 0` gate was
  applied to CF's seconds-offset `scheduledTime` (~53s past nominal
  minute → always truthy → early-return). Fixed in `7a96b252` ~3h later.
- Loader-emitted `gbfs/avail/agg=1m/cons=1m/<date>/HHMM.parquet` shards
  **were intact throughout** — verified post-hoc, 91 KB each at sampled
  minutes during the "gap" window. Loader has never failed.
- Gap-fill attempt via `pyramid-cascade -r 2026-06-19/2026-06-28` then
  **overwrote** partial-cover shards (/30m..7d), causing 11-week data
  loss in /30m..7d derived tiers (a separate failure mode that the new
  `--partial-cover` guard rail now blocks by default).
- Recovery: full re-cascade `2026-04-07/2026-06-28` + new
  `--partial-cover {error,overwrite,merge}` guard rail in `pyramid-cascade`.

### Post-deployment CFW health (snapshot 2026-06-29 ~03:35Z, ~33h after deploy)

| Cadence | Expected | Actual | Coverage | Notes |
|---------|----------|--------|----------|-------|
| /p5min  | 396 | 370 | 93%      | normal cron-drop churn |
| /p10min | 198 | 184 | 93%      | "" |
| /p30min | 66  | 61  | 92%      | "" |
| /p1h    | 33  | 31  | 94%      | "" |
| /p3h    | 11  | 1   | **9%**   | **SECOND BUG — far worse than input-cascade rate predicts** |
| /p12h   | 2-3 | 1   | ~33%     | likely same bug as p3h |

Tracked as Phase 0 (RC the p3h/p12h underwriting) — needs to be done
before generalizing to all tiers (Phase 3), since the bug would amplify
across the new derived-tier partials.

The recovery validates the rebuild path works end-to-end. This spec is
about not needing it in the first place AND fixing the residual bugs
the recent deployment surfaced.

## Design

### (a) Generalize partial cascade to all tiers

`avail3Tick` currently writes /1m partials for the 8 cadences in
`configs/pyramids/avail.yaml#partials`. Extend it to walk the full
`(tier, cadence)` matrix:

```typescript
for each tier T in pyramid.tiers (excluding base /1m):
  for each cadence C in pyramid.partials:
    if C % T.bin !== 0:                // bin doesn't divide cadence
      continue
    if C >= T.canonical_shard:         // beyond this tier's canonical
      continue
    if tickMs % (C * 60_000) !== 0:    // cadence boundary not closing now
      continue
    write_partial(T, C, periodStart)
```

**Source for `(T, C)` partial**: `/1m@pC` (the same-tick output of the
existing /1m partial cascade). Re-bin /1m rows by flooring `dt` to
`T.bin` boundaries, then histogram-sum same-bucket rows per
`(s2_cell, dt_out, metric, state)`. Write to
`avail-v3/{T.name}/p{C.label}/{period}.parquet`.

**Why source from /1m always (not tier-to-tier cascading)**: simpler DAG
(one parent per node), no read-after-write timing issues across cadence
chains, /1m@pC is guaranteed-present (just written same tick). Tradeoff:
larger reads than e.g. /2m@p10min × 3 → /2m@p30min would be. Revisit if
profiling shows it matters.

**Skip-on-zero-rows**: emit `{status: 'empty'}` (don't write), keep
recording shard absence so the watermark behaves consistently with the
existing /1m partials.

**Cadence-matrix worked example** (avail-v3 tiers, partials =
[5min, 10min, 30min, 1h, 3h, 12h, 1d, 3d]):

| Tier  | Bin    | Canonical | Eligible cadences                              |
|-------|--------|-----------|------------------------------------------------|
| /1m   | 1min   | 1d        | 5,10,30,60,180,720 (existing)                  |
| /2m   | 2min   | 2d        | 10,30,60,180,720,1440                          |
| /3m   | 3min   | 3d        | 30,60,180,720,1440                             |
| /5m   | 5min   | 5d        | 5,10,30,60,180,720,1440                        |
| /10m  | 10min  | 10d       | 10,30,60,180,720,1440                          |
| /15m  | 15min  | 15d       | 30,60,180,720,1440                             |
| /30m  | 30min  | 1mo       | 30,60,180,720,1440,4320                        |
| /1h   | 1h     | 1mo       | 60,180,720,1440,4320                           |
| /2h   | 2h     | 1mo       | 120-aligned? → 180 NO (180%120≠0), 720,1440,4320 (skip 60,180; recheck: 720%120=0 ✓, 1440%120=0 ✓) |
| /3h   | 3h     | 1mo       | 180,720,1440,4320                              |
| /6h   | 6h     | 1y        | 360-aligned? → 720,1440,4320 (skip <360)       |
| /12h  | 12h    | 1y        | 720,1440,4320                                  |
| /1d   | 1d     | 1y        | 1440,4320                                      |
| /3d   | 3d     | all       | 4320                                           |
| /7d   | 7d     | all       | (none — 10080 not in ladder)                   |

(Note for /2h, /6h: divisibility test eliminates finer cadences. Worth
adding `2h`, `6h` to the partials ladder later if those tiers' freshness
turns out to lag.)

### (b) Generalize canonical promotion to all tiers

At each tick, for each tier T, if `tickMs` aligns with a T.canonical_shard
boundary, promote that tier's just-completed shard to canonical.

**Input count** by canonical shard size:

| Shard | Largest partial in ladder | Inputs to concat |
|-------|---------------------------|------------------|
| 1d    | 12h                       | 2                |
| 2d    | 1d                        | 2                |
| 3d    | 1d                        | 3                |
| 5d    | 1d                        | 5                |
| 10d   | 1d                        | 10               |
| 15d   | 1d                        | 15               |
| 1mo   | 1d                        | 28..31           |
| 1y    | 1mo (existing canonicals!)| 12               |
| all   | 1y                        | grows yearly     |

For 1y and all, **source from already-canonical shards** (12 monthly
parquets → 1 yearly, or N yearly → 1 all). This keeps each
canonical-promotion step bounded to ~30 inputs max, well within a
CFW's 30 s / 128 MB budget. (No new code needed for the "monthly →
yearly" merge — it's the same `mergeRows` primitive over fewer, larger
inputs.)

**`shard: all`**: rebuild the entire `all` shard every UTC midnight by
concatenating all yearly canonicals + the current year's most-recent
`/1y@p<largest>` partial-of-canonical. Current `/3d/all` is 35 MB and
`/7d/all` is 19 MB; growth is ~5 MB/year. Stays cheap through 2030+.

### (c) Monitoring

**Heartbeat** (GHA cron every 6h): HEAD all expected canonicals for the
latest closed period across all tiers. Email/Slack on any miss.

```bash
# scripts/avail-v3-heartbeat.sh — to be written
#  - For each tier T, compute expected_latest_period(T, now)
#  - HEAD avail-v3/<T>/<period>.parquet
#  - Exit non-zero on any miss; CI surface = email notification
```

**Inline alerting in `avail3Tick`**: on `status: 'no_inputs'` for a
canonical promotion, log a structured warning to Workers Analytics
Engine (configurable). The 9-day gap was silent only because we never
checked CFW logs.

## Implementation phases

### Phase 1: RC the 9-day gap — DONE (see Background §Recent incident)
Result: deployment gap + cron-seconds-offset bug, both already
identified. **Newly surfaced**: distinct p3h/p12h underwriting bug
(Phase 0 below).

### Phase 0: RC the /p3h /p12h underwriting (~1 hr)
Coarser-cadence partials (3h, 12h) are firing at <50% the rate
predicted by input-cascade availability (~94% per /p1h tick × 3
required = 83% predicted vs 9% actual for /p3h). Likely a code bug in
the boundary-detection logic or in `write1mPartial`'s `inputsExpected`
calculation for cadences that haven't fully healed yet. Worth fixing
**before** Phase 3 (generalize partial cascade) because the bug pattern
will replicate across every derived tier we add.

### Phase 2: Heartbeat + alerting (~2 hr)
- `scripts/avail-v3-heartbeat.sh` (or python `ctbk avail-v3-heartbeat`).
- GHA workflow `.github/workflows/heartbeat.yml` cron `0 */6 * * *`.
- Email-on-fail via existing GHA notification or new webhook.
- **Ship before Phase 3+4** so we catch any regressions introduced by
  bigger changes.

### Phase 3: Generalize partial cascade (~1 day)
- Hard-code TIER_MATRIX in `gbfs/cascade/src/avail3/cascade.ts` (mirrors
  `configs/pyramids/avail.yaml`; future cleanup: ship YAML in bundle).
- Add `writeDerivedPartial(r2, tier, cadenceIdx, periodStart)`.
- Add to `avail3Tick` after the /1m partial loop.
- Unit tests on synthetic data (extending existing
  `gbfs/cascade/src/avail3/cascade.test.ts`).
- Deploy to staging CFW first; validate one tick.

### Phase 4: Generalize canonical promotion (~1 day)
- Add `promoteCanonical(r2, tier, boundaryStart)` for sub-1mo tiers.
- Add `promoteFromMonthly(r2, tier, year)` for /1y tiers.
- Add `rebuildAll(r2, tier)` for /3d, /7d.
- Hook into `avail3Tick` with proper boundary detection.
- Tests + staging.

### Phase 5: Decommission ad-hoc tools (~30 min)
- Rename `scripts/avail-v3-cascade.sh` → `scripts/avail-v3-rebuild.sh`,
  update docstring: "backfill / recovery only".
- Same for `scripts/recovery-cascade.sh` (already this purpose).
- Update CLAUDE.md.

## Open questions

- **TIER_MATRIX source of truth**: hard-code in CFW vs ship the YAML in
  the bundle vs hydrate from D1 at startup? Hard-code is simplest;
  drift risk is real but low-cadence (YAML changes are infrequent).
- **Partial retention**: once `/T/<period>` canonical is written, do we
  delete the underlying `/T@p<C>/...` partials? They're useful for
  sub-T.canonical_shard freshness queries between cadence closures. R2
  cost is low. Recommend: keep for at least 1× T.canonical_shard, then
  expire via lifecycle rule.
- **Migrations**: when `configs/pyramids/avail.yaml` changes (add/remove
  tier, adjust shard size), need a recovery cascade run. Document this.

## Risks

- **CFW CPU budget**: each tick now writes ~15 partials/cadence × N
  cadences-closing-this-tick. Worst case at /12h-boundary tick: 15 ×
  6 = 90 writes. Verify under 30 s on prod CFW.
- **R2 write rate limits**: 1200 PUT/s per bucket. 90 writes per /12h
  boundary tick is comfortably under, but if multiple boundaries
  align we approach the budget. Could throttle via cadence-sorted
  write order if needed.
- **Bytes-identical compatibility**: canonical shards written by the
  CFW must be readable by every existing consumer (FE, D1 backend,
  pyramid-stats). Must match pyrmts `S3Storage` write conventions
  (column order, sort, RG=2048, snappy). Validate via diff against
  pyramid-cascade output on a smoke range.
- **Backfill story**: when this ships, `/2m..7d/p*` partials and
  canonicals after the cutover date are CFW-written; before are
  pyramid-cascade-written. Need a clean cutover date documented in R2
  manifest.
