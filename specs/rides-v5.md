# rides-v5: engine-built rides pyramids (drop-LUC keys, fixed-duration ladder)

Status: **draft** (2026-08-06). Successor to `rides-v3` bundling the two standing migrations, per `specs/lu-attribution.md` §Sequencing and `specs/drop-luc-station-keys.md`: station-ID (`s:<short_name>`) keys + frozen vocab cells, and the v5-style stack (YAML ladder config, pyrmts-engine Batch build, D1 `pyramid_shards` registry, `/health` cover, reconcile, GC). Supersedes the drop-LUC spec's "rides-v4" Lambda-streaming plan — the engine + Batch pipeline (proven by avail-v5/v6) replaces it.

## What changes vs rides-v3

| | rides-v3 | rides-v5 |
|---|---|---|
| keys | LUC chains (L10..L15 + LUC cell) | station vocab: L10..T=4 coarse cells + `s:<short_name>` identity (same graph as avail-v5/v6, `station-vocab.json`) |
| ladder | calendar shards (`1mo`/`3mo`/`1y`/`120y`) | fixed-duration pow-2 day shards (engine-native; kills the pyrmts calendar-shard dependency, task #122) |
| builder | `ctbk rides-v1 build` on `e` (whole-frame pandas) | pyrmts-engine raw-ingest (`TiledSource`), one Batch job per anchor |
| registry / health / GC | none (parquet-only, hand-tracked) | D1 `pyramid_shards` + api-worker reconcile + `/health` cover + GC, identical to avail-v5 |
| serving | `/api/rides-v3` parquet planner | same route, `v5` variant: vocab bbox-cover (as `v5BBoxCover`) + s:-key identity rows |

Two pyramids per the existing model: `rides-v5/start/…` and `rides-v5/end/…` (anchor = which end of the ride the time+station key comes from).

## Long-form mapping (sum monoid, no pyrmts changes)

Engine long-form contract: `(dims…, binCol ms Int64, metric Enum, state Int32, count Float64)`; merge = group-sum. Rides metrics are all sums, so:

- dims: `cell` (vocab cell or `s:` key), `gender` ∈ {M, F, U}, `user_type` ∈ {Subscriber, Customer}, `bike_type` ∈ {classic, electric, …}
- `metric` ∈ {`rides`, `dur_s`, `dur_s2`} — count, Σ duration_s, Σ duration_s² (mean/σ derivable at read time, matching rides-v3's `count_n/duration_sum/duration_sumsq` triplet)
- `state` = 0 constant (histogram axis unused; the monoid degenerates to plain sums)
- `count` = the value

Rebinning/consolidation is the same group-sum the avail engine already does; no engine changes expected. Serving decodes the metric triplet back to the v3 column shape so `rides_v1.ts` needs only key-template + variant plumbing, not a new reader.

## Source tiles: monthly normalized parquets

Tile = `normalized/<YYYYMM>.parquet` (S3 `s3://ctbk/`; rides that **end** in the month). `MonthlyRidesSource(TiledSource)` per anchor:

- `parse(blob, tile)`: read SRC_COLS → null-latlng station-geo fallback (as `build_1h_month_table`) → canonical station map → vocab chain explode (`s:` + coarse cells; coordinate-fallback for unmapped station ids, vocab cells excluded — same rule as rides-v3's `luc_chains` fallback) → `dt = floor(anchor_time, 1h)` ms → unpivot to the metric triplet → group-sum.
- **Anchor-time spillback (the tile-period subtlety)**: tiles are keyed by *end* month, but start-anchored `dt` can precede the tile's month (a ride starting 23:50 Jun 30 ending Jul 1 lives in the July parquet with a June `dt`). Declare each tile's period as `[month_start − 1mo, month_end)` for the `start` anchor: any window then covers the tile(s) that can contain its rows, at worst reading one extra month per window. Rows are unique per tile (each ride ends in exactly one month), so overlapping tile reads are exact under union+window-clip. The `end` anchor has no spillback (`period = [month_start, month_end)`).
- Missing month = coverage miss (`max_missing_source=0.0`), so the build halts at the true source watermark — e.g. a 202607-shaped partial month never bakes a hole.

## Ladder (sketch — final packing by the same planner as avail)

Genesis 2013-06-01, ~4,900 days of 1h base bins. Target ≈1k bins/shard (the v2 sizing insight). Two axes, kept distinct: **bin** = tier aggregation granularity, **shard** = file-packing duration. All PYRAMID bins are fixed-duration:

```
tier   bin   max shard   ≈bins/shard
1h     1h    32d         768
3h     3h    128d        1024
6h     6h    256d        1024
12h    12h   512d        1024
1d     1d    1024d       1024
3d     3d    4096d       ~1365
7d     7d    4096d       ~585
14d    14d   4096d       ~293
```

**Calendar tiers (`1mo/3mo/1y`) are dropped from the pyramid and become serve-time rebins of the `1d` tier.** Rationale: the Home chart's full-history query (`bin_budget=200`) lands on today's `1mo` tier and its bars are true calendar months — epoch-anchored 30d bins would be a visible regression. But month boundaries are whole days and rides metrics are pure sums, so `floor(1d bins → calendar month) + sum` at serve time is *exact*, cheap (~4,900 daily rows → 160 monthly rows; fewer R2 GETs than the current 14-shard `1mo` reads), and edge-cacheable. The rides route grows a `bin=1mo|3mo|1y` calendar-rebin mode reading the `1d` tier; the pyramid stays fixed-duration end to end (no pyrmts calendar-shard support needed — task #122 stays unnecessary for rides).

## Build + steady state

- **Batch**: derived `ctbk-engine` image (same chain as avail-v6) + `rides-v5.yaml` configs (one per anchor, or one config with an anchor dim — prefer two prefixes to keep key templates simple). ~150 monthly tiles, ~285M rides × ~9 chain rows — comparable to or smaller than the avail-v6 job (5.35B source rows, 73 min); expect O($1-5) per anchor on Fargate Spot.
- **Monthly extension**: no Lambda tick — rides advance monthly. Hook the ci.yml "Process new month" flow: after `norm create` lands `normalized/<ym>.parquet`, submit the engine fill (extension mode fills the new month across both anchors' rungs). Idempotent, journal-repairable (shard-invalidation applies as-is if a month is ever re-published).
- **Registry/health**: add `rides-v5-start`/`rides-v5-end` to `RECONCILE_PYRAMIDS` + `HEALTH_PYRAMIDS` **in the same change that creates the prefixes** (the avail-v6 burn-in lesson: reconcile-map omission = invisible tip).

## Acceptance (per drop-LUC spec, adapted)

1. Every v5 `s:<short_name>` row ≡ the corresponding v3 LUC row via the current denorm's cell↔station map, over a sample of months spanning eras (2013, 2019, 2024, 2026) — run before the next monthly churn while v3 and the denorm are freshly consistent.
2. Vocab-cell rows cross-checked by monoid rebin (1h→6h consistency probe, as avail).
3. Whole-pyramid totals vs `ctbk agg` monthly counts (the existing gt).

## Cutover

`?pyramid=`-style variant param on `/api/rides-v3` (or `/api/rides-v5` route alias), FE flag akin to `availPyramid`, burn-in, flip, GC `rides-v1/2/3` prefixes (v1/v2 already deletable per #106).

## Open questions

- One config with `anchor` as a dim vs two prefixes (leaning two prefixes).
- Whether to keep `gender` (null since 202102; v3 keeps it — keep for history, it costs little).
