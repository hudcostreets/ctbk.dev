# avail-v3 strict tier-by-tier cascade

## Status

Python side landed as `bf1db714`. TS-side (`gbfs/cascade/src/avail3/cascade.ts`) still on the old heterogeneous-cover design — see §TS-side follow-up.

Supersedes:
- `specs/avail-v3-fsck-heterogeneous-source-cover.md`
- `specs/avail-v3-fsck-recursive-intermediates.md`

## The incident (why we're here)

Killed fill on 2026-07-08 wrote 61 shards over ~7h before we noticed hundreds of `MISSING` reads in the log. Investigation traced it to a specific pattern:

- `plan_source_cover` did a **greedy heterogeneous cover** — pick largest-fitting rung at each position across ALL prior tiers + within-target smaller rungs. Step 1: picks from `key_set`. Step 2: recursively materialize small missing intermediates. Step 3: emit `/1m@X` picks **without checking `key_set`**, hoping they exist.
- For coarse pre-genesis-notional shards (`/6h@128d 2026-01-27` etc.) whose eff_gap didn't cleanly tile the largest existing prior-tier shards, Step 1 left an unaligned tail. Step 2 aborted (too many candidates: `MAX_CANDIDATE_INPUTS=60`). Step 3 emitted 232 `/1m@10min` picks — none of which had ever been written (raw ingest only wrote `/1m@1d`). All returned 404, were silently skipped, and the shard built with a tail-of-eff_gap-worth of data missing.
- 9 shards fired Step 3; 8 were successfully written before we killed. Contamination propagates: any coarser tier that (under the old heterogeneous algo) picked from a Step 3 shard inherited the missing data.

The old algorithm was correctness-fragile — it silently produced wrong output when the greedy cover left holes AND the fallback picks didn't exist. The clever heterogeneous cover was chasing a marginal read-cost optimization that isn't worth the loss-of-invariant.

## Design

**Strict tier-by-tier cascade.** Each target-tier gap sources from exactly one lower tier's shard set.

### Core invariants

1. **Unique source tier per target.** For target tier `T` (except `/1m`), `source_tier_for(T)` = the largest tier `T'` with `bin(T') < bin(T)` AND `bin(T) % bin(T') == 0`. Bin-divisibility guarantees `_preaggregate_to_tier_bin`'s floor-then-groupby is exact — misaligned bins send half a source bucket into the wrong target bucket.

   Concrete for the current ladder:
   ```
   /1m  → raw WAL (avail_ingest_1m)
   /2m  → /1m           /3m  → /1m           /5m  → /1m
   /10m → /5m           /15m → /5m           /30m → /15m
   /1h  → /30m          /2h  → /1h           /3h  → /1h
   /6h  → /3h           /12h → /6h           /1d  → /12h
   /3d  → /1d           /7d  → /1d
   ```
   Note `/7d`'s source is `/1d` (not `/3d`) — `7d % 3d ≠ 0`. Same reason `/2h`, `/5m` have no descendants in this ladder.

2. **Source tier must be complete-in-range before target.** Enforced by `fsck.fill_gaps` sorting missing shards by `(tier_idx, shard_dur, period_start)` ascending and processing tier layers strictly before advancing.

3. **Uncovered ⇒ raise.** `source_long_for_gap` treats any uncovered segment as a `RuntimeError('strict-cascade invariant violation')` — no silent fallback.

### Source picks: the outer expected set

Naive approach: for target `T`'s gap `G`, compute source-tier's min-cover of `G.eff_gap` via `pyrmts._cover_for_tier`. Bug: source-tier's outer fsck cover for the whole fsck range picks different tiles than a fresh eff_gap-only cover. E.g. `/7d@28d 2026-06-04`'s eff_gap needs 28 days of `/1d`; fresh cover asks for `/1d@16d + /1d@8d + /1d@4d` — shards never built. Outer `/1d` fsck cover picked `/1d@32d 2026-06-04` (fits the outer range), which overshoots our target by 4 days.

**Fix:** thread `expected_by_tier: dict[tier_name, list[ExpectedShard]]` (from the outer `list_expected_shards`) through `discover_gaps` → `fill_gaps` → `materialize_shard` → `source_long_for_gap`. `plan_source_cover_single_tier` filters the source tier's outer expected set to **shards intersecting eff_gap** — including shards that pre-extend before or overshoot after.

**Overshoot is safe:**
- `_preaggregate_to_tier_bin` floors dt to target bin (source rows outside eff_gap contribute to buckets whose target dt falls outside `[seg_from, seg_to)`).
- `_build_tier_shard`'s `dt < seg_to` (and `dt >= seg_from`) filter drops those buckets entirely.
- Pre-genesis source rows contribute zero (source shards for pre-genesis periods are empty by the same clip logic upstream).

### Pre-genesis clipping

`AVAIL_GENESIS = 2026-04-07 UTC` (first raw `/1m` WAL). Coarse trailing max-shards have notional periods extending arbitrarily far into the past. `source_long_for_gap` clips `eff_gap.period_start = max(gap.period_start, AVAIL_GENESIS)`. If `gap.period_end ≤ AVAIL_GENESIS`, `materialize_shard` short-circuits to `no_inputs` immediately (avoids astronomical wall-clock scanning empty periods).

The 5 fsck-expected shards that are perpetually "missing" (`/3d@192d 2025-09-21`, `/3d@384d 2024-09-02`, `/3d@1536d 2020-06-19`, `/7d@1792d 2019-01-24`, `/7d@3584d 2009-04-02`) are pre-genesis short-circuits — expected forever, no work to do.

### What we deleted

`materialize.py` went 820 → 606 lines. Removed:
- `enumerate_source_candidates` + `SourceCandidate` dataclass — dead code
- `pick_one_m_source_rung`, `_all_keys_exist` — dead
- `_priority_rung_pairs` cross-tier iteration
- `_one_m_picks_for_segment` `/1m` fallback (the silent-corruption path)
- `MAX_CANDIDATE_INPUTS`, `MAX_RECURSION_DEPTH` — no more recursion
- `plan_source_cover` heterogeneous → replaced by `plan_source_cover_single_tier`
- `recursion_depth` / `sub_results` params from `materialize_shard` and downstream

## Rebuild + verification

- 8 R2 objects deleted (the confirmed step3-firers).
- `--fsck --fill` rebuilt them + the 9 not-yet-processed shards.
- Two live-fire debugging iterations:
  1. **Original strict-single-tier cover with alignment-strict picks**: rejected legit closed-history tiles (e.g. `/1h@64d 2026-04-01` for target eff_gap `[2026-04-07, ...)`). Fixed by using `_cover_for_tier` directly.
  2. **eff_gap-only fresh cover**: asked for smaller source tiles that outer fsck never built (`/7d@28d` case). Fixed by threading `expected_by_tier` through.
- Final steady state: 5 perpetual pre-genesis short-circuits, everything else materialized.

### Per-shard walltime

Old heterogeneous with valid greedy: ~800s per coarse shard (many small reads, high concurrency-bounded overhead).
Strict cascade with single-tier reads: 8-500s depending on source-shard size (dominated by one big R2 read + Polars build).

Some concrete comparisons (killed fill vs. re-fill):
- `/6h@128d 2026-01-27`: killed 974s → rebuilt 114s
- `/12h@128d 2026-01-27`: killed pre-write → rebuilt 61s
- `/1d@128d 2026-01-27`: not in killed → 35s
- `/7d@28d 2026-06-04`: not in killed → 9s

## D1 recovery

`emit_d1_insert_sql` overwrites `tmp/fsck-d1-record.sql` per fill run — each run only has THIS run's writes. To sync D1 after multi-run fill: `scripts/reregister-avail-v3-r2.py` lists R2 and emits INSERT ON CONFLICT DO UPDATE for every avail-v3 shard. Latest snapshot: `tmp/reregister-avail-v3.sql` (11,668 shards + 111 watermarks).

Applied via `(cd gbfs/api && wrangler d1 execute ctbk-gbfs --remote --file tmp/reregister-avail-v3.sql)`.

## TS-side follow-up

`gbfs/cascade/src/avail3/cascade.ts` has the same heterogeneous-cover design flaw (see `priorityRungPairs` — 1) within-target-tier smaller rungs largest-first, 2) previous tiers coarsest-bin-first, largest-rung-first; caller HEAD-checks candidates and picks first fully-populated).

**Not urgent** — the CFW's per-5min tick has a bounded budget and the cascade only advances the trailing edge (small delta from last checkpoint). In practice `priorityRungPairs` picks from the immediately-prev rung because that's what exists most recently. The failure mode only bites broad backfills (Python side), not steady-state ticks.

**When we do rework it:**

1. Replace `priorityRungPairs(targetTier, shardDurMin)` with `sourceTier(targetTier)` returning a single tier name — mirror Python's `source_tier_for`. Bin-divisibility rule identical.

2. Replace the multi-candidate loop in `writeShard` with a single `sourceExpected` computation:
   - Enumerate the source tier's expected shards over the range the CFW is materializing (probably `[watermark, now)`).
   - Filter to shards intersecting the target gap's eff_gap.
   - HEAD-check against R2 / query D1.
   - Any uncovered ⇒ throw / return `pending` status. The CFW should never emit source picks it hasn't verified exist.

3. Remove the `/1m@X` fallback branch — the CFW writes `/1m` at all rungs on every tick, so this only exists for pathological "raw WAL just arrived, no prior tier exists" cases which shouldn't happen in steady state.

4. Add `expected_by_tier` threading similar to Python side — the CFW's `converge()` primitive already knows its target range; enumerate source-tier expected shards once per tick.

5. Update `pyrmts-cfw`'s `walkForShard()` reader path — currently reads with a cursor-aware walk (largest-first, fall back to smaller). Under strict cascade, walkForShard should only serve up cover from the queried tier, no cross-tier fallbacks. (Actually — the api-worker read path is separate from the cascade write path; check if we want to unify.)

6. Add a bin-divisibility unit test that walks every pair of tiers and asserts `sourceTier(T).bin | T.bin`.

7. Deprecate `LADDERS[targetTier]`'s within-target-tier "smaller rungs" — those exist on R2 (writable, readable) but the cascade never sources from them under strict semantics. The api-worker reader can still use them for queries. Ladder YAML unchanged.

8. Consider surfacing a `--strict` flag on `ctbk pyramid-cascade` and its TS equivalent — flip default once we've verified no regressions. Rollback path if strict cascade shows a corner-case bug in prod: fall back to old heterogeneous by flipping the flag. (Or don't — this is the correct algorithm and heterogeneous had the bug; hard cutover is fine.)

## Anti-goals

- **Do NOT add same-tier smaller-rung reads back** as an "optimization". It saves at most ~2× read cost per step and breaks the "each tier is a pure function of the previous" invariant that makes correctness reasoning trivial.
- **Do NOT allow raw WAL fallback for target tiers ≥ /2m**. Only `/1m` reads raw. Everything else cascades. If your target's source tier isn't populated, that's a bug in fill ordering, not a signal to reach for raw.
- **Do NOT expand the recursion depth** to make the heterogeneous algorithm "work harder". Strict cascade with topo-sorted fill is provably correct in one pass.

## Cross-references

- Commit: `bf1db714 pyramid-cascade: strict tier-by-tier cascade materializer`
- Related decisions in `~/c/pyrmts/`: `specs/unified-shard-ladder.md` (why the ladder has multiple shard-durs per tier), `python/pyrmts/src/pyrmts/gap_discovery.py` (`_cover_for_tier` — the tile enumeration we now use directly).
- Prior specs superseded: `avail-v3-fsck-heterogeneous-source-cover.md`, `avail-v3-fsck-recursive-intermediates.md`. Both had correct-sounding designs that turned out to admit silent-corruption paths under adversarial ladder configurations.
