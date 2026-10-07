# Unified page architecture: (station-set × time-range) → {rides, map, avail, states}

Status: in progress on `wip-deckgl` (rebased onto `main` 2026-09-29): map mechanics + lens shipped; the GL map (deck.gl + MapLibre) is now the **default** on `/stations` and the Home embed, with the shared `lib/mapSelection` selection model (Leaflet via `?gl=0`)
Author: Ryan + Claude
Date: 2026-09-08

## Motivation

Today ctbk.dev has three pages that are really three views of the same thing, each with its own state model:

- `/` (Home): system-wide rides plot + a map embed + a system station-states (SMG) panel. Has **no** station selection — its map is decorative (local state, click → a "View station details" link).
- `/stations`: a map whose `?sel=` multi-select set drives a `StationRidesPanel` and an `SmgPanel` below it. This is already the unified page in miniature.
- `/s/:id`: a single station's page — rides (monthly + rollup), availability (avail-v3), station-states (SMG), and a map centered on it.

The map itself is functional but fights the user: hovering a station is immediately intercepted by a hover on a destination *edge* drawn over it, three tooltips (source / hovered / edge-destination) compete, and a pile of workarounds (edge-click forwarding, a 150ms hover-select settle timer) compensate for edges rendered in a pane above the station dots.

The vision: **one page structure whose inputs are a set of stations (one, several, or all) and a datetime range, producing four coordinated vizzes — rides, map, availability, station-states.** The map becomes the primary selection control and a lens (color stations by their relationship to the selected set), not a spiderweb of lines. `/`, `/stations`, and `/s/:id` all become instances of this one page with different default sets.

## Current state (grounding)

Router: Vite + React SPA, `react-router-dom` `BrowserRouter` (`www/src/main.tsx`). URL state via `use-prms` (`useUrlState(name, codec)`).

Three selection encodings coexist, with no shared abstraction:

| Page | Selection | Propagation on map click |
|---|---|---|
| `/` (via `StationMapEmbed`) | local React state (`hoveredId`, `pinnedId`); no URL | shows caption + `<Link to="/s/:id">`; no auto-nav |
| `/stations` | `?sel=` multi-set (`selParam`, comma-joined short_names) + `?s=` single hover/subtitle | toggles set membership in `?sel=` |
| `/s/:id` | route param `:id` (slug/short_name/UUID) | `navigate(/s/:newId)` |

No shared date/time-range, and two different range *types*:

- Rides chart uses `DateRange` (`www/src/date-range.ts`): `"All" | {duration,end?} | {start,end?}`, param `d`.
- Everything availability/states/multi-rides uses `TimeRange` (`www/src/time-range.ts`): `{ timestamp: Date|null; duration: ms }` (null = "Latest"), params `ar` (Home SMG), `r` (`/s/:id` avail, shared with its SMG), `rr` (`StationRidesPanel`), `pr` (map pies).

The four vizzes and their inputs:

1. **Rides** — three implementations: system (`Home`, `useRidesV1`, region cell-covers, no station filter); multi-station (`StationRidesPanel` → `useMultiStationRides`, `cells=s:<sn>` identity keys); per-station monthly (`StationDetail`, `useStationTrips` / `RollupTripsChart`).
2. **Map** — `StationMap.tsx`, geometry from static `/assets/station-urls.json` (per-month `stations[ym].json` + `pairs[ym].json`), not the API. Already accepts `stationColors` (per-station fill override) and `pinnedIds`/`onTogglePin` (multi-select rings).
3. **Availability (avail-v3)** — `StationAvailabilityChart` (`/s/:id` only), per-station GBFS UUID, `useStationAvailabilityRouted`.
4. **Station-states (SMG)** — `SmgPanel` → `SmgChart`, `/api/avail-v3?pyramid=smg-v1&reducer=hist`. Selection is `bbox=` (system) **or** `cells=s:<sn>,…` (station/set), via `smgCellsFor(shortNames)`. Rendered in all three pages.

Station-filter support in the API is already good: `/api/rides-v5`, `/api/avail-v3` (smg-v1), `/api/totals`, `/api/query` all accept a station/cell filter. The blocker to unification is **frontend**, not backend.

## Target model

### The page's inputs

Two inputs, shared by all four vizzes:

- **`sel`** — a station set. Empty set = "all stations" (system view). One member = the current `/s/:id` case. Several = a region or ad-hoc comparison. Encoded as today's `selParam` (comma-joined short_names, order-preserving). `/s/:slug` becomes a pretty alias for `?sel=<one short_name>`.
- **a shared time-range** — one range that drives rides, avail, and states together, replacing the current `d`/`ar`/`r`/`rr` split.

The range-type mismatch (`DateRange` vs `TimeRange`) is the one real modeling decision. Recommendation: **standardize on `TimeRange`** as the shared page range (it already backs three of the four vizzes and supports the "Latest" anchor the availability/states data needs), and derive the rides chart's `DateRange` from it. Keep a per-viz range *override* param for the cases where someone wants the rides window wider than the states window (see Open questions).

### The four vizzes, re-scoped

Each viz reads `(sel, range)` and nothing else identity-wise:

- **Rides**: empty `sel` → system `useRidesV1` (region cell-covers). Non-empty `sel` → `useMultiStationRides` (`cells=s:<sn>`). Same chart component, two data sources behind one hook keyed on `sel`.
- **Map**: always shows all stations; `sel` drives which are ringed/emphasized and how the rest are colored (the lens, below). Clicking toggles set membership.
- **Availability**: empty `sel` → system availability overview; non-empty → the union/mean over the set. (Currently per-station only; a set view is new but the API supports `cells=`.)
- **Station-states**: `smgCellsFor(sel)` (or `bbox` when empty). Already set-aware.

### The map: mechanics fix (first increment, standalone)

The flicker/3-tooltip mess is a structural fix, independent of everything above and worth doing first:

1. **Flow layer becomes non-interactive.** Render edges with `interactive: false` / `pointer-events: none`, below the dot layer. This deletes `onEdgeClick`/`stationAtLatLng` (`StationMap.tsx:184-201`), the `edgeDstTooltip` (`:377-397`), and the `scheduleHoverSelect` settle timer (`:147-156`) — all of which exist only to compensate for edges-on-top. Nothing but stations receives hover/click.
2. **One station drawer, station-driven.** **Shipped.** Both map renderers share `StationInfoDrawer`, fixed at the top-left below the zoom control. Selected sources keep their names, total rides, and prominent "View station details" links in the drawer even when the pointer leaves the map. Hovering another station appends its name, total rides, and "N from selection" below the persistent source information; hovering a source does not duplicate it. Multiple sources have a bounded, scrollable list. The source section accepts clicks; the destination section lets pointer events pass through to the map.
3. **Inspect vs. select.** Hover = transient inspection (tooltip only). Click = persistent set toggle (already `onTogglePin`). Remove `hoverToSelect` auto-selection from the primary flow.

### The map: lens model (second increment)

When one or more stations are selected (a source set), style every *other* station by the share of the set's outbound flow ending there — the "map as lens." Encoding channels, by implementation cost:

- **color** — flat, on the current react-leaflet map, no deps. The `stationColors` prop applies it. `flowLens.ts::flowLens(stations, pairCounts, sourceIds, channel)` computes per-destination fractions (sqrt-scaled) → a cool→hot ramp for destinations, dim grey for everything else. **Shipped**: Home embed (keyed on the pinned station) and `/stations` (keyed on the `?sel=` set, taking precedence over color-by-age).
- **radius** — flat, no deps. **Shipped**: `StationMap` now takes a `stationRadii` override (per-station *pixels*, scaled to meters internally); `flowLens` fills it (destinations `R_MIN..R_MAX` by sqrt-flow, non-destinations a `R_DIM` dot) when the channel is on.
- **opacity / ring-weight** — other flat channels on the same circles, ~free once radius/color exist.
- **flow ribbons (geo-sankey)** — `$js/geo-sankey` (`runsascoded/geo-sankey`, not on npm; install `github:...#dist`). Core is dependency-free pure geometry returning `GeoJSON.FeatureCollection<Polygon>`; render in a low non-interactive Leaflet `<Pane>` via `<GeoJSON>`. The **radiating case is near-turnkey**: one `origin→dest` edge per destination, `weight = tripCount`, `renderFlowGraphSinglePoly({ refLat, zoom, mPerWeight })` → width-proportional ribbons. Widths bake in at a `zoom`+`refLat`, so re-render on `zoomend` or use `mPerWeight` for zoom-stable widths; sink arrowheads are forced-on (use `renderEdgeCenterlines` for arrow-free thin curves). It will **not** auto-compute a bundled/forking trunk — that topology (split nodes, `weight:'auto'`) is caller-designed work. Do NOT use `geo-sankey/react` (a maplibre editor).
- **height (3D)** — the only channel that can't live on the current map. jc-taxes gets 3D from **deck.gl `ColumnLayer` over a maplibre basemap with a pitched camera**; `$c/jc-taxes/www/src/gradient.ts` (hand-rolled multi-stop ramp, log/sqrt/linear position) + the `ColumnLayer` accessor pattern (`getPosition`/`getElevation`/`getFillColor`, `pickable`, GPU picking) are cleanly liftable (~150 lines fresh — do NOT lift the 1,783-line `MapView.tsx`). But **react-leaflet can't tilt the camera**, so a `@deck.gl/leaflet` overlay renders columns flat/top-down — pointless. True 3D requires a **separate deck.gl + maplibre pitched map surface** ("3D mode"), a real fork, decided separately.

Lines: kept as inert decoration under the dots (`interactive:false`, `.lines` z-index below `.circles`), faded further when the lens is active (now a dedicated `lensActive` prop → opacity 0.12, so a plain color-by-age recolor no longer dims the fan). **Shipped.** Open: replace with geo-sankey ribbons, or keep the flat faded fan.

Config: **Shipped** a `lens` URL param on `/stations` — `c` (color, default), `r` (radius), `cr` (both), `n` (off) — so the channels can be compared before any control-UI investment. The Home embed is color-only (no URL config there). Open: which channel(s) to keep as default, and whether to surface a toggle in the UI.

Non-destination treatment: **Fixed.** Stations the source set never (meaningfully) sends to render dim grey (`#888`); destinations get the cool→hot ramp — so "no trips → faint grey, more → hotter" reads monotonically. The earlier orange-heavier-than-low-flow-blue muddle is gone.

Ramp scaling: **rank, with a floor.** Fraction-of-max scaling read as a wall of blue — a busy source sends ≥1 rider almost everywhere over a month, so one dominant sink compressed the whole long tail into the ramp's cool end. Fix (`flowLens.ts`): drop destinations below `FLOOR_FRAC` (4% of the top destination) to grey, then position the survivors on the ramp by **rank** (top = hot, least = cool). Turns the wall of blue into a clear radiating gradient; grey now carries real meaning ("not a real destination"). `FLOOR_FRAC` is a tunable constant (no URL knob yet).

Source visibility: **Fixed.** The `sel` ring was bare pink `#e91e63` — camouflaged among its own hot (red) destinations, so you couldn't tell *which* station drove the lens. Now each source renders a **white halo + bold pink ring + a permanent name label** (in `StationMap`'s `multiPinRings`), unmistakable against the ramp and the tiles. Plus a **flow-lens legend** on `/stations` (top-right, clears the bottom rides panel) naming the source(s) and showing the ramp with "fewer / where riders go → / more" + a grey "no trips there" swatch — the coloring is now self-describing.

First feel-read across `c`/`r`/`cr`: **color alone reads cleanest** (grey recedes, warm=near/high; radius stays data-proportional so size still encodes volume as a bonus second signal); radius-only loses the recede-to-grey distinction (all one hue); `cr` is redundant and busy. Pending the user's pick.

Legend numbers + direction: **Shipped.** The legend now reports the set's **total** directed flow and labels the ramp with real trip counts at both ends (floor-cutoff count → top-destination count); a **⇄ direction toggle** flips `?dir=out|in` between "where riders go" (outbound) and "where riders come from" (inbound) — inbound sums `pairCounts[other][sel]` over the set, all client-side from the already-loaded pairs.

Selection interaction: **Shipped.** Plain click selects just that station (replaces the set); **meta/ctrl-click** adds/removes it (`additive` flag read from the Leaflet event); clicking empty map clears the set. The destination fan is now a `?fan=` toggle, **off by default** — it's a heavy pile of SVG polylines that, at low opacity, stacks into a red blob at the origin (see image). Still open: region-select (rect/lasso/polygon toolbar à la Preview), and an undo/redo buffer for selection edits.

### Rendering architecture (research — the "wow factor" path)

The SVG map is the real bottleneck, not Leaflet: ~2,700 stations × 2 `<circle>` + a ~600-`<Polyline>` fan, and *every* recolor/selection re-mounts the whole layer group (full DOM reconciliation per hover). SVG maps jank in the low thousands of nodes. Desired interactions the SVG arch makes expensive — recolor **all** stations on every hover (live choropleth), curved flow ribbons, 3D extrusion, hexbin density — are exactly what a GPU pipeline does cheaply.

**Recommendation: migrate the map to deck.gl layers over a MapLibre basemap (`MapboxOverlay`, `interleaved:true`)** — same stack already shipped in `$c/jc-taxes`, so setup risk is low. Key wins: one instanced `ScatterplotLayer` for all stations (100×–1000× headroom); **GPU color-encoded picking** (`pickable`/`autoHighlight`) replaces the invisible hit-circle hack; **`updateTriggers`** re-uploads only the changed fill/radius attribute buffer on recolor (never the geometry) — turning "recolor on hover" into a near-free GPU update; `ArcLayer` (with `getSourceColor`→`getTargetColor` gradient, `getWidth`, `getHeight`) replaces the fan and fixes the red-blob; `ColumnLayer` (lift from jc-taxes) for the 3D height channel; `HexagonLayer`/`HeatmapLayer` for density. Crucially, **`flowLens.ts` is already a pure `(pairCounts, selection) → per-station style` function**, so it ports unchanged into deck.gl accessors.

Incremental path (each stage ships independently, preserves current features): **0** MapLibre basemap parity (~0.5d) · **1** stations → one `ScatterplotLayer` with picking, fed by `flowLens` (~1–1.5d; kills the re-mount jank) · **2** live hover-choropleth via `updateTriggers` + GPU `transitions` (~0.5–1d) · **3** fan → `ArcLayer` (~1d) · **4** optional `ColumnLayer` 3D + hexbin (~1–2d). ~3–4 focused days to flow-arc parity. Lighter-but-dead-end fallback: keep react-leaflet, swap only the circle layer to Leaflet.glify (~1d) — fixes point jank but no arcs/3D, so not recommended given the roadmap. **Hover-driven whole-map recolor (open question below) is gated on Stage 1–2** — cheap on the GPU, a re-mount storm on the current SVG.

#### Stage 1 progress (`StationMapGL.tsx`, behind `?gl=1`)

Added on top of Stage 1 (all typecheck-clean + render-verified; the click/hover/drag *interactions* need mouse-CIC — automation couldn't reliably land synthetic clicks because the screenshot capture is scaled ~0.78× vs the real viewport, and the WebGL canvas captures black between renders): **fill/ring toggle** (`?mark=` code `f`/`r`, default fill — verified both render); **radius channel** on GL (`?lens=r`/`cr` → per-station px radii, layer switches `radiusUnits` to pixels); **hover subtitle** (`onHover`→`setSelectedId`); **live hover-preview lens** (Stage 2 — hovering a station, when nothing pinned, feeds it as the lens source so the whole map recolors by that station's flow; GL-only, gated off the SVG map); **rectangle select** (#2 — shift-drag a box, capture-phase mousedown suppresses maplibre pan + toggles `dragPan`, corners unprojected to a lng/lat bbox, meta/ctrl adds vs replaces); and a **robust click-select** (station selection via the layer's own `onClick`, not the hover ref — works for touch/programmatic clicks; empty-space clear guarded by a `justPicked` timestamp).

Built and **functionally working**: deck.gl `9.4.0` + `maplibre-gl 5.24` + `react-map-gl 8.1` (React-18-compatible; installed to match `jc-taxes`). Pattern = MapLibre root `<Map>` + deck via `MapboxOverlay` (overlaid, not interleaved — interleaved left the basemap unpainted). All ~2,700 stations render as one `ScatterplotLayer` colored by `flowLens` (ported unchanged into `getFillColor`), with GPU picking (`pickable`/`autoHighlight`, no more hit-circles), source-set pink+white rings, and the hover drawer. Click model: hover sets a `hoveredIdRef`; the map's `click` reads it (station → `onTogglePin(id, meta/ctrl)`, empty → clear) — race-free since hover precedes click. Basemap is **raster Stadia** (the Leaflet map's tiles), because the CARTO **vector** style never rendered under Vite: style/TileJSON/sprite fetch 200 but **zero `.mvt` tiles are ever requested** (maplibre worker not running under our `optimizeDeps` config) → revisit for vector later.

**"Basemap black on load" was a screenshot artifact, not a bug.** maplibre renders *on-demand* (not a continuous RAF loop), so between renders its WebGL drawing buffer is empty; a screen-capture of a `preserveDrawingBuffer:false` canvas grabs that empty buffer as **black**, even though the compositor shows the real frame on screen. deck renders continuously, so *it* captured fine — which is why only the basemap looked black in CIC screenshots, and why a pan (forcing a maplibre render right before capture) "fixed" it. Confirmed by direct on-screen observation: the basemap loads normally. Lesson: **for the GL map, interact-then-capture, or trust on-screen/DOM over a raw screenshot** (`react-map-gl` doesn't expose `preserveDrawingBuffer` as a prop). No compositing fix is needed; the ~dozen `resize`/`idle`/nudge attempts chased this ghost and were reverted. **We stay on maplibre** (the 3D-capable target arch) — no Leaflet detour.

#### Stage 3 (`ArcLayer` fan)

**Shipped.** `flowLens.ts::flowArcs(stations, pairCounts, selIds, dir)` → one arc per directed (set ↔ other) pair, in riding direction (`?dir=out`: set → other; `in`: other → set). Same `pairCounts` the Leaflet fan reads, and the lens and the arcs now share one pair walk (`directedPairs`; `flowTotals` = its per-station sum). Arcs take the lens's `FLOOR_FRAC` cut (pairs < 4% of the heaviest are dropped — the 1–3-trip tail is what piled into the SVG fan's red blob), are ranked for ramp color (`rampRgb(t)`, exported from `flowLens.ts`), and are sorted light→heavy so heavy arcs draw on top. Rendering (`StationMapGL.tsx`): an `ArcLayer` *under* the station `ScatterplotLayer`, `pickable: false` (decoration, like the Leaflet fan's `interactive={false}` edges); width `1 + 5·sqrt(count/max)` px; color fades along the arc from 40α at the origin to 230α at the destination, so direction reads without arrowheads and the origin stays legible; `getTilt: 90` + `getHeight: 0.35` lay each arc's plane flat so it reads as a curve from straight above (a 0-tilt arc is a straight line at pitch 0). Sources = the lens sources: the `?sel=` set, or (nothing pinned) the hover-preview station — so sweeping the cursor previews each station's fan live. Multi-source sets draw every source's pairs (per-pair rank, so arc color can differ slightly from the per-station lens color of the same destination). e2e: `e2e/station-map-gl.spec.ts` (GL surface mounts in place of Leaflet, legend names the source, ⇄ flips `?dir=`; no WebGL-pixel assertions).

The full map's legend has an **Arcs** checkbox bound to `?fan=` (inside the expanded legend on phones). Toggling it preserves the selected stations, direction, and map view; shared links and reloads retain the choice. Arcs remain off by default on the full map and on in the homepage embed.

Open (Stage 3):
- **Fan default on GL.** Still opt-in via `?fan=` (same param as the Leaflet fan, off by default). Arcs are now width-encoded and neutral (see "Flow encoding v2" below). They read well for one source but form a hairball for multi-station sets, so the fan stays opt-in.
- **Tilt/curvature.** All arcs bow the same way (`getTilt` constant). A per-arc sign (e.g. by bearing) would spread the bundle symmetrically; a pitched camera (Stage 4) would show the arcs' real height instead.
- **Ribbons vs arcs.** `ArcLayer` covers the "radiating" case well; geo-sankey ribbons (bundled trunks) remain a separate, heavier design.

#### GL default + shared selection model (2026-09-29)

**Shipped** on `wip-deckgl`:

- **GL is the default map.** `/stations` renders `StationMapGL` unless `?gl=0` (Leaflet `StationMap` fallback). The `gl` codec encodes GL as absent, so old `?gl=1` (and bare `?gl`) links still decode to GL. Both renderers are `React.lazy`, so each page load fetches only the one in use. Station types + tile styles moved to `stationMapCommon.ts`, so importing them no longer pulls in leaflet.
- **Home embed is GL too.** `StationMapEmbed` renders `StationMapGL` with local selection state: color lens + arc fan for the set, and a caption with the station's details link (or, for several, a `/stations?sel=…` compare link). The embed was already `lazy`, but its in-view margin (400px) meant it loaded with the first viewport on desktop (the map starts ~850px down). The margin is now 100px, so deck.gl + MapLibre (~0.5 MB gz) load only on scroll. `bundle.spec.ts` (all three tests) passes. Before this change, its two "map chunk only after scroll" tests failed against leaflet too.
- **Shared selection model** (`www/src/lib/mapSelection/`), factored out of `/timelapse`:
  - `gesture.ts`: the pure pointer state machine (was `lib/tlGesture.ts`).
  - `selection.ts`: `reduceSel`, `stationsInRect`, `gestureSelAction` (gesture output → `SelAction`) and the `selParam` codec.
  - `hooks.ts`: `useSelection(ids, setIds)` (the ids plus session-local multi mode) and `useSelectionGestures(map, {pickAt, pickRect, apply})`, which listens on the MapLibre canvas container so overlays never start a gesture.

  The model is the same on `/stations`, `/timelapse` and the embed:
  - tap selects one; a tap on empty map, or `esc`, clears;
  - long-press enters multi-select (taps toggle, empty taps are ignored, Done / Clear);
  - long-press-drag and shift-drag draw a rectangle that adds the stations inside it;
  - shift/⌘-click toggles.

  `/stations` keeps `push` history for `?sel=`, so browser back / forward undoes and redoes selection edits. The Leaflet fallback routes its clicks through the same reducer. The hover-preview lens and hover drawer are gated to `(hover: hover)` pointers. Selection panels stay page-specific: `/stations` shows the multi-select tag and Done in the `StationRidesPanel` header (a floating bar would sit under the fixed panel), and the embed uses a small `MultiSelectBar`.
- Tests:
  - vitest covers `gesture` and `selection`, including end-to-end sequences from gesture events to selection state.
  - e2e: `station-map-gl.spec.ts` covers the default map, `?gl=0` / `?gl=1`, tap / ⌘-click / empty-tap / back, long-press multi-select / Done / Esc, and shift-drag rectangles. `map-embed.spec.ts` covers the GL embed. The helper `e2e/glMap.ts` projects station coordinates from the known camera, because WebGL pixels can't be read.

Left:

- **Vector basemap.** Still raster Stadia tiles: the CARTO vector style didn't render under Vite (the worker issue in `GLMap.tsx`).
- **Home embed weight.** After scroll, the embed costs ~0.5 MB gz for deck.gl + MapLibre, versus ~50 KB for leaflet. Options: trim deck imports, or share the chunk with `/stations` prefetch.
- **Parity gaps vs Leaflet:**
  - `?pies=1` / the `?api=1` pie overlay and the `t=` tile-style picker exist only on Leaflet. GL follows the theme (light / dark raster).
  - `/s/:id` still uses Leaflet.
- Fan default on GL, tilt, and ribbons (see Stage 3 "Open").

#### Flow encoding v2 + phone layout (2026-09-29)

**Shipped** on `wip-deckgl`, after user feedback that the rainbow fan "seems gimmicky" and the phone layout overlapped:

- **Circles (the lens).** Size and color now encode the same quantity (trips to/from the set), redundantly. Default `?lens=` is now `cr` (size + color); `c` / `r` / `n` still select one channel or none. The Home embed uses `cr` too.
  - 0 trips: a grey (`#888`) dot of `R_DIM` = 1.5px.
  - ≥ 1 trip: radius `max(R_MIN, R_MAX·sqrt(count/max))`, so area ∝ trips, with `R_MIN` = 2.5px and `R_MAX` = 14px at the top station (`lensRadiusPx`). Circles no longer take a `FLOOR_FRAC` cut: the tail draws at `R_MIN`, small but not hidden.
  - Color keeps the existing cool→hot ramp (shared with `/timelapse`'s `act` preset), now positioned by **log** trips, `ln(count)/ln(max)` (`lensColorT`), instead of by rank. Color is then a true function of the count, so one legend keys both size and color.
  - Radii are px at z12 and scale √2 per zoom level, clamped to ×0.5–×2.5 (`lensZoomScale`, applied as the layer's `radiusScale`, so zooming doesn't re-run `getRadius`). Big circles draw first and small ones on top. Connected circles get a 0.75px contrasting edge (dark on the dark basemap, light on the light one).
- **Arcs (`?fan=1`).** Width is the primary channel: linear in trips, `max(1, 12·count/max)` px (`arcWidthPx`). They use one neutral hue per theme (white on dark, `#282830` on light), with no ramp. Alpha at the destination is `110 + 125·sqrt(count/max)` (`arcAlpha`); the origin end gets 15% of that, so direction reads as a fade-in. The `FLOOR_FRAC` (4%) cut is kept, and the sort is still light→heavy, so heavy arcs draw on top. Bundling by direction isn't needed: `dir=out` / `in` already makes the fan one-directional.
- **Legend** (`components/FlowLensLegend.tsx`): the source, the total, the ⇄ toggle, and a "trips per station" key (the top count plus 1-2-5 values near 1/5 and 1/25 of it, as sized and colored circles, then "● no trips"). With the fan on, it adds a "trips per arc" key (the top count, ~½ and ~⅙, as strokes). The values come from `legendTicks`.
- **Phone layout** (`< 768px`, `useWide`, following `/timelapse`):
  - The title and lens legend share one compact header strip across the top. The title is 1.05rem, and the legend collapses to a single summary line ("Trips from X +3 more · N total ▾") that expands to the keys on tap.
  - The rides panel becomes one bar: a chevron (collapse the sheet to just the bar), the station chips on one scrolling line, clear, and ⚙ (the rides/states tabs, starts/ends legend, and Range/Latest/Bin row, hidden by default). The chart is shorter (140px).
  - The panel reports its height (`onHeight`), and the SpeedDial is lifted above it at every width (on desktop it used to sit over the Bin controls).
- Tests: vitest `flowLens.test.ts` covers the scale functions, ticks, `flowLens` and `flowArcs`. e2e (`station-map-gl.spec.ts`) checks the key labels, and at 400px that the legend and panel collapse and that header, panel and SpeedDial don't overlap.

Open: multi-source fans (e.g. 4 Midtown stations) are still a hairball of 1–2px arcs at z12. Options: a stronger floor when there are many sources, or aggregating per destination. Fan stays opt-in.

## Examples, reconceived

Examples currently live on Home and set rides-chart options (`?y=`, `?s=`, `?rt=`, `?d=`). Under the unified page they split by scope:

- **Page-scoped presets** — set `sel` and/or the range: "Jersey City + Hoboken" (a region set), "8 Ave & W 33 St" (a one-station set), "This month". These become the landing affordance.
- **Rides-scoped presets** — set the rides stacking/y-axis (`y`/`s`/`rt`/`pct`). These stay attached to the rides plot, not the page.

Different `sel` values can surface different suggested presets (e.g. a single-station set suggests "compare to neighbors").

## Pre-v2 station-states data

Poller v2 (2026-08-04) sharply improved station-states quality: pre-v2 `stale_feed` is inflated by the old poller serving CloudFront-cached GBFS 1.1, so it measures our collection, not the bikes.

Recommendation: **default the states window to start at poller-v2 (2026-08-04)**, keep the dashed era marker, and let a pan / explicit "show earlier (measurement-limited)" reveal the older data with a note. Don't delete pre-v2 — it's an honest record of our own instrumentation — just don't front it. This is a small, standalone change to the SMG default window and can ship independently.

## Thumbnail landing + dynamic OGIs (later polish)

- **Thumbnail landing**: the empty-`sel` (all-stations) page shown as four viz thumbnails (rides / map / avail / states) you drill into. Teases that there's more below the fold.
- **Dynamic OGIs per station-set**: composite the four mini-vizzes into an `og:image` per `sel`. Powerful for sharing but needs a render pipeline (`scrns` exists) — last piece, not first.

## Sequencing

1. **Map mechanics fix** — non-interactive flow layer, one tooltip, click-to-scope. Isolated to `StationMap.tsx` (+ its three callers' tooltip content). Ship now; unblocks daily use.
2. **Pre-v2 states default** — small, standalone SMG window default. Ship alongside or right after (1).
3. **Map lens** — destination choropleth via `stationColors`; decide lines-gone vs single-edge-on-hover.
4. **Unified page** — the big one: shared `(sel, range)` model, converge Home/`/stations`/`/s/:id`, standardize on `TimeRange`, slug URLs as `sel` aliases. Cross-cutting; the reason for this spec.
5. **Examples reconception** — page-scoped vs rides-scoped presets; thumbnail landing.
6. **Dynamic OGIs**.

(1)–(3) are independently shippable and don't require committing to the (4) design. (4) is where the URL model and range-type decision get locked.

## Open questions

- **Range type**: standardize on `TimeRange` (recommended) and derive rides' `DateRange` from it? Or keep both and sync? Standardizing simplifies the mental model but changes the rides chart's URL param semantics (`d` → a `TimeRange`), which is a bookmark-compat consideration.
- **Per-viz range overrides**: do we want the rides window to be independently widenable from the states window (rides has years of history; states has weeks)? If yes, the shared range is a *default* and each viz keeps an optional override param.
- **Lines**: gone entirely (choropleth only), or kept as a single-edge-on-hover affordance?
- **Empty-`sel` = all**: is "all stations" the right meaning of the empty set, or should the system view be its own explicit mode?
- **`/s/:slug` canonicalization**: keep the pretty per-station URL and treat it as `?sel=<one>` under the hood (recommended), or fold everything into `?sel=` and redirect `/s/:slug` → `/?sel=`? The former preserves existing links and SEO.

## Non-goals

- No backend/API changes — station-filter support already exists across `/api/rides-v5`, `/api/avail-v3`, `/api/totals`, `/api/query`.
- No change to how map geometry loads (static `/assets/*.json` manifests).
