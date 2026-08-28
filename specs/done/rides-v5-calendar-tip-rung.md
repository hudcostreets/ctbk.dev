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

---

## Status: done (2026-08-28, ctbk)

Diagnosis confirmed exactly. Implemented as specified — config + backfill, no pyrmts change.

| Step | Result |
| --- | --- |
| 1. Flip the ladder | `5fbc694e`. `gbfs/api`'s `V5_TIERS` already carried it (`c7ebf897`); the R2 `config.yaml` objects the Batch job actually reads were republished, single-line diff on both anchors, no other drift. |
| 2. Backfill | 7 shards per anchor (2026-01…2026-07), ~15.5–16.5k rows each. Uncapped, as specified. |
| 3. Re-measure | Below. |
| 4. No historical rebuild | Confirmed — `1y` rungs for 2013–2025 untouched. |

Registration landed in all three stores (R2 / D1 `pyramid_shards` / `manifest.jsonl`), plus RG-manifest rows (8–9 RGs per shard).

### Correctness

Each new shard was cross-checked against the `1d`-tier path it replaces, over the union of the three region covers:

```
month     1mo-tier      1d-tier   count   duration
2026-01  1,826,936    1,826,936    ==       ==
2026-02  1,223,434    1,223,434    ==       ==
2026-03  2,967,804    2,967,804    ==       ==
2026-04  3,891,820    3,891,820    ==       ==
2026-05  4,733,297    4,733,297    ==       ==
2026-06  5,427,576    5,427,576    ==       ==
2026-07  5,032,474    5,032,474    ==       ==
```

### Effect on the 503s

`5mo`/`7mo`/`18mo` all serve now. Full-history NYC-cover sweep (prod, `cell_budget=16`):

| bin | code | secs | keys | atoms | tiers |
| --- | --- | --- | --- | --- | --- |
| 1mo | 200 | 1.5 | **10** | 158 | `1mo` |
| 2mo | 200 | 1.3 | 12 | 89 | `1d,1mo,2mo` |
| 3mo | 200 | 1.4 | 13 | 64 | `1d,1mo,3mo` |
| 4mo | **413** | — | 63 | — | — |
| 5mo | 200 | 12.6 | 61 | 94 | `1d,1mo,2mo,3mo` |
| 6mo | 200 | 1.3 | 11 | 39 | `1d,1mo,6mo` |
| 7mo | 200 | 9.9 | 49 | 82 | `1d,1mo,2mo,3mo,6mo` |
| 18mo | 200 | 1.9 | 18 | 32 | `1d,1mo,1y,6mo` |
| 2y | 200 | 1.2 | 12 | 29 | `1d,1mo,1y,6mo` |

The headline is `1mo` — the only width the FE issues. It now plans **one `1mo`-tier segment across the whole 13-year history, 10 keys**, where 2026 previously fell to the day tiers. The `1d` tier still appears in most other rows: that is the un-closed August tip, by design.

`4mo` 413s at `keys×cells 1008 > 1000` (63 shards × 16 terms). Not a regression — isolating it shows pre-2026 alone is 55 keys and 2026 now adds 8, where day tiers previously added ~21. So `4mo` was already ~76 keys, i.e. already past the 62-shard ceiling; this moved it to 63, one shard short.

### Guard thresholds: not retuned, deliberately

You predicted the product would drop enough to allow tightening. It did — Home is now 10×16 = 160 against a 1000 limit, ~6× headroom. But tightening toward Home would cut off `5mo`/`7mo`, which currently succeed at 10–13s, and loosening to ~1100 would admit `4mo` at a similar cost. Both are defensible and neither is implied by this work, so the threshold is unchanged pending a call on whether double-digit-second widths should serve at all.

### Found while doing this: `rides-v5-extend`'s `--max-missing` is wrong

`max_missing` divides by the sources *that fill reads*, not by all history. Under `-f` that is the gap set, so this backfill read 8 source months and failed at `1/8 = 0.125 > 0.01` — the cadence's "1/~160 months ≈ 0.006" assumed the wrong denominator.

The engine writes and registers before the guard fires, so this fill's outputs all landed and only the exit code was nonzero. But `extend` raises on that rc, so a failing fill skips everything after it: the relic sweep and the RG-manifest backfill. Unswept August relics found today (`start/1h/1d/2026-08-19`, `1h/4d/2026-08-15`, `1h/8d/2026-08-07`) date the last such abort.

Documented at both sites (`e6fd7a40`) but not fixed: no fraction expresses "only months at/after the current one may be absent" when the gap set can be a single open month. The check belongs in `pyramid-cascade` discovery, which can compare period starts. Tracked separately.

Also factored out along the way (`dd0d72d8`): `engine submit -t/--max-missing` and `ctbk gbfs rides-v5-sweep [-a YYYY-MM]`, both previously reachable only from inside `rides-v5-extend`.
