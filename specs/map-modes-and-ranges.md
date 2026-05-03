# Spec: stations map — arbitrary date ranges + mode toggle (circles | pies | cylinders3d)

Status: **open** (2026-05-02).

## Goals

1. Replace the current monthly-static map data path with `/api/totals?kind=trips`,
   so the map respects an arbitrary date range like the rest of the app.
2. Add a render-mode toggle: **circles** (radius=count, today's default),
   **pies** (split start/end at each station), **cylinders3d** (deck.gl
   `ColumnLayer`, height=count, with start/end side or stack mode).
3. De-POC `StationPies.tsx` (currently behind `?pies=1`).

References: deck.gl 3D map precedent in `~/c/jct` (Jersey City 311 calls)
and `~/c/nj-crashes` (NJ crash counts by location).

## What exists today

- **`StationMapEmbed.tsx`** loads from a static `manifest.json` on
  `s3://ctbk` listing per-month `stations[ym]` JSON URLs. Hard-codes "latest
  month." No date-range UI on this view.
- **`StationMap.tsx`** renders Leaflet circles, takes a `pieRange?: TimeRange`
  prop, and conditionally renders `StationPies` over the circles when
  `?pies=1` is set.
- **`StationPies.tsx`** is a working POC: one `useTotalsQuery` call against
  `/api/totals?kind=trips&scope=stations&filter.short_name=<visible>` for the
  visible viewport, returning rows with start/end side counts. Renders SVG
  pie slices via custom Leaflet `divIcon`.
- **`useTotalsQuery`** (rollups.ts) supports arbitrary `(from, to)`,
  `filterShortName`, `filterRegion`, `filterSide`, `dims`. **The infra for
  arbitrary range + start/end split is already in place.**

## Design

### Date-range picker

Reuse the same `RangeWidthControl` + `BinSelect` pattern as the station
detail page, dropping `BinSelect` (the map doesn't bin in time). The
`TimeRange` URL codec (`?r=-30d` etc.) carries the state.

Default view: `?r=-30d` (last 30 days). The "Latest" mode (no `?r=`) means
"now backwards 30d" — different from the per-station chart's "Latest"
(no end ts) but the codec accommodates both.

### Render mode toggle

URL param `?m=circles|pies|cylinders3d` (default: `circles`). Toggle UI is
a 3-button segmented control adjacent to the range picker.

#### `circles` (default)

Existing `StationMap` Leaflet-Circle path. radius = `f(count)`. Currently
count = `starts + ends`. Add a `?side=start|end|both` URL param:

- `both` (default): radius = starts + ends.
- `start`: radius = starts only, color = blue.
- `end`: radius = ends only, color = orange.

Backed by `useTotalsQuery({ kind: 'trips', scope: 'stations',
filterShortName: visible, filterSide: side })`.

#### `pies`

De-POC of `StationPies.tsx`:

- Drop the `?pies=1` flag; mode toggle is the new gate.
- Move from divIcon SVG to deck.gl `IconLayer` w/ canvas-rendered pies,
  OR keep Leaflet divIcon (lighter; current impl works). Pick by
  smoothness: if pies feel laggy on pan with 200+ stations, switch to
  deck.gl.
- Same data path as circles: one `/api/totals` call with `dims=side` (or
  two parallel calls without `dims`, one per `filter.side`).
- `MIN_ENDS_FOR_PIE` threshold stays — small stations render the
  underlying circle only.

#### `cylinders3d`

New `StationCylinders3D.tsx` using deck.gl. Two viable architectures:

1. **deck.gl as a Leaflet overlay layer** (`@deck.gl/leaflet` adapter, or
   custom Leaflet pane wrapping a deck.gl canvas). Keeps the existing
   tile/UI layer and only swaps the geometry layer. Easier integration.
2. **Replace Leaflet with a deck.gl `MapboxOverlay` or pure deck.gl with
   `TileLayer`**. More native 3D feel (perspective rotation, terrain),
   bigger refactor. JCT and nj-crashes both went this route.

Recommendation: start with (1) for ship-velocity, plan a separate phase
to evaluate (2) against feature parity.

deck.gl layer choice: **`ColumnLayer`** (extruded hexagonal columns) or
**`ScatterplotLayer`** with `getElevation` for cylindrical-feeling rendering.
`ColumnLayer` is the canonical "3D bar at each (lat, lng)" — pick that.

Data:

- Same `/api/totals?kind=trips&scope=stations&filter.short_name=<visible>`
  call as the other modes.
- For "stack starts + ends" mode: two `ColumnLayer`s at the same lat/lng,
  one for starts (offset 0), one for ends (offset = startsHeight).
- For "side by side": offset cylinders horizontally (small jitter).
- For "split by ride type" (rideable_type/user_type): future, not v1.

UI:

- 3D pitch slider (0° = top-down → looks like circles; 60° = oblique 3D).
- Optional: rotate / orbit gesture on right-click drag.
- Color: same blue/orange palette as circles for start/end.

### Repointing `StationMapEmbed`

Today the home-page embed loads from the manifest. Once the API path
works for the full-screen `/stations` view, repoint the embed too:

- Drop `manifest.json` fetch.
- Use the same `useTotalsQuery` call with the same `?r=` default.
- `latestMonth` label becomes `formatTimeRange(range)` ("Last 30 days"
  etc.) and updates with the picker.

The `s3://ctbk` per-month static `stations[ym].json` files are no longer
on the critical path. Keep them for the public archive (the URL pattern
is documented in pipeline docs); future reaper if storage matters.

## Migration plan

1. **Phase 1 — circles via API.** Add the date-range picker + side toggle
   to `/stations`. Keep mode=circles only. Verify correctness against the
   current monthly-static numbers (sum over month should equal). Ship.
2. **Phase 2 — de-POC pies.** Add mode toggle (circles | pies). Move the
   `?pies=1` flag's logic onto the toggle. Ship.
3. **Phase 3 — cylinders3d (Leaflet overlay).** Introduce deck.gl as a
   dependency. ColumnLayer with ColumnLayer + a pitch slider. Ship.
4. **Phase 4 (optional) — full deck.gl.** If the Leaflet-overlay approach
   feels constrained (pitch ceiling, perf at 2000+ stations, terrain),
   migrate to a deck.gl-native map. Reuse JCT/nj-crashes patterns.

Each phase is independently shippable; order them as time permits.

## Open questions

- **Polygon region aggregation.** Out of v1; the visible-viewport clip is
  enough for now. If we want lasso-select later, deck.gl's draw layer
  gives us the polygon and the FE filters station list to those inside →
  refetches. The backend's `/api/totals?scope=regions` already supports
  named regions but not arbitrary polygons.
- **Trip lines** (`StationMap.tsx` currently draws lines between stations
  for selected pairs from `station-pair-jsons/<id>.json`). For an
  arbitrary date range, we'd need an `/api/pairs?from=&to=&station=`
  endpoint. Defer until trips work hits — not on v1's critical path.
- **Cache heat.** With arbitrary ranges, the first user picks a window and
  pays the cold cost. The worker `caches.default` quantization on
  `(qFromS, qToS)` already buckets nearby ranges. Worth bumping
  `Cache-Control` for closed windows here too (same as `avail-perf-pass`).
- **Mobile 3D.** Pitch + orbit on touch is awkward. Default to top-down on
  small viewports; surface the 3D view only behind an explicit toggle on
  mobile.

## Acceptance (per phase)

Phase 1: `/stations?r=-30d&side=start` shows starts-only circles for the
last 30 days, sized correctly. Switching `&side=end` updates without a
reload. `?r=-1y` works. Latency on cold cache < 3s.

Phase 2: `?m=pies` renders start/end split per station, comparable
visual to current `?pies=1` POC.

Phase 3: `?m=cylinders3d&pitch=45` renders extruded columns at each
station, height = count. Stack mode shows starts + ends as one column.
