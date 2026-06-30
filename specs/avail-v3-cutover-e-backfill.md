# avail-v3 cutover: `e`-side fsck backfill runbook

What `e` does as part of the avail-v3 unified-shard-ladder cutover.
Laptop already ran steps 1-5 (D1 ALTER, cascade + api deploy, D1
canonical-row DELETE, push). This spec covers what `e` does next.

## Pre-flight (verify)

```bash
# Should be at c387d60e or later. (push was cfe2943e..c387d60e.)
grhh                                # align WT to pushed HEAD
git log --oneline -3
# expect:
#   c387d60e cutover: simplify d1-update to clean DELETE; fsck emits for 'exists' too
#   12c1b3dc pyramid-cascade --fsck --fill: per-gap materialization (Phase B)
#   9774ef13 pyrmts bump → gap-discovery (...)

uv sync                             # refresh pyrmts dep + ctbk install

# Sanity check: fsck discovery should print expected ≈ 2562 × N days,
# existing ≈ ~5k, missing = the rest. Adjust `-r` start date if newer
# raw GBFS data is available.
ctbk pyramid-cascade --fsck -c configs/pyramids/avail.yaml \
    -r 2026-04-08/$(date -u +%Y-%m-%d) | head -30
```

If the gap counts look reasonable, proceed.

## Run the fill

```bash
# Heavy: 80+ days of raw GBFS data → ~tens-of-thousands of shards
# materialized across all 15 tier ladders. Wall-clock probably hours.
# Logs to stdout; emits tmp/fsck-d1-record.sql at the end.
ctbk pyramid-cascade --fsck --fill -c configs/pyramids/avail.yaml \
    -r 2026-04-08/$(date -u +%Y-%m-%d) \
    2>&1 | tee tmp/fsck-fill-$(date -u +%Y%m%dT%H%M).log
```

CLI options worth knowing:
- `-L N` / `--fill-limit N`: stop after N gaps (smoke / staged).
- No `--ingester` flag needed (fsck mode skips the engine).
- No `--engine` / `--workers`: fsck currently fills serially. Future
  Phase C adds ProcessPool parallelism per the spec.

Per-shard log format (every ~20 gaps + on error/empty):
```
  [N/M] /tier@shard YYYY-MM-DD → status [(R rows, B bytes)]
```

Status legend:
- `wrote` — built + uploaded.
- `exists` — R2 path already there (from earlier r2-copy); HEAD-skipped.
- `no_inputs` — source shards/raw all missing; can't build. Investigate.
- `empty` — sources present but no rows fell in the period. Rare; OK.
- `error` — exception during read/build/write. Logged with the
  exception repr; check the log + decide whether to retry.

End-of-run summary:
```
fill summary: wrote=X, exists=Y, ...
emitted N shard INSERTs (2N statements) → tmp/fsck-d1-record.sql
```

## Apply the D1 INSERT batch

```bash
(cd gbfs/api && wrangler d1 execute ctbk-gbfs --remote \
    --file ../../tmp/fsck-d1-record.sql)
```

This populates `pyramid_shards` + `pyramid_watermarks` for every
materialized (and `exists`) shard. After this completes, the deployed
api worker can find the historical shards via its planner walk.

## Verify

```bash
# Should report 0 missing (or very close — handful for periods that
# closed during the fill run).
ctbk pyramid-cascade --fsck -c configs/pyramids/avail.yaml \
    -r 2026-04-08/$(date -u +%Y-%m-%d) | grep "missing:"

# Spot-check via pyramid-status (the script handles cadence vs shard_dur
# auto-detect post-ALTER).
pyramid-status.py avail | head -20
```

Hand off to laptop for steps 9-10 (CIC /health + Grove St plateau
check; R2 DELETE legacy via `scripts/avail-v3-rename.py r2-delete`).

## Failure modes

- **OOM** on the per-shard build (Polars peak during `_build_tier_shard`):
  the existing engine uses `PIVOT_CHUNKS` to bound working set per
  block. The fsck per-shard path inherits the chunking but operates
  on whatever the source shards' size is. If a particular shard
  OOMs, file an issue + skip with `--fill-limit` until it.
- **R2 transient 5xx**: `materialize.py` doesn't retry per shard
  today. Re-run; idempotent (HEAD-skip already-written).
- **D1 INSERT batch too large for wrangler**: split
  `tmp/fsck-d1-record.sql` into chunks of ~1000 statements + apply
  each. (D1's `--file` cap is on the order of MB; ~50k inserts is
  probably fine. Try first; split if it errors.)

## When this is done

- Laptop reruns `--fsck` (no `--fill`); expects 0 gaps.
- Laptop verifies Grove St plateau is gone (the original bug that
  motivated this cutover).
- Laptop runs `scripts/avail-v3-rename.py r2-delete` to GC the legacy
  R2 paths now superseded by the new layout.

## Cross-reference

- `specs/avail-v3-fsck-backfill.md` — the design behind fsck.
- `specs/avail-v3-storage-rename.md` — the broader cutover doc.
- `gbfs/cascade/src/avail3/cascade.ts` — the steady-state CFW writer
  whose mechanics fsck mirrors.
- `ctbk/pyramid_cascade/materialize.py` — the per-shard fill driver.
