# rides-v5: engine-built rides pyramids (drop-LUC keys, fixed-duration ladder)

Status: **calendar layer COMPLETE — materialized tiers built + registered + serving** (2026-08-10; originally 2026-08-07). Calendar fill ran on Batch (both anchors, `submit -f -s 1d`, ~5 min each incl. one absorbed Spot reclaim; image `ctbk-engine:b1bc03c4-cal` on base `pyrmts-engine:ed50cdb`, jobdef rev 11): 18 calendar shards/anchor (`1mo`:3, `2mo`:4, `3mo`:5, `6mo`:3, `1y`:3 — exactly the gap-discovery cover), 261/261 registered per anchor in D1. Post-register verification: the 2024-01→2026-01 `bin=1mo` query plans as ONE `1mo`-tier segment (was 40+ het-tiled atoms) with records identical to the het-tiled baseline; full-history 2013→now `bin=1mo` (the shape that OOM-killed the worker pre-manifest) serves in ~2s on both anchors — closed years from `/1mo` shards, edges/tip het-tiled from day-divisor fixed tiers. Monthly-extension note: the fill now also covers calendar tiers — the per-month `submit -f` after each ingest picks up newly-closed calendar shards automatically (and bare `-f` now defaults the range to `RIDES_GENESIS` for rides configs). pyrmts #122 landed both phases (`ed50cdb`, dist `6043922`); ctbk re-pinned (Python uv sources + `pds gh` JS pins), `V5_TIERS` + both anchor YAMLs carry the calendar family, and `bin=` requests (now `1mo|2mo|3mo|6mo|1y`) plan through the core ragged-calendar planner (`targetBin` via `planQueryFromInventory` — the geo wrapper doesn't forward `targetBin`, and the v5 path filters rows by `include` itself so the time-only plan suffices). The interim serve-time `rebinCalendar` 1d-pin is deleted. Equivalence verified against the old path on prod (s:HB101, 2024-01→2026-01): `1mo`/`3mo`/`1y` row-for-row equal (96/32/8 rows, incl. leap-Feb 2024), `2mo`/`6mo` equal to re-aggregated `1mo`, tip window equal. Remaining for the calendar layer: rebuild the engine image on pyrmts `ed50cdb` + Batch calendar fill (both anchors) so closed months serve from materialized tiers instead of het-tiling. Calendar bins design (RESOLVED DESIGN below): het-tiling planner + materialized `{1,2,3,6}mo + 1y` tiers. Multi-select-stations multiscale FE work proceeds in parallel on the fixed tiers. Both anchors Batch-built full-history in one pass each (start: 2,390 windows / 1.89B source rows → 243 shards / 14.1GB, 20 min; end: 243 shards / 14.2GB, 16 min; Fargate Spot 16 vCPU), 243/243 registered per anchor in D1. Acceptance: 5/5 scratch month×anchor samples (201306, 201907, 202605, 202606 start; 202606 end) byte-equal to rides-v3 via the registry map — the runs caught the v3 `canon.get(sid, sid)` identity-fallback rule and era-varying parquet dtypes (both fixed in `MonthlyRidesSource`), plus a stale `normalized/` plain-key S3 mirror (refreshed server-side from the DVC store, all 157 months). Deferred: ci.yml monthly-extension hook (GHA IAM Batch-submit perms unverified; interim = manual `ctbk gbfs engine submit -f` per anchor after each monthly ingest, + `ctbk gbfs invalidate` on the previous month's tail for start-anchor spillback). Originally drafted 2026-08-06. Successor to `rides-v3` bundling the two standing migrations, per `specs/lu-attribution.md` §Sequencing and `specs/drop-luc-station-keys.md`: station-ID (`s:<short_name>`) keys + frozen vocab cells, and the v5-style stack (YAML ladder config, pyrmts-engine Batch build, D1 `pyramid_shards` registry, `/health` cover, reconcile, GC). Supersedes the drop-LUC spec's "rides-v4" Lambda-streaming plan — the engine + Batch pipeline (proven by avail-v5/v6) replaces it.

## What changes vs rides-v3

| | rides-v3 | rides-v5 |
|---|---|---|
| keys | LUC chains (L10..L15 + LUC cell) | station vocab: L10..T=4 coarse cells + `s:<short_name>` identity (same graph as avail-v5/v6, `station-vocab.json`) |
| ladder | calendar shards (`1mo`/`3mo`/`1y`/`120y`) | fixed-duration pow-2 day shards (engine-native; kills the pyrmts calendar-shard dependency, task #122) |
| builder | `ctbk rides-v1 build` on `e` (whole-frame pandas) | pyrmts-engine raw-ingest (`TiledSource`), one Batch job per anchor |
| registry / health / GC | none (parquet-only, hand-tracked) | D1 `pyramid_shards` + api-worker reconcile + `/health` cover + GC, identical to avail-v5 |
| serving | `/api/rides-v3` parquet planner | same route, `v5` variant: vocab bbox-cover (as `v5BBoxCover`) + s:-key identity rows |

Two pyramids per the existing model: `rides-v5/start/…` and `rides-v5/end/…` (anchor = which end of the ride the time+station key comes from).

## Long-form mapping (native `sum` monoid — no pyrmts changes)

The engine already supports scalar monoids first-class (`pyrmts_engine/longform.py`): for a `sum` metric `m`, the long `metric` column takes the *state-column names* `m_n`/`m_sum`/`m_sumsq` (three long rows per group), `state` is null, `count` carries the value, and merge stays the uniform group-by-sum. So:

- dims: `cell` (vocab cell or `s:` key), `gender` ∈ {male, female, unknown}, `user_type`, `bike_type`
- metrics config: `[{name: count, monoid: sum}, {name: duration, monoid: sum}]` — wide output columns `{count,duration}×{n,sum,sumsq}`, byte-compatible with rides-v3's `MONOID_COLS`
- `duration` value = ride seconds; `count` value = 1 (its `_n` ≡ `_sum` ≡ `_sumsq`, kept for v3 schema symmetry)

Serving reuses the existing wide reader; `rides_v1.ts` needs only key-template + variant plumbing.

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

Planned calendar family (blocked on pyrmts #122; see RESOLVED DESIGN below) — calendar-aligned pow-2-year shards, exact from the fixed base:

```
tier   bin    shards (sketch)          ≈bins/max-shard
1mo    1mo    1y, 2y, 4y, 8y, 16y      192
2mo    2mo    1y, 2y, 4y, 16y, 32y     192
3mo    3mo    1y, 4y, 16y, 64y         256
6mo    6mo    2y, 8y, 32y, 128y        256
1y     1y     4y, 16y, 128y            128
```

**RESOLVED DESIGN (2026-08-07, superseding both earlier takes)**: calendar bins land as *two layers sharing one core* (see pyrmts `specs/calendar-units.md`, the #122 spec ask):

1. **Calendar-target het-tiling in the pyrmts planner** — decompose each calendar bin into aligned fixed-day bins fully contained in it (greedy containment from `{14d, 7d, 3d, 1d}`, ~5–9 pieces/month), reaggregate at stitch. Required unconditionally: the in-progress month's `/1mo` shard cannot exist until the month closes, so live monthly tips are always het-tiled (calendar flavor of mixed-tier tail coverage). Also serves calendar bins over any pyramid with no materialized calendar tiers.
2. **Materialized calendar tiers `{1,2,3,6}mo + 1y`** as the index on top — bin-SUFs above `14d`: 2.17, 2, 1.5, 2, 2 (all ≤2.2). Cascade edges `1mo ← 1d` (exact; only divisors of one day divide months, so `3d/7d/14d` can't be build sources), `2mo ← 1mo`, `3mo ← 1mo`, `6mo ← 3mo`, `1y ← 6mo`. Calendar-aligned shards (pow-2 years per tier, same ≲1k-bins/shard sizing pass as the fixed tiers). Closed months are immutable → build-once, extend-monthly.

Whether a pyramid materializes calendar tiers is a per-pyramid config choice (tiers present in YAML or not); the planner prefers a materialized+registered calendar tier and het-tiles the residue. Rides materializes (full-history monthly Home view: ~160 bins/series materialized vs ~1.1k het-tiled vs ~4.8k from raw `1d` — the last OOM-killed the CFW worker, and het-tiling alone leaves the flagship view on a ~4× memory margin). Avail stays fixed-only until a calendar view exists there.

**Interim (until the calendar fill runs)**: Home's default stays `v3`. The het-tiling serve path is live (2026-08-10 — the `rebinCalendar` 1d-pin is deleted); calendar bins het-tile from `{1d,3d,7d,14d}` until the materialized tiers are Batch-built + registered, after which the planner serves closed months from them automatically and only the residue/tip het-tiles.

## Build + steady state

- **Batch**: derived `ctbk-engine` image (same chain as avail-v6) + `rides-v5.yaml` configs (one per anchor, or one config with an anchor dim — prefer two prefixes to keep key templates simple). ~150 monthly tiles, ~285M rides × ~9 chain rows — comparable to or smaller than the avail-v6 job (5.35B source rows, 73 min); expect O($1-5) per anchor on Fargate Spot.
- **Monthly extension**: no Lambda tick — rides advance monthly. Hook the ci.yml "Process new month" flow: after `norm create` lands `normalized/<ym>.parquet`, submit the engine fill (extension mode fills the new month across both anchors' rungs). Idempotent, journal-repairable (shard-invalidation applies as-is if a month is ever re-published).
- **Registry/health**: add `rides-v5-start`/`rides-v5-end` to `RECONCILE_PYRAMIDS` + `HEALTH_PYRAMIDS` **in the same change that creates the prefixes** (the avail-v6 burn-in lesson: reconcile-map omission = invisible tip).

## Footer pathology (2026-08-07): `rg_size` 2048 → 16384 rebuild

Prod incident: multi-select FE requests (wide windows, `bin_budget≈1460` → 12h tier) intermittently died with CORS-less network errors. `wrangler tail` showed `outcome: exceededMemory` ("Worker exceeded memory limit", 503) — an isolate kill takes down every in-flight request together, and CF's kill response carries no `Access-Control-Allow-Origin`, which is why the browser reported it as a CORS block.

Root cause chain:
- `rg_size: 2048` was inherited from the avail configs (tuned for small per-station shards). Rides shards are all-network × dims: the 12h/512d and 1d/1024d shards run 11-13M rows / 245-285MB with **5.6-6.3k row groups** and **7-8MB serialized parquet footers** (~60k column-chunk metadata entries each).
- pyrmts' `fetchShardData` parses the *full* footer per shard per request (`parquetMetadataAsync`, no cache); hyparquet materializes it as a JS object graph ~10× the serialized size (50-100MB per big shard).
- `serveRidesV5` fanned all plan segments out concurrently, and the FE fires start+end anchors in parallel → several multi-MB footer parses stacked in one isolate → 128MB limit exceeded. Single sequential requests always succeeded (~1.2-2s, most of it footer parse — also the "first hit takes ~4s" report); concurrency was the killer. Repro: 8 concurrent cold `bin_budget=1460` requests → 24/24 failures; curl sequential → 0 failures.
- avail-v6 has the same shard shape (15m/32d = 534MB, 6.2k RGs, 5.4MB footer) — it survives because avail queries touch 1-2 segments for one station, but it sits near the same cliff. Fold an `rg_size` bump into the #175 avail-v6 regen.

Mitigations (deployed from `gbfs/api`, no rebuild needed):
1. Segments fetched sequentially within a request (`fetchSegmentsSequential`) in both `serveRides` and `serveRidesV5` — one metadata graph alive per request. (A cross-request semaphore was tried first and 1101'd: Workers forbid resuming one request's I/O from another request's context, so queued-waiter hand-off is structurally impossible.)
2. Load-shed: module-scope in-flight counter, immediate CORS'd 503 + `Retry-After` beyond 2 concurrent rides fetches (no queuing → no cross-context continuation); cap 4 was tried first and still 1102'd. TSQ's default retry absorbs sheds client-side, and the FE passes TSQ's `AbortSignal` so superseded fetches cancel instead of stacking against the cap. Dev-worker verification: 8 concurrent cold `bin_budget=1460` → 2×200 + 6× clean shed 503s, zero 1101/1102s, all responses CORS'd.
3. Rides edge-cache live-window TTL 60s → 1h (rides data lands monthly; fresher is pure cold-miss waste).
4. FE Latest-mode "now" quantized to 15 min (stable TSQ + edge cache keys).

Durable fix: **D1 RG manifest** (`specs/rg-manifest.md`) — per-RG byte spans + cell/dt stats + chunk metadata in D1, so serving does one D1 query + parallel range reads of exactly the matched RGs and never touches a footer. Keeps `rg_size: 2048` (fine pruning becomes an asset: ~150-500KB fetched per multi-select query); the `rg_size: 16384` Batch regen originally proposed here is SHELVED as a fallback. Interim mitigations above stay until manifest P1 lands, then the sequential-fetch + in-flight-cap constraints get relaxed.

## Acceptance (per drop-LUC spec, adapted)

1. Every v5 `s:<short_name>` row ≡ the corresponding v3 LUC row via the current denorm's cell↔station map, over a sample of months spanning eras (2013, 2019, 2024, 2026) — run before the next monthly churn while v3 and the denorm are freshly consistent.
2. Vocab-cell rows cross-checked by monoid rebin (1h→6h consistency probe, as avail).
3. Whole-pyramid totals vs `ctbk agg` monthly counts (the existing gt).

## Cutover

`?pyramid=`-style variant param on `/api/rides-v3` (or `/api/rides-v5` route alias), FE flag akin to `availPyramid`, burn-in, flip, GC `rides-v1/2/3` prefixes (v1/v2 already deletable per #106).

## Open questions

- One config with `anchor` as a dim vs two prefixes (leaning two prefixes).
- Whether to keep `gender` (null since 202102; v3 keeps it — keep for history, it costs little).
