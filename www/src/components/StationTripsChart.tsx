/**
 * Per-station monthly trips chart (`/s/:slug` page).
 *
 * Renders a stacked bar chart of starts + ends per month for one
 * station. Uses Plotly for consistency with the homepage chart.
 * Later this may factor further with Home.tsx as shared utilities.
 */
import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import { useTheme } from '../contexts/ThemeContext'

export interface TripsRow {
  Year: number
  Month: number
  Count: number
  Duration: number
  Region: string | null
  'User Type': string | null
  Gender: number | null
  'Rideable Type': string | null
  is_start: boolean
}

interface Props {
  rows: TripsRow[]
  stackBy?: 'side' | 'none'  // 'side' shows starts/ends separately, 'none' sums to total trips
  height?: number
}

const BAR_WIDTH_MS = 25 * 24 * 60 * 60 * 1000

const COLORS = {
  start: '#1976d2',  // blue
  end: '#ef6c00',    // orange
  total: '#546e7a',  // blue-grey
}

function ymKey(r: TripsRow): string {
  return `${r.Year}-${String(r.Month).padStart(2, '0')}`
}

function ymToDate(ym: string): Date {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1)
}

export default function StationTripsChart({ rows, stackBy = 'side', height = 400 }: Props) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const gridcolor = isDark ? '#505050' : '#ccc'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  const traces = useMemo(() => {
    if (!rows.length) return []

    // Group by (ym, is_start). Sum across region/gender/user_type/bike_type dims.
    const starts: Record<string, number> = {}
    const ends: Record<string, number> = {}
    for (const r of rows) {
      const ym = ymKey(r)
      if (r.is_start) starts[ym] = (starts[ym] || 0) + r.Count
      else ends[ym] = (ends[ym] || 0) + r.Count
    }

    const allMonths = Array.from(new Set([...Object.keys(starts), ...Object.keys(ends)])).sort()
    const monthDates = allMonths.map(ymToDate)

    if (stackBy === 'none') {
      const totals = allMonths.map((m) => (starts[m] || 0) + (ends[m] || 0))
      return [{
        x: monthDates,
        y: totals,
        type: 'bar' as const,
        name: 'Trips',
        width: BAR_WIDTH_MS,
        marker: { color: COLORS.total },
        hovertemplate: '%{y:,} trips<extra></extra>',
      }]
    }

    return [
      {
        x: monthDates,
        y: allMonths.map((m) => starts[m] || 0),
        type: 'bar' as const,
        name: 'Starts',
        width: BAR_WIDTH_MS,
        marker: { color: COLORS.start },
        hovertemplate: '%{y:,} starts<extra></extra>',
      },
      {
        x: monthDates,
        y: allMonths.map((m) => ends[m] || 0),
        type: 'bar' as const,
        name: 'Ends',
        width: BAR_WIDTH_MS,
        marker: { color: COLORS.end },
        hovertemplate: '%{y:,} ends<extra></extra>',
      },
    ]
  }, [rows, stackBy])

  const layout = useMemo(() => ({
    autosize: true,
    height,
    barmode: 'stack' as const,
    bargap: 0,
    dragmode: 'pan' as const,
    showlegend: true,
    hovermode: 'x' as const,
    legend: {
      x: 0.5,
      xanchor: 'center' as const,
      yanchor: 'top' as const,
      orientation: 'h' as const,
      font: { color: tickcolor },
    },
    xaxis: {
      type: 'date' as const,
      tickfont: { size: 12, color: tickcolor },
      tickangle: -45,
      gridcolor,
      hoverformat: "%b '%y",
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
  }), [height, tickcolor, gridcolor])

  if (!rows.length) {
    return <div style={{ padding: 20, color: tickcolor, textAlign: 'center' }}>No trip data yet.</div>
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
