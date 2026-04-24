/**
 * Rollup-backed trips chart (feature-flagged `?rollup=1` path on `/s/:slug`).
 *
 * Takes pre-aggregated rows from the `/api/query` Worker endpoint (see
 * `specs/multiscale-timeseries-backend.md`) plus the bin size used to
 * aggregate them, and renders a stacked bar chart. The x-axis format is
 * picked based on `binMs` so minute-bins show HH:MM and year-bins show
 * just the year.
 *
 * Row shape is generic: `{dt: unix-seconds, ...numericFields}`. We assume
 * any non-`dt` numeric field is a stackable value and sum-charts them in
 * order. For v1 we just render one "Trips" trace summing all numeric
 * fields per bin — enough to validate the wiring before expanding.
 */
import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import { useTheme } from '../contexts/ThemeContext'
import type { RollupRow } from '../query/rollups'

interface Props {
  rows: RollupRow[]
  binMs: number
  height?: number
}

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

/** Pick a plotly `hoverformat` based on bin size. */
function hoverFormatFor(binMs: number): string {
  if (binMs < HOUR_MS) return '%Y-%m-%d %H:%M'
  if (binMs < DAY_MS) return '%Y-%m-%d %H:00'
  if (binMs < 28 * DAY_MS) return '%Y-%m-%d'
  if (binMs < 365 * DAY_MS) return "%b '%y"
  return '%Y'
}

export default function RollupTripsChart({ rows, binMs, height = 500 }: Props) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const gridcolor = isDark ? '#505050' : '#ccc'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  const traces = useMemo(() => {
    if (!rows.length) return []
    const x = rows.map((r) => new Date(r.dt * 1000))
    // Sum all non-`dt` numeric fields per row into one "Trips" stack.
    // Future: split by dim (region/side/etc) into separate traces.
    const y = rows.map((r) => {
      let s = 0
      for (const k of Object.keys(r)) {
        if (k === 'dt') continue
        const v = r[k]
        if (typeof v === 'number') s += v
      }
      return s
    })
    return [{
      x,
      y,
      type: 'bar' as const,
      name: 'Trips',
      width: binMs,  // bar width in ms — matches bin size
      marker: { color: '#1976d2' },
      hovertemplate: '%{y:,} trips<extra></extra>',
    }]
  }, [rows, binMs])

  const layout = useMemo(() => ({
    autosize: true,
    height,
    barmode: 'stack' as const,
    bargap: 0,
    dragmode: 'pan' as const,
    showlegend: false,
    hovermode: 'x' as const,
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
  }), [height, tickcolor, gridcolor, binMs])

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
