# Spec: Multi-Scale Time Series Library (Umbrella / Tracking Doc)

## Problem

Across multiple projects, we keep rebuilding the same pattern:

- **awair** (air quality sensors, per-minute): Lambda writes parquet →
  browser renders multi-resolution time series via `pltly`.
- **ctbk** (this project): CF Worker writes R2/D1 → browser renders
  multi-resolution availability + monthly trip charts.
- **apvd** (uses older `agg-plot`, now pltly): similar multi-scale
  visualization.

Common needs:

1. **Renderer-agnostic aggregation**: given raw data points, auto-pick a
   window size based on visible range and target point count. Compute
   mean/stddev/min/max per window. Rolling averages, log-space windows,
   gap detection. (Already in `pltly`.)
2. **Data tiers**: raw points (minute-level) → aggregated tiers (hourly,
   daily, monthly). Frontend fetches the appropriate tier for the visible
   range.
3. **Live refresh**: auto-update when upstream appends new points, synced
   to the upstream cadence (e.g. every minute with an observed intraminute
   offset).
4. **Flexible date range controls**: any-start to any-end, plus duration
   presets, URL-serializable.
5. **Renderer**: currently pltly wraps Plotly. This repo uses uPlot for
   some charts. The abstraction should support both.

## Current State

| Project | Lib used | Renderer | Multi-scale? | Live refresh? |
|---------|----------|----------|--------------|---------------|
| awair | `pltly` | Plotly | Yes (client-side from 1 parquet) | Yes (smart polling) |
| ctbk homepage | custom | Plotly | No (single monthly dataset) | No |
| ctbk `/s/:slug` availability | custom | uPlot | Not yet | Not yet (see `live-minute-refresh.md`) |
| ctbk `/s/:slug` trips | custom | Plotly | Not yet (see `station-trips-monthly.md` + `station-zoom-subdaily.md`) | N/A (monthly data) |
| apvd | `pltly` | Plotly | Yes | Unknown |

## Proposed Shape

Not committing to a specific library yet — tracking the factoring pressure.
Three candidate directions:

### A. Extend `pltly`
Add uPlot support as a second renderer backend. Pros: one lib, familiar.
Cons: plotly and uPlot have very different APIs; abstracting over them is
nontrivial.

### B. Split: `pltly-core` + `pltly-plotly` + `pltly-uplot`
Core holds the renderer-agnostic logic (window selection, aggregation,
rolling averages, date-range utilities, smart-poll hook). Renderers are
thin adapters.

### C. Keep libraries independent, share smaller utilities
e.g. a `@rdub/time-series` package with just the window-selection and
aggregation math, used by both pltly and any future uPlot wrapper.

Leaning toward **B** once we have 2+ concrete consumers for each renderer.

## Factoring Candidates from awair

awair already has mature implementations of several patterns we need:

- **`useSmartPolling`** (`$c/awair/www/src/hooks/useSmartPolling.ts`):
  burst-retry after mtime + exponential backoff + visibility-aware.
- **`DevicePoller`** (`$c/awair/www/src/components/DevicePoller.tsx`):
  headless poll orchestrator, only polls when viewing "latest".
- **`RangeWidthControl`** (`$c/awair/www/src/components/RangeWidthControl.tsx`):
  duration picker (6h/12h/1d/3d/7d/14d/1mo/2mo/3mo/All) + "Latest" toggle.
- **`timeRangeCodec`** (`$c/awair/www/src/lib/timeRangeCodec.ts`):
  compact URL codec: `[YYMMDD[THHMMSS]][-duration]`
  (e.g. `251123-3d` = 2025-11-23 minus 3 days).
- **Row-group parquet caching** (`HyparquetSource` / `ParquetCache`):
  HTTP Range Requests for partial parquet reads, `Last-Modified` check
  to detect new data without downloading.

These are strong candidates for factoring. Initial path for ctbk: port
verbatim, keep APIs stable, extract into shared package later.

## Factoring Candidates (from ctbk)

As we build out ctbk features, these should eventually move into the
shared lib:

- `smoothRow` (capacity-based smoothing for bike/dock counts) — ctbk-specific
- `useLivePoll` (`specs/live-minute-refresh.md`) — shared
- Stepped area rendering with bands → uPlot renderer
- Interactive legend with solo/hover/dim → shared component
- Flexible date range widget (see `station-zoom-subdaily.md`) → shared
- Multi-tier fetch abstraction (minute → hourly → daily → monthly) → shared

## Non-Goals (for now)

- Don't block ctbk feature work on library factoring. Build inline, factor
  later when the interface stabilizes.
- Don't try to unify Plotly and uPlot APIs pre-emptively.

## Next Concrete Steps

1. Finish the ctbk feature set (trips chart, subdaily zoom, live refresh)
2. Once awair/ctbk/apvd all have implementations, compare and extract the
   3-way commonalities into `pltly-core` (or whatever name)
3. Migrate existing usages to the shared lib

## See Also

- `specs/station-trips-monthly.md` — monthly chart with homepage controls
- `specs/station-zoom-subdaily.md` — drill down to day/hour
- `specs/live-minute-refresh.md` — intraminute-offset polling pattern
