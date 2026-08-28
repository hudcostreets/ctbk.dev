# rides-v5: add a `1mo` rung to the calendar tier, so closed months of the current year serve whole

Source: pyrmts session, 2026-08-16, after `/read ctbk`. Answers the gap you documented at the end of the `bin=`-opening work:

> `5mo`/`7mo`/`18mo` over a region cover still 503 with CF's CPU limit… The root cause is upstream and is the same one behind the current-year 21-key problem I found earlier: **the current-year calendar shards aren't sealed**, so any bin whose span reaches into 2025+ falls back to `1d`/`3d`/`7d` tiers.

It isn't upstream. It's the `mo1` tier's shard ladder, and the fix is one config line plus a backfill — no pyrmts change needed.

## Diagnosis

`mo1` is `{ bin: '1mo', shards: ['1y'] }`. A single-rung ladder means the min-cover has exactly one way to represent monthly data: a whole-year shard. `listExpectedShards` therefore expects **nothing at all** from `mo1` for the current, still-open year — not "an unsealed shard", but no shard. Every closed month of 2026 is invisible to the calendar tier and falls through to the day tiers, which is your 1-key → 21-key blowup.

Verified against the newly-pushed pyrmts (`dist 69de58b`) with a ctbk-shaped pyramid, `[2024-01-01, 2026-07-15)`:

```
mo1 ladder ['1y']          → expected: mo1/1y/2024, mo1/1y/2025
                             2026-H1 @1mo query: 0 keys (falls to day tiers)

mo1 ladder ['1mo', '1y']   → expected: mo1/1y/2024, mo1/1y/2025,
                                       mo1/1mo/2026-01 … mo1/1mo/2026-06
                             2026-H1 @1mo query: 6 keys, all tier mo1
```

The trailing-partial-max region of the cover tiles greedily by the largest non-max rung that fits — with a `1mo` rung present, each closed month of the open year gets its own shard the moment it closes.

## Change

```diff
- { name: 'mo1', bin: '1mo', shards: ['1y'] }
+ { name: 'mo1', bin: '1mo', shards: ['1mo', '1y'] }
```

This is the same multi-rung tip pattern awair adopted for its raw tier (`[1mo]` → `[1d, 1mo]`, `specs/done/streaming-tip-writer.md` + `specs/done/js-calendar-same-tier-tiling.md` in pyrmts): a fine rung bounds the open period, the coarse rung consolidates at close.

Ladder validation accepts it — calendar-calendar pairs divide in months, and `12 % 1 == 0`.

## What happens at year close

`mo1/1y/2026` becomes buildable on 2027-01-01 from the twelve `1mo` shards. That consolidation is **pure concat, no re-aggregation** (same tier, identical bins), and it is calendar-correct in both languages as of this week:

- Python: `pyrmts_engine.consolidate.tile_from_existing` walks calendar rungs via `ceil_to_span`/`add_span` (`specs/done/calendar-rung-consolidation.md`).
- TS: `tileFromExisting` in `pyrmts` (`specs/done/js-calendar-same-tier-tiling.md`), if you ever want the CFW cascade to own it rather than Batch.

Both are pinned by a cross-impl parity fixture, so the year-close tiling is the same walk on either side.

## Expected effect on the 503s

Your measurement was `11 keys × 60 terms = 660` slipping under both guards. With closed 2026 months served from `mo1`, a `5mo`/`7mo`/`18mo` bin whose span reaches into the open year plans as whole `1mo` atoms instead of `1d`/`3d`/`7d` residue — you predicted "`5mo` plans as ~5 whole `1mo` atoms and becomes as cheap as `4mo`", and that's what this buys. Worth re-measuring the guard thresholds afterward: the `keys × cover-terms` product should drop enough that you may be able to tighten them without catching the Home query.

## Rollout

1. Flip the ladder in the rides-v5 pyramid config.
2. Backfill the `1mo` rung for closed months of 2026 (uncapped fill, per your range-cap lesson — a month-end cap leaves coarse-rung holes).
3. Re-run the region-cover widths that 503'd; re-measure the guard thresholds.
4. The `1y` rung is unchanged for 2013–2025, so no historical rebuild.

One caution from your own notes: registration is three-store (R2 + D1 `pyramid_shards` + `manifest.jsonl`). The new rung's shards need to land in all three or the fill will keep rebuilding them.

## Not in scope

- Any pyrmts change. This is config + backfill.
- `maxAtoms` tuning — your finding that atom count isn't a cost model (prod Home = 223 atoms, serves in ~6s) is right, and is recorded on the pyrmts side too. `keys × cover-terms` remains the load-bearing guard.
