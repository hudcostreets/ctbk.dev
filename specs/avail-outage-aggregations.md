# avail: outage aggregations + plot issue-bands

Status: proposed (captured 2026-07-13; separate direction from the
rides+pyrmts refactor).

## Goal

Fast aggregate answers to "how often / how long is availability bad?"
over any station set, plus visual annotation of problem windows on
avail plots:

1. **Fraction-of-time stats** — % of minutes at 0 bikes / 0 ebikes /
   0 docks, or < N total, over a window and station set.
2. **Span stats** — number and lengths of contiguous outage spans
   (e.g. "0 bikes for ≥ 15 min"), incl. distributions.
3. **Group emptiness** — for a station set, time at k stations empty
   (k = 0, 1, 2, …) — "how often is the whole neighborhood dry?"
4. **Plot issue-bands** — semi-transparent red vertical background
   spans on avail plots over x-ranges where outages (or data issues)
   occurred. Prior art: the homicides plot in `$hccs/crashes`
   (`www/src/njsp/HomicidesComparisonPlot.tsx` + `src/annotations/*` —
   `useAnnotations` → `toPlotLayers` → plotly shapes/layers), which
   layers annotation ranges behind the traces with hover/click detail.

## What the pyramid already answers (cheap)

(1) falls out of the histogram monoid today — proven during the OGI
work: ONE `reducer=hist` query over 30d at a coarse tier returns
per-bin `{value: minute_count}` histograms; merging gives
`pct_zero = h[0]/Σh` and mean in O(bins) client-side. Works for any
`cells=` station set, any window, no schema change. The og card's
"% of the time no bikes, last 30d" stat is exactly this.

`< N total` similarly: `Σ_{v<N} h[v] / Σh`.

Caveat: multi-station sets' histograms mix stations (a bin's histogram
counts (station, minute) observations) — (1) then reads as "fraction
of station-minutes", not "fraction of minutes where ANY/ALL empty".
Per-station loops (one hist query per LUC cell) recover per-station
stats; (3) needs more (below).

## What it doesn't (spans, group-k)

(2) and (3) are **not monoidal** — span boundaries don't survive
histogram aggregation. Options:

- **Query-time scan** of `/1m` (or `/5m`) bins over the window for the
  set's cells: runs/spans computed in the worker (or FE) from the fine
  series. Fine for ≤ ~a month of 1m bins × small sets; wide windows
  want coarser bins with a "min" reducer (a 1h bin with min=0 ⇒ some
  zero minute inside — conservative span detection at 1h resolution).
- **Materialized runs**: a Lambda-side pass emitting per-station
  outage-span records (start, end, metric, threshold) to a small
  parquet/D1 table, maintained incrementally like the pyramid. Exact
  spans, O(1) query; new moving part. Prefer starting with query-time
  scan; materialize only if usage warrants.

(3) group-k: needs per-station series aligned per bin → k(t) =
#stations with value 0 at t. Query per-LUC-cell series (one request,
`cells=` with per-cell grouping — the /cells route already returns
per-cell rows) and fold client-side.

## Issue-bands (4)

- Data source: outage spans from (2) (query-time at first).
- Rendering: uPlot (StationDetail avail chart) supports background
  band plugins; mirror the crashes annotations shape — bands behind
  series, tooltip/hover shows span detail (metric, duration).
- Also usable for *data* issues (feed gaps — the poller's missed
  minutes are visible as absent observations; /health already knows
  scrape gaps).

## Sketch of increments

1. Worker: `/api/avail-v3/stats?cells=…&from=…&to=…&thresholds=…` —
   hist-based (1) + scan-based (2) over ≤ 31d windows.
2. FE StationDetail: issue-bands from (2) + a small "reliability"
   stat block (reuse og card's 30d numbers).
3. Group page (post station-sets work): (3) fold + set-level bands.
