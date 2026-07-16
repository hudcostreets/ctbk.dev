# avail-v3: LE-driven bulk rebuilds (stale-content re-keys without `e`)

**Status: implemented 2026-07-16** (`ctbk gbfs lambda rebuild`; see
"Implementation notes" at bottom for deviations from the sketch below).
First production re-key still pending — exercised so far via smoke
(single fresh fill + single in-place stale overwrite through
`ctbk-avail-rebuild`).

## Context

The Lambda executor is live (P2 cut over 2026-07-13, see
`specs/avail-v3-lambda-cascade.md`): `ctbk-avail-cascade` owns the
whole ladder minutely (`FILL_ALL=1`) + GC hourly, plans against the
merged ladder, has per-shard D1 REST registration
(`run_extension_fill(register=True)`), and materializes via the
accumulator path (~375 B/output-row — N≤4096 in ~6 GB).

What it can't do: **stale-content rebuilds**. Its `discover_gaps` is
existence-driven — a shard built against a superseded input (the
pre-re-key denorm) isn't a gap. The 2026-07-16 LUC re-key therefore
ran on `e` (`pyramid-cascade -M -B <ts> --fsck --fill`, see
`specs/avail-v3-ladder-view-split.md`), costing hours of 16-core wall
time and requiring a live dev box. `discover_gaps` now takes
`stale_before` (commit `105b1eb7`); this spec extends that knob to the
LE so re-keys need no long-lived compute at all.

## Design

### 1. `stale_before` through the Lambda path

- `run_extension_fill(..., stale_before: datetime | None = None)` →
  forwarded to `discover_gaps`. (`fsck.discover_gaps` already
  implements the mtime partition; `list_existing_with_mtime` works
  unchanged against R2 via the storage paginator.)
- Handler: read `event.get('stale_before')` (ISO 8601) and forward.
  The steady-state EventBridge tick passes nothing — zero behavior
  change at the minutely cadence.

### 2. Fan-out driver (the actual rebuild)

Serial won't do: 148-gap re-key × ~1-4 min/shard ≫ the 12-min budget
(and `reserved_concurrent_executions=1`). Driver pattern — a `ctbk`
subcommand (runnable from a laptop, `e`, or the auto-rebuild GHA):

```
ctbk avail-lambda-rebuild -B <stale_before> [-n] [-c 16]
  1. discover_gaps(merged, stale_before)   # locally, ~seconds
  2. group gaps by tier layer (finest first — strict-cascade order)
  3. per layer: async-invoke the Lambda once per gap
     (event = {gap: {tier, shard_dur, period_start}, stale_before}),
     bounded by -c; poll for completion (D1 row updated / R2 mtime)
     before starting the next layer
```

- Needs a handler branch for single-gap events (thin: materialize +
  register, skip discovery) and a temporary concurrency raise for the
  rebuild (either a second alias/function with
  `reserved_concurrent_executions=16`, or lift the reservation and
  rely on the driver's `-c`).
- Layer barriers preserve the finest-first invariant the fill loop
  enforces today (coarser tiers source finer ones).
- Idempotent + resumable for free: a re-run's discovery sees fresh
  mtimes and skips completed shards. A killed driver loses nothing
  (per-shard D1 registration).

### 3. Wall-time / cost envelope

Heaviest shard class (`/1m@2d` from raw): 2,880 minute-GETs + ~12 M
output rows — a few minutes and ~5 GB in the accumulator path, well
inside 10 GB/15 min. At `-c 16`: 148 shards ≈ **~15-25 min wall**,
~7 GB-hr of Lambda ≈ **~$0.85** + R2 ops noise (R2 transfer is free
both ways; contrast EC2's ~$0.09/GB write egress). vs today: ~5 h
wall on `e` + ~$3 egress + a box that must stay alive.

### 4. Integration with the auto-rebuild workflow

`specs/avail-v3-auto-rebuild-gha.md`'s rebuild step becomes a thin
trigger: detect denorm drift → upload denorm → run
`ctbk avail-lambda-rebuild -B <upload_ts>` on a **standard** runner
(it's just an invoker + poller now) → verify → Slack. The 64-core /
large-runner question evaporates. The delta-patch fast path
(`specs/avail-v3-delta-patch.md`) still slots in front when it lands —
patching beats even fanned-out rebuilds for small churn.

## Open questions

1. Concurrency mechanics: second Lambda alias with its own reserved
   concurrency vs unreserved + driver-side bound. → **Resolved:
   neither as sketched.** Reserved concurrency is function-level in
   AWS (aliases can't carry their own), so it's a second FUNCTION,
   `ctbk-avail-rebuild`: same zip, no schedule, UNRESERVED (account
   pool); the driver's `-c` thread pool is the only bound — hence
   arbitrary parallelism. The tick keeps `reserved=1`.
2. Does the rebuild need to pause the minutely tick? No — its
   discovery is existence-driven, rebuilt keys stay registered, and
   same-key overwrites are atomic on R2. GC is likewise safe (all
   rebuilt keys are in the merged expected cover). DC during first
   run anyway.
3. `shard_to_long` decode cost (observed ~400-500 s per 100 M-row
   input on `e`'s fsck path) — the LE's accumulator materializer
   reads tiles differently; measure before assuming the mid-tier
   layers are fast in-Lambda. If they're slow, the same base-tier
   raw substitution landed in `dddd24d1` applies. → **Per `e`
   (2026-07-16): the 30 GB blowup is an fsck-materializer artifact
   (it explodes inputs to full long-form frames); the LE accumulator
   runs ~375 B/output-row (~5 GB for the same shards), so they fit
   the 10 GB Lambda. Porting the accumulator pattern into the fsck
   path is the proper fix for both memory and (much of) decode time —
   follow-up tracked in `e`'s incident spec.**
4. Rides-v3: same pattern would remove `e` from rides re-keys too,
   but rides' 1h base builds from monthly normalized parquets
   (~7-8 GB RSS at 2023+ months) — over the 10 GB Lambda budget for
   some months. Out of scope; revisit with per-month memory profiling.

## Implementation notes (2026-07-16)

Landed as `ctbk gbfs lambda rebuild` (nested in the existing
`ctbk gbfs lambda` group, not the sketch's top-level
`avail-lambda-rebuild`). Deviations from the design above:

- **Sync invocations, not async+poll.** The driver invokes
  `RequestResponse` from a `-c`-sized thread pool
  (`pyramid_cascade/rebuild.py`): each invoke returns the shard's
  exact `MaterializeResult` status — no D1/R2 completion polling, and
  no Lambda-service async retries that could double-invoke. botocore
  `read_timeout=920` ≥ the function's 900 s cap;
  `retries={max_attempts: 1}` so a transport timeout can't re-invoke.
- **Layers are `(tier, rung)`, not tier.** `materialize_extension_shard`
  tiles a gap from same-tier SUB-rung shards, so within a tier the
  smallest rung must land first (from raw / cross-tier) for coarser
  rungs to concat it instead of re-aggregating per rung. The
  serialized 1-2-shard coarse tail this costs is seconds per layer.
  Layer-order violations degrade to `no_inputs` bounces + re-run
  (discovery skips completed shards — resumable as designed).
- **`head_check=False` on stale rebuilds.** The pre-existing
  HEAD-probe idempotency in `materialize_extension_shard` would
  'exists'-skip a stale key (it IS on R2); with `stale_before` the
  fresh-keys `key_set` alone decides, and stale keys are overwritten
  in place.
- **Warm-container denorm hazard, two halves.** (a) In-Lambda:
  `_luc_chains` caches per container; a rebuild invocation passes
  `fetched_after=stale_before` so a pre-re-key cache refetches.
  (b) Tick-side: warm `ctbk-avail-cascade` containers would keep
  writing tail shards with the OLD chains — fresh mtimes, invisible
  to any `stale_before`. `rebuild -T/--touch-tick` bumps the tick
  function's env (`DENORM_REV`) to recycle its containers, then
  raises the effective `stale_before` to the touch time (i.e. a `-T`
  rebuild treats the whole pyramid as stale — the honest semantics of
  a re-key). Denorm re-key runbook: upload denorm → `rebuild -T -c 16`.
- **Bulk path too:** `run_extension_fill(stale_before=…)` is also
  wired (handler reads `event['stale_before']`), for small stale sets
  that fit one serial invocation.
- Census at implementation time: full re-key = **184 shards / 71
  layers** (spec's "148" had aged with the ladder). Smoke: fresh
  `/1m@5min` wrote in 9 s via single-gap invoke (D1-registered
  in-Lambda); same shard then rebuilt in place under `-B now`
  (stale-overwrite path).
- **Scaffold layers** (added after the first full `-T` dress
  rehearsal): a rebuilt-from-scratch max-rung shard has no fresh
  sub-rungs to concat (GC swept them long ago), so its build
  degenerates to a whole-period raw/cross-tier fill — `/1m@2d` =
  2880 raw minutes, which TIMED OUT at the hard 900 s Lambda cap
  (28 timeouts, ~$12; `/1m@12h` = 720 minutes took 258 s — the §3
  "few minutes" estimate only held for concat-able shards). The
  driver now inserts per-tier scaffold layers at the largest rung
  with ≤720 source bins (`SOURCE_BIN_BUDGET`; e.g. `/1m@12h`,
  `/15m@2d`, `/7d@448d`) ahead of bigger rungs, which then concat
  2-16 fresh tiles. Scaffolds are real in-ladder shards invoked with
  `register=False`: D1-gated reads and the D1-driven `gc_sweep`
  never see them (registration would let the hourly GC delete a
  scaffold mid-rebuild — its "covering parent", the STALE max-rung
  shard, exists on R2); the driver deletes them after a clean run
  and keeps them for reuse when shards bounced. Honest envelope with
  scaffolds: full re-key = ~145 expected shards + ~900 scaffolds,
  wall ~1 h at `-c 48`, ~$25-40 of Lambda (scaffold fills dominate)
  — more than the §3 guess, still ≪ `e`'s hours + egress + live box.
