# avail-v3 historical backfill for N≤960 ladder

## Context

Commit `f1913dc6` (avail-v3: pure-DAG cascade + N≤960 ladder cap)
capped each tier's max rung so every `writeShard` fits under CFW's
30 s CPU cap. Dropping the top rungs demoted each tier's expected
max — e.g. `/1m` was `5min..1d`, now `5min..12h`; `/2m` was
`10min..2d`, now `10min..1d`; etc. Full new ladder in
`configs/pyramids/avail.yaml`.

The CFW cascade builds the new-max-rung shards going forward
(boundary-tick-driven, `sortMissing` orders finer-first so each rung's
dependencies land before it's tried). But **historical periods have
holes**: under the old ladder, `_cover_for_tier`'s min-cover
picked `/1m@1d` for each full day and skipped `/1m@12h` entirely, so
no `/1m@12h` shards for pre-cutover history exist on R2 or in D1.
Same story for every other tier's new-max rung (`/2m@1d`, `/3m@2d`,
`/5m@2d`, `/10m@4d`, `/15m@8d`, `/30m@16d`, `/1h@32d`, `/2h@64d`,
`/3h@64d`, `/6h@128d`, `/12h@256d`, `/1d@512d`, `/3d@1536d`,
`/7d@3584d`).

Reader queries against those historical periods still work via
cursor-walk fallback to smaller rungs (`/1m@6h × 2` for a period
where `/1m@12h` is missing, etc.) — slower but correct. Backfill
makes them fast.

## Scope

**Backfill target:** every new-max rung of every tier over
`[AVAIL_GENESIS, now)` = `[2026-04-07, ~now)`.

**Estimated missing shards** (from the CFW `/avail3?dryRun=1`
just before deploy):

```
/1m@12h   × ~182   (2/day × 91 days + trailing)
/2m@1d    × ~93
/3m@2d    × ~46
/5m@2d    × ~46
/10m@4d   × ~24
/15m@8d   × ~13
/30m@16d  × ~7
/1h@32d   × ~4
/2h@64d   × ~2
/3h@64d   × ~1
Plus trailing sub-max rungs (30min, 1h) at each tier: dozens
─────────
Total ~420 shards
```

## Task

Run the Python fsck-fill on `e` to close every gap in the new ladder:

```bash
cd ~/ctbk
source .venv/bin/activate
ctbk pyramid-cascade -c configs/pyramids/avail.yaml \
    -r 2026-04-07/2026-07-09 \
    --fsck --fill
```

Adjust the `-r` upper bound to today's date.

## Notes / expected wrinkles

- The Python side (`ctbk/pyramid_cascade/materialize.py`) uses strict
  tier-by-tier cascade (`bf1db714`). For `/1m` targets it reads raw
  WAL via `avail_ingest_1m`. For non-`/1m` targets it reads
  `sourceTierFor(tier)` — bin-divisible finer tier. No same-tier
  reuse (contra the TS-side CFW's `writeSameTierCascade`, which is a
  CFW-CPU-cap concession the Python side doesn't need).
- With unbounded RAM, `/1m@12h` from raw = 720 raw minutes ×
  ~15K rows/min post-LUC ≈ 11M rows in memory, then aggregated
  down to ~2.7M output rows. Should be fine on `e`.
- After each `/1m@12h` lands, the cross-tier `/2m@1d ← /1m@12h × 2`
  and similar builds become possible. `sortMissing` handles this via
  dep-order, so a single fsck-fill run should complete all rungs in
  one pass.
- The old post-cutover `pyramid_shards` D1 rows for now-dropped rungs
  (`/1m@1d`, `/2m@2d`, etc.) are inert — pyrmts's outer expected set
  no longer emits them, so they don't affect gap discovery. Leave them
  in D1 for now; a later cleanup can prune them.
- Each `--fill` shard's D1 registration is emitted to
  `tmp/fsck-d1-record.sql` per prior convention. Apply via:
  ```bash
  (cd gbfs/api && wrangler d1 execute ctbk-gbfs --remote \
      --file ../../tmp/fsck-d1-record.sql)
  ```
  after the fsck-fill finishes.

## Verification

After fsck-fill + D1 apply, dry-run against the CFW to confirm the
new-max-rung set is dense:

```bash
source .envrc  # for COMPACTOR_SECRET
T=$(date -u -Iseconds -d "@$(( ($(date +%s) / 300) * 300 ))" | \
    sed 's/+00:00/Z/')
curl -sS -H "x-compactor-secret: $COMPACTOR_SECRET" \
    "https://ctbk-gbfs-cascade.ryan-0dc.workers.dev/avail3?t=$T&dryRun=1" \
    | jq '.totalMissing, .stats'
```

Expect `totalMissing` to drop to just the trailing edge (single-digit
shards representing recently-closed rungs the CFW cron will pick up
on the next tick).

## Outcome (2026-07-09)

Ran `ctbk pyramid-cascade -r 2026-04-07/2026-07-09 --fsck --fill` on
`e` in ~7h wall clock. Fill summary: **wrote=423, no_inputs=3,
errors=0**. The three `no_inputs` are pre-genesis notional shards
(`/3d@192d 2025-09-21`, `/3d@384d 2024-09-02`, `/7d@1792d
2019-01-24`) — expected; their inputs predate `AVAIL_GENESIS =
2026-04-07`.

Applied `tmp/fsck-d1-record.sql` (846 statements) to prod D1 via
`wrangler d1 execute ctbk-gbfs --remote --file …` (31 ms).

Verify against CFW returned `totalMissing = 22`, all
`status = "no_inputs"`, all at the current /5m tick's trailing edge
(e.g. `/1m/10min/2026-07-09T13-{00,10}.parquet`, `/1m/1h/T12.parquet`).
Higher than the spec's "single-digit" estimate but same character —
`totalMissing` at boundary ticks scales with how many rungs have a
boundary at that tick, not with how many shards are backfill-missing.
Zero `error` / `barrier_missing` results — the historical ladder is
dense.

Independent verification via a second Python `--fsck` after fill:
same 3 pre-genesis short-circuits, no other gaps.

## Related

- `specs/avail-v3-strict-cascade.md` — the design bf1db714 landed
- Commit `f1913dc6` — TS-side pure-DAG + N≤960 cap on the CFW
- `configs/pyramids/avail.yaml` — current ladder
