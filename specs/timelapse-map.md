# Timelapse map: every station, one time bin per frame

Status: in progress (2026-09-29). Backend (P0, P2 `/api/tl`, P4 full-history build + monthly extend) on branch `rides-tl`, deployed to the dev worker only; FE (P1–P3 + control-bar and mobile UX passes) on `wip-deckgl`. Neither is merged to `main`.
Author: Ryan + Claude
Builds on: `specs/unified-page-architecture.md` (deck.gl + MapLibre GL map, Stages 1–3 on `wip-deckgl`); the rides pyramid (`specs/rides-v5.md`, `configs/pyramids/rides-{start,end}.yaml`).

## Goal

An interactive timelapse of the whole system: a map of every station, and a time slider over bins much smaller than a year (1 day, 1 hour, and the tiers between). Each frame draws each station's ride **starts** and **ends** during that bin. Play/pause/speed, URL-persisted state, keyboard control, a couple of styling presets, and a deterministic "movie mode" so [`scrns`] can render GIF/MP4 timelapses frame by frame.

Every frame renders **every station individually**, at any zoom. There are ~2,450 of them (~330 in 2013), which deck.gl draws trivially; no S2 rollups, no pre-rendered tiles, no viewport filtering of the data.

Phasing (agreed):

- **v1: stations only.** Per-station starts/ends per bin, served as **frames** (one bin × all stations) in fixed-size chunks, from a time-first copy of the rides pyramid.
- **v2: arcs between stations.** Needs a pair dataset finer than the monthly `station-pairs-json` that exists today. Sketched below, gated on a size/cost estimate.
- **Movie mode** alongside v1: seek-by-frame, a "frame ready" signal, and capture that doesn't come out black.

## The shape of the query: a transposed index

The station pages read the rides pyramid **station-first**: a fixed station set (one station, or a bbox/S2 cover) over many time bins. A timelapse frame is the transpose: a fixed **time bin** over every station. Same data, opposite access pattern.

The existing pyramids are physically sorted for the first shape and can't serve the second cheaply:

- `rides-{start,end}` shards are sorted `cell,dt,gender,user_type,bike_type` (the `-s` passed by `_engine_sort`, `ctbk/gbfs_cli.py:1626`; pyrmts' own default is `dt` first). Measured on live shards (`data.ctbk.dev/rides/start/…`): every row group's `dt` min/max spans the **whole shard**, so time pruning never applies. One frame = read every station row group. `1d/64d` is 23 MB / 559 RGs, of which the station RGs are 14.3 MB; `1h/32d` is ~100 MB / 2,720 RGs. Projecting just `cell,dt,count_sum` still costs 1.5 MB (`1d/64d`) to 12 MB (`1h/32d`) per anchor before the first frame renders.
- Rows are split by `gender × user_type × bike_type` (~3.4 rows per station-bin; 509 k `s:` rows for 150 k station-days in `1d/64d`), none of which a frame needs.
- `smg-v1` (station state) is sorted `s2_cell,dt` too, so state/availability frames have the same problem. Out of scope here, but the fix below applies verbatim when we want them.
- `/api/rides` can't be bent to it either: `cells=s:…` for 2,450 stations is a ~25 KB URL (CF limit 16 KB) and trips the 1,000 keys×terms guard; `bbox=` returns S2 vocab cells, not stations; a full-shard decode blows the worker's 128 MB isolate.

So v1 adds the transposed index: the same pyramid, sorted time-first, with only what a frame needs.

## Data: `rides-tl-{start,end}`, a time-first pyramid variant

A second pyramid per anchor, built by the existing engine/Batch/manifest/canonicalize machinery (`ctbk gbfs engine submit`, `pyrmts-engine batch submit`), differing from `rides-{start,end}` only in:

| | `rides-{start,end}` (existing) | `rides-tl-{start,end}` (new) |
|---|---|---|
| dims | `cell, gender, user_type, bike_type` | `cell` only (the rider dims summed away at ingest) |
| `cell` values | S2 vocab chain (levels 15–10) + `s:` leaves + `c:` rollups | `s:` leaves + `c:` rollups only (`geo.resolutions: []`, no vocab chain) |
| metrics | `count`, `duration` (`n,sum,sumsq`) | `count` only (`duration` optional; not needed for v1) |
| sort | `cell,dt,…` | `dt,cell` |
| tiers | 1h … 1y ladder | same ladder |
| identity rollup | `c:` from `station-canonicalize-map.json` | same |
| storage | `rides/{start,end}/{tier}/{shard}/{period}.{hash}.parquet` | `rides-tl/{start,end}/…`, same content-hashed keyTemplate + `manifest.jsonl` |

Why this and not a bespoke "frame cube" artifact (the previous draft of this spec): the cube would rebuild the same numbers outside pyrmts and lose the tier ladder (arbitrary bin widths for free), monthly `rides-extend` fills, the canonicalize pass, and the manifest/registry. As a pyramid it's one more config file plus a small source change.

### Source change

`MonthlyRidesSource` (`ctbk/pyramid_cascade/rides_source.py`) hardcodes `group_by(['cell','dt','gender','user_type','bike_type'])` and emits the S2 vocab chain. It needs:

- a `dims` parameter read from the config (so `dims: [cell]` groups by `cell,dt` only), and
- an `identity_only` switch that emits the `s:` leaf per ride without the vocab-chain rows (the engine groups by whatever dims the config declares, `pyrmts_engine/longform.py` `group_cols`, so the engine side should need nothing — **verify in P0**).

`_engine_sort` gets a third branch: `dt,cell` for `rides-tl-*` configs. The sort is stamped into each shard (`pyrmts.sort` footer metadata), so canonicalize rewrites keep it.

### Frame cost, with time-first sort

Rows per bin ≈ live stations (2,450 today; fewer in the past). With `rg_size: 2048` and `dt`-major sort, a `1d` frame is ~1–2 row groups; a `1h` frame (fewer active stations per hour, ~1–1.5 k) is under one. pyrmts' existing RG pruning on `dt` stats (`rg_manifest.ts`) does the rest.

| bin | rows/frame | bytes/frame/anchor (≈4 B/row: `cell` dict-encoded + `dt` RLE + small ints) | frame (starts + ends) |
|---|---|---|---|
| `1h` | ~1–1.5 k | ~5–8 KB | ~15 KB |
| `1d` | ~2.4 k | ~10 KB | ~20 KB |
| `7d`, `1mo` | ~2.4 k | ~10 KB | ~20 KB |

Consecutive frames are **adjacent bytes** in the shard, so a run of N frames is one contiguous range read. That is the whole "tile in time" story: the physical layout is the tiling.

Storage per anchor (estimated): `1h` tier ≈ 115 k hours × ~1.2 k rows × ~4 B ≈ 0.5 GB across all shard rungs; `1d` ≈ 45 MB; coarser tiers negligible. Footers: ~0.4 KB/RG with 3 columns, so prefer mid-size shard rungs when serving (a `1h/32d` shard is ~380 RGs → ~150 KB footer, read once per shard). **P0 measures all of this on one built month.**

Bins are local wall-clock time (naive NYC time stored as if UTC), as in the existing pyramids; the FE formats `dt` with `timeZone: 'UTC'`. DST quirks (a doubled fall-back hour, an empty spring-forward hour) are inherent.

### P0 results (2025-06 scratch build, `rides-tl-p0/{start,end}`, 2026-09-28)

Built via `engine-image.yml` (25 s) + two Batch jobs (a few minutes each, <$1). 13 shards/anchor, 14.8 MB, all stamped `pyrmts.sort=dt,cell`, `rg_size 2048`; columns `cell, dt, count_{n,sum,sumsq}`; only `s:` rows (2,239 stations; no vocab, no fallback rows: June 2025 fully mapped). **Validation gate passed** both anchors: 5 stations' per-day counts equal `/api/rides?raw=1&cells=s:<id>` on every day; system Σ per day equals `/api/rides?bbox=` on all 30 days (4,836,455 start / 4,836,609 end); `1h` rungs re-aggregated to days equal `1d@32d` on all 35,316 cell-days. Probe tool: `ctbk gbfs engine frame-cost` (footer-only, over HTTP).

| measured | `1h` | `1d` |
|---|---|---|
| rows/frame (median) | 1,488 | 2,210 |
| RGs per frame | 1 (occasionally 2) | 2 |
| bytes/frame, `cell,dt,count_sum` projection | 11–14 KB alone; **8.1 KB amortized in a 48-frame chunk** (388 KB, one contiguous range) | 34 KB alone; 18 KB amortized in a chunk |
| bytes/row (projection / all cols) | 6.4 / 8.0 | 8.2 / 11.8 |
| storage/anchor/month | 7.7 MB | 0.8 MB |
| footer | ~0.6 KB/RG (≈280 KB for a full `1h@32d` shard) | |

RG pruning on `dt` stats works: consecutive frames are adjacent bytes, and a chunk is one range read. Spec estimates were 1.5–3× low on bytes (storage extrapolates to ~1.2 GB/anchor at `1h`, ~130 MB at `1d`, before historical station growth), for two fixable reasons:

- **`cell` is ~68% of bytes.** With `dt`-major sort and `rg_size 2048` (≈ one bin), every row group holds ~2 k *distinct* cells, so the dictionary never amortizes. Rewriting `1h@32d` locally: `rg_size` 32,768 → 1.98 MB vs 4.06 MB (4.0 B/row all columns, 2.4 B/row projected = the spec's figure); zstd on top → 1.47 MB. Chunked serving never reads a lone frame, so **set `rg_size` 16–32 k for `rides-tl` before P4** (a 48-frame `1h` chunk ≈ 170 KB projected; footers shrink ~16×).
- **`count_{n,sum,sumsq}` are identical** on every row (`count` ≡ 1 per ride); `sum`/`sumsq` are float64 dead weight (~20%). Serve `count_n` (or drop the extra monoid columns if pyrmts allows a count-only metric).

**`rg_size 32768` re-run (`rides-tl-p0b/{start,end}`, same image, `-g 32768`)** confirmed the halving on Batch: 6.97 / 6.94 MB per anchor (was 14.80), `1h` tier 3.78 MB (was 7.72), `1h@32d` 16 RGs / 10 KB footer (was 241 / 139 KB), `1d@32d` 2 RGs / 2 KB footer (was 18 / 11 KB). Frame cost: a 48-frame `1h` chunk = 2 RGs, **157 KB projected / 255 KB all columns, one contiguous range (3.3 KB/frame)** vs 388 KB; a 32-frame `1d` chunk = 123 KB / 218 KB (3.8 KB/frame) vs 291 KB. Lone-frame reads cost a whole RG (73–84 KB projected at `1h`, 104 KB at `1d`) — fine, since serving is chunked. Full history extrapolates to ~0.6 GB/anchor at `1h` (less with historical station growth), ~35 MB at `1d`. `rides-tl-{start,end}.yaml` now declare `defaults.rg_size: 32768` and `engine submit` takes its `-g` default from the config.

`duration`: out. Tip-side `1d` frames span the min-cover (`1d@32d` + `6h@8d` + `3h@4d` + `1h@2d`), so `/api/tl` re-aggregates finer rungs for the last days of a month, as `/api/rides` does. Raw leaves include odd ids (`s:JC116`, a trailing-space `s:Shop Morgan `); the FE joins via station-luc / canonicalize.

## Serving: chunked frames

### Endpoint

`GET /api/tl?anchor=start|end&bin=<tier>&chunk=<k>` on the api worker (`gbfs/api/src/`), reading `rides-tl/{anchor}` through the same planner/fetch path as `serveRides`, with `dt` RG pruning doing the work.

- **Chunks, not playhead-centered windows.** Frames are numbered from genesis (2013-06-01 local) in units of `bin`; a chunk is a fixed run of `K` frames aligned to `k·K`. `K` per tier: `1h` → 48 (2 days, ~700 KB), `1d` → 32 (~640 KB), `7d` → 32, `1mo` → 24 (one `1mo@2y` shard). Chunk URLs are identical for every viewer and every scrub, so the CF edge cache serves them; the client asks for whichever chunks it lacks. This replaces any "here's what I already have" negotiation.
- **No `bbox`.** A frame is ~20 KB for the whole city; viewport filtering would save almost nothing and make every viewport a distinct cache key. The client filters (or rather doesn't: it renders everything).
- **Canonical stations.** Select `c:` for merged clusters and `s:` otherwise (`selectLeaves(…, 'canonical')`, `gbfs/api/src/canon.ts`), same as `/api/rides`' default. `?raw=1` for audit, as there.
- **Response**: a compact dense block, not one JSON record per row:

  ```jsonc
  {
    "bin": "1d", "chunk": 512, "k": 32, "t0": "2025-06-09T00:00:00",   // local start of frame 0 of the chunk
    "ids": ["116", "119", "5721.14", …],                                // canonical ids with ≥1 count in the chunk, sorted
    "counts": [/* K × ids.length, frame-major: counts[f * S + s] */],
    "unmapped": [/* K per-frame totals the pyramid couldn't key to a station */]
  }
  ```

  Frame-major so a frame is one contiguous slice (`Uint16Array.subarray`). JSON in v1 (data.ctbk.dev/CF auto-compress br/gzip; runs of zeros and small ints compress ~5×); switch to a gzip'd binary body only if parse time shows in profiles. Tip chunks (touching the live month) get a short `Cache-Control`; closed chunks are immutable (`RIDES_CACHE_GEN`-style key rotation on repair, as `/api/rides`).

### Browser-direct alternative

`data.ctbk.dev/rides-tl/…` will be public, range-readable and CORS-open (as `rides/` is today: `206` + `access-control-allow-origin: *`), and pyrmts JS ships `httpStorage` (`js/packages/pyrmts/src/storage.ts`) for `parquetBackend`, so the planner can run client-side with no worker in the loop. The wrinkle: R2 keeps several hashed copies per period (older builds, rollback copies), so the client must resolve shards through `manifest.jsonl` (latest `written_at`). Keep this as the fallback design; v1 uses the worker endpoint because chunk URLs cache at the edge and keep the client simple.

### Client cache and prefetch

- `frames: Map<frameIndex, Frame>` per `(anchor, bin)`, filled chunk by chunk; TanStack Query `queryKey: ['tl', anchor, bin, chunk]`, `staleTime: Infinity` for closed chunks (`gcTime` ~10 min, ~700 KB each). `ensureQueryData` is the fetch primitive.
- **Playback**: hold the current chunk and the next; prefetch the next when the playhead passes 50% of the current (and one more at high fps). If the next chunk isn't in yet, **stall** with a buffering badge rather than skip frames.
- **Scrub / jump**: snap to the nearest cached frame immediately (or a faint "loading" state if none is within ±1 chunk), fire the chunk under the new `t` first, then neighbours.
- **Idle fill**: a priority queue over chunks by distance from the playhead — ±1, ±2, then every second chunk out to ±6, then exponential back-off — throttled to one in-flight request while idle. This is the progressive fan-out from the design discussion; start with ±1 only and widen once the rest works.
- **Range fill** (as built): after the near fan-out, the queue continues through every chunk in `d`, two in flight, so the scrubber's totals strip fills in seconds (`1d` × 1 y = 12 chunks, < 1 s locally). A range change re-queues; a bin change drops the queue. The queue is created in an effect (a module-level/`useMemo` queue was shut down by StrictMode's double mount, so only ±1 ever loaded in dev).

## UX

### Route

Add a new page `/timelapse` (`www/src/pages/Timelapse.tsx`), not a mode of `/stations`. It has its own controls, keyboard map and movie mode, and `/stations` already binds ←/→ to month nav (`hooks/useStationsKeyboardShortcuts.ts`). A later `/stations` → "▶ timelapse" link can carry `ll` and `sel` over.

### Layout

As built after the mobile pass (2026-09-29); the original sketch is kept below it.

- **Header strip** (top): compact clock (`Tue Jun 10 · 18:00`) + a thin legend color bar; tapping the bar or ⓘ expands the full legend (scale incl. the `sz` factor, "faint dot = …", frame info, source chip). Expanded by default on wide viewports. Only warning badges (buffering, error, synthetic, no data) stay in the collapsed strip.
- **Transport**: ‹ › chevrons (step one bin; not ⏮/⏭, which read as first/last) around a larger, round, accent-filled ▶/❚❚.
- **Control bar**: on phones, collapsed to transport + scrubber + timestamp + ⚙; ⚙ expands range, presets, bin, speed, style, size, loop, and (touch only) the keyboard hints. Desktop shows everything.
- **Selection panel** (replaces per-station floating cards): docked right on desktop, a collapsible bottom sheet (max 38vh) above the controls on phones. Header: count, **Clear**, and **Done** + a "multi-select" tag in that mode. Rows: name, starts/ends/net at `t`, mini sparkline, ×. A single selection gets a larger sparkline and a "Station page →" link (`/s/<short name>`, which redirects to the slug; current stations only).
- **Overlays consume pointer events**; selection gestures listen on the map canvas container only, so taps on overlays never reach stations.
- **Tooltips** (floating-ui) only when `(hover: hover)`; the hover card follows the cursor, clamped to the viewport. The site's bottom-right `ThemeToggle` widget is hidden on `/timelapse` (it covered ⚙ and the scrubber end); `?` still opens the shortcuts modal.

#### Selection gestures (pure state machine: `tlGesture`, `timelapseSelection`, with tests)

- **Tap** a station: select only it. Tap empty map / `esc`: clear.
- **Long-press** (~500 ms; < 10 px movement on touch, < 5 px mouse) on a station: enter **multi-select** and add it (short vibration where supported). In the mode, taps toggle; an empty-map tap does nothing (so a stray tap can't wipe a hand-built set); Done / Clear / `esc` / removing the last station exits.
- **Rectangle select**: long-press then drag (touch or mouse), or shift-drag on desktop, draws a translucent rect with map panning suspended; on release adds stations inside it (current, plus retired ones alive at `t`). A long-press rect also enters multi-select. A second finger cancels the rect (becomes pinch). Shift-drag no longer triggers MapLibre box-zoom.
- Desktop: shift/⌘-click toggles without entering the mode.
- An immediate drag pans as usual.

Original sketch:

- Full-bleed GL map.
- Top-left: a **clock** overlay showing the local date and time for hourly bins (e.g. "Tue Jun 10, 2025 · 08:00"), or the date + weekday for daily bins. Big type, so it's legible in movies.
- Bottom: the **control bar**:
  - ▶/❚❚, step ◀ ▶, a speed selector, the bin selector, the style preset, and loop.
  - A **scrubber** over the full range, with a **system totals strip** drawn inside it (a tiny area chart of Σ starts per bin from cached chunks; unloaded spans hatched). The strip shows weekday/weekend rhythm, storms and holidays at a glance, and where the playhead is.
- Top-right: the preset's legend (the diverging ramp for `flow`, size key).
- Hover drawer (reuse `css.hoverDrawer`): station name, plus starts / ends / net in the current bin. Click pins a station: its ring persists and the drawer shows its sparkline over the cached chunks. Nothing extra is fetched.

### URL params (`use-prms`)

| param | codec | default | meaning |
|---|---|---|---|
| `b` | `codeParam` over every `/api/tl` tier (`1h`,`3h`,`6h`,`12h`,`1d`,`3d`,`7d`,`14d`,`1mo`) | `1d` | bin |
| `d` | range string `YYMMDD-YYMMDD` | the bin's `DEFAULT_SPAN` ending on the last published day (end of `station-urls.json` `latestMonth`; yesterday until that loads) — week at `1h`, year at `1d`, … | playback range (inclusive days) |
| `t` | `YYMMDD` or `YYMMDDTHH` | range start | playhead. Written with **replace** on pause/step/scrub only, never per frame while playing |
| `sp` | int | `8` | frames per second (1, 2, 4, 8, 16, 30; labeled in the bin's units, e.g. `24 h/s` at `3h`) |
| `st` | `codeParam` `flow`/`act`/`split`/`col` | `flow` | style preset |
| `lp` | `boolParam` | `false` | loop |
| `ll` | `llzParam` (reuse `viewParam`) | system view | camera |
| `sel` | `selParam` (reuse) | empty | selected stations (see Selection gestures) |
| `sz` | float, ×0.25–×2 | `1` | circle-size multiplier (deck `radiusScale`); below zoom 11 radii also shrink ×½ per 2 zoom levels, floored at 0.35 |
| `mv` | `boolParam` | `false` | movie mode (below) |
| `fpb` | int | `1` | movie: rendered frames per bin (sub-bin interpolation) |

Autoplay is never URL state: a shared link opens paused at `t`.

### Keyboard (`use-kbd` `useAction`, group "Timelapse")

`space` play/pause · `←`/`→` step one bin · `shift+←`/`shift+→` a bigger per-bin step (a day at `1h`/`3h`, a week at `6h`–`1d`, a year at `1mo`, …) · `[`/`]` slower/faster · `home`/`end` jump to range start/end · `b`/`shift+b` coarser/finer bin · `s` cycle style preset · `l` toggle loop · `esc` clear pins. All of these show up in `ShortcutsModal` and the Omnibar for free.

### Styling presets

All presets size by activity and **normalize to a global per-bin scale** (p99/max per tier, computed once by the builder and served in a small `tl-scale.json` sidecar or as a manifest field), never the per-frame max. A per-frame max would make the whole map "breathe" as the system gets busier and quieter, and that breathing *is* the signal.

1. **`flow` (default)**: radius ∝ `sqrt(starts + ends)`. Color is a diverging ramp on damped net share `f = (starts − ends) / (starts + ends + k)` with `k ≈ 3` pseudo-counts, so a station with 1 start / 0 ends doesn't max out the ramp. Warm = net source (more departures), cool = net sink (more arrivals), neutral grey near 0. This is the preset that makes morning commutes visible: residential areas glow warm at 8 am, Midtown cool, and the pattern reverses at 6 pm.
2. **`act` (activity)**: radius ∝ `sqrt(total)`, single-hue ramp by total (reuse `rampRgb` from `flowLens.ts`), with additive blending (deck `parameters` blend `SRC_ALPHA, ONE`) for a "glow" look on the dark basemap. Prettiest for movies, carries less information.
3. **`split`**: two glyphs per station: a filled disk for starts and a stroked ring for ends, each sized independently on the same scale. The GL successor to the `?pies=` POC (`StationPies.tsx`, `specs/map-modes-and-ranges.md`) without pie geometry. Two `ScatterplotLayer`s share one position buffer.
4. **`col` (v1.5, optional)**: `ColumnLayer` with height = total, color per `flow`, on a pitched camera (`unified-page-architecture.md` Stage 4). Cheap once the frame plumbing exists and very good for movies. Defer until 1–3 have shipped.

Stations with no activity in the current bin but alive (`first ≤ t ≤ last` in the station sidecar) render as a faint 2 px dot, so 4 am shows the network's skeleton instead of an empty map. Stations outside `[first, last]` aren't drawn. That's how openings and expansions show up in the timelapse.

### Station metadata

A `tl-stations.json` sidecar (canonical id → `{name, lat, lng, region, first, last}`), ~2.9 k entries / ~60 KB compressed, from the same registry the pyramid keys against (vocab + `stations/rides-extra-stations.json` + `station-geo.json`), so every frame id has a position by construction; the builder fails otherwise. `first`/`last` are the first/last `1d` bin with activity. One position per station in v1; see Open questions for moves.

## Rendering

- **Factor the GL shell out of `StationMapGL`**: `GLMap` = MapLibre `<Map>` + `DeckOverlay` + `rasterStyle` + camera/`onMove` + a `ready` hook. `StationMapGL` and the new `TimelapseMap` both render through it. Don't grow `StationMapGL`'s prop surface further; its layers (lens, pins, fan, rect-select) are `/stations` concerns.
- **Static geometry, dynamic attributes.** One `data` array for the union of station ids across cached chunks (`{id, position, idx}`), rebuilt only when a chunk introduces new ids. Per frame, only typed-array slices change: pass binary attributes (`getRadius: {value: Float32Array}`, `getFillColor: {value: Uint8Array, size: 4}`) so deck re-uploads just those buffers. At ~2.5 k instances that's microseconds.
- **Frame interpolation in JS, not deck `transitions`.** The playhead is continuous: `t = bin + φ`. Each rendered frame lerps starts/ends between bins `⌊t⌋` and `⌊t⌋+1`, then derives radius and color. Smooth at any speed and **deterministic**; deck `transitions` are wall-clock-driven, so a capture would depend on timing. Disable `autoHighlight` and transitions in movie mode.
- Playback loop: one `requestAnimationFrame` driver advances `t` by `sp × dt` (in bins), stalling (buffering badge) when the next chunk isn't cached.
- Basemap: raster Stadia (as now). Dark theme is the default for movies. Movie mode uses a local tile cache (`tileBase=` precedent from `specs/done/deterministic-screenshots.md`) so frames don't depend on the network.
- The "black screenshot" finding in `unified-page-architecture.md` applies. MapLibre renders on demand with `preserveDrawingBuffer: false`; deck's canvas preserves by default (`@deck.gl/core` `deviceProps.webgl.preserveDrawingBuffer`). That spec's "react-map-gl doesn't expose `preserveDrawingBuffer`" is **outdated**: `@vis.gl/react-maplibre` 8.1's `MapProps` = `Omit<MapOptions, …>`, so `canvasContextAttributes={{ preserveDrawingBuffer: true }}` is a valid `<Map>` prop.

## Movie mode (`?mv=1`)

Goal: `scrns` renders a timelapse deterministically. The same URL + frame count must produce byte-identical frames (per `specs/done/deterministic-screenshots.md`'s Docker/amd64 setup).

- **Chrome off**: no control bar, speed dial or hover drawer. The clock, legend and optional title card stay. The viewport comes from the scrns `width`/`height`; the camera is fixed from `ll`; interaction is disabled.
- **Seek API**: `window.__tl = { frames, seek(i): Promise<void> }`. `frames = nBins(range) × fpb`. `seek(i)` sets `t = rangeStart + i / fpb` and awaits `ensureQueryData` for the needed chunk(s), the deck render with that frame's attributes (`onAfterRender` after the `setProps`), and MapLibre `idle` (tiles loaded; instant after the first frame since the camera is fixed). Then it resolves and sets `data-tl-frame="<i>"` on the map container, for selector waits.
- **scrns config** (`www/scrns.timelapse.json`, `animate` action; `page.evaluate` awaits the returned promise, then scrns double-rAFs and captures):

  ```json
  "tl-2025-week": {
    "query": "timelapse?mv=1&b=1h&d=250609-250615&st=flow&fpb=4&theme=dark&tileBase=/tiles/alidade_smooth_dark",
    "width": 1080, "height": 1080,
    "selector": "[data-tl-frame='0']",
    "path": "tl-2025-week.mp4",
    "actions": [{ "type": "animate", "frames": 672, "eval": "(i) => window.__tl.seek(i)" }]
  }
  ```

  Frame counts get big (a year daily at `fpb=4` is 1,460 frames). MP4 via ffmpeg is the default for movies; GIFs for short loops (one day hourly, `fpb=2`, ~48 frames).
- **Black-canvas fix**: in movie mode, pass `canvasContextAttributes={{ preserveDrawingBuffer: true }}` to the MapLibre `<Map>`. Together with "resolve only after `idle` + `onAfterRender`", Playwright's `page.screenshot` sees both canvases populated. Keep it **off** outside movie mode (a buffer copy per frame).
- **Determinism checklist**: cached tiles; fixed DPR (`deviceScaleFactor: 1` in scrns); no deck transitions or `autoHighlight`; interpolation from `t` only; no wall-clock or `Date.now()` in render paths; fonts bundled.
- Title cards and captions: optional `?cap=` text rendered as an overlay. Anything fancier happens in post (ffmpeg).

## Interim: prototype against the existing pyramid (P1, no rebuild needed)

Before `rides-tl` exists, the page can be developed against today's station-first shards: a throwaway `/api/tl` implementation (or the browser-direct path) that, per chunk, projects `cell,dt,count_sum` over the station row groups of the covering shard and pivots. Cost: ~1.5 MB per anchor per `1d/64d` shard (64 frames), ~12 MB per `1h/32d` (768 frames). Slow first frame, fine afterwards — enough to settle UX, presets and movie mode with real data, and to get the numbers the validation gate compares against. Delete it when P2 lands.

## v2 sketch: arcs between stations

Pair data only exists **monthly** today (`pairs[ym].json` via `station-urls.json`, the source for `flowLens`/`flowArcs`). Arcs per frame need a pair dataset at `1d`, maybe `1h`. **Don't build it until a P0-style size/cost estimate is written up and approved.**

- Shape: per-chunk sparse triples `(src idx, dst idx, count)`, the same `ids` table framing, on R2. **Not D1**: at ~100 k distinct pairs per day, a year of `1d` pairs is ~36 M rows → ~$72 in D1 writes per history-year (×2 with an index), ~$500+ for full history, past D1's 10 GB cap (already at ~6.1 GB). On R2 it's 6 B/triple × ~100 k/day ≈ 600 KB/day raw, ~90 MB/year compressed, ~1 GB for all history: pennies in storage, but ~250 KB per *day* frame. This is where viewport (`bbox`) filtering earns its keep, unlike v1.
- `1h` pairs are nearly ride-level (~147 k rides/day → ~140 k pair-hours). At that point serve per-day files with an hour column, or render from trips directly: animated individual trips, a deck `TripsLayer`, a v3 idea.
- Thinning: `flowLens`' `FLOOR_FRAC` idea per frame, and a global floor (count ≥ 2) at build time; the estimate reports sizes with and without.
- Rendering: reuse the Stage 3 `ArcLayer` (`flowArcs` color/width conventions), per-frame binary attributes like the stations.
- Source: normalized trips (the pyramid has no pair axis), canonicalized with the same id-map. Could itself be a pyramid with a `pair` dim if pyrmts handles the cardinality.

## Phased plan

- **P0: build `rides-tl` for one month (backend).** Config files `rides-tl-{start,end}.yaml`; `MonthlyRidesSource` `dims`/`identity_only`; `_engine_sort` branch; one Batch build (2025-06, all tiers) per anchor. Measure shard sizes, footer sizes, bytes per frame at `1h`/`1d`, RG pruning behaviour; validation gate: per-station per-bin counts equal `/api/rides?cells=s:<sn>` summed over dims for 5 stations, and Σ frame + `unmapped` = `/api/rides?bbox=<SYSTEM>` per bin. Decide `duration` in/out.
  - *Code landed (branch `rides-tl`)*: `configs/pyramids/rides-tl-{start,end}.yaml` (dims `[cell]`, metrics `[count]`, hashed keys, the rides `identityRollup` with explicit `col: cell`, **no `geo` block** — pyrmts rejects an empty `geo.resolutions`, and omitting `geo` is how "no vocab chain" is expressed; every engine use of `pyramid.geo` is `is not None`-guarded); `MonthlyRidesSource(dims=…, identity_only=…)` with dims/metrics read from the pyramid config (identity-only keys a mapped ride by its raw `s:<sid>` leaf alone and an unmapped ride by its single coarsest non-vocab fallback cell, so non-`s:`/`c:` rows per bin = `unmapped`); `ctbk_engine_src:rides_tl_{start,end}` factories; `_engine_sort` → `dt,cell`. Batch build not yet run.
- **P1: page skeleton on `1d`, against the existing pyramid (interim path).** Factor `GLMap`; `/timelapse` with `flow`, scrubber, play/pause/step/speed, URL params, `use-kbd` actions, chunk cache with ±1 prefetch. One-year range. **Status (2026-09-28): landed on `wip-deckgl`** — `GLMap` factored out of `StationMapGL`; `/timelapse` (`www/src/pages/Timelapse.tsx`) with the `flow` preset, clock, control bar + scrubber/totals strip, hover drawer, URL params (`b`,`d`,`t`,`sp`,`ll`,`st`,`lp`, plus interim `src`), "Timelapse" `use-kbd` group; chunk cache (`www/src/query/timelapse.ts`, pure math + tests in `timelapseFrames.ts`). Interim data: the browser tail-reads the live `1d` shards via hyparquet (one range request per station row group, ~2.7 MB/anchor per 64d shard) where the covering shard is ≤ 64 MB (2026-01-27 onward: `128d`/`64d` rungs); earlier days sit in 1024d shards (285–360 MB) and fall back to frames synthesized from monthly `stations[ym].json` totals, badged "synthetic". Station positions/names come from `stations-regional.json` + `station-luc.json` (no `tl-stations.json` yet, so no `first`/`last`; unmapped ids are counted in the clock badge). Canonical ids: `c:` rows + `s:` leaves not in a `station-merges.json` cluster.
- **P2: `/api/tl` on `rides-tl` + `1h`.** Real endpoint, chunk sizing, tip-chunk caching, bin selector, totals strip, `act` + `split` presets with legends, pins + sparkline, idle fan-out prefetch.
  - *Backend landed (branch `rides-tl`, `gbfs/api/src/tl.ts`)*: `GET /api/tl?anchor=&bin=<1h|3h|6h|12h|1d|3d|7d|14d|1mo>&chunk=<k>[&raw=1]` → `{anchor, bin, chunk, k, t0, t1, ids, counts (frame-major K×S), unmapped, partial, covered, plan}`. K = 48 (`1h`) / 24 (`1mo`) / 32 (others); the FE mirrors the table (`timelapseFrames.ts`). **Frame grid deviates from "numbered from genesis"**: frame 0 is genesis floored to the `K·bin` grid (fixed spans are epoch-aligned in pyrmts, months year-0), so every chunk lies exactly on a shard rung (`1d`×32 = one `1d@32d`, `1h`×48 = one `1h@2d`, `1mo`×24 = one `1mo@2y`, origin 2012-01); genesis is frame 17 at `1d`, 24 at `1h`, 17 at `1mo`; the FE (`timelapseFrames.ts`) uses the same origin. Shards resolve from `manifest.jsonl` (latest `written_at` per slot), not D1; footers are 2–10 KB at `rg_size 32768`, so serving is the footer path (one 64 KB range + `dt` RG pruning + projected `cell,dt,count_n` reads), no `rg_manifest`, no footer guard. The tier's shards cover first (largest rung first); finer tiers whose bin divides `bin` fill the tip (`1d` tip = `6h@8d` + `3h@4d` + `1h@2d`, summed at pivot); uncovered frames → `partial: true` + `gaps`. Canonical mode folds merged `s:` leaves via the id-map until `TL_CANONICALIZED=1` says the prefix has `c:` rows; `?raw=1` = raw leaves. Cache: closed chunks (fully covered by the requested tier, ended ≥5 min ago) `max-age=86400, immutable`, else `max-age=3600`; edge-cache key folds `RIDES_CACHE_GEN` + `TL_PREFIX` (`wrangler.toml` var, now `rides-tl`; the gate below also passes on the full-history build, and a 2014 `1d` chunk reads 39 KB from the `1d@1024d` shard in ~0.5 s cold). Measured (scratch build, HTTP-backed local worker): `1d` chunk 203 KB raw / 50 KB gzip, `1h` chunk 243 KB / 58 KB, cold 0.2–0.5 s, edge hit ~2 ms. Validation: Σ `1d` frame for 2025-06-10 = 147,465 start / 147,226 end = `/api/rides?bbox=` system totals; Σ of the day's 24 `1h` frames equal too (`tl.e2e.test.ts`). FE (`wip-deckgl`): `api` source first in `auto`, falling back to `shard`/`synth` on `partial` (badged), `b=1h` with `t=YYMMDDTHH`, hourly clock/steps. *Not yet*: totals-strip polish, `act`/`split` presets, pins + sparkline, idle fan-out, `tl-stations.json`.
- **P3: movie mode.** `?mv=1`, `window.__tl.seek`, `data-tl-frame`, `preserveDrawingBuffer`, cached tiles. scrns entries for 2–3 showcase movies (a summer week hourly; a year daily; the 2013→now expansion at `1d`, sparse `fpb`); check determinism twice.
  - *P3 status (2026-09-28, `wip-deckgl`)*: movie mode landed with the rest of P2's FE. `?mv=1` drops the control bar, drawers and hotkeys, fixes the camera from `ll` (`GLMap` `interactive={false}`), turns picking off, and keeps the clock (date + rides started), legend, a "no data" badge, and an optional `?cap=` caption. `window.__tl = { frames, seek }` with `frames = nBins × fpb`; `seek(i)` (serialized) awaits both anchors' chunks under `⌊t⌋` and `⌊t⌋+1`, a committed render at exactly that `t` with the pair ready and the scale frozen, a deck redraw of those layers (`GLMap` `onAfterRender`), and MapLibre idle, then sets `data-tl-frame` on the page element; on load it seeks to the URL's `t`, so `[data-tl-frame='0']` is the ready selector. `preserveDrawingBuffer` only in movie mode. `GLMap` takes `tileBase`, but no tile cache covers the timelapse view yet (the checked-in one is z=12 around one `/stations` screenshot), so the scrns entries omit it and depend on Stadia. scrns entries live in `www/scrns.timelapse.json` (`pnpm scrns:tl` → `tmp/movies/`), not `scrns.config.json`, so the plain `pnpm scrns` doesn't render 2,000+ frames: a summer week hourly (`fpb=4`, 672 frames) and 2024 daily (`fpb=4`, 1,464 frames); the 2013→now expansion movie isn't added yet. Measured locally (headless Chromium, 1080², local worker): ~130 ms/frame seek+screenshot, no black frames; the same URL + frames captured twice gave byte-identical PNGs (Stadia tiles cached by then; not yet checked in the Docker/amd64 setup); the 672-frame week renders to MP4 via scrns in ~1m50s. Also in this pass: `act` (flowLens ramp, additive blend) and `split` (warm disk = starts, cool ring = ends) presets with per-preset legends, `st=` + `s` cycling; the global scale is the p99 of per-station-frame starts + ends over the first chunk pair the playhead lands on, frozen per bin for the session (client-side stand-in for `tl-scale.json`); pins (`sel=`, click toggles, yellow ring, drawer card with a sparkline over cached chunks, `esc` clears); the idle fan-out prefetch (`timelapsePrefetch.ts`: ±1, ±2, ±4, ±6, then doubling, one request in flight, re-targeted on every chunk change); partial tip chunks keep their `covered` frames and badge the rest "no data" without stalling playback; `1mo` K = 24 mirrored in `TL_K`.
- *Control-bar UX (2026-09-28, `wip-deckgl`)*: all nine `/api/tl` tiers exposed (`1mo` frames are calendar months, same origin math as the worker; `DEFAULT_SCALE` per tier until the frozen per-bin p99 lands); per-bin clock labels (`Tue, Jun 10, 2025 · 18:00–21:00`, `Jun 5–11, 2025`, `June 2025`). Range picker for `d`: two date inputs bounded by genesis … the last published day (end of `station-urls.json` `latestMonth`) plus per-bin presets (`1h`: 1d/3d/1w/2w … `1d`: 1mo/3mo/1y/all); a preset keeps the current end when the playhead fits, else starts at the playhead. Frame-count guard: sub-day ranges over 1,500 frames show a "use <bin>" button; edits past 6,000 frames are trimmed (keeping the edited side, with a note); a bin switch re-fits the range to the new bin's default span around the playhead when it'd be > 1,500 frames at a finer bin or < 4 at a coarser one; changing the range clamps `t`. Scrubber hover previews the frame under the pointer (map + clock, hover line, floating-ui tip `Tue Jun 10 · 18:00 · 7,893 rides`), pausing playback while hovering (resumed on leave); click commits `t`; touch keeps tap/drag-to-commit. Pure logic in `query/timelapseControls.ts` (+ tests).
- **P4 status (2026-09-28): full-history build done.** `engine config -C rides-tl-<a> -R -u` + `engine submit -C rides-tl-<a> -R -f -r 2013-06-01/2026-09-01` (capped at the latest published month, not "now", so no open tip is built), both anchors, ~20 min wall each incl. Spot startup. **275 shards / 581 MB per anchor**: `1h` 154 shards / 269 MB, `3h` 135 MB, `6h` 80 MB, `12h` 49 MB, `1d` 7 shards / 26 MB, coarser tiers < 20 MB together (the `1h` figure is under the 0.6 GB extrapolation because of historical station growth). **Validated** (read-only, `tmp/p4/`): manifests clean (275 latest, hash = md5 prefix, no gaps/overlaps in any of the 14 tiers; mid tiers end at their last rung boundary exactly as `rides/start` does, the tail being served cross-tier); footers all `dt,cell` / 32768; the exact-match gate vs `/api/rides` passed on 2014-07, 2019-10 and 2024-03 for both anchors, system-wide per day and for 3 stations per month (zero diffs); frame cost on a 2019 `1h@32d` shard = 1.4 KB/frame projected in a 48-frame chunk, 5.4 KB/frame in a 32-frame `1d` chunk from the 10 MB `1d@1024d` shard. Raw ids: 2014 shards are all numeric legacy ids (302/338 map to clusters; 36 are stations that died before short_names); 2026 has 2,433 ids, 947 in merged clusters, 1,486 singletons; leftovers to look at before the canonicalize pass: `s:Shop Morgan ` (trailing space, 42 rides) and two trailing-zero-dropped ids the id-map doesn't cover, `s:3576.1` (532) and `s:3593.1` (4,956), whereas `s:6131.1` does map. **Monthly extension wired** (`ctbk gbfs rides-tl-extend <YM>`, `ctbk/gbfs_cli.py`): `engine submit -C rides-tl-<a> -R -f -r 2013-06-01/<first of the month after YM>` for both anchors — fill mode builds only the missing shards, and the cap is the last published month's end, never "now", so no open tip is built — then `engine watch` on both job ids (the anchors run concurrently); `-n` prints the two submit commands (`test_rides_tl_extend_dry_run`). CI runs it right after `rides-extend` (`ci.yml` "Extend rides-tl": `continue-on-error` + a Slack `:warning:` on failure, since nothing on prod serves `rides-tl` yet, so it must block neither the month nor the deploy). No canonicalize pass is mirrored for `rides-tl`: `/api/tl` folds merged `s:` leaves at serve time while `TL_CANONICALIZED` is unset, so `rides-extend`'s canonicalize step gets a `rides-tl` twin only when the `c:` pass lands. Not yet done from this bullet: the canonicalize pass (`c:` rows), `tl-stations.json`.
- **P4: backfill + CI.** Full-history `rides-tl` build on Batch (genesis → latest; ~0.5 GB/anchor at `1h`); `rides-tl-extend` alongside `rides-extend` monthly; canonicalize pass included on id-map changes; `tl-stations.json` regen in `ctbk update`.
- *Mobile UX pass (2026-09-29, `wip-deckgl` `a966088c`)*: header strip, chevron transport, collapsible ⚙ controls, selection panel, long-press multi-select + rect select, `sz`, hover-only tooltips, range-fill prefetch (all under Layout / Client cache above). `VITE_API_BASE=http://localhost:…` is rewritten to the page's host (`lib/apiBase.ts`) so the dev FE works from a phone on the tailnet (the local `wrangler dev` must bind `--ip 0.0.0.0`). Verified in desktop Chrome and a 400×850 iframe; long-press / rect gestures only via synthetic touch pointer events, so real-device feel is unverified.
- **P5 (v1.5): `col` 3D preset.**
- **State frames (later)**: the same transposition for `smg-v1` (`dt,s2_cell` sort, identity-only) gives availability/state timelapses through the same endpoint shape.
- **v2: arcs.** Estimate first, then build.

## Open questions

- **Station moves.** v1 uses one position per canonical station, so a relocated station never moves. `station-observations.parquet` (per-day `id/lat/lng`) could feed a per-station position timeline in the sidecar (`positions: [[fromDate, lat, lng], …]`), with the FE picking the position for `t`. Worth it only if moves are visually significant; count them in P0.
- **Chunk size `K` per tier**: 48 h / 32 d are guesses balancing request count against bytes; tune from P0 measurements (target ≤ ~1 MB compressed per chunk).
- **Default range.** The last full year at `1d` is the best first impression ("the year in Citi Bike"). Alternatives: the last full week at `1h`, or the whole history at `1d` (~4,850 frames, ~150 chunks).
- **Dims.** `rides-tl` sums away `user_type`/`bike_type`. An "e-bike share" color preset would need `bike_type` kept as a dim (~+50% rows). Decide after the P1 feel-read; adding it later is a config change and a rebuild.
- **Entry points.** Link from `/stations` and the Home map embed, a SpeedDial action; eventually a "play" affordance on the unified page's shared time range (`unified-page-architecture.md`).
- **Canonical vs raw.** Frames are canonical, so merged clusters render as one dot; `?raw=1` exists for audit only.

## Non-goals

- No change to the existing `rides-{start,end}` layout or `/api/rides`; `rides-tl` is an additional pyramid.
- No S2 rollups in `rides-tl`, no pre-rendered tiles, no viewport filtering of frame data: every station is drawn every frame.
- No D1 usage (v1 or v2).
- No per-trip animation (`TripsLayer`) in v1/v2.

[`scrns`]: https://www.npmjs.com/package/scrns
