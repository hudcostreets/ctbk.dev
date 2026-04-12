# Spec: Sub-Daily Zoom for Station Trips

## Goal

On `/s/:slug`, let users zoom in from monthly to daily and hourly trip
volumes for a specific station. Target use case: *"show me bike activity
at this station on the evening of 2024-06-15, hour-by-hour"*.

## Why

The monthly chart (see `station-trips-monthly.md`) is a good overview but
obscures patterns like:
- Commute peaks at transit-adjacent stations
- Weekend vs weekday variation
- Weather / event disruptions

## Data Availability

`ctbk agg` already supports arbitrary group keys. We'd add:

- `ymdrsgtb_cd` (by start station, day granularity)
- `ymdrsegtb_cd` / `ymdregtb_cd` (end side)
- `ymdhsgtb_cd` / `ymdhegtb_cd` (with hour, for intra-day)

Sizes (rough):
- Daily, per station: ~365 days/year × ~12 years × ~2,609 stations × 2 sides ≈ 23M rows across all dim combos. Probably closer to 100M with full dim breakdown. Still fits D1 if we store in a narrower schema.
- Hourly: 24× that. Pushes into "probably too big for D1" (~2 GB compressed, many GB expanded).

## Storage Tiers

Propose tiered storage matching the awair pattern:

| Granularity | Where | Access pattern |
|-------------|-------|----------------|
| Monthly | D1 `station_trips_monthly` | Default chart view, all history |
| Daily | D1 `station_trips_daily` (or R2 parquet) | When zoomed in to ≤1 year |
| Hourly | R2 parquet per (station, month) | When zoomed in to ≤1 week |

Frontend decides which tier to fetch based on the visible time range.
Worker API abstracts this: `/api/stations/:id/trips?from=...&to=...&grain=auto`
picks the right tier.

## UX

Reuse pltly's multi-resolution machinery — window size auto-adapts to the
visible range. Current chart is monthly bars; zoom reveals daily bars,
further zoom reveals hourly.

Transitions:
- 10+ years visible → monthly bars (coarse)
- 1–2 years → monthly bars
- 3 months – 1 year → daily bars
- 1 week – 3 months → daily bars (or weekly aggregates)
- <1 week → hourly bars

## Implementation Phases

This is a **larger spec**; not for immediate build. Blocked on:
1. Monthly chart + controls done (`station-trips-monthly.md`)
2. New `agg` granularities added to `ctbk`
3. Decision on tiered storage vs all-in-D1
4. Date range widget that supports arbitrary start/end (see below)

## Related: Flexible Date Range Widget

Currently the homepage has preset durations (1y, 2y, 3y, ..., All). Replace
with:
- Range picker: any month → any month (month-level granularity minimum)
- Duration presets as shortcuts (1y, 3y, etc.)
- URL-serializable (`?from=202401&to=202406`)
- When zooming on the chart itself (drag-select), update the URL

Extend awair's date-range controls (see `$c/awair`) for inspiration and
possibly extract into a shared hook/component.

## Open Questions

- Day-grain data volume: pre-compute all dim combos, or only the base
  `ymd_c` (date + count) and filter client-side?
- Hourly: store in R2 parquet (per station per month) and stream via
  Worker, or attempt to fit into D1 with aggressive schema compression?
- For very active stations (thousands of trips/day), hourly bars are
  useful; for sleepy stations, they're noise. Auto-collapse?
