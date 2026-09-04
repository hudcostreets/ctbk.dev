# avail: empty/full bitmaps — exact station-set reliability over strided time windows

Status: in progress (2026-09-04) — increment 1 landed (builder + backfill, packed layout, forward-filled planes, coverage artifacts; bake-off in §9). Next: increment 2 (worker `/api/empty`, `/api/coverage`) and the health-page history view (§9.2). Supersedes [`avail-outage-aggregations.md`] (the `/api/avail-v3/stats` + `n_empty`-per-cell + keyed week-hour-pyramid line of thinking); see "What this retires" below. Experiments in §1 are done (`tmp/empty-bitmap-exp.py`, output in `tmp/empty-bitmap-exp.out`).

## Goal

Answer, exactly and cheaply, for any user-selected station set (1–4 nearby stations, a transit hub, a neighborhood, or in the limit all ~2,500):

1. How often is there **no bike at all** / **no e-bike** / **no dock** (full), during windows like 8–9am, 9–10am, 8am–12pm, on weekdays or specific days of the week, over the last week / month / N months / since a date?
2. Joint versions of the same: how often were **all** (or ≥k of) the selected stations empty at the same minute — i.e. "how often could I actually not commute". Distribution of "how many of my K stations were empty" over the window.
3. "Right now these 4 are all empty — show me the recent history" — minute-fresh tail.

## 0. Why bitmaps, not histograms

The avail-v6 pyramid stores `histogram` monoids per `(s2_cell, dt)`, merged by bin-wise sum in both time and space (pyrmts `monoids.py`). That answers per-station "% time empty" (`h[0]/Σh`, already used by the OG card) and spatially-rolled-up *magnitude* stats, but it discards the per-minute cross-station join: "all 4 empty at once" is not recoverable from any combination of merged histograms, and neither is hour-of-week slicing without a fine-tier scan.

"Is station *s* empty at minute *t*" is a bit. A dense `(minutes × stations)` bit matrix is ~164 MB/yr/plane raw and compresses ~10–25× (§1), so the whole thing is ~50 MB/yr. Every query above is a strided row-slice × column-subset over that matrix, followed by popcounts. Small enough to scan at request time; no pre-aggregation, no planner.

## 1. Experiments (done 2026-09-04)

Data: 7 daily status parquets, 2026-08-24 (Mon) → 08-30 (Sun), public at `https://data.ctbk.dev/gbfs/status/<date>.parquet` (~15 MB each). 24.5M observations, 2,511 stations, `dt = floor(ts/60)` (v6 LU semantics), dedup per `(station, minute)`. Minute coverage: 96.8% of station-minutes observed.

### 1a. Density

89 stations report `0 bikes & 0 docks` for >95% of their observed minutes (decommissioned / uninstalled). They inflate every density (no-bikes 7.7% → 4.4% once excluded) and must be masked out (§2.1). `is_renting == 0` is 4.35% of observations. Live stations only:

| condition | overall | per-station p50 | p90 | p99 | stations >50% | weekday 8–9am ET |
|---|---|---|---|---|---|---|
| no bikes | 4.4% | 0.3% | 12.2% | 49.8% | 25 | 4.2% |
| no e-bikes | 15.1% | 12.7% | 32.0% | 63.5% | 58 | 16.5% |
| full (0 docks) | 11.0% | 5.0% | 31.5% | 63.0% | 78 | 8.4% |

Heavy-tailed: the median station is essentially never bike-empty; the p90 station is empty an eighth of the time. The FE should lead with per-station numbers, not city means.

Encoding consequence: a coordinate/sparse encoding costs ≥16–32 bits per set bit; dense+gzip lands at ~1.2 bits per set bit even for the sparsest plane. Dense wins outright, and Zarr's lack of a sparse story is moot.

### 1b. Chunk encoding (packbits along stations, then gzip -6)

| plane | (60,512) B/chunk | ratio | (240,512) ratio | (1440,512) ratio |
|---|---|---|---|---|
| observed | 69 | 56× | 133× | 242× |
| no bikes | 204 | 19× | 24× | 25× |
| no e-bikes | 480 | 8× | 9× | 9× |
| full | 358 | 11× | 13× | 14× |

Taller inner chunks gain ≤25% ratio while quadrupling over-read for hour-aligned windows → inner chunk height is **60 minutes**. Width 512 vs 2,560 is ratio-neutral → station-sharding is free. Total: **133 KB/day for all four planes, ~48 MB/yr.**

## 2. Data model

### 2.1 Four planes, one bit each per `(minute, station)`

| plane | bit = 1 when |
|---|---|
| `observed` | an observation exists for this `(minute, station)` **and** the station is live (`is_installed & is_renting`, and not `0 bikes & 0 docks`) — stored raw, never filled |
| `no_bikes` | `num_bikes_available == 0` at the station's last observed minute ≤ t (forward-filled; see below) |
| `no_ebikes` | `num_ebikes_available == 0`, likewise |
| `full` | `num_docks_available == 0`, likewise |

**Condition planes are stored forward-filled; `observed` is stored raw.** An un-ticked feed means "unchanged", not "unknown", so minute *t* carries the condition from the station's last observed minute ≤ *t* — uncapped within the day, seeded at midnight from the previous day's carry (its filled state at minute 1439, read from the prior day-shard's last chunk), zero before a station's first-ever observation. This is lossless: `strict = filled & observed` recovers exactly what was reported, and any fill horizon *N* is recoverable at query time from the lengths of the unobserved runs (mask filled bits at run position > *N*). It also removes the reader's dependence on the chunk *before* a window (an 8:00 bit already holds the 7:58 state). Readers pick the semantics per view (`query --ffill`: as stored / strict / ≤N); nothing about fill is decided by the index. Absent chunk ≡ all-zero ≡ unobserved.

`num_bikes_available` is the GBFS total (classic + e-bike), so `no_bikes` is "no bike of either type". Nothing else is needed for the two "empty" kinds of interest.

### 2.2 Axes

- **Time**: minutes since a fixed epoch (`2026-04-01T00:00Z`, before GBFS scraping began), monotonic, append-only. Never re-keyed by hour-of-week: that would break append (§3). Hour-of-week filtering is a strided row selection at read time.
- **Stations**: a versioned, append-only vocab `empty-v1/stations.json` = ordered list of `station_id` (uuid) → column index. Initial order: **by s2 cell id** of the station's lat/lng (same mapping avail-v3/v6 use), so spatially-close stations — the typical selection — share a station-shard. New stations append at the end (locality lost only for them). Re-ordering is a rebuild under a new prefix (`empty-v2/`); everything here is derived, so rebuilds are cheap.
- Both axes are **oversized** in the array metadata (time through 2030, 4,096 station columns) so `zarr.json` is written once and never mutated. Growth = writing new immutable chunk objects.

### 2.3 Layout (Zarr v3, sharded)

One uint8 array `empty-v1p/planes` of shape `(4, T, S/8)` — planes × minutes × packed station bytes:

| level | shape | meaning | object |
|---|---|---|---|
| shard (= R2 object) | `(4, 1440, 64)` | all planes × one UTC day × one 512-station shard (5 shards cover 2,536; 8 with the 4,096 oversize) | `empty-v1p/planes/c/0/<day_idx>/<shard_idx>` |
| inner chunk | `(4, 60, 64)` | all planes × one hour × that station-shard, plane-major (each plane a contiguous 3,840 B block) | byte range within the shard, via the shard's trailing index |

Codecs: `bytes` → `gzip` (bit-packing along the station axis is done by the builder, so the Zarr dtype is plain uint8 and no custom `packbits` codec is needed). **gzip, not zstd**: CF Workers decompress gzip/deflate natively via `DecompressionStream`; zstd would need wasm.

**All four planes ride in one chunk.** Measured over 840 real `(hour, shard)` chunks: separate planes gzip to 1,103 B summed (86 / 194 / 471 / 352), plane-major packed to **1,027 B (0.93×)**, bit-interleaved nibbles to 937 B (0.85×). The planes are correlated (`no_bikes ⊂ observed`, …), so packing compresses *better*, and one range read serves every condition — the FE can switch condition or recompute k-of-K in memory with no further fetch. Plane-major beats nibbles on reader simplicity for 9% bytes. A shard is ~25 KB per day; the index adds 24 × 16 B + 4.

A separate-plane variant (`empty-v1/<plane>`, four arrays of `(T, S/8)`, shard `(1440, 64)`, chunk `(60, 64)`) was built alongside for the bake-off (§9), lost, and was deleted 2026-09-04; only the shared vocab remains under `empty-v1/`.

Reader (`ctbk gbfs empty read`, and the worker): fetch the trailing `INDEX_LEN = 24×16+4` bytes, take `(offset, nbytes)` for the hour, range-GET, gunzip, `unpackbits` on the last axis. Strategy `whole` (one GET per shard object, index parsed locally) is the alternative benchmarked in §9.

## 3. Write path: mirror the existing n0 → h1 → d1 ladder

The raw status data already has exactly the immutable-write cascade this needs. Each rung is emitted by the job that already runs at that cadence:

| rung | existing writer | new object | size | notes |
|---|---|---|---|---|
| n0 | poller (`gbfs/worker`, `* * * * *`) writes `gbfs/status/<day>/HH-MM.json` | `empty-v1/n0/<day>/HH-MM.bin` | ~1.3 KB (4 planes × 320 B, packbits, all stations) | one extra `put` per tick |
| h1 | compactor (`gbfs/compactor`, `5 * * * *`) writes `gbfs/avail/h1/<day>/HH.parquet` | `empty-v1/h1/<day>/HH.bin` | ~1–4 KB/plane, gzip | same bytes as the inner chunks the day-shard will contain |
| d1 | daily GHA (`compact-r2.py`) writes `gbfs/status/<day>.parquet` | the Zarr day-shards (§2.3), 5 objects, plus `empty-v1p/coverage/<day>.json` | ~130 KB/day + ~6 KB | built from the daily parquet by `ctbk gbfs empty build <day>` |

Every object is written once; nothing is mutated. No coarsening cascade is needed (the archival unit is uniform), so pyrmts is not involved. The day-shard array holds **complete days only** (a partial trailing Zarr chunk would require rewriting the chunk + metadata — exactly the torn-read problem to avoid).

**Tail as a second, smaller-shard Zarr array.** The `h1` rung is best expressed as another Zarr array with the same column layout and a shard of one hour — `empty-v1p/h1` with shard `(4, 60, 64)`, inner chunk `(4, 10, 64)` — so the worker reads it with the *same* index-parse-and-range code as the archival array, and a "last 20 minutes" read pulls two ~200 B chunks rather than a whole hour. It tops out at a day: once the day-shard exists the reader prefers it, and the hour objects can be GC'd or left (immutable, ~1 KB each). Because objects are immutable, **shard height = write cadence**: the hourly compactor gives 1-hour shards and leaves ≤59 minutes of raw tail; running the compactor every 10 minutes would give 10-minute shards and ≤9 minutes of raw tail. Start hourly (the compactor already exists at that cadence); the 10-minute cadence is a one-line cron change if the raw tail proves annoying. The raw tail itself is the per-minute `n0` rows written by the poller (4 planes × 320 B per minute, all stations), read as ≤59 tiny parallel GETs.

`ctbk gbfs empty build <day>` is idempotent (rebuild = same bytes) and `ctbk gbfs empty backfill [--from]` walks genesis → yesterday and fills any missing day-shard from the daily parquets; `ctbk gbfs empty verify` lists missing/oversized shards. Backfill of the ~5 months to date is a one-off on `e` (R2 creds live there).

## 4. Read path

### 4.1 Worker

`GET /api/empty?stations=<ids>&from=&to=&hours=<HH-HH,...>&dow=<0-6,...>&planes=<no_bikes,...>`

1. Resolve stations → column indices (vocab) → station-shards. Enumerate `(day, hour)` pairs in the window that match `hours × dow` (in `America/New_York`; DST handled by evaluating each UTC hour's local `(dow, hour)`).
2. Sources, unioned: Zarr day-shards for complete days (one range read per `(day, shard, hour)`), `h1` objects for today's complete hours, `n0` objects for the ≤59 minutes since the last compaction.
3. Gunzip + unpack, keep the selected columns, then per requested plane: per-station `% of observed`, per-row popcount over the selected set → the `k-of-K` distribution, plus `all`/`any` (AND/OR) rates. Optionally per-`(dow, hour)` breakdown for the heatmap.

Request-count budget (the CFW constraint, not bytes): "weekday 8–9am × 12 weeks" = 60 hours × ⌈shards touched⌉. Four nearby stations → 60 requests of ~0.3 KB; city-wide (all 5 shards) → 300. Parallel, well under the subrequest limit. Guardrail: cap `hours × days × shards` (e.g. ≤2,000 requests); multi-year × all-minutes × all-stations is a Python job, not a request.

The worker reads shards by hand: parse the sharding index, range-read the inner chunks, `DecompressionStream('gzip')`, unpack bits. ~50 lines; no zarrita dependency.

### 4.2 Python

Real `zarr`/`xarray` access for builds, backfill, verification, and notebook analysis (`xr.open_zarr` over the public `data.ctbk.dev` prefix). This is where Zarr pulls its weight; the worker merely honors the layout.

## 5. FE

- **Heatmap**: day-of-week × hour-of-day, cell = % of observed minutes in the selected condition, for the current selection (`?sel=` multi-select on `/stations`, or a single station page). Lookback picker (1w / 4w / 12w / since date). Plane toggle (no bikes / no e-bikes / full).
- **Set view**: for K selected stations, the `0..K`-of-K distribution for the chosen window, and the headline "all K empty x% of weekday 8–9am minutes".
- **Tail**: "last 24h / 7d for these K stations" strip using h1 + n0, for the "they're all empty right now" moment.

## 6. What this retires (from the prior spec)

- `/api/avail-v3/stats` with `thresholds=`/`group=` over histograms — replaced by `/api/empty` over bitmaps.
- `n_empty` as a per-s2-cell, space-leaf metric — a cell is just a column subset of the bitmap.
- The keyed week-hour (`aHH`) pyramid rung, and its 2-level runtime tiling — for the empty family, the strided slice *is* the hour-of-week filter and the data is small enough to scan. (A keyed rung may still be worth it later for city-wide *magnitude* stats in the avail-v6 pyramid; that's a separate, pyrmts-side spec if ever.)

Unchanged: the avail-v6 histogram pyramid keeps serving magnitude stats (mean bikes/docks, neighborhood roll-ups) and the existing charts. Per-station "% empty" is available both ways — a free consistency check.

## 7. Increments

0. **Experiments** — done (§1).
1. **Python builder** — DONE 2026-09-04: `ctbk/gbfs_empty.py` = `ctbk gbfs empty {vocab,build,backfill,verify,stats,read}`. `stats -e` absorbs the §1 experiment script; `read` is the reference range-reader (trailing shard index → range GET → gunzip → unpack), i.e. the algorithm the worker will port, and `build -V` round-trips every written shard through it. Unit tests: `ctbk/tests/test_gbfs_empty.py` (exact plane coordinates incl. dedup/spill/dead/not-renting cases; Zarr round trip on a `LocalStore`; reader on absent shards + empty chunks). Backfill 2026-04-07 → 2026-09-03 ran **locally** (R2 write creds are present on the laptop and the job is ~150 × 15 MB streamed reads, so `e` wasn't needed). The daily `build <yesterday>` step is in `gbfs-compact.yml` (both layouts until §9 decides). `ctbk gbfs empty query` is the reference `/api/empty` (strided local hours × dows over a date range → per-station % + k-of-K joint distribution, with RPC/byte/time accounting); `bench` runs it across layouts × fetch strategies.
2. **Worker reader** + `/api/empty` (complete days only, from Zarr). Vitest against a fixture day built from a public daily parquet.
3. **Tail rungs**: compactor emits `h1` bitmaps; poller emits `n0`; reader unions all three.
4. **FE**: heatmap + set view + tail strip.

Each increment is independently shippable; 1+2 already answer every historical question in the Goal.

## 8. Open questions

- **n0 granularity**: per-minute 1.3 KB objects (≈43k puts/mo, inside R2's free Class A tier) vs. reading ≤59 × 580 KB status JSONs for the sub-hour tail. Per-minute objects are ~400× cheaper to read; the only cost is one extra `put` per poller tick. Leaning yes.
- **Day-boundary spill (pre-2026-08-04)**: a few daily parquets carry rows whose `ts` (feed `last_updated`) falls in the adjacent day — e.g. 2026-04-25 has 4,812 such rows ≈ 2 minutes × all stations — because the poller-v2 era named WAL files by poll minute, not LU minute (the seam avail-v6 erased). The builder drops them (`spill=` in the log), so those days lose ≤2 boundary minutes. Exact fix = also read the neighbouring days' parquets when building a day (3× the read); not worth it for ~0.1% of minutes on ~4 months of history, but recorded here so the number isn't mistaken for a bug later.
- **Station-shard count**: 512-wide (5–8 shards) is the §1 pick; if prod queries turn out to be mostly ≤4 nearby stations, 256-wide halves bytes at 2× request count for city-wide. Revisit with real query logs.
- **Live/dead criterion** — resolved in the builder as per-minute: `observed = is_installed==1 & is_renting==1 & !(bikes==0 & docks==0)`. The `0/0` guard catches the decommissioned stations (a live station can't be at 0 bikes *and* 0 docks); `is_renting==0` minutes drop out of the denominator rather than counting as "empty" — arguably a rider can't get a bike either way, so a later FE toggle could fold them in. Recorded in the group's `zarr.json` attrs.

## 9. Bake-off: layout × fetch strategy (done 2026-09-04)

Both layouts fully backfilled (2026-04-07 → 2026-09-03, 150 days, every day round-tripped through the reference reader; `verify`: 150 built / 0 missing / 0 partial for each). `ctbk gbfs empty bench` runs the same query under `{separate, packed}` × `{range: index tail + range GET per hour, whole: one GET per object}` × `{all planes, one plane}`, asserts identical answers, and reports RPCs / bytes / wall time with 16-way parallel fetch. Window: weekdays 8–9am ET over the full five months (108 weekday-hours). Python from a laptop, so absolute times are pessimistic; ratios are what matter.

| stations (shards) | layout | strategy | RPCs | KB | best s |
|---|---|---|---|---|---|
| 3 JC (1) | separate | range | 864 | 382 | 5.10 |
| 3 JC (1) | separate | whole | 432 | 4,092 | 2.69 |
| 3 JC (1) | packed | range | 216 | 246 | 1.30 |
| 3 JC (1) | **packed** | **whole** | **108** | 3,671 | **0.69** |
| 20 spread (5) | separate | range | 4,320 | 1,596 | 23.5 |
| 20 spread (5) | packed | range | 1,080 | 909 | 5.99 |
| 20 spread (5) | **packed** | **whole** | **540** | 13,986 | **2.89** |
| all 2,537 (5) | separate | range | 4,320 | 1,596 | 31.6 |
| all 2,537 (5) | packed | range | 1,080 | 909 | 7.21 |
| all 2,537 (5) | **packed** | **whole** | **540** | 13,986 | **3.84** |

Findings:
- **Packed wins outright**: 4× fewer RPCs and ~4× faster than separate for the all-planes read, and one-plane reads cost the same as all-planes (separate only breaks even on bytes when a single condition is wanted, and is still 2× the RPCs).
- **`whole` beats `range`**: halves RPCs again and roughly halves wall time, because `range` needs two *dependent* round trips per object (index tail, then chunk). It costs ~15× the bytes (a whole day-shard is ~25 KB vs one ~2 KB hour chunk), which is irrelevant at 14 MB for a city-wide five-month query and free within CF. It also gets better as the query asks for more hours per day (8am–12pm = 4 chunks from the same one GET). Bytes only start to matter if shards grow much taller than a day, which they won't.
- Station-set size barely matters once all five shards are touched: the cost is `days × shards` objects, not stations. City-wide five months = 540 objects, under the worker subrequest cap; a 12-week query is ~300.

**Decisions**: layout = **packed** (`empty-v1p/planes`); worker fetch strategy = **whole shard, index parsed locally, gunzip only the needed hour chunks**. The separate layout's objects, code, and CI half were dropped the same day.

### 9.1 What the `k-of-K` zeros actually were (measured from the `observed` plane)

The bench's joint distribution requires **all K selected stations observed in the same minute** — a minute with any station unobserved is dropped from the group, NaN-style. Reading the `observed` plane back over the full window (2,537 stations × 150 days):

- **The K=20 / K=2,537 zeros are dead stations, not gaps.** 3 of the 20 spread stations (and 44 of 2,537 overall) have zero live days in the window, so no minute can ever satisfy "all observed". Fix: a station set is evaluated over its members that are live in the window (dead members are dropped, and reported), and the joint is over minutes where all *live* members are observed. K=3 (JC) loses only 3 pts to the strict rule (80.6% qualifying vs the 83.8% ceiling).
- **Missing minutes are fleet-wide, not per-station.** Every live station's observed fraction over its live days sits at 83.8% (p10 = p50 = p90): the gaps are whole minutes with no LU-minute record for *anyone* — the feed's `last_updated` not advancing, or a missed poll — so they drop out of every denominator uniformly and don't bias per-station or joint rates. Weekly rate among live stations: **~80% before 2026-08-04, ~96% from 2026-08-04** (the LU-attributed poller; pre-v2 files were named by poll minute and deduped to LU minutes, losing ~1 in 6). The worst single days (50–65%) are outages, visible as weekly `min day` dips.
- **Health page**: `/health` already shows the fleet-wide poll-minute count vs 1,440 for today and the last 7 days (`feed.todayCount / todayExpected`, `last7Days`) plus feed-staleness drift, which post-2026-08-04 *is* this observed rate; it doesn't show the long-run series or that pre-08-04 counts overstated coverage. The bitmaps give the full-history per-day rate for free (`observed` plane popcount ÷ live stations) — worth a sparkline there.
- **Forward-fill lives in the stored planes, losslessly** (§2.1), not in the reader: `observed` stays raw, so strict and any-horizon views are query-time choices. Rebuilt 2026-09-04.

### 9.2 Coverage artifact and the health page

`build` also writes `empty-v1p/coverage/<day>.json` — `{day, live, observed_minutes, gaps: [[start_minute, length, min_count], …], counts: [1440 per-minute observed-station counts]}` — the fleet-wide "lost minutes" signal at minute resolution, for the whole history. Unlike the poll-file count on `/health` today (files per day vs 1,440), it sees partial-feed minutes and is correct before 2026-08-04. Reconstructing the 2026-08-30/31 dip from the `observed` plane: 182 + 121 lost minutes, **not** a continuous outage — ~300 separate runs, none ≥5 minutes, every one a whole-fleet miss (0 stations, no partial minutes), i.e. the feed's `last_updated` failing to advance (or missed polls) scattered through both days. That's a question the daily bars can't answer and the per-day JSON can (`gaps` lists every run). Health-page increment — DONE 2026-09-04: `gbfs/api/src/coverage.ts` serves `GET /api/coverage?from=&to=[&counts=1]` (fan-out over the per-day JSONs, `missing` for days without a doc, 1-day cache for closed ranges) and `GET /api/coverage/<day>`; `www/src/pages/Health.tsx` adds an "Observed-minute history" expander under the 7-day table with 30d / 90d / all presets, one row per day (live stations, minutes, %, gap-run count, longest run) and a 1,440-minute SVG strip with a red rect per gap run (hover = time span + min count). Verified in Chrome against a local worker with remote bindings: the pre-2026-08-04 days read as ~51% with ~700 runs of ≤2 min (every other minute deduped away, not outages), 08-04 shows the cutover mid-day, and 07-29's single 8-minute run stands out as a real gap. The coverage doc also carries the **feed `last_updated` cadence** (`lu_updates`, `lu_per_hour`, `lu_skips_per_hour`, `lu_skips`, `lu_interval{p50,p99,max}`), computed from the day's distinct `ts` values: the feed ticks every 60 ± 1 s, so "> 60 s" is noise (p90 = 61 s always); the signal is *skipped cycles* (intervals ≥ 90 s, each ≈ a fleet-wide lost minute). On 2026-08-30/31 that separates two regimes — 01–08h ET with 38–49 updates/h and p90 = 120 s (every ~3rd cycle skipped), then 8/30 12h → 8/31 21h at a steady 55/h (one skip every ~11 min). The doc also carries `lu_hist` (interval seconds → count; ~3 keys on a normal day). The feed material moved to its own page, **`/health/feed`** (`www/src/pages/FeedHealth.tsx`; `/health` keeps the 7-day poll table and links to it): range presets (7d/30d/90d/all), a summary (observed %, gap runs, longest run, skipped cycles), the **update-interval histogram** over the range (fixed bins: <59 / 59 / 60 / 61 / 62–89 / 90–119 / 120 / 121–179 / 180 / 181–239 / ≥240 s, log-scaled bars, skip bins in amber), and the per-day table with skips + p99 and an hourly amber strip under the gap strip; all hover text uses the app's floating-ui `Tip` (one per strip, content follows the pointer). `ctbk gbfs empty coverage` regenerates the docs without rewriting shards. Not yet shown: per-station gaps (the bitmaps have them; a station page could show its own strip).

[`avail-outage-aggregations.md`]: ./avail-outage-aggregations.md
