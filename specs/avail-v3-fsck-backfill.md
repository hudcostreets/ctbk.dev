# avail-v3 fsck / backfill

One-shot tool to fill historical (tier, shard_dur, period) gaps in
the avail-v3 pyramid. Runs after `gbfs/cascade` is deployed with the
multi-tier ladders (commit `dbebb0b7`). Idempotent — re-runs skip
already-present shards via ShardIndex lookup.

Pairs with `~/c/pyrmts/specs/gap-discovery.md` which provides the
`list_missing_shards` primitive this tool drives off.

## Scope

The new cascade only writes shards forward from deploy time. Every
declared (tier, shard_dur) in `configs/pyramids/avail.yaml` has
historical periods (back to 2026-04-08, the earliest GBFS data) that
will *never* be filled by the cron writer. The fsck tool walks every
declared period in the configured backfill range and fills any that
the ShardIndex doesn't already know about.

## Inputs

- `configs/pyramids/avail.yaml` — declares the 15-tier ladder + key
  template.
- D1 `pyramid_shards` (`ShardIndex`) — what's already recorded.
- R2 `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet` — raw GBFS
  minute parquets (the base-tier source).
- A `--range` arg: `[from, to]` to bound the fsck. Default = full
  history (`[2026-04-08, now)`).

## Algorithm

```
1. Call pyrmts list_missing_shards(avail-v3 pyramid, ShardIndex, range)
   → list of ExpectedShard

2. Sort by dependency:
   - tier_index ascending (base /1m first)
   - shard_dur ascending within tier (5min before 10min before ...)
   - period_start ascending within (tier, shard_dur)

3. For each missing shard:
   - If (tier == '1m' AND shard_dur == smallest /1m rung):
     Read from raw GBFS minute parquets (1m@1m via SRC_PREFIX),
     LUC-expand, transform to /1m@<smallest> rows, write parquet,
     record in ShardIndex.

   - Else if (tier == '1m'):
     Read N × /1m@prev-rung shards (already in ShardIndex this run
     or pre-existing), mergeRows, write, record.

   - Else if (non-/1m tier smallest rung):
     Pick /1m source-rung via pickOneMSourceRung (largest /1m rung
     dividing shard_dur). Read N × /1m@source-rung shards, re-bin to
     tier_bin via mergeRows(_, binMs=tierBinMin*60_000), write,
     record.

   - Else (non-/1m tier, coarser rung):
     Read N × same-tier prev-rung shards, mergeRows, write, record.

4. Verify with a second list_missing_shards pass; assert empty.
```

The algorithm mirrors what `gbfs/cascade/src/avail3/cascade.ts`
already does per-tick — same source-readers, same monoid combines —
but driven from "fill these gaps" instead of "this tick's
boundaries-closing rungs."

## CLI

Add a `--fsck` mode to the existing `ctbk pyramid-cascade` CLI:

```bash
ctbk pyramid-cascade --fsck -c configs/pyramids/avail.yaml -i avail \
    --range 2026-04-08/2026-07-01 \
    [-n]           # dry-run: list missing, don't fill
    [-j 4]         # parallel workers (default 1)
```

`--fsck` short-circuits the normal cascade flow:
- Skips the "block planner" + per-block `cascade_block` engine path
- Instead calls `list_missing_shards` once, then fills each shard
  serially (or in parallel within tier — same-tier coarser rungs
  must wait for their prev rung, but distinct tiers can parallel).

## Implementation phases

### Phase A: gap discovery wired up

Add a `--fsck` flag to `ctbk/pyramid_cascade/cli.py`. When set, call
`pyrmts.list_missing_shards`, print the list, exit. No fills yet.

This validates the pyrmts gap-discovery primitive against ctbk's
actual ladder + state. Cheap to run.

### Phase B: serial fill

`--fsck` + writes-enabled: iterate the gap list in dependency order,
call existing materializer functions (`build_1m_hour_table` for
/1m smallest rung; cascade engine's `_build_tier_shard` for coarser
rungs) one per missing entry.

Materializers stay where they are in `ctbk/pyramid_cascade/`. The
fsck loop is a thin orchestrator on top.

### Phase C: parallel fill

Parallelize across (tier, shard_dur) entries that don't share a
dependency. ProcessPool, similar to the existing block-cascade
engine. Save for after Phase B proves correct.

## Run plan (on `e`)

Backfill is heavy compute (read 80+ days × 1440 raw files for /1m
smallest rungs alone). Per memory rule (`no_heavy_local_compute`),
runs on `e`, not laptop.

Estimate (very rough):
- /1m smallest rung (5min): ~80 days × 288 shards = 23k shards.
  Each reads 5 raw files. Total ~115k raw reads.
- All /1m rungs combined: similar order, building up.
- Non-/1m tiers smallest rungs: a few hundred to a few thousand
  shards depending on tier.
- Total fill volume: ~50k-100k shards. R2 PUTs at $4.50/M.

Wall-clock with `-j 4` ProcessPool: probably ~hours, not days.

## Verification

Post-run:
- `pyramid-status.py avail` shows non-empty counts for every
  declared (tier, shard_dur).
- `list_missing_shards` returns empty over the backfill range.
- Spot-check a few stations across the timeline — Grove St 6/28
  early-morning empty pattern shows up correctly via /api/avail-v3
  for the full ladder.

## Cross-reference

- `~/c/pyrmts/specs/gap-discovery.md` — pyrmts primitive.
- `specs/avail-v3-ladder-migration.md` — umbrella; this is the
  "backfill" piece referenced there.
- `gbfs/cascade/src/avail3/cascade.ts` — the steady-state writer
  whose mechanics this tool reuses.
