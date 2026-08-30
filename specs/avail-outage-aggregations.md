# avail: outage / reliability aggregations (v6 refresh)

Status: proposed. Original captured 2026-07-13 (pre-v6, pre-drop-LUC); this
rewrite brings it to the avail-v6 serving surface and adds the concrete
questions that motivate it (single-station reliability, group co-emptiness,
peak-hour slicing).

## Goal

Fast answers to "how often / how long is availability bad?" over any station
set, plus visual annotation of problem windows on avail plots. Driving
questions (user, 2026-08-29):

- How often is a station **out of bikes** (0 total) or **out of ebikes**
  (0 ebikes)? — the two primary metrics of interest.
- How often are my 4 closest stations in that state **all at once**?
- …restricted to **peak commute hours** (e.g. 7–10am weekdays).

(Not a priority: "classic-only" = `ebikes==0 AND bikes>0`. It's the one
*joint-across-metrics* case and the only reason to touch two metrics together;
demoted to the footnote below since the questions above don't need it.)

## What already exists (don't rebuild)

- **Station sets.** `/stations` has a multi-select set (`?sel=` URL codec,
  `www/src/pages/Stations.tsx`) and named sets via `neighborhoods.json`
  (`ctbk neighborhoods`). "My 4 closest" is a `?sel=` set or a neighborhood.
- **Per-metric histograms.** avail-v6 stores five histogram-monoid metrics —
  `bikes`, `ebikes`, `docks`, `disabled`, `pending` — per (`s2_cell`, `dt`)
  (`configs/pyramids/avail-v6.yaml`). GBFS `num_bikes_available` is TOTAL, so
  classic = `bikes − ebikes`.
- **Serving.** `/api/avail-v3[/cells]?from=&to=&cells=|bbox=&reducer=` (serves
  the default pyramid = v6; the `-v3` in the path is legacy naming). `reducer`
  ∈ `mean|min|max|p05|p25|p50|p75|p95|hist`; `hist` returns full per-metric
  histograms. `/cells` returns one row per station; the rollup route collapses
  `dims` and sums across the set (`gbfs/api/src/avail_geo.ts`).
- **FE chart.** `StationAvailabilityChart.tsx` (uPlot) already renders a
  station's series.

## Monoidal (cheap, any tier/window) vs. joint (needs a fine scan)

The split is the whole design. A histogram monoid answers questions about ONE
metric's MARGINAL distribution; anything joint (across metrics, or across
stations, at a specific instant) is not recoverable from merged histograms.

**Monoidal — cheap, any tier/window — and it covers both primary questions:**

- `% time 0 bikes` for one station over a window = `h_bikes[0] / Σ h_bikes`.
- `% time 0 ebikes` = `h_ebikes[0] / Σ h_ebikes`. **Also cheap** — it's the
  `ebikes` metric's own bin 0, a separate marginal from `bikes`, so no joint is
  involved. (`0 docks` likewise.) Proven during the OGI work (the og card's
  "% of the time no bikes, last 30d" is exactly this shape).
- `% time < N` = `Σ_{v<N} h[v] / Σh`.
- Per-station stats over a set: one `/cells` request, fold each row.

  Caveat (unchanged): on the ROLLUP route the histogram mixes stations —
  `h[0]/Σh` reads as "fraction of station-minutes empty", NOT "fraction of
  minutes where ANY/ALL empty". Per-station needs `/cells`.

So "how often is station X out of bikes / out of ebikes, last 30d" is a
histogram read at any tier — the cheap path, shippable first.

**Joint — NOT monoidal, needs a scan of fine bins:**

1. **Group co-emptiness** (k of N stations at 0 at the same t) — the "are all 4
   dry at once?" question, and a joint ACROSS stations. Needs per-station series
   aligned per bin, then `k(t) = #{stations : bikes(t)=0}` folded
   client/worker-side. Simultaneity requires bins fine enough that a bin ≈ an
   instant: at a coarse tier a station's bin is a distribution, and even
   `reducer=min=0` only says "some minute in this bin was empty" without telling
   you WHICH minute — so cross-station alignment is lost above the fine tiers.
   The per-station "% time empty" fractions above are cheap; only their
   *simultaneity* costs a scan.
2. **Spans / runs** ("0 bikes for ≥15 min", count + length distribution) —
   boundaries don't survive histogram aggregation. Same fine-scan path.

Footnote — **classic-only** (`ebikes==0 AND bikes>0`), not a current priority:
a joint across two metrics. Marginals give `P(ebikes=0)` and `P(bikes=0)`
separately, never the joint, so it'd need the same fine scan. Left out of the
increments below.

**Peak-hour slicing** is orthogonal to both: it's a periodic (hour-of-day,
day-of-week) filter, not a window. Neither the monoid nor a plain window gives
it — scan fine bins and bucket by `hour_of_day(dt)`. Cheap for bounded windows
(a month of 1m bins × a handful of stations); wide windows want a coarser bin
with a conservative reducer, accepting the simultaneity caveat above.

## Increments

1. **Worker `/api/avail-v3/stats?cells=&from=&to=&thresholds=&hours=`** —
   monoidal fractions (1) from `hist` + fine-scan spans (3) over ≤ ~31d
   windows; optional `hours=7-10` weekday-peak filter. Returns per-station
   `{pct_zero_bikes, pct_zero_ebikes, pct_zero_docks, spans:[…]}` — all three
   cheap from `hist` — and, with `group=1`, the co-emptiness histogram
   `k → minutes` (1), the one part that scans.
2. **FE reliability block** on StationDetail: reuse the og card's 30d numbers
   (% time 0 bikes / 0 ebikes) and, for a `?sel=` set, the group-k summary.
3. **Issue-bands** on the avail chart: semi-transparent red x-spans over
   outage windows from (3). uPlot supports background-band plugins; mirror the
   crashes annotations shape (`$hccs/crashes` `HomicidesComparisonPlot.tsx` +
   `src/annotations/*` → `useAnnotations` → `toPlotLayers`), bands behind the
   series with hover detail (metric, duration). Doubles for feed-gap bands
   (`/health` already knows scrape gaps).

## Materialization (only if usage warrants)

Spans and co-outage records could be precomputed by a Lambda/engine pass into a
small parquet/D1 table (start, end, metric, threshold, k), maintained
incrementally like the pyramid — exact spans, O(1) query, new moving part.
Start query-time; materialize only if the fine-scan windows people actually
ask for get too wide. Group-k especially is a candidate: a "co-outage" metric
keyed by a station SET is the one thing no per-station monoid can ever give.
