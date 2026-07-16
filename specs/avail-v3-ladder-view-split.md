# avail-v3: ladder-view split (fsck vs GC) + stale-content invalidation

## Incident (2026-07-16, during the LUC re-key rebuild on `e`)

The denorm-v2 re-key rebuild ran in three acts, and the first two
undid each other:

1. `pyramid-cascade -i avail -P overwrite` (block engine) rebuilt all
   derived tiers' max rungs over `[genesis, now)` — 107 min, 14.2 GB,
   0 errors. But the block engine (a) skips the base `/1m` tier
   entirely (`engine.py`: `derived = tiers − base`), (b) only writes
   each tier's largest *`shards`* rung — never `lambda_shards` rungs —
   and (c) registers nothing in D1.
2. `--fsck --fill` (unmerged ladder) then saw 204 gaps — mostly the
   200 historical `/1m@12h` — and rebuilt them from raw WAL (fresh
   denorm). Applied 402 D1 statements. CFW dry-run: dense. 
3. **Within the hour, the `ctbk-avail-cascade` Lambda's hourly
   `gc_sweep` deleted all 200 fresh `/1m@12h` shards** (R2 + D1).
   `gc.py` uses `merge_lambda_shards(config)` — the *merged* ladder,
   where `/1m`'s max rung is `2d`, not `12h`. Its min-cover expected
   set doesn't contain historical `/1m@12h`, and each had a covering
   parent on R2 (`/1m@2d`) → eligible → deleted.

Net effect: the fresh `/1m@12h` data was garbage-collected, while the
covering `/1m@2d` shards — **built 2026-07-12 against the OLD denorm**
— were retained and continued to serve. Prod historical `/1m` queries
were stale for the 166 LUC-churned stations, and the CFW's own
(unmerged-view) converge loop reported `no_inputs=200` every tick.

Two distinct root causes:

- **Ladder-view split**: `fsck`/`pyramid-cascade` planned against the
  raw YAML `shards`; `gc.py`/`lambda_exec` plan against
  `merge_lambda_shards(...)`. Two components disagreed about which
  (tier, rung, period) tuples should exist → one built what the other
  deleted.
- **No content invalidation**: fsck's idempotency is HEAD-based
  ("key exists ⇒ done"). A shard whose *content* is stale (built from
  a superseded input like the pre-re-key denorm) is invisible to it.
  The block engine's `-O` rebuild path doesn't cover lambda rungs, so
  nothing in the toolchain could refresh `/1m@2d` & friends.

## Fix (landed with this spec)

`ctbk pyramid-cascade` grew two fsck flags + one tuning knob:

- `-M, --merged-ladder` — plan fsck/fill against
  `merge_lambda_shards(config)`, the same view GC uses. With `-M`,
  fill materializes the lambda rungs (`/1m@2d`, `/2m@4d`, …) on `e`
  and never builds sub-max rungs the GC would reap.
- `-B, --stale-before <ISO>` — existing shards last-modified before
  the timestamp are treated as missing and rebuilt **in place** (same
  key, overwrite on put ⇒ no read-visibility gap). This is the
  content-invalidation knob: after an upstream input changes (denorm
  re-key), pass the time the new input landed.
- `-w, --fill-workers <N>` — per-rung-batch threadpool size
  (default 3). `/1m@2d`-from-raw holds ~4× the rows of `/1m@12h`
  (~115 M raw rows/shard); `-w 2` keeps peak RSS under the 61 GB box.

Remediation run:

```bash
ctbk pyramid-cascade -c configs/pyramids/avail.yaml \
    -M -B 2026-07-15T23:21:00Z -r 2026-04-07/2026-07-17 \
    --fsck --fill -w 2
# → 148 gaps: 49×/1m@2d + 25×/2m@4d + 13×/3m@8d + ... (stale lambda
#   rungs) + trailing-edge; /1m@12h correctly NOT expected.
# then: (cd gbfs/api && wrangler d1 execute ctbk-gbfs --remote \
#     --file ../../tmp/fsck-d1-record.sql)
```

Because rebuilds are same-key overwrites and every written shard is in
GC's expected set, the fill is GC-race-free and readers see fresh
content as each put lands.

## Fallout / follow-ups (not addressed here)

1. **The CFW `/avail3` endpoint still plans against the unmerged
   ladder.** Its cron was removed at the LE P2 cutover
   (`specs/avail-v3-lambda-cascade.md`) so nothing burns per-tick —
   but the endpoint remains the manual/rollback lever, and a manual
   `?dryRun=1` reports ~200 `no_inputs` for historical `/1m@12h` it
   thinks should exist. Misleading during verification (this incident
   initially read those numbers as real gaps). Either point its
   planner at the merged view or fold the check into `/health` and
   delete the endpoint (P2 step 4 already slates the avail3 code for
   deletion). Also DC the api worker's health config adopted the
   extended ladder per the LE spec's sequencing.
2. **Block engine writes rungs GC will eventually orphan.** Its
   max-`shards`-rung finals (e.g. `/2m@1d`) aren't in the merged
   min-cover wherever a lambda rung covers them; since the block
   engine doesn't register D1 rows, GC can't even see them — they
   linger as unregistered R2 cruft. Options: teach the block engine
   the merged ladder + D1 registration, or accept fsck-fill as the
   only historical-rebuild path and demote the block engine to
   staging/experiments. Decide before the next full rebuild.
3. **D1 registration is fsck-only.** The block engine's 261 finals
   from the re-key run were never registered (readers are D1-index-
   driven ⇒ invisible). The `-M -B` fill re-registers everything in
   min-cover, which papers over this — but any future block-engine
   run has the same hole.
4. **R2 cruft**: ~119 old-schema 3-deep keys, ~1,362 `p*` staging
   partials, plus the unregistered non-cover finals from (2). All
   invisible to readers (D1-driven) and to GC (unregistered). A
   one-shot orphan sweep (list R2 − merged-expected − registered)
   would reclaim ~10-20 GB.
5. **Pinned anchor registry (#161)** removes the biggest *cause* of
   full re-keys (monthly GBFS drift moving anchors), but denorm
   changes will still happen (new stations, same-dock merges); `-M -B`
   is the tool for those.
