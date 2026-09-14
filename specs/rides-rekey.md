# Rides re-key: canonicalized + de-versioned genesis→now rebuild (c14n P3)

Status: proposed (2026-09-14). The one-time genesis→now Batch rebuild that
operationalizes materialized canonicalization (`materialized-canonicalization.md`
P1a/P1b, landed) on the serving data, and — because it is a full rewrite anyway
— folds in the rides half of `deversion-clean-slate.md`. Blocks P2 (worker
`c:`-serve) and P4 (prod cutover); needs explicit owner go-ahead (Batch compute +
cost) before execution.

## What it does, in one rewrite

Three changes to the rides pyramid, all realized by rewriting every shard once:

1. **Raw-id leaves.** Key the `cell` column by `s:<raw reported id>` (P1a
   `rides_source` already emits these), id-map-independent.
2. **Materialized `c:` rows.** In each built shard, add one `c:<canonical>` row
   per merged station cluster, summed from its raw `s:` leaves per the declared
   `identityRollup.map` (P1b: `station-canonicalize-map.json`, 2110 entries / 974
   clusters). Raw leaves + s2 cells untouched.
3. **De-versioned prefix.** Write to the clean `rides/{start,end}/…` R2 prefix and
   register under pyramid names `rides-start` / `rides-end` — dropping the `-v5`
   suffix (`deversion-clean-slate.md`).

### Why fold canonicalization and de-versioning together

Both are genesis→now full rewrites of the same shards, and **R2 has no cheap
server-side rename** — a `rides-v6/` build would need a second full object copy to
ever become `rides/`. Doing the canonicalization re-key straight into the clean
`rides/` name is the one free moment to drop the version suffix; splitting them
means rewriting ~13 years × 2 anchors of shards twice. So P3 delivers the rides
rows of `deversion-clean-slate.md` (avail + smg de-versioning and the superseded-
prefix purge stay in that separate pass).

## Non-destructive by construction

- **New prefix, old untouched.** P3 writes only `rides/…`; prod's `rides-v5/…`
  shards and its `rides-v5-{start,end}` D1 rows are never modified. D1
  registration of the new shards is **additive** (a new pyramid name), so the
  existing registry and the prod worker keep functioning unchanged.
- **Nothing flips at serve until P4.** The prod worker still hardcodes
  `rides-v5/${anchor}/…` (`rides_v1.ts:316`) and `rides-v5-${anchor}`
  (`rides_v1.ts:409`), so it keeps serving old data + `s:` selection. The cutover
  is exactly the P4 edit of those two literals + the `c:`-default selection.
- This is the `validate-fills-off-prod` rule satisfied structurally: the build
  targets a fresh prefix, so it cannot poison a live tip even mid-run.

## Dev-stack validation (no prod risk)

The stack is already forkable for a dev deploy — no new infra needed:

- `gbfs/api/wrangler.toml` `[env.dev]` is a sibling worker
  (`ctbk-gbfs-api-dev.ryan-0dc.workers.dev`) sharing the **same** R2 bucket
  (`ctbk`) and D1 (`ctbk-gbfs`) as prod. So the moment P3 writes `rides/…` and
  registers `rides-{start,end}`, the dev worker can see them — against real,
  full-history data.
- **P2 lands on dev only first.** Deploy the `c:`-default + `?raw=1` worker code
  with its two literals pointed at `rides/` / `rides-{start,end}` via
  `wrangler deploy --env dev` (~15s, no GHA). Prod worker unchanged.
- **FE points at dev** with `?api=dev` (`www/src/query/stations.ts`), so the site
  can be exercised end-to-end against canonicalized data on `dev.ctbk.dev` /
  `ctbk-gbfs-api-dev` while prod serves the old path.
- Because dev and prod share D1, the `rides-{start,end}` registration P3 writes is
  the *same* registration prod will later read — so P4 is a pure worker-code
  deploy (the two literals + selection), with **no** data move or re-registration.

## The job

Run on Batch (`no-heavy-local-compute`); surface the cost estimate before the go.

1. **Config prep (P3a).** In `configs/pyramids/rides-v5-{start,end}.yaml`, change
   `storage.key` `rides-v5/{anchor}/…` → `rides/{anchor}/…` and rename the files
   to `rides-{start,end}.yaml` (deversion). Recommend the **nested** `rides/start`,
   `rides/end` shape (matches the current `rides-v5/{start,end}/` layout — the
   keyTemplate change is just dropping `-v5`). This edit is isolated on `c14n`; it
   must land atomically with P4 (the monthly extend job can't straddle two
   prefixes).
2. **Build raw-keyed shards (P3b).** Batch build genesis (2013-06-01) → now via
   the `rides_start` / `rides_end` engine factories (`gbfs/engine/
   ctbk_engine_src.py`) against the deversioned configs. Produces `s:`-keyed
   shards under `rides/…` (no `c:` rows yet — cascade never materializes the
   rollup).
3. **Canonicalize pass (P3c).** `pyrmts-engine canonicalize -r 2013-06-01/<now>
   -m s3/ctbk/stations/station-canonicalize-map.json -j <N> configs/pyramids/
   rides-{start,end}.yaml` — reads each built shard's raw `s:` leaves and writes
   the `c:` rollup rows in place. Reactive fast path: no source re-pull, no
   cascade. (In prod the `-m` override is optional once the map lives at the
   declared `stations/station-canonicalize-map.json` bucket key.)
4. **Register (P3d).** Register the new shards in D1 `pyramid_shards` under
   `rides-{start,end}` (`register_shard` / `ctbk gbfs lambda reconcile`), additive.

## Validation gate

On the dev worker (new data) vs the prod worker (old data), before any P4 flip:

- **Un-merged stations byte-equal.** For a sample of stations in no merged
  cluster, the canonical (`c:`, `rides/`) response must byte-equal the current
  prod (`s:`, `rides-v5/`) response — no behavior change where nothing merged.
- **Merged pairs.** A formerly-merged pair serves **separated** under `?raw=1`
  (raw `s:` rows) and **summed** on the canonical default, and only where the
  *corrected* id-map says so (the 25 dissolved false merges serve separated on
  canonical too).
- **Totals.** Genesis→now homepage totals within float tolerance of prod.

## Steady-state after cutover

The monthly extend job (`rides-v5-extend` → `rides-extend`) must, each month,
run the P3c canonicalize pass over the newly-built tip shards so new months also
carry `c:` rows. Add the `canonicalize` step to `gbfs-compact.yml` (or wherever
the monthly rides extend runs) alongside the build. An id-map correction becomes
a `pyrmts-engine canonicalize` pass over just the affected span (shard-scoped),
not a rebuild — the whole point of materialized canonicalization.

## Sequencing

1. **P3a** config rename (isolated on `c14n`).
2. **P3b/c/d** Batch build → canonicalize → register to `rides/…`
   (owner go + cost approval).
3. **P2** deploy `c:`-serve worker to `--env dev`; FE `?api=dev`; run the
   validation gate on `dev.ctbk.dev`.
4. **P4** flip prod (two literals + `c:` selection), coordinated FE+API deploy;
   then retire `rides-v5/` data + D1 rows (rolls into the
   `deversion-clean-slate.md` purge pass).
5. **P5** `/merge-review` page (reads `?raw=1`). **P6** avail parity.

## Open owner decisions

- **Prefix shape:** `rides/{start,end}/…` (nested, recommended) vs
  `rides-{start,end}/…` (flat). Both appear in `deversion-clean-slate.md`.
- **Cost/go:** approve the genesis→now Batch build + canonicalize run (estimate to
  be surfaced at execution time).
- **Scope confirm:** P3 is rides-only; avail canonicalization is P6, and avail/smg
  de-versioning + the superseded-prefix purge remain the separate
  `deversion-clean-slate.md` pass.
