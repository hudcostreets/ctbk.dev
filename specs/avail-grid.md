### Spec: avail multi-scale grid v2 — CLI-driven, D1-manifested

Status: **open** (2026-05-04). Supersedes `specs/avail-perf-pass.md` for
all next-phase work. Phase 0 of that spec (cron writes 1m@1m parquet via
loader) and the initial cons/agg cascade compactor (`gbfs/cascade/`) are
already in production; this spec freezes the v2 design that the
remaining work will follow.

The semantic primitives — wall-clock bins, monoid schema, manifest as
source-of-truth for the planner — carry over unchanged. What's new:

- **Final grid**, with smoother SUFs (max ≤ ~5) at every step
- **Hive-style key encoding** end-to-end (period segment included)
- **`ShardStore` interface** with `R2Store` and `LocalStore` impls
- **`gbfs` Node CLI** (`gbfs/cli/`) as the single entry point for all
  grid operations; CFW worker, GHA jobs, and ad-hoc EC2 runs all invoke
  the same code via the same subcmds
- **D1 manifest** as live source of truth (replaces the R2 `manifest.json`)
- **Static CFW-vs-GHA dispatch** per (agg, cons), refined from empirics

DVX-as-manifest (using `r2/ctbk/.../*.parquet.dvc` files in-repo as the
authoritative grid record) is a v2 thought. **Out of scope for this spec.**

## Grid (locked)

| agg | cons levels (SUFs in parens)                            | max ts/file |
|-----|---------------------------------------------------------|------------:|
| 1m  | 5m(5), 15m(3), 1h(4), 3h(3), 8h(2.67), 1d(3)            | 1440 |
| 5m  | 15m(3), 1h(4), 3h(3), 8h(2.67), 1d(3), 5d(5)            | 1440 |
| 15m | 1h(4), 3h(3), 8h(2.67), 1d(3), 3d(3), 10d(3.33)         | 960  |
| 1h  | 3h(3), 8h(2.67), 1d(3), 3d(3), 1w(2.33), 1mo(4.3), 2mo(2) | 1440 |
| 1d  | 3d(3), 1w(2.33), 1mo(4.3), 3mo(3), 1y(4), 3y(3)         | 1095 |

Plus the agg-self levels: 5m@5m, 15m@15m, 1h@1h, 1d@1d (one row per
station per bucket; SUFs against the previous agg-self).

The `1mo → 3mo → 1y` boundaries are structural (months/years aren't
powers of weeks); SUF=4.3 there is the unavoidable max.

## Key encoding (Hive-style throughout)

```
avail/agg=<A>/cons=<C>/dt=<period>.parquet
```

Period:

| cons        | period format         | example                       |
|-------------|-----------------------|-------------------------------|
| ≤1d, ≥1m    | `YYYY-MM-DD_HHMM`     | `2026-05-04_1430`             |
| 1h, 3h, 8h  | `YYYY-MM-DD_HH`       | `2026-05-04_14`               |
| 1d, 3d      | `YYYY-MM-DD`          | `2026-05-04`                  |
| 1w          | `YYYY-Www` (ISO 8601) | `2026-W18`                    |
| 1mo, 2mo, 3mo | `YYYYMM`            | `202605`                      |
| 1y, 3y      | `YYYY`                | `2026`                        |

For multi-period cons (3d, 1w, 5d, 10d, 3mo, 3y), the period encodes the
**bucket start**. The planner derives the end from the cons size.

## `ShardStore` interface

```ts
interface ShardStore {
    head(key: string): Promise<{ size: number } | null>
    get(key: string): Promise<ArrayBuffer | null>
    put(key: string, body: ArrayBuffer | Uint8Array): Promise<void>
    list(prefix: string): AsyncIterable<{ key: string; size: number }>
}
```

Two implementations:

- **`R2Store`** wraps `R2Bucket` (CFW) and the S3 API (Node, via
  `@aws-sdk/client-s3` against the R2 endpoint). Same class works in
  both runtimes via constructor-injected backend.
- **`LocalStore`** reads/writes under a root dir (`r2/ctbk/` by default).
  Used for backfill review, dry-runs, and CLI dev.

All grid logic in `gbfs/lib/cascade.ts` takes a `ShardStore`; no direct
`R2Bucket` references in the cascade or CLI code.

## D1 manifest

Schema:

```sql
CREATE TABLE shards (
    agg          TEXT NOT NULL,
    cons         TEXT NOT NULL,
    period       TEXT NOT NULL,        -- e.g. '2026-05-04_1430', '202605'
    state        TEXT NOT NULL,        -- 'present' | 'subsumed' | 'deleted'
    bytes        INTEGER NOT NULL,
    rows         INTEGER NOT NULL,
    created_at_s INTEGER NOT NULL,
    subsumed_at_s INTEGER,             -- NULL until subsumed
    PRIMARY KEY (agg, cons, period)
);

-- Planner: "give me extant shards for (agg, cons) in [period_lo, period_hi]"
CREATE INDEX idx_planner ON shards (agg, cons, period) WHERE state = 'present';

-- GC: "shards eligible for deletion"
CREATE INDEX idx_gc ON shards (state, subsumed_at_s) WHERE state = 'subsumed';
```

The manifest is the **planner's only source of truth** for what exists.
R2 head() probes are reserved for write-time barriers and recovery
(`gbfs manifest sync` rebuilds D1 from R2 listings).

State transitions:

- `present` — shard exists in R2; planner serves it
- `subsumed` — a coarser cons covers this period; planner ignores; GC
  eligible after grace period (≥24h)
- `deleted` — shard removed from R2; row retained briefly for audit

Subsumption is automatic at write-time: when `attemptCons` writes a cell
at cons=C₁, all extant cells at cons=C₀ < C₁ that overlap the C₁ bucket
get `state='subsumed', subsumed_at_s=now()` in the same D1 transaction.

## `ensureCell` driver

Replaces the bespoke `attemptCons`/`attemptAgg` from the current cascade.

```ts
async function ensureCell(
    store: ShardStore,
    manifest: Manifest,
    grid: GridSpec,
    agg: string, cons: string, period: string,
    opts: { dryRun?: boolean; recursive?: boolean } = {},
): Promise<EnsureResult>
```

Behavior:

1. If manifest reports `state='present'` for (agg, cons, period) → noop.
2. Else compute the input cells from the grid spec (the unique parent in
   the grid for cons C is the next-finer cons in the same agg series, or
   the agg-self of the previous agg level for an agg-self cell).
3. If `recursive=true` and any input is missing → recurse to ensure them.
   If `recursive=false` and any input is missing → return
   `{status: 'missing_inputs', missing: [...]}`.
4. Read inputs from the store, run cons-merge or agg-merge, write the
   output, update the manifest (insert/upsert + subsumption).

Idempotent and safe to run concurrently from multiple processes (D1 row
PK + R2 conditional puts via `If-None-Match: *` for first-write safety).

## CLI surface

Single `gbfs` binary (Node, pnpm workspace). Subcmds:

```
gbfs ensure   --agg=<A> --cons=<C> --period=<P> [-r/--recursive] [-n/--dry-run]
gbfs backfill --grid=gbfs/grid.yaml --from=<P> --to=<P> [-n]
gbfs plan     --agg=<A> --from-s=<S> --to-s=<S>      # preview planner output
gbfs gc       --grace=24h [-n]
gbfs manifest sync       # rebuild D1 from R2 (recovery)
gbfs manifest get/put/list/rm
gbfs serve-dev           # local dev: serves the planner against LocalStore
```

Global flags:

- `--store=r2|local` (default `r2`; `local` reads/writes under `r2/ctbk/`)
- `--manifest=d1|local` (default `d1`; `local` uses a SQLite file under
  `r2/.manifest.sqlite`)
- `--config=<path>` (default `gbfs/grid.yaml`)
- `-n/--dry-run` on every write subcmd

CFW worker invokes `ensure`-equivalent inline (no subprocess; same TS
code, just imported as a lib). GHA cron worker runs `pnpm gbfs <cmd>`
with literal cmd/args from the dispatch input.

## CFW vs GHA dispatch

Each grid level has a `runner` field in `gbfs/grid.yaml`:

```yaml
levels:
  - {agg: 1m, cons: 1h,  runner: cfw}
  - {agg: 1m, cons: 3h,  runner: gha}   # ~30MB inputs blows 128MB heap
  - {agg: 1m, cons: 1d,  runner: gha}
  - {agg: 5m, cons: 5d,  runner: gha}
  ...
```

CFW cron at each tick: for each due cell, if `runner == cfw` → run inline.
If `runner == gha` → write a row to D1 `dispatch_queue` and call
`gh workflow run` via fetch (single dispatch can carry many cells).

Static thresholds derived empirically. Bootstrap rule: any cons whose
expected total decoded input size exceeds ~80MB (conservative on 128MB
heap) → GHA. Refined as we ship.

CFW emits Workers Analytics Engine custom dims per cell:
`(agg, cons, period_size, input_bytes, output_bytes, ms)`. After a few
days of soak we query for actual p99 input bytes and resize the runner
table.

GHA workflow is one job:

```yaml
on:
  workflow_dispatch:
    inputs:
      cmd: { type: string, required: true }
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm gbfs ${{ inputs.cmd }}
```

GHA cron jitter is multi-hour in this repo's experience; CFW-dispatched
runs fire within seconds of the trigger.

## Migration

No backwards compatibility. Fast-follow delete of all old code and old
shard paths. Per the user's standing instruction.

1. **CLI + ShardStore + grid spec** — purely additive; nothing wired up
   to prod yet.
2. **`ensureCell` + cascade refactor**, run only against `LocalStore`
   end-to-end. Test by running the CLI to backfill a few days of history
   into `r2/ctbk/`. Inspect outputs locally.
3. **`R2Store` impl**, run the CLI against R2 + a local SQLite manifest.
   Verify the production R2 path produces correct shards.
4. **D1 manifest live**. Wire the CLI's `--manifest=d1` path through to
   the production D1 instance.
5. **Cut over CFW worker**: replace `gbfs/cascade/` and `gbfs/loader/`
   write paths with calls into `gbfs/lib/grid.ts` (the lib backing the
   CLI). Same code paths, just different runtime.
6. **Delete old code and old keys**: drop `gbfs/cascade/src/index.ts`'s
   bespoke `attemptCons`/`attemptAgg`, drop the old `avail/agg=*/cons=*/`
   non-Hive keys, drop the old `pickAvailAggTier`. R2 lifecycle rule
   on the old prefix; manifest reflects only new layout.
7. **Backfill historical** from the JSON archive (since 2026-04-08), via
   the CLI + GHA, into the new layout. Manifest extends back to start.
8. **Planner cutover** (next spec): replace `pickAvailAggTier` in the
   API worker with a manifest-aware planner (D1 query). Drop legacy
   fallbacks in the same change.

Steps 1–4 happen against `LocalStore` and a local SQLite manifest;
production isn't touched until step 5. This lets the CLI soak in dev
before any worker change ships.

## Out of scope

- **DVX-as-manifest** (Git/DVC-tracked `*.parquet.dvc` files as the
  authoritative grid record). Considered; deferred. v1 is D1+R2 only.
  Revisit when grid is stable and we want a durable, branch-able,
  history-tracked snapshot.

- **Per-h3-hex shards** for heatmaps. Same grid pattern, different sort
  key. Deferred to when a heatmap UI lands. (Same status as in
  `avail-perf-pass.md`.)

- **`@4m` agg series** (coprime with @5m). No caller asks for it.
  Re-evaluate if a use case appears.

- **`samples` column** for distributional queries (Tukey fences /
  outlier-aware UI). The monoid schema in `avail-perf-pass.md` reserves
  the column; we'll fill it in a follow-up. v1 schema = `(n, sum, sum_sq)`
  per metric, no samples.

## Sequence (this spec)

0. **Spec lock** (this commit).
1. **CLI scaffold** at `gbfs/cli/`: `pnpm init`, bin entry, subcmd
   dispatch via `commander` or similar.
2. **`ShardStore` + `LocalStore`** at `gbfs/lib/store.ts`. Integration
   test: write/read/head/list round-trips under `tmp/store-test/`.
3. **Grid spec** at `gbfs/grid.yaml` (the table above). Loader at
   `gbfs/lib/grid.ts`.
4. **`ensureCell` + cascade refactor** (`gbfs/lib/cascade.ts`). Take
   `ShardStore` + grid; produce `EnsureResult`.
5. **D1 schema + `Manifest` interface + local SQLite impl**
   (`gbfs/lib/manifest.ts`).
6. **Backfill subcmd**, end-to-end against `LocalStore` for a single day
   of historical JSON. Review output by hand.
7. **`R2Store` impl** + cutover of CFW workers (`gbfs/cascade/`,
   `gbfs/loader/`) to call `gbfs/lib/grid.ts`. Delete old code paths.
8. **D1 manifest live** in production CFW + Worker.
9. **Backfill historical** from JSON archive (GHA matrix job).
10. **Planner cutover** (likely a separate spec — the planner is the
    consumer side and warrants its own design pass given the SUF
    framework already documented in `avail-perf-pass.md`).

Acceptance:

- CLI dry-runs match prod actual outputs byte-for-byte (deterministic
  cascade).
- `gbfs backfill` against local store produces a complete grid for one
  test day, verified by `gbfs plan` returning expected file lists for
  representative queries.
- Production cron tick after step 7 produces byte-identical shards to
  the pre-cutover code (regression guarantee for shard contents).
- D1 manifest stays consistent with R2 over a 24h soak — a `gbfs
  manifest sync` after that produces zero diffs.
