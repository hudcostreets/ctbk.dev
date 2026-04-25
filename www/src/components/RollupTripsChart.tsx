/**
 * Rollup-backed trips chart (feature-flagged `?rollup=1` path on `/s/:slug`).
 *
 * Takes pre-aggregated rows from the `/api/query` Worker endpoint (see
 * `specs/multiscale-timeseries-backend.md`) plus the bin size used to
 * aggregate them, and renders a stacked bar chart.
 *
 * Row shape: `{dt: unix-s, count?, duration_s?, ...dimCols}`. The chart
 * plots a single metric (`count` or `ride-minutes` derived from
 * `duration_s`) and stacks by whatever non-metric, non-`dt` columns the
 * Worker returned (e.g. `side`, `user_type` — driven by the caller's
 * `dims` query param).
 *
 * The x-axis tick / hover format auto-adapts to `binMs` so minute bins
 * show HH:MM and year bins show just the year.
 */
import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import { useTheme } from '../contexts/ThemeContext'
import type { RollupRow } from '../query/rollups'

export type Metric = 'count' | 'ride_minutes'

interface Props {
  rows: RollupRow[]
  binMs: number
  /** Which metric to plot. `count` is trips/rides; `ride_minutes` is
   *  `duration_s / 60` per row (sum of ride durations in minutes). */
  metric?: Metric
  height?: number
}

const SECOND_MS = 1000
const MIN_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

/** Column names that are metrics (sum-aggregated server-side), not dim
 *  group keys. Mirrors the Worker's `METRIC_COLUMNS` allowlist. */
const METRIC_COLS = new Set(['count', 'duration_s'])

/** Plotly `hoverformat` based on bin size. */
function hoverFormatFor(binMs: number): string {
  if (binMs < HOUR_MS) return '%Y-%m-%d %H:%M'
  if (binMs < DAY_MS) return '%Y-%m-%d %H:00'
  if (binMs < 28 * DAY_MS) return '%Y-%m-%d'
  if (binMs < 365 * DAY_MS) return "%b '%y"
  return '%Y'
}

/** Color palette for stack traces (cycled). */
const PALETTE = [
  '#1976d2', '#ef6c00', '#9c27b0', '#388e3c',
  '#d32f2f', '#0097a7', '#fbc02d', '#7b1fa2',
]

/** Detect dim columns in a row sample: anything that's not `dt` or a metric. */
function detectDims(row: RollupRow | undefined): string[] {
  if (!row) return []
  return Object.keys(row).filter((k) => k !== 'dt' && !METRIC_COLS.has(k))
}

/** Get the metric value from a row. */
function getMetricValue(row: RollupRow, metric: Metric): number {
  if (metric === 'count') return (row.count as number | undefined) ?? 0
  // ride_minutes: convert duration_s to minutes
  return ((row.duration_s as number | undefined) ?? 0) / 60
}

export default function RollupTripsChart({
  rows, binMs, metric = 'count', height = 500,
}: Props) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const gridcolor = isDark ? '#505050' : '#ccc'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  const traces = useMemo(() => {
    if (!rows.length) return []

    const dims = detectDims(rows[0])
    // Group rows by (dim-combo). Each group becomes one stacked trace.
    // No dims → one trace with all rows.
    const groups = new Map<string, { label: string; rows: RollupRow[] }>()
    for (const r of rows) {
      const key = dims.length
        ? dims.map((d) => String(r[d] ?? '')).join('|')
        : ''
      const label = dims.length
        ? dims.map((d) => String(r[d] ?? '')).join(' / ')
        : 'Trips'
      let g = groups.get(key)
      if (!g) {
        g = { label, rows: [] }
        groups.set(key, g)
      }
      g.rows.push(r)
    }

    // Stable trace ordering: sort by label.
    const orderedGroups = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    const yAxisName = metric === 'count' ? 'trips' : 'ride minutes'
    return orderedGroups.map(([, g], i) => ({
      x: g.rows.map((r) => new Date(r.dt * 1000)),
      y: g.rows.map((r) => getMetricValue(r, metric)),
      type: 'bar' as const,
      name: g.label,
      width: binMs,  // bar width in ms — matches bin size
      marker: { color: PALETTE[i % PALETTE.length] },
      hovertemplate: `${g.label}: %{y:,.0f} ${yAxisName}<extra></extra>`,
    }))
  }, [rows, binMs, metric])

  const layout = useMemo(() => ({
    autosize: true,
    height,
    barmode: 'stack' as const,
    bargap: 0,
    dragmode: 'pan' as const,
    showlegend: traces.length > 1,
    hovermode: 'x unified' as const,
    hoverlabel: {
      bgcolor: isDark ? 'rgba(32,32,36,0.95)' : 'rgba(255,255,255,0.95)',
      bordercolor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
      font: { color: tickcolor },
    },
    legend: {
      orientation: 'h' as const,
      x: 0.5,
      xanchor: 'center' as const,
      yanchor: 'top' as const,
      font: { color: tickcolor },
    },
    xaxis: {
      type: 'date' as const,
      tickfont: { size: 12, color: tickcolor },
      tickangle: -45,
      gridcolor,
      hoverformat: hoverFormatFor(binMs),
    },
    yaxis: {
      automargin: true,
      gridcolor,
      tickfont: { size: 14, color: tickcolor },
      fixedrange: true,
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 10, r: 10, b: 60, l: 40 },
  }), [height, tickcolor, gridcolor, binMs, traces.length, isDark])

  if (!rows.length) {
    return <div style={{ padding: 20, color: tickcolor, textAlign: 'center' }}>No rollup rows in range.</div>
  }

  return (
    <Plot
      data={traces}
      layout={layout}
      style={{ width: '100%' }}
      config={{ displayModeBar: false, scrollZoom: false }}
    />
  )
}
