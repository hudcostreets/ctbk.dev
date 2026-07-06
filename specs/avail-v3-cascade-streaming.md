# avail-v3 cascade: streaming-output + self-healing rewrite

Follow-on to `specs/avail-v3-cascade-oom-fix.md` (streaming input reads,
which shipped in `cefb66f7` + `bd08ef64`). That fix bounded the **input**
memory footprint but left the **output aggregator** (`StreamingMerger`'s
`Map<key, row>`) scaling with `cells × dt-bins`. Empirically confirmed
after 24h in prod: every 24h-boundary rung failed to fire at 00:00 UTC
2026-07-05 because `/1m@12h` (720 × 3800 = 2.7M buckets) or `/1m@1d`
(5.5M buckets) OOMs mid-tick and terminates the isolate before
downstream tiers' rungs get a chance to fire.

The current cascade also has structural issues beyond OOM:

- **Not self-healing.** A missed tick (deploy hiccup, R2 blip, OOM) is
  never retried; the gap sits until a manual fsck runs.
- **No sub-max GC.** Sub-max shards accrete indefinitely; the min-cover
  ideal is 1× max-rung shard per period + trailing rungs for the tail,
  but D1 currently has ~2× that count (16 vs 7 for the `/6h` tier over
  89 days) due to overlap from repeated fsck runs and leftover
  legacy shards.
- **No fault isolation.** One rung's failure kills every subsequent
  rung in the same tick — the tier loop has no try/catch.
- **Two implementations.** The CFW writer (TypeScript, forward-only) and
  the Python `pyramid-cascade --fsck --fill` (offline backfill) do
  effectively the same job in two languages. They drift; edge cases
  differ; ops complexity doubles.

## Design goals

1. **Streaming aggregation.** Peak heap independent of shard cell/bin
   cardinality. `/1m@1d` (5.5M output rows) should write in the same
   memory footprint as `/6h@1d` (15k output rows).
2. **One declarative primitive.** A pure `converge(env, opts)` function:
   *"survey existing tier-shards, compute diff vs min-cover, create/GC
   until the state matches."* CFW cron, laptop CLI, and e-cron are all
   thin adapters over this function differing only in `parallelism` /
   `timeBudget` / `tiers` scope.
3. **Self-healing.** Missed ticks are transparent: the next
   `converge()` re-derives what's missing and fills it, regardless of
   whether the miss was a single boundary or a 3-day outage.
4. **Correct min-cover at rest.** Steady-state: exactly the shards
   pyrmts's `list_expected_shards` emits — max-shards from genesis
   forward, trailing rungs for the un-max-fitted tail, nothing else.

## Recommended runtime: single CFW

Steady-state per-tick work is well-bounded once streaming aggregation
lands:

- Small rungs (`≤3h`): ~10 ms each (streaming aggregate + streaming
  write, small output).
- Medium rungs (`6h`–`2d`): ~100 ms.
- Large rungs (`5d`–`30d+`): ~1 s.

At the heaviest tick (00:00 UTC, every rung whose duration divides
24 h fires):

- ~15 tiers × ~6 divisor-rungs ≈ 90 writes.
- Serial ≈ 9 s (fits 30 s CPU cap comfortably).
- Parallel via `Promise.all` per tier ≈ 600 ms wallclock.

Multi-day-boundary ticks are heavier (`/5d`, `/15d`, `/30d`, `/60d`
all fire on aligned days) but each write is still streaming-bounded
and these events are rare (weekly / monthly).

**Bootstrap** (89-day cold-start of empty D1) is the one workload
that doesn't fit a single tick. But bootstrap is one-time — handled by
running the same `converge()` on `e` or laptop in a loop until
`report.toWrite.length === 0`. After bootstrap, incremental catch-up
(even from a multi-day outage) fits in a handful of subsequent ticks.

Per-tier CFW split is deferred to an escape hatch (see below) — only
adopted if measured per-tick load exceeds budget in practice.

## Architecture

### The `converge` primitive

```typescript
interface ConvergeOpts {
  tiers?: string[];        // subset of tiers to process; default = all
  now?: Date;              // override "current time" for testing; default = new Date()
  parallelism?: number;    // concurrent writeShard operations; default = 1
  timeBudgetMs?: number;   // stop before exceeding this wallclock; default = Infinity
  maxOps?: number;         // hard cap on operations this call; default = Infinity
  dryRun?: boolean;        // compute + report diff, don't mutate
}

interface ConvergeReport {
  tier: string;
  toWrite: ExpectedShard[];  // total gaps found this call
  written: WriteResult[];    // subset actually applied
  skipped: SkipReason[];     // deferred (missing sources, out of budget, ...)
  errors: ErrorResult[];
}

async function converge(env: Env, opts?: ConvergeOpts): Promise<ConvergeReport[]>;
```

Note: `converge()` **does not GC.** That's a separate primitive
(`gcSweep()`, below) to keep the writer's contract clean —
`converge()` only creates shards; only `gcSweep()` deletes them.

Adapters:

- **CFW cron** (`avail3Tick`): `converge(env, { timeBudgetMs: 25_000, parallelism: 4 })`.
  Runs every /5m; each tick catches up whatever is missing since the
  last successful tick.
- **Laptop / e CLI** (`node cascade-cli.js converge`): default
  `parallelism: 16, timeBudgetMs: Infinity`, loop until stable. Same
  code path, no rate limit.
- **Selective tier** (e.g. debugging a stuck tier): `converge(env, { tiers: ['/6h'] })`.
- **Dry run for CI/monitoring**: `converge(env, { dryRun: true })`
  returns `toWrite` counts; can alert if non-zero at steady state.

### The `gcSweep` primitive

Separate from `converge()`. Deletes shards that (a) are superseded by
a max-rung parent that IS registered, and (b) are past the grace
window.

```typescript
interface GcSweepOpts {
  tiers?: string[];
  now?: Date;
  graceMinutes?: number;   // default 15
  dryRun?: boolean;
  maxOps?: number;
  parallelism?: number;
}

interface GcSweepReport {
  tier: string;
  eligible: RegisteredShard[];  // total supersedable + past grace
  deleted: RegisteredShard[];
  skipped: SkipReason[];
}

async function gcSweep(env: Env, opts?: GcSweepOpts): Promise<GcSweepReport[]>;
```

Adapters:

- **Dedicated CFW cron** (separate from the writer cron): runs less
  often, e.g. `0 6 * * *` (daily at 06:00 UTC). Trailing sub-max
  shards get GC'd within a day of being superseded.
- **CLI**: `node cascade-cli.js gc-sweep [--tiers=/6h] [--dry-run]`.
- **Manual**: run once at cutover to clear the ~9 accreted sub-max
  shards per tier that D1 currently holds.

Keeping GC separate from `converge()` means:
- The writer is idempotent and monotone-additive; easy to reason about.
- GC can be turned off entirely (skip the cron) without affecting
  correctness — just leaves R2/D1 fat.
- Different rate limits: writer runs every 5 min; GC runs daily.

If we later decide to fold GC into `converge()`, that's an internal
change to the primitive — adapters unaffected.

### Streaming aggregation algorithm

**Precondition:** input shards are sorted by `(s2_cell, dt)`
ascending. Already true — `transform.ts:sortRows` enforces this on
every write, and ctbk #114 re-sorted historical shards to match.

**Aggregator state:** exactly one `(s2_cell, target_dt_bin) → row`
in flight at any time. When the next merged input row's key differs,
emit the current aggregate + advance.

**k-way heap-merge across N sources.** Open N `streamShardToMerger`
cursors, one per source shard. Use a min-heap of `(s2_cell, dt)` keys
to pull the smallest across all cursors. Since `(s2_cell, dt)` is a
totally-ordered key and each cursor is sorted, the merged stream is
also sorted — trivial invariant of the k-way merge.

**Rebinning to target `dt`:** when target bin > source bin, floor
`dt` to the target bin as rows are pulled. Floor preserves ordering
(sorted source stays sorted after floor), so the heap-merge doesn't
break.

```typescript
async function* streamMerged(
  cursors: AsyncIterator<Row>[],
  targetBinMs: bigint,
): AsyncIterator<Row> {
  const heap = new MinHeap<{ key: string; row: Row; ci: number }>();
  for (let i = 0; i < cursors.length; i++) {
    const first = await cursors[i].next();
    if (!first.done) heap.push({ key: sortKey(first.value, targetBinMs), row: first.value, ci: i });
  }
  let acc: Row | null = null;
  while (heap.size > 0) {
    const { row, ci } = heap.pop();
    const rebinned = { ...row, dt: row.dt - (row.dt % targetBinMs) };
    if (!acc || acc.s2_cell !== rebinned.s2_cell || acc.dt !== rebinned.dt) {
      if (acc) yield acc;
      acc = rebinned;
    } else {
      acc = mergeRow(acc, rebinned);
    }
    const next = await cursors[ci].next();
    if (!next.done) heap.push({ key: sortKey(next.value, targetBinMs), row: next.value, ci });
  }
  if (acc) yield acc;
}
```

**Peak per-in-flight state:** N × (one decoded row-group) for the
cursors + 1 accumulator row + N heap entries. For N=24 sources at
2 k rows/RG × ~200 bytes = ~10 MB total, regardless of output
cardinality.

### Streaming parquet writer

`hyparquet-writer` already exposes `ParquetWriter` — its docstring is
literally *"allows incremental writing of parquet files"*. Verified
against the source: each `.write()` call emits row-group bytes to the
writer buffer immediately; only ~200-byte-per-RG metadata accumulates
for the footer.

```typescript
const bw = new ByteWriter();
const w = new ParquetWriter({ writer: bw, schema, codec: 'SNAPPY' });
let batch: RowBatch = emptyBatch();
for await (const row of streamMerged(...)) {
  batch.push(row);
  if (batch.length >= ROW_GROUP_SIZE) {  // e.g. 2048
    w.write({ columnData: batchToColumns(batch), rowGroupSize: ROW_GROUP_SIZE });
    batch = emptyBatch();
  }
}
if (batch.length) w.write({ columnData: batchToColumns(batch), rowGroupSize: ROW_GROUP_SIZE });
w.finish();
await r2.put(key, bw.getBytes());
```

Peak output-side heap: one `ROW_GROUP_SIZE`-row batch (~400 KB) + the
accumulated `ByteWriter` buffer (bounded by output shard bytes — 50-
100 MB for `/1m@1d`, well under paid-tier 512 MB).

For future scale (if output exceeds ByteWriter capacity), the same
API supports swapping in an R2 multipart uploader that flushes ≥5 MB
parts. Deferred; not required now.

### Self-healing diff loop (inside `converge()`)

```
1. For each tier in opts.tiers (default: all):
   a. Compute expected = list_expected_shards(pyramid[tier], [genesis, now]).
   b. Query D1 for registered shards at this tier.
   c. Diff → toWrite (in expected, not registered).
   d. Dependency-sort toWrite (smallest-rung-first: sources before consumers).
   e. For each shard in toWrite (respecting parallelism / time / maxOps):
      i.  Verify sources exist (R2 HEAD or D1 shard_index lookup).
          If not: skipped, waiting_on_sources. Next call will retry.
      ii. Streaming aggregate + streaming write.
      iii. Register in D1 shard_index + update watermark.
2. Return ConvergeReport per tier.
```

### GC diff loop (inside `gcSweep()`)

```
1. For each tier in opts.tiers:
   a. Compute currentExpected = list_expected_shards(pyramid[tier], [genesis, now]).
   b. Query D1 for registered shards at this tier.
   c. eligible = registered - currentExpected (superseded shards).
   d. Filter by grace: only shards where the max-rung parent covering
      the same period is registered AND period_end + graceMinutes ≤ now.
   e. For each shard (respecting parallelism / maxOps):
      i.  Verify parent max-rung shard exists on R2 (belt-and-suspenders).
      ii. Delete R2 object.
      iii. Delete D1 shard_index row.
2. Return GcSweepReport per tier.
```

## Phased migration

**Phase A: streaming primitives inside current tick.**
Replace `StreamingMerger` with the k-way-merge streaming aggregator.
Replace `writeParquet` with `ParquetWriter` incremental write.
Keep the current `avail3Tick` structure (fire-on-boundary gate) —
still monolithic, still forward-only. This alone unblocks all current
OOMs. Deploy + validate for a week.

**Phase B: refactor to `converge(env, opts)`.**
Extract tick logic into a pure `converge()` function taking an
opts object. `avail3Tick` becomes a 3-line adapter:
`await converge(env, { timeBudgetMs: 25_000, parallelism: 4 })`.
Add a Node CLI adapter (`packages/cascade-cli/`) that wraps the same
function for laptop / e use. Deprecate `ctbk pyramid-cascade --fsck --fill`;
the CLI replaces it with a single implementation.

**Phase C: diff loop + `gcSweep()` + retire the fire-on-boundary gate.**
Replace boundary-firing with min-cover diff (per §"Self-healing diff
loop"). Add `gcSweep()` primitive + its own cron (or CLI). Bring
GC online; sub-max shard count drops to min-cover exact + grace tail.

**Phase D (escape hatch — only if needed):** if boundary-tick load
exceeds CPU budget in practice, split into N workers with a
configurable tier-grouping (any `worker → tier[]` map — could be 1:1,
1:all, or arbitrary N:M). Config-driven, not a rewrite.

**Phase E: cleanup.** `scripts/avail-v3-rename.py r2-delete`-style
purge of pre-cutover `avail-v3-test/` and calendar-duration
(`1mo`/`1y`/`120y`) shards. Optionally: retire Python
`pyramid-cascade` fsck entirely.

## Alternative runtimes (not adopted, but noted)

The `converge()` function is designed to be **runtime-agnostic** —
its dependencies are `R2Bucket`, `D1Database`, and a pyramid config.
CFW binds these natively; Node CLI binds via `@aws-sdk/client-s3`
against R2's S3-compat endpoint (and `better-sqlite3` or a D1 HTTP
client). Same code, either runtime.

**AWS Lambda:** possible but not recommended.

|  | CFW (paid) | Lambda |
|---|---|---|
| Max wallclock | 30 min (waitUntil) | 15 min |
| CPU per handler | 30 s | 15 min |
| Max memory | 512 MB | 10 GB |
| R2 I/O path | CF-internal (~ms) | public egress (~100s ms) |
| Cold start | ~1 ms | ~100 ms – 1 s |
| Cost | trivial at our volume | trivial at our volume |

For R2-bound streaming work (~thousands of small reads/writes per
call), CFW's colo-adjacent network wins decisively. Lambda's memory
+ CPU headroom only matters if we outgrow streaming (unlikely) or
want managed bootstrap without `e`. If a Lambda adapter ever becomes
useful, the same `converge()` compiles into an AWS Lambda handler
with only the Env binding differing.

## Failure modes and retry

1. **Source shard missing when a rung tries to read.** Skip this
   shard (`skipped: waiting_on_sources`); next `converge()` call
   re-diffs and tries again.
2. **Streaming aggregate/write throws (network, R2 5xx).** Log,
   don't register in D1. `errors[]` in the report. Retried next call.
3. **CFW isolate terminates mid-shard-write.** No D1 registration.
   Retried next call.
4. **Partial output visible on R2 but not D1.** Next call's
   `converge()` still sees the shard as missing (D1-driven diff), so
   it tries to write again. `r2.put()` overwrites — idempotent.
   Alternative: HEAD-check + content-hash on R2 before treating as
   authoritative. Overwrite is simpler.
5. **D1 write succeeds, R2 delete (in `gcSweep`) fails.** Next
   `gcSweep()` re-tries the delete.
6. **`converge()` writes a shard that GC then immediately deletes
   because the writer's `now` was stale.** Prevented by opt.now
   being the same clock and `gcSweep()`'s grace window > worst-case
   converge() wallclock.

## Success criteria

- Every steady-state `converge()` call returns
  `toWrite=[]` and `written=[]`.
- Every steady-state `gcSweep()` call returns
  `eligible=[]` and `deleted=[]`.
- D1 shard count for each tier equals its expected min-cover count ±
  the grace window's worth of trailing sub-max shards.
- No OOM tail events in CF logs for 30 days.
- A killed tick doesn't leave D1/R2 inconsistent for more than one
  subsequent `converge()` call.
- Manual `converge(env, { dryRun: true })` reports zero gaps at
  steady state; can be wired to `/health` or an alerting cron.

## Open questions

- **`ParquetWriter` API stability under long incremental writes.**
  Read the source: bytes flush to the writer per `.write()` call;
  only ~200-byte-per-RG metadata accumulates for the footer. Should
  be memory-safe. Spike/bench before Phase A ships.
- **D1 write batching.** `converge()` may register 90+ shards in a
  single 00:00 UTC boundary tick. Batch the `INSERT OR REPLACE`
  into a single D1 `.batch()` call (up to 1000 statements per
  batch, per D1 docs) to avoid 90 round-trips.
- **R2 rate limiting.** Same tick could HEAD + GET + PUT hundreds
  of objects. R2 free tier is 10k Class-A ops/day, paid is
  effectively unmetered. Confirm no rate-limit surprises in the
  bootstrap loop.
- **Bootstrap.** First deploy of `converge()` with an empty D1
  will find ~1500+ shards missing. Run `node cascade-cli.js converge
  --tiers=/1m` first (populates the base), then loop until stable.
  Documented in the cutover section.

## Where this fits

- `specs/avail-v3-ladder-migration.md` — umbrella for the current
  cutover.
- `specs/avail-v3-cascade-oom-fix.md` — the streaming *input* fix
  that shipped. This spec addresses what that fix left on the table.
- `specs/avail-v3-fsck-backfill.md` — Python-side fsck design.
  Superseded by the Node CLI adapter in Phase B; retired in Phase E.

## Code pointers

- `gbfs/cascade/src/avail3/cascade.ts` — current single-worker
  `avail3Tick` (becomes a thin adapter in Phase B).
- `gbfs/cascade/src/avail3/transform.ts` — `StreamingMerger` (to be
  replaced), `sortRows` (invariant: sources sorted by `(s2_cell, dt)`).
- `node_modules/hyparquet-writer/src/parquet-writer.js` —
  `ParquetWriter` class, incremental `write()` + `finish()`.
- `~/c/pyrmts/js/packages/pyrmts/src/*` — `list_expected_shards`
  min-cover semantic (as of `9d16761`), the source of truth for what
  `converge()` diffs against.
- `ctbk/pyramid_cascade/{fsck,materialize}.py` — the Python impl
  Phase B deprecates.
