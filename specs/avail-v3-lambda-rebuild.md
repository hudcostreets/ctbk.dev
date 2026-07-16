# avail-v3: LE-driven bulk rebuilds (stale-content re-keys without `e`)

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
   concurrency vs unreserved + driver-side bound. (Alias is cleaner —
   the steady-state minutely function keeps `reserved=1` semantics,
   so a rebuild can't starve the live tick.)
2. Does the rebuild need to pause the minutely tick? No — its
   discovery is existence-driven, rebuilt keys stay registered, and
   same-key overwrites are atomic on R2. GC is likewise safe (all
   rebuilt keys are in the merged expected cover). DC during first
   run anyway.
3. `shard_to_long` decode cost (observed ~400-500 s per 100 M-row
   input on `e`'s fsck path) — the LE's accumulator materializer
   reads tiles differently; measure before assuming the mid-tier
   layers are fast in-Lambda. If they're slow, the same base-tier
   raw substitution landed in `dddd24d1` applies.
4. Rides-v3: same pattern would remove `e` from rides re-keys too,
   but rides' 1h base builds from monthly normalized parquets
   (~7-8 GB RSS at 2023+ months) — over the 10 GB Lambda budget for
   some months. Out of scope; revisit with per-month memory profiling.
