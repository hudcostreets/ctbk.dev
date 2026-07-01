# CFW cascade: OOM fix for coarse-tier steady-state writes

Follow-on to `dbebb0b7` (avail-v3 cascade: extend to all 15 tiers).
That commit made every tier's ladder walked per-tick, but its
smallest-non-/1m-rung path sources from `/1m@X` shards, which OOMs the
Worker on coarse tiers.

**Status**: implemented across `cefb66f7` (streaming + prev-tier picker)
and `bd08ef64` (R2 body streaming). Pre-deploy checklist below.

## Problem

`writeShard`'s non-/1m smallest-rung branch calls `pickOneMSourceRung`
to pick the largest `/1m` rung that divides the target shard duration,
then reads N × that `/1m` shard via `readShard` (loads full parquet
into a JS `AvailV3Row[]` array).

Working-set estimates for smallest-rung firings (3800 s2_cells, ~64
bytes/row JS overhead):

| Tier smallest | Source | N | Rows | Est. MB |
|---|---|---|---|---|
| `/2m@10min` | `/1m@10min` | 1 | 38K | 2 |
| `/3m@15min` | `/1m@5min × 3` | 3 | 57K | 4 |
| `/5m@15min` | `/1m@5min × 3` | 3 | 57K | 4 |
| `/10m@30min` | `/1m@30min` | 1 | 114K | 7 |
| `/15m@1h` | `/1m@1h` | 1 | 228K | 15 |
| `/30m@2h` | `/1m@1h × 2` | 2 | 456K | 29 |
| `/1h@3h` | `/1m@3h` | 1 | 684K | 44 |
| `/2h@6h` | `/1m@3h × 2` | 2 | 1.4M | 88 |
| `/3h@12h` | `/1m@12h` | 1 | 2.7M | 175 |
| **`/6h@1d`** | `/1m@1d` | 1 | 5.5M | **350** |
| **`/12h@2d`** | `/1m@1d × 2` | 2 | 10.9M | **700** |
| **`/1d@3d`** | `/1m@1d × 3` | 3 | 16.4M | **1050** |
| **`/3d@15d`** | `/1m@1d × 15` | 15 | 82M | **5253** |
| **`/7d@35d`** | `/1m@1d × 35` | 35 | 191M | **12,257** |

Worker memory ceiling is 128 MB (free tier) / 512 MB (paid, no
explicit `limits.memory` override in `wrangler.toml`). Everything from
`/6h@1d` down will OOM at boundary close. `/6h@1d` fires daily —
guaranteed daily crashes in prod.

## Design: prev-tier chain sourcing

Mirror `ctbk/pyramid_cascade/materialize.py:plan_source_cover` — the
Python-side heterogeneous planner already proven on the fsck fill.

Instead of always rooting non-/1m smallest rungs at `/1m@X`, walk the
LARGER-BIN tier ladders first:

    priority = [
      target-tier smaller rungs (largest first),
      prev-tier max rung, then smaller rungs,
      prev-prev-tier max rung, ...,
      /1m fallback,
    ]

For each priority pair `(tier, rung)` in order, check if:

1. `rung` duration divides `target_shard_dur`
2. `rung`-aligned periods span the target period exactly
3. All required source shards exist on R2 (D1 shard_index lookup)

First match wins. For `/6h@1d`, the priority is:

- `/6h` smaller rungs (none exist; `/6h@1d` IS the smallest)
- `/3h@2d`: doesn't divide 1d
- `/3h@12h`: divides 1d cleanly → 2 × `/3h@12h` shards. Just written
  this tick by the /3h iteration.
- Rows/shard: 12h × 20 (3h-bins) × 3800 = ~900K rows × 2 shards
- **Est. memory: 115 MB** (vs 350 MB via `/1m@1d`)

For `/7d@35d` (the worst case):

- Walk down to `/6h@5d × 7`: 5d × 4 (6h bins) × 3800 = ~76K rows × 7
  shards = **~530K rows total = ~34 MB** (vs 12 GB)

**Reduction: 3-300× across the ladder.**

## Implementation

Port `enumerate_source_candidates` from
`ctbk/pyramid_cascade/materialize.py`:

    // gbfs/cascade/src/avail3/cascade.ts
    function pickSourceRung(
      tier: string,
      shardDurMin: number,
      shardIndex: ShardIndex,  // D1-backed, checked in memory
    ): { sourceTier: string; sourceRungDur: Duration; sourceRungMin: number; n: number } | null {
      const tierIdx = TIERS.indexOf(tier);
      // 1. Within-target-tier strictly smaller rungs, largest-first
      const targetRungs = LADDERS[tier]!;
      for (let i = targetRungs.length - 1; i >= 0; i--) {
        const r = targetRungs[i]!;
        const rm = durationToMin(r);
        if (rm >= shardDurMin) continue;
        if (shardDurMin % rm !== 0) continue;
        // For steady-state: the just-written prev-rung of THIS tier
        // is guaranteed to exist (sequential loop). Prefer that.
        return { sourceTier: tier, sourceRungDur: r, sourceRungMin: rm, n: shardDurMin / rm };
      }
      // 2. Previous tiers (coarsest-to-finest bin), each rung largest-first
      for (let prev = tierIdx - 1; prev >= 0; prev--) {
        const pTier = TIERS[prev]!;
        const pRungs = LADDERS[pTier]!;
        for (let j = pRungs.length - 1; j >= 0; j--) {
          const r = pRungs[j]!;
          const rm = durationToMin(r);
          if (rm > shardDurMin) continue;
          if (shardDurMin % rm !== 0) continue;
          // Existence check via D1 (or presume-exists for same-tick writes).
          if (!shardIndex.hasAllShards(pTier, r, /*period range*/)) continue;
          return { sourceTier: pTier, sourceRungDur: r, sourceRungMin: rm, n: shardDurMin / rm };
        }
      }
      // 3. /1m fallback — only fires for edge cases (missing prev-tier).
      const one_m = pickOneMSourceRung(shardDurMin);
      return { sourceTier: '1m', sourceRungDur: one_m.sourceRungDur, sourceRungMin: one_m.sourceRungMin, n: shardDurMin / one_m.sourceRungMin };
    }

For steady-state CFW: within-tier prev-rung + prev-tier chain works
without external state — same-tick iteration order guarantees
prerequisites are on R2.

## Streaming reads (optional, later)

For the RARE cases where even prev-tier chain doesn't fit (edge cases
after major backfill gaps), fall back to streaming parquet reads:

- Use `hyparquet`'s low-level API to iterate row-groups instead of
  loading the full file
- Accumulate per-bucket aggregation state in a `Map<key, bucket>` as
  we go
- Never hold more than one row-group in memory (~10K rows)

Not needed for the common case if prev-tier chain lands. Defer as a
follow-on if any real shard still OOMs.

## Testing

1. Update `gbfs/cascade/src/avail3/cascade.test.ts` — add cases:
   - `/6h@1d` sources from `/3h@12h × 2` (not `/1m@1d`)
   - `/7d@35d` walks down to `/6h@5d × 7`
   - `/1m` fallback triggers only when nothing else divides
2. Local `wrangler dev --remote --test-scheduled` at a synthesized
   tick that fires `/12h@2d` — verify memory usage stays under
   100 MB via `console.log(process.memoryUsage())` (or similar).
3. Deploy to `ctbk-gbfs-cascade-dev` for a week; verify all rung
   fires complete successfully.

## Deployment sequence

1. ~~Land this fix as a follow-on commit on top of `dbebb0b7`~~ — done
   in `cefb66f7` (streaming reader + prev-tier picker) and `bd08ef64`
   (R2 body streaming via ranged gets, drop arrayBuffer).
2. **Macbook-side pre-push decision**: pin `hyparquet` to the
   `runsascoded/hyparquet` fork's dist-branch SHA if we want the
   `columnChunkAggregation` opt-in (commit `42624b6` on the fork) —
   coalesces per-column-chunk ranges under a `columns:` projection,
   reduces sub-request count on R2 reads. Bump
   `gbfs/cascade/package.json` `hyparquet: ^1.25.6` → git+SHA of the
   fork's most recent dist commit.
3. Push both commits (plus the 27 other unpushed ones) — GHA runs
   `wrangler deploy` for ctbk-gbfs-cascade.
4. First-hour monitoring: `wrangler tail ctbk-gbfs-cascade` for any
   `Error: Exceeded memory limit` / `Error: Too many subrequests`
   messages.
5. First-day check: rerun `ctbk pyramid-cascade --fsck` on EC2 —
   expect 0 new missing shards (post the 6 known-no-data ones).
6. Weekly cadence: fsck as a safety net for anything the CFW cron
   dropped.

## As-built peak heap (post `bd08ef64`)

Coarse-tier smallest rungs, sourced via `pickSourceForShard`
(picks coarsest available prev-tier rung):

| Rung target | Picked source (typical) | Peak decoded rows | Peak heap |
|---|---|---|---|
| `/6h@1d` | `/3h@12h × 2` | ~30K rows | ~5 MB |
| `/12h@2d` | `/6h@1d × 2` | ~4K rows | ~1 MB |
| `/1d@3d` | `/6h@1d × 3` | ~4K rows | ~1 MB |
| `/3d@15d` | `/1d@15d × 1` | ~57K rows | ~10 MB |
| `/7d@35d` | `/6h@5d × 7` | ~76K rows | ~15 MB |

`/1m@X` fallback (when no coarser prev-tier rung is populated on R2)
still exists for edge cases — its peak is bounded by streaming
row-group decode (~400 KB per row group in memory at a time) plus
buffered R2 byte ranges (<1 MB per column-chunk fetch). Well under
128 MB even for the worst case.
