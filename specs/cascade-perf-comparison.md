# Cascade perf comparison: Python-dict vs Polars-vectorized

Measure whether the existing chunked-block Polars `pyramid-cascade`
actually beats a properly-parallelized Python-dict `cascade_from_1m`,
on the same input and hardware.

## Why now

User instinct (and partly mine): the long-form pivot RT in the
Polars engine may be net overhead vs Python-native histogram-dict
merging. The earlier `engine_streaming.py` experiment (5.5× slower
than chunked-block) was **single-process**, so it doesn't settle the
question — it only shows that Python single-process loses. The
question we actually need to answer: does Python-dict + ProcessPool
beat Polars-chunked-block + ProcessPool?

Result shapes downstream decisions:
- **If Python wins materially**: the pyrmts vectorized primitive
  (rides Phase 1a in `specs/rides-pyramid-cascade.md`) should expose
  a dict-accumulator fast path for the histogram-monoid, not just a
  long-form group_by. We may also want to backport that path to
  ctbk's pyramid-cascade engine.
- **If Polars wins**: confirms the current chunked-block-Polars
  approach; pyrmts primitive can be Polars-only.
- **If wash**: lower stakes for the pyrmts API decision; pick on
  ergonomics, not perf.

## Three contenders (apples-to-apples)

All three over the **same 7-day range** (`2026-06-11 → 2026-06-18`)
matching the §2 reference number from the smoke spec, on **the same
EC2 instance**, reading the **same 1m source** from `avail-v3/1m/`.

| # | name              | impl                                                           | parallelism   | output prefix              |
|---|-------------------|----------------------------------------------------------------|---------------|----------------------------|
| 1 | `orig-baseline`   | `ctbk avail-v3-cascade-from-1m` (single-process Python dict)  | none          | `avail-v3-orig-base-7d/`   |
| 2 | `orig-parallel`   | `scripts/cascade-orig-parallel.py` (ProcessPool + reduce)     | 4 workers     | `avail-v3-orig-par-7d/`    |
| 3 | `polars-chunked`  | `ctbk pyramid-cascade -i avail` (chunked-block Polars)         | 4 workers     | `avail-v3-polars-7d/`      |

**Shard-layout caveat**: (1) and (2) use the legacy `TIER_SPECS` shard
sizes (e.g. `2m@1h`, `1h@1mo`); (3) uses the new `avail.yaml` shard
sizes (e.g. `2m@2d`, `1h@1mo`). Different partitionings; same
underlying histogram data. Wall-time comparison is valid (both
process the same 168 source-hour shards into all derived tiers);
byte-for-byte output is NOT comparable. To force apples-to-apples
output, would have to either (a) port new TIER_SPECS shard sizes into
`cascade_from_1m`, or (b) port legacy sizes into `avail.yaml` for a
parallel test config. Punt on this for now; comparing wall is
sufficient to answer the design question.

## Metrics

For each contender, capture:
- **Wall** (start → finish, seconds)
- **Peak RSS** (sample via `ps`/`top`; if multi-process, sum)
- **R2 GET bytes** (read side — should be identical across all three:
  same 1m source)
- **R2 PUT count + bytes** (write side — (1) and (2) write more,
  smaller files than (3))
- **CPU usage** (avg % busy across run; via `top -b` sample)
- **Reduce-phase wall** for (2) and (3): how much of total goes to
  the cross-block merge

Logs: `logs/bench-cascade-{orig-baseline,orig-parallel,polars-chunked}-7d.log`.

## Procedure

1. **Confirm 1m source is current** at `avail-v3/1m/` for the range
   (already done as part of avail-v3 cutover).
2. **Run (1) baseline** — kicked off in background via:
   ```bash
   # NOTE: had to copy 1m source to baseline prefix before we shipped
   # --src-prefix; the copy is part of the wall time as logged.
   ctbk avail-v3-cascade-from-1m \
     -f 2026-06-11 -T 2026-06-18 \
     -p avail-v3-orig-base-7d 2>&1 | tee logs/bench-cascade-orig-baseline-7d.log
   ```
3. **Run (2) parallel** (after baseline completes — both contend for
   cores/R2 bandwidth, so sequential):
   ```bash
   scripts/cascade-orig-parallel.py \
     -r 2026-06-11/2026-06-18 \
     -j 4 \
     -p avail-v3-orig-par-7d \
     -S avail-v3 \
     2>&1 | tee logs/bench-cascade-orig-parallel-7d.log
   ```
4. **(3) polars-chunked** — reuse the §2 number (793s wall pre-parallel
   reduce, 520s post). If we want a fresh head-to-head:
   ```bash
   ctbk pyramid-cascade \
     -c configs/pyramids/avail.yaml \
     -i avail \
     -r 2026-06-11/2026-06-18 \
     -j 4 \
     -t 1d \
     -p avail-v3-polars-7d \
     2>&1 | tee logs/bench-cascade-polars-chunked-7d.log
   ```

## Hypotheses

H1 — **null**: all three are within 2× of each other. → Confirms
overhead/throughput tradeoff is a wash; pyrmts primitive can be
Polars-only on ergonomics.

H2 — **Python wins**: parallel-original beats chunked-block-Polars by
≥1.5×. → The long-form RT is real overhead; expose a dict-accumulator
fast path in pyrmts.

H3 — **Polars wins**: chunked-block beats parallel-original by ≥1.5×.
→ Long-form RT is amortized; current direction is correct.

## Results

Run on 2026-06-21, c7a.16xlarge (16 vCPU, 64 GB), 7-day range
`2026-06-11 → 2026-06-18`. Logs: `logs/bench-cascade-*-7d*.log`.

| contender                 | wall      | map / reduce      | RSS peak  | shards out | notes |
|---------------------------|-----------|-------------------|-----------|------------|-------|
| orig-baseline (j=1)       | ~85 min ext. | n/a            | ~10 GB @ 14 min | n/a   | killed at 14 min / 12 of 168 source shards processed (~7 %); per-shard wall ~30 s; extrapolation only |
| orig-parallel j=7         | 991.7 s   | 948.1 / 43.6      | ~16 GB    | 365        | clamped from `-j 16`: `cascade_from_1m` takes Date not datetime, so natural max is 1 worker per day. Per-worker per-shard wall: 33 s @ j=4 vs 40 s @ j=7 — modest CPU/R2 contention. |
| polars-chunked j=4        | **504 s** | 349.7 / 154.6     | ~18 GB (§2) | 21 finals from 98 partials | block phase: 7 blocks × 1d task-size; reduce-phase wall is real but small fraction of total |

(§2 reference: 520 s — confirmed within noise on re-run.)

### Verdict: **H3 — Polars wins** (~2× over parallel-original, ~10× over single-process baseline extrapolation)

Even with the long-form pivot RT overhead, chunked-block Polars beats
the best Python-dict parallelism by roughly 2× at the same hardware.
The pivot-RT cost is real but is dwarfed by the per-row dispatch cost
that Python pays.

#### Why the gap

- **Per-shard sequential cost** in Python is dominated by row-by-row
  dict-update + json.loads/json.dumps. We measured ~30-33 s per source
  hour at j=1 / j=4, going up to ~40 s at j=7 (CPU/R2 contention).
- **Polars** batches the same logical work via long-form group_by +
  sum, paying a small pivot overhead but doing the inner aggregation
  in Rust. Per-block wall is ~50 s for 1 day's worth of source × all
  17 tiers via chunked pivot — call it ~2 s per source hour
  effectively. ~15× per-source-hour speedup at the inner level.
- **The reduce phase** (block-boundary partials → final shards) takes
  ~155 s for Polars vs ~44 s for parallel-original. Polars writes
  fewer, larger partials; reduce per-shard is heavier but total
  reduce-time is still small relative to map.

#### Implications for rides Phase 1a

The pyrmts vectorized cascade primitive can be **Polars-only** — no
need for a dict-accumulator fast path for the histogram-monoid branch.
The current `cascade.py:cascade_tiers` row-at-a-time API stays as the
"correctness reference"; the new primitive is the perf path.

#### Followups (not blocking)

- **`-j 16` true scaling**: requires refactoring `cascade_from_1m` to
  accept datetime ranges (currently Date-only). Going from j=7 to j=16
  on 7 days = sub-day splits. Trend suggests diminishing returns
  (per-shard cost grew from j=4 to j=7), but worth measuring once.
- **Polars at j=16**: trivially possible (pyramid-cascade already
  supports it via `task_size=1d` × N day-blocks). Likely 2-3 min wall
  for 7 days but R2 bandwidth may saturate.
- **Shared shard layout**: standardize legacy + new engines on the
  same shard sizes so byte-equality concordance becomes a valid 3-way
  check, not just wall-time.

## Followups

- If parallel-original wins, port the orchestration pattern (worker
  per sub-range + reduce on boundary-spanning shards) into pyrmts
  alongside the existing `cascade_tiers` — as a "fast path" for
  workloads that fit in dict memory.
- Either way: standardize on one shard layout across legacy + new
  engines (so byte-comparison becomes valid in future benchmarks).
