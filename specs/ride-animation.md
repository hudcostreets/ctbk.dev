# Ride animation: every ride, moving

Status: Full 160-month candidate history, interactive animation, movie capture, monthly driver, formal DVX stage, and routed sample implemented and verified (2026-10-12). Full route population remains a subsequent phase.
Author: Ryan + Claude
Builds on: [`timelapse-map.md`] (the `/timelapse` page, `GLMap`, movie mode `?mv=1` / `window.__tl.seek`), [`timelapse-fine-bins.md`] (the linked bin/fps/range/length controls). Its "v3 idea" in the v2-arcs sketch was per-trip animation; this spec is that idea.

## Goal

Draw every ride as a moving dot with a short trail, from its start station to its end station, over its real start time and duration. v1 moves riders in straight lines. v2 moves them along plausible bike routes. The same page and movie mode render it both interactively and as MP4s.

## Scale (measured)

Sources: `rides-tl/start/1d` shards (`count_n` summed per day, over all of history) and a local projection of `normalized/202506.parquet`. The projection has `Start/Stop Time`, `Start/End Station ID`, `Rideable Type` and `User Type`, 4,836,609 rides ending in June 2025, 51 MB read over HTTP from `data.ctbk.dev/.dvc/files/md5/7a/4dc92b…`. Scratch outputs are in `tmp/norm-202506-*.txt` and `tmp/fine/anim-pack.txt`.

| quantity | value | source |
|---|---|---|
| rides, 2013-06-01 → 2026-08-05 | 325.6 M (≈330 M through Aug 2026) | Σ `1d` shards |
| peak day | **208,126** (2026-06-03); 2025 max 206,229; 2025 mean 127.7 k/day | `1d` shards |
| duration, June 2025 | mean 12.9 min, median 9.2, p90 25.5, p99 58.8, p99.9 166 min; max 94 h | projection |
| long rides | 0.94% > 1 h; 0.09% (4,334) > 3 h; 21 > 1 d | projection |
| **concurrent rides** (per-minute max), June 2025 | mean **1,461**, p99 4,232, **peak 4,970** (2025-06-04 18:21, a 195 k-ride day); 18:00–19:00 hour mean 4,665 | ±1 event sweep |
| concurrent, at the 208 k peak day | ~5.3 k (scaling the above ×1.07) | extrapolated |
| round trips (start = end station) | 2.28% (June 2025); 2.06% (12 months) | projection; `se_c` |
| bike / user type | 70.7% e-bike; 20.0% `Customer` | projection |

The envelope estimate (150 k rides on a peak day, 15 min mean, so ≈1.5 k average and 3–4 k at the peak hour) got the average right. The peak is higher, ~5 k, because peak days now reach ~208 k rides. Five thousand moving dots is still trivial for deck.gl.

## Ride index

This is not a pyramid. Nothing here is summed; it is a **time-sorted leaf table**, chunked per day.

### Record

| field | type | notes |
|---|---|---|
| `Δstart` | LEB128 varint, seconds | delta from the previous ride's start, with the first ride relative to local midnight. Max gap on 2025-06-04 was 75 s (fits 1 byte); winter nights in 2013 may need 2 |
| `dur` | u16 seconds | capped at **3 h** (10,800). This keeps 99.91% of rides exact. Longer rides get `dur=cap` plus a `long` flag (drawn fading out, not arriving) |
| `ss`, `es` | u16 | indices into the month's station table |
| `flags` | u8 | bit 0 e-bike, bit 1 casual, bit 2 long (capped), bit 3 unknown bike type, bit 4 unknown user type |

The file is stored columnar (all `Δstart`, then all `dur`, …) and gzipped. **Measured on 2025-06-04**: 195,324 rides, 8.0 B/ride raw, **5.2 B/ride gzip-9**, **1.02 MB/day**. On 2025-06-15 (101 k rides) it was 5.3 B/ride. Brotli (R2/CF re-compress) should do slightly better; that is not measured. Full history is ~330 M × 5.3 B ≈ **1.75 GB**.

Tie order is `(start_ms, ss, es, dur)`, so a ride's **ordinal within its day file is a stable id**. `Ride ID` exists only from 2021-02, so it can't serve as the id.

Implemented wire format: `CTRA`, version `1`, reserved `0`, station count `u16`, record count `u32`, carry-in count `u32` (16-byte little-endian header). First start offset is signed zigzag LEB128; following offsets are unsigned deltas. Columns then contain durations, source indices, destination indices (`u16`) and flags (`u8`). Timestamps and durations are quantized to whole local-clock seconds; ties sort by `(start_seconds, ss, es, dur, flags)`. Both decoders reject invalid bounds, column lengths, carry-in, and noncanonical ordering. gzip has `mtime=0`.

### Chunking: per day, with carry-in

Each day file also carries the **carry-in**: rides that started in `[t0 − 3h, t0)` and are still in progress at `t0`, with negative start offsets. The cap bounds the look-back. On 2025-06-04 there were 576 carry-in rides (0.3%), and on 2025-06-15 there were 816. The alternative is hour chunks, whose carry-in would be the concurrency: 4,738 in progress at 18:00 against 19,528 starting in that hour, **+24%**. Hour files would also multiply request count by 24. So: day files, fetched whole (≤ ~1 MB), with the next day prefetched at 50% playback as `/timelapse` chunks are.

### Serving: static R2 files, no worker

- Keys: `rides-anim/v1/{YYYY}/{MM}/stations.json` (index → `{id, lat, lng}`, ~2.5 k entries) and `rides-anim/v1/{YYYY}/{MM}/{DD}.bin.gz`. These are DVX-tracked, so they are content-addressed under `data.ctbk.dev/.dvc/files/md5/…`. A small `rides-anim/v1/index.json` (day → md5, rides, bytes) is regenerated with each month and is the one mutable object (short `max-age`). Every day file is then immutable (`max-age=31536000, immutable`), CORS-open and edge-cached.
- There is no `/api/rides-anim` endpoint. A worker would only add a hop, since the files are already the exact unit the client wants and need no bbox filter. At ~5 k concurrent dots, viewport culling happens on the GPU for free.
- Canonical ids: the station table maps raw ids to canonical positions (`c:` clusters, from the same id-map as `/api/tl`), so merged stations draw at one point.

### Build

- **Monthly**: a new `ctbk update` stage, `ctbk rides-anim create -d <YM>` (a `MonthTable`, DVX-tracked, after `cons`). It reads `normalized/<YM>.parquet` plus `<YM+1>` when available, for rides that start in `YM` but end in the next month, and writes ~30 day files. This takes seconds, one month of rides being ≈ 5 M rows × 6 columns. When month `M+1` arrives, day files at `M`'s end are rewritten, because they gain the late-ending rides. DVX content hashes make this a normal re-run.
- **Backfill**: 160 months, run on `e` (not the laptop). It reads the six needed columns (~60–80 MB per recent month) and writes ~1.75 GB. Batch is optional; it is embarrassingly parallel over months.

## Rendering (v1)

Implemented candidate: `ctbk rides-anim create -d YYYYMM [-i LOCAL_NORMALIZED_DIR] [-u]`, `check -i BUILD_DIR`, and resumable `backfill -d YYYYMM-YYYYMM [-u]`. Projected R2 inputs are cached by ETag; checkpoints also compare the canonical map and station table hashes. Hashed day/station objects are published under `rides-anim-candidate/v1/objects/<md5>.*`; the mutable index uses 60-second caching. This candidate publication is content-addressed independently of DVX; the separate formal `MonthTask`/DVX stage is implemented and verified below. It accounts separately for invalid-duration and unmapped rides.

June 2025 has 4,836,455 source and encoded rides, zero invalid-duration or unmapped rides, and 4,363 rides capped at three hours. Every one of its 30 daily counts equals the fine pyramid's `1d` start count exactly (`ctbk rides-anim check`); all daily files plus the station table total 25,713,970 bytes. June's local consolidated input plus projected July spillback are recorded in `tmp/animation-june/month.json` with the remote July ETag. Candidate index and files are published and publicly readable.

The browser mode is `/timelapse?anim=1&b=1m&d=250610-250610&t=250610T1800&len=60`. It shares linked controls and the movie clock, buffers on animation data, prefetches the next day after noon, and uses only the current day's padded carry-in (no adjacent-day double drawing). Geometry stays stable within 15-minute buckets; GPU trails use local seconds, with moving dot heads and round-trip loops. Long rides fade out; colors distinguish bike/user type and unknowns. This is labeled an animation preview with inferred paths; monthly exclusions and provisional status appear in the legend. Candidate mode still shares count-series queries for the scrubber; it does not require them to advance the clock.

Verification: 219 hermetic Python tests; 159 frontend unit tests and TypeScript; eight existing browser checks plus the animation browser check (exact concurrency 3,870 at 18:00 and 3,851 at 18:01; deterministic movie seek to 18:00). Desktop and 390×844 phone rendering/settings checked in HCCSx Chrome. Movie artifact `www/tmp/movies/ride-day-smoke.mp4`: 720 frames at 12 fps, 640×640, exactly 60.000000 seconds by ffprobe; the evening frame has visible trails and 3,870 rides. `e` was unreachable over SSH; `rides-anim submit` prepares a pinned HCCS Batch run using existing reproc capacity and R2 Secrets Manager bindings, with 4 vCPU/8 GiB and checkpoint resume after Spot interruption.

- deck.gl `TripsLayer` (`@deck.gl/geo-layers`, a new dependency beside `@deck.gl/layers` 9.4). Each ride is a path of `[start pos, end pos]` with timestamps `[start, start + dur]` in **seconds since the day's midnight**. float32 is exact to 1 s over a day, which is why the time base is per day and not epoch.
- **Data feed**: one layer per loaded day. The GPU filters by `currentTime`, so an entire day (≤ 210 k two-vertex paths, ~7 MB of attributes) is uploaded once, not per frame. Around midnight, both adjacent days' layers render; carry-in rides are dropped from day `d+1`'s layer when day `d` is loaded, which avoids double-drawing. `binary` data (typed arrays straight from the unpacked columns) avoids JS object churn.
- **Trails**: `trailLength` in sim-seconds (default 120 s), with `fadeTrail`. Color by `flags`: e-bike vs classic (default) or member vs casual; round trips (2%) could get a distinct hue, or a small arc (below).
- **Straight-line v1**: position(t) = lerp(start, end, (t − start)/dur). Round trips would sit still at their station. Instead, draw them as a small loop, a 3-vertex path out ~150 m toward the bearing of the next-most-common destination and back, so they are visible without faking a route.
- **Station layer underneath**: the `/timelapse` `flow` preset over a matching window (`w = trailLength`) shows departures and arrivals as the dots leave and land.
- **Controls**: the playhead is continuous time. The linked controls from [`timelapse-fine-bins.md`] apply with `bin` read as "sim-seconds per rendered frame": for example, 1 day at 30 fps in 60 s is 1,800 frames of 48 s each. `range = bin · fps · length` still holds.
- **Movie mode**: this reuses `?mv=1` and `window.__tl.seek(i)`, where `seek` sets `currentTime = rangeStart + i·bin` and awaits the day file(s) covering `[t − trailLength, t]`, deck's `onAfterRender`, and MapLibre `idle`. `TripsLayer` interpolates purely from `currentTime`, so frames are deterministic. The same black-canvas and `preserveDrawingBuffer` rules apply.

## Routes (v2)

Straight lines cut across buildings and rivers. The fix is to route every observed pair offline and animate along the route.

### Pair counts (measured)

These are from `aggregated/se_c_YYYYMM.parquet` (the monthly pair counts behind `spj`), 2025-09 → 2026-08, raw ids (`tmp/sec/pairs-stats.txt`):

- **1,640,937 distinct (start, end) pairs** in 12 months, over 2,515 stations (~26% of the 6.3 M possible). A single month has 310–786 k. 437 k pairs appear once in the year.
- **Concentration**: the top 60 k pairs carry 50% of rides, 420 k carry 90%, and 1.19 M carry 99%. Pairs with ≥ 10 rides/yr number **544 k and carry 93.2%** of rides; pairs with ≥ 2 number 1.20 M and carry 99.1%.
- Straight-line distance (from `gbfs/engine/station-geo.json`): the ride-weighted mean is **2.0 km**. The per-pair mean is 4.84 km (p99 13.6 km), because rare pairs are long.
- For all of history, raw ids churn across eras, and the geometric pairs (after canonicalization) are unmeasured. A guess is 2.5–3.5 M.

### Routing

- **Engine**: OSRM with a customized `bicycle.lua`, or Valhalla `bicycle`. Either takes an NYC-plus-Jersey-City OSM extract and requests `alternatives=3`. Valhalla's bike costing models bike lanes and hills better; OSRM is faster and simpler to batch. Try both on 1 k pairs and compare against a few hundred e-bike GPS tracks if any public ones exist; otherwise just eyeball them.
- **Where**: a Batch job (container: OSRM plus the extract, preprocessed once at ~1–2 GB RAM for NYC) runs over a pair list sharded by origin. As a guess, 1.6 M pairs at ~2–5 ms per route with alternatives on 16 vCPUs is **~5–10 min**. That is ungrounded, so time a 10 k sample first. The run repeats only for new pairs (a monthly delta) and on OSM refreshes (yearly).
- **Thinning**: route pairs with ≥ 2 rides/yr (1.2 M, 99.1% of rides). The rest draw straight-line.

### Storage

- Each route is Douglas-Peucker simplified at ~5 m and stored as a Google-encoded polyline (precision 5). Assumption, not measured: a ~6 km route (1.3× the 4.8 km pair mean) has ~20 vertices, since the grid means few turns, at ~4 B/vertex, so ~**80 B per route**.
- Totals: all 1.64 M pairs × 3 alternatives ≈ 390 MB raw; the ≥10 rides/yr set (544 k × 3) ≈ 130 MB raw. gzip makes both smaller.
- **Per-origin files**: `routes/v1/{origin}.json.gz`, each `{dest: [[len_m, polyline], …]}`. At ~52 KB average (≥10 set) they are lazy-loaded for the origins in the loaded day's rides. A whole-city day touches nearly every origin, so the first play of a day pulls most of the ~130 MB. After that everything is cached immutable. If that proves too heavy, the fallback is **per-day route bundles**: only the (pair, alt) used that day, deduplicated, written next to the day file. That costs ~100 k distinct pairs × 80 B ≈ 8 MB/day raw, a larger per-day cost but none up front. Decide from measurements.

### Per-ride route choice and timing

- Choice: `alt = weightedPick(hash32(day, ordinal), weights)` with `wᵢ ∝ (len_min / lenᵢ)^α`, α ≈ 4, so near-equal alternatives split and long detours are rare. The pick is deterministic, so every viewer and every movie render sees the same route.
- Timing: position(t) = the point at arc length `len · (t − start)/dur` along the polyline, which is constant speed. `TripsLayer` does this natively once per-vertex timestamps are set to `start + dur · cumlen/len`. Those are computed in the browser when a day is assembled (~210 k rides × ~20 vertices ≈ 4 M vertices, ~64 MB of attributes). That is heavy, so upload a sliding 2-hour window of rides instead of the whole day.
- A ride's duration is often longer than the route explains (stops, detours, an idle ride-share). In that case the dot moves slower, uniformly; there is no invented dwell.
- **Fallbacks**: pairs with no route (rare pairs, or new stations before the next routing delta) draw straight lines. Round trips keep the v1 loop, since there is no meaningful route.

## Streaming vs batch-rendered movies

Movie exports support a bin-aligned, inclusive-start/exclusive-end `clip=YYMMDDTHHMM-YYMMDDTHHMM` within the `d=` date range. Capture speed stays the same as the underlying range: `d=260929-260930&len=60&clip=260929T04-260930T04` exports 24 hours in 30 seconds. `pnpm render:tl --fps 30 --width 1080 --height 1350 URL OUTPUT.mp4` saves the exact start/end in its JSON manifest. The movie header contains the date/time, a conventional 12-hour dial with hour/minute hands and AM/PM, active ride count, and bike-color key; detailed caveats stay in the interactive view. Both clock hands use fractional simulated New York wall time, independently of the movie's elapsed seconds, FPS or duration. Electric rides are light purple, classic rides blue, and unknown bike types gray. A bottom sparkline shows ride starts per bin over the capture window, with calendar-aligned hour ticks, subtle vertical guides, and dates at clip edges/midnight. Tick density responds to the actual output width; both 24-hour low-to-low and arbitrary 48-hour clips retain clear day boundaries. Capture waits for the entire strip before its first frame and retains its immutable totals across query-cache expiry, so the curve stays fixed throughout the video.

`/movie` is an interactive workspace reached from “Movie preview & export” on `/timelapse`. Its scaled iframe runs the actual movie renderer at the chosen output dimensions, with playback, frame stepping, scrubbing and looping outside the captured frame. Pan/zoom preserves fractional zoom and six-decimal coordinates; rotation is disabled so the saved camera fully describes the preview. Clip start/end use New York wall time, with an exclusive end. Length/FPS/format edits apply together; export remains disabled until edited settings are applied. The preview and MP4 share the same frame grid, minimal header, clock, colors and fixed sparkline. A late-arriving published-date bound cannot reset movie seeks to midnight.

The Vite development server mounts `/__movies/capabilities` and `/__movies/jobs`: same-origin JSON submissions from loopback clients with a localhost/loopback Host create serial renderer jobs, expose progress/cancel and provide a ranged MP4 download. The server accepts validated settings rather than caller-controlled URLs, output paths or shell commands. Jobs snapshot the applied query/camera independently of subsequent preview edits. Limits are four pending jobs, 1–120 seconds, 1–60 FPS, even dimensions up to 1920×1080 pixels, 20,160 bins, and at least 2 GiB free before rendering. Frames stream straight to the encoder under `www/tmp/movies/exports/`. Completed exports remain discoverable from their renderer manifests after a server restart; stopping the server cancels pending renders. This endpoint is development-only and rejects tailnet/remote clients. A hosted export service can later put an `@open-athena/auth` admin gate in front of a Batch-backed renderer; localhost needs no OAuth setup.

- **Streaming (interactive)**: the default. Day files plus lazy routes, with deck.gl rendering live. It is cheap to host, since the files are static and immutable.
- **Batch-rendered**: movie mode through `scrns` on a headless browser, per [`timelapse-map.md`]. For long or high-fps movies (a year at 1 day/2 s), run it on `e` or Batch with the deterministic Docker setup. The outputs (MP4s on R2) are the showcase artifacts. A server-side renderer (headless deck.gl via `@luma.gl` + node GL, or a Python/Datashader path) isn't worth building while scrns determinism holds.

## Privacy

Citi Bike already publishes the source data per ride: start and end time, station and bike type, with no rider ids since 2021. Before 2021 there were also gender and birth year, which this index **drops**. Animating it reveals nothing new. The index keeps no `Ride ID`, and routes are inferred, not observed. One nuance: a rare pair at an odd hour is individually distinctive in the raw data too, so nothing changes. Still, don't add rider attributes (gender, age) as colors.

## Phases

- **A0: estimates** (this doc). Done: concurrency, packing, pair counts. Still open: the routing timing sample and the route vertex count, both measured on a 1 k-pair OSRM run on `e`.
- **A1: ride index**. The `rides-anim` stage and DVX outputs for one month, the day file format and a TS decoder (golden test: decode → re-encode is byte-identical, and count equals the `1d` shard's `count_n`), then the backfill on `e`.
- **A2: straight-line page**. `/timelapse?anim=1` (or `/rides`?), `TripsLayer`, the trail and color presets, the station layer underneath, and the round-trip loops.
- **A3: movie mode**. `seek` and scrns entries (a summer weekday evening rush in 60 s; one full day).
- **A4: routes**. The OSRM sample, then the measured full run on Batch (authorized with the whole roadmap), per-origin files, deterministic choice, polyline timing, and the per-day-bundle decision.

## Open questions

- Page shape: a mode of `/timelapse` (sharing controls, range and movie mode) or its own route? The default is a mode (`anim=1`), because the linked controls and seek API are identical.
- Duration cap: 3 h (99.91%) or 2 h? Long rides are mostly docking failures and lost bikes. Should they draw at all?
- Station moves: does a per-month station table (above) handle relocations well enough?
- Pre-2021 data has no bike type. Color by user type there by default?
- Could routes also improve the v2 arcs in [`timelapse-map.md`] (arc = drawn route, width = count)?

[`timelapse-map.md`]: timelapse-map.md
[`timelapse-fine-bins.md`]: timelapse-fine-bins.md

Route sample preview is implemented under `?anim=1&flow=routes`. Alternative choice is stable across midnight carry-in; distance-based timestamps and binary-search interpolation drive trails and heads. The same route readiness gate applies to playback and deterministic movie seeks. The June 10 18:00 browser fixture has 3,870 active rides, including 84 on sample street routes. Uncovered pairs and round trips retain their explicit inferred fallback. The banner now says “Animation preview” because the candidate index is growing during the remote history build.

History gate: `ctbk rides-anim check-index -d YYYYMM-YYYYMM` validates a snapshot of the published candidate index against a complete exact daily reference from `rides-tl-fine/start` (coarsest covered dividing tier). It requires every calendar day and unchanged R2 source ETags, checks source = encoded + invalid-duration + unmapped accounting, requires exact daily count equality in months without exclusions, and bounds exceptional-month differences by explicitly reported exclusions. Exceptional months also cannot exceed the pyramid on any day. The report distinguishes exact daily months from monthly accounting gates; it does not claim exact daily equality for excluded records. First/last day objects of each month are hash/size checked, decoded and canonically re-encoded, with station/carry/count checks. This is a boundary-day payload sample, not a full payload census. `.github/workflows/animation-check.yml` runs it remotely and retains only the small audit report.

Monthly integration: `ctbk rides-anim extend -d YYYYMM` submits the preceding/current start-month range to HCCS Batch, watches completion, and runs the index audit against the fine pyramid. The pinned `de615adb` image already contains the required backfill builder; the driver/audit execute from current GHA source. Matching finalized checkpoints skip, while the preceding provisional month rebuilds when the new consolidated end month becomes available. GHA ingest runs are serialized and the driver refuses a currently active independent animation writer. This is not a distributed atomic lock; independently racing CLI submits still require one operator/writer. The monthly workflow waits for a successful fine timelapse extension, retains the count report, and reports animation update failures without blocking tripdata processing.

Formal DVX stage: `ctbk ride-animation create [-w LEVEL] YYYYMM` (alias `ra`) builds `s3/ctbk/rides-animation/YYYYMM/`, containing the immutable packed objects and deterministic month manifest. It is a `MonthTask` directory output, rather than a dataframe `MonthTable`; the standard root CLI records DVX provenance. Dependencies include the current and, when available, following consolidated end months, canonical-ID map, station registry/geo, and codec/source code. Machine-specific input locations/ETags are removed from the DVX output manifest and retained in the publication index instead. The stage can prepare provenance before materialization and handles provisional final-month output. Registration and exact provenance fixtures pass. Full-history Batch publication is still tracked by the candidate index; it does not automatically add 160 DVX directories to Git or duplicate all their binaries into the laptop's DVX cache.

Initial remote audit run `38198509148` passed for 53 months (201306–201710): 52,161,549 source rides, 52,160,804 encoded, 745 explicitly excluded, 42 exact daily months, zero source/pyramid monthly count difference. The other 11 months passed the exclusion accounting bounds and boundary-day object checks.

The animation legend now shows reported monthly invalid-duration/unmapped exclusions and marks a provisional month awaiting the next end-month release. HCCSx rendering verified for November 2015: 647 concurrent rides at noon and the explicit 72-invalid/zero-unmapped monthly note. These are source-data limitations, not silently missing encoded records.

Audit correction: the first full run `38201778889` passed through 202608 but could not cover the September tip using `1d` shards: the minimum 32-day day shard straddles the monthly cap and is still open. The audit now chooses the coarsest fully covered exact dividing tier (`1d`, then `1h`, `15m`, `1m`) and sums its bins into days. It catches only an explicit uncovered-tier exception; malformed manifests still fail. The report records the chosen reference tier. This changes the reference read plan, not the count gate.

Image pin, 2026-11-06: ECR's keep-4-tags rule evicted `de615adb`, failing the 202610 extend (`CannotPullContainerError`). Definition revision 2 and the `extend` default use `ctbk-reproc:1a7fdd1d`; `ride_animation.py` and `uv.lock` are identical between the two images, so the encoder is unchanged. The lifecycle now keeps 4 `routes-*` tags and 20 tags overall. A pin still expires once 20 newer tags exist: move it forward before then.

Monthly GHA submission uses a pre-provisioned `ctbk-reproc-animation` definition under the role's existing `ctbk-reproc*` allowlist; it does not register job definitions. `rides-anim submit -j` provisions it separately, and `-e` reuses it with command/resource overrides. Definition revision 1 is pinned to `ctbk-reproc:de615adb`, binds only the R2 pair from Secrets Manager, and passed existing-role submission simulation without IAM changes. Monthly jobs fetch only the canonical map, station registry, and geo assets from the driver's full commit SHA before executing the pinned codec, so updated station data is not frozen to the image's older asset snapshot. The dry-run plan includes this asset commit and existing-definition mode.

Full-history verification on 2026-10-12: HCCS Batch job `26e330cf-67a1-4a13-b767-40381b2a40db` succeeded; audit `38202744110` passed all 160 months / 4,870 calendar days. Source 335,007,626 = encoded 335,004,840 + invalid-duration 2,194 + unmapped 592. There are 104 exact daily months without exclusions; other months pass the reported exclusion bounds. Every month also passes first/last day payload checks. September is provisional and uses the fully covered `1h` reference, with exact daily parity. Report: root `tmp/animation-full-audit-proof/animation-history-audit/animation-index-audit.json`.

Monthly-driver proof job `d739ca0a-45b8-4db1-8e23-74bc2c651167` succeeded for 202608–202609 and audited 10,409,038 source/encoded rides, zero exclusions, exact daily parity. The driver reuses pre-provisioned `ctbk-reproc-animation:1` (the existing GHA role allows `ctbk-reproc*` submission, not registration). `submit -j` provisions separately; `submit -e` never registers. Its `-r` asset SHA is the full current source checkout commit; the pinned builder fetches only the canonical map, registry, and geo assets at that SHA, keeping source-code/image provenance explicit. The proof used `63b648984a5f74de03e8244a0010f0a064b3277f`. GHA permission simulation allowed the existing queue/definition.

The real formal June DVX rebuild passed hosted runs `38199702250` and `38200110343`. Directory output hash is `04161565b142dcba10f41704cc839d07.dir`, 25,726,739 bytes. Dependencies are repository-relative source/asset/code paths; only `.dvc` and month-manifest metadata were downloaded to the low-disk laptop. Latest Python CI `38202741296` passed after the reference-tier and existing-definition fixes.
