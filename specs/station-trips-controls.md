# Spec: Station Trips Chart Controls

## Goal

Render the per-station monthly trips chart (`/s/:slug`) with full
homepage-style controls, plus a stats block above it. Consumes the
per-station `ymdgtb_cd.json` files from
`specs/station-trips-static-json.md`.

## Data Contract

Client fetches `/assets/stations/ymdgtb/{short_name}.json`. Each row:

```json
{
  "Year": 2023, "Month": 7,
  "Docking": "start",              // NEW: 'start' | 'end'
  "Gender": 0, "User Type": "Annual", "Rideable Type": "classic",
  "Count": 124, "Duration": 987654
}
```

Note: no `Region` column (per-station files, drop it). If the chart
code wants to filter by region it can fall back to a default (the
station's region from metadata).

## Component Structure

New component: `<StationYmrgtbChart rows={...} />`. Delegates rendering
to `<YmrgtbChart>` (already factored), adds:

1. **Docking toggle** (stack-by-docking, or show starts/ends/both as
   filter)
2. **All homepage controls**: StackBy, YAxis, RollingAvgs, StackPercent,
   filters (user type, gender, rideable type)
3. **Stats block above chart**: total starts, total ends, ratio,
   avg/month, top month
4. **Date range**: shared widget from homepage (`MonthRangePicker` +
   duration buttons)

## StackBy Extension

Add `'Docking'` as a new `StackBy` value:
- Stack colors: start = blue, end = orange
- Applied via the existing `extraFilter` / stacking machinery in
  `buildTraces`

This requires adding `'Docking'` to:
- `StackBy` type in `www/src/data.ts`
- `StackByQueryStrings` (pick a code, e.g. 'd')
- `stackKeyDict` (`'start' | 'end'`)
- `Colors` record (new `DockingColors` map)
- The stackVal switch in `buildTraces`

## Stats Block Layout

Simple Grid above the chart:

```
+-------------------+-------------------+-------------------+
| Total starts      | Total ends        | Start/end ratio   |
| 12,345            | 11,987            | 1.03              |
+-------------------+-------------------+-------------------+
| Avg/month         | Peak month        | First / last      |
| 1,234             | 2023-07 (2,345)   | 2018-06 / 2026-04 |
+-------------------+-------------------+-------------------+
```

Computed from the same rows as the chart. React component lives next
to `StationYmrgtbChart`.

## URL State

Station detail page inherits most URL params from homepage conventions,
but in its own namespace (don't collide with homepage when navigating):
- `?y=r|m` — Y axis (rides vs minutes)
- `?s=None|d|r|u|g|b` — stack by (add 'd' for Docking)
- `?avg=12` — rolling avg
- `?d=...` — date range (same format as homepage)
- `?u=a|d` — user type filter
- `?g=m|f|u` — gender filter
- `?rt=c|e|u` — rideable type filter

## Implementation Phases

1. Extend `StackBy` / `stackKeyDict` / `Colors` to include `'Docking'`
2. Build `StationYmrgtbChart` with controls + stats
3. Wire into StationDetail below the map
4. Remove the placeholder `StationTripsChart` (the simpler one built
   earlier)

## Dependencies

Blocked on:
- Per-station `ymdgtb_cd.json` files (EC2 implementing
  `specs/station-trips-static-json.md`)

## Open Questions

- Should the docking toggle be:
  (a) a `StackBy` option ("Stack by Docking" → show both as colored bars), or
  (b) a filter ("show starts / show ends / show both" radio group)?

  Probably both — user wants to see the split, and also wants to filter
  one side out. Maybe implement (a) as StackBy, and (b) via the user
  clicking the legend entry for one side to hide it (existing Plotly
  behavior).

- Default view: stacked by Docking, or None (total trips)?
  Probably Docking by default since that's the interesting split.

- Should the stats block show a sparkline mini-chart above the main chart?
  Probably not — adds visual complexity.

- On very long histories (10+ years monthly), is there a way to
  switch into day/hour view via legend or zoom gesture? Defer to
  `specs/station-zoom-subdaily.md`.
