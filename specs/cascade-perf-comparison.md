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

(Filled in after runs complete)

| contender         | wall     | peak RSS | R2 GETs | R2 PUTs | notes |
|-------------------|----------|----------|---------|---------|-------|
| orig-baseline     | TBD      | TBD      | 168     | TBD     |       |
| orig-parallel j=4 | TBD      | TBD      | 168     | TBD     |       |
| polars-chunked j=4| ~520s    | ~18 GB   | 168     | ~120    | from §2 |

### Interpretation

(After results, decide which of H1/H2/H3 holds and what it implies for
rides Phase 1a.)

## Followups

- If parallel-original wins, port the orchestration pattern (worker
  per sub-range + reduce on boundary-spanning shards) into pyrmts
  alongside the existing `cascade_tiers` — as a "fast path" for
  workloads that fit in dict memory.
- Either way: standardize on one shard layout across legacy + new
  engines (so byte-comparison becomes valid in future benchmarks).
