/**
 * Pure layout builder for ymrgtb Plotly charts (used by Home + StationDetail).
 */
import type { Layout } from 'plotly.js'
import { monthToDate } from './ymrgtb-traces'

export interface BuildLayoutConfig {
  /** Visible months (YYYY-MM strings). */
  months: string[]
  /** `[first, last]` month runs with no rides at all, shaded + labeled. */
  inactive?: [string, string][]
  /** Estimated plot width in px (for tick-density heuristic). */
  plotWidth: number
  /** Show stack percents on y-axis (0–100%). */
  stackPercents: boolean
  /** Show the legend. */
  showLegend: boolean
  /** Theme colors. */
  tickcolor: string
  gridcolor: string
  /** True when rendering on a dark background (controls hoverlabel palette). */
  isDark: boolean
  /** Any string that uniquely IDs the plot state; Plotly resets UI state on change. */
  uiRevision: string
  /** Optional per-yaxis uirevision. Bump on data-affecting changes (filter
   *  toggles) to force y-axis autorange recompute without resetting other
   *  preserved UI state (legend toggles). Falls through to `uiRevision`. */
  yAxisRevision?: string
}

export function buildLayout(cfg: BuildLayoutConfig): Partial<Layout> {
  const {
    months, inactive = [], plotWidth, stackPercents, showLegend,
    tickcolor, gridcolor, isDark, uiRevision, yAxisRevision,
  } = cfg

  // Adaptive tick intervals based on date range AND viewport width
  const totalMonths = months.length
  const maxTicks = Math.floor((plotWidth * 0.9) / 50)
  const quarterlyTicks = Math.ceil(totalMonths / 3)
  const semiAnnualTicks = Math.ceil(totalMonths / 6)

  let tickDtick: string
  let tickAxisFormat: string
  let tickFormat: 'monthly' | 'quarterly' | 'semiannual' | 'annual'

  if (totalMonths <= maxTicks) {
    tickFormat = 'monthly'
    tickDtick = 'M1'
    tickAxisFormat = "%b '%y"
  } else if (quarterlyTicks <= maxTicks && totalMonths <= 60) {
    tickFormat = 'quarterly'
    tickDtick = 'M3'
    tickAxisFormat = "%b '%y"
  } else if (semiAnnualTicks <= maxTicks && totalMonths <= 144) {
    tickFormat = 'semiannual'
    tickDtick = 'M6'
    tickAxisFormat = "%b '%y"
  } else {
    tickFormat = 'annual'
    tickDtick = 'M12'
    tickAxisFormat = "'%y"
  }

  const xAxisRange = months.length > 0 ? [
    new Date(monthToDate(months[0]).getTime() - 15 * 24 * 60 * 60 * 1000),
    new Date(monthToDate(months[months.length - 1]).getTime() + 15 * 24 * 60 * 60 * 1000),
  ] : undefined

  const HALF_MONTH_MS = 15 * 24 * 60 * 60 * 1000
  const fmtMonth = (ym: string) => monthToDate(ym).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).replace(' ', " '")
  const shown = inactive.filter(([a, b]) => months.length && b >= months[0] && a <= months[months.length - 1])
  const inactiveShapes = shown.map(([a, b]) => ({
    type: 'rect' as const, layer: 'below' as const,
    xref: 'x' as const, x0: new Date(monthToDate(a).getTime() - HALF_MONTH_MS), x1: new Date(monthToDate(b).getTime() + HALF_MONTH_MS),
    yref: 'paper' as const, y0: 0, y1: 1,
    fillcolor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
    line: { width: 1, dash: 'dot' as const, color: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' },
  }))
  const inactiveNotes = shown.map(([a, b]) => {
    const span = a === b ? fmtMonth(a) : `${fmtMonth(a)} – ${fmtMonth(b)}`
    return {
      xref: 'x' as const, x: (monthToDate(a).getTime() + monthToDate(b).getTime()) / 2,
      yref: 'paper' as const, y: 0.5, showarrow: false,
      text: `<b>Station inactive</b><br>no rides ${span}`,
      font: { size: 12, color: tickcolor },
      // Opaque-ish chip: the label is wider than a short band and sits over bars.
      bgcolor: isDark ? 'rgba(32,32,36,0.85)' : 'rgba(255,255,255,0.85)',
      bordercolor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)',
      borderpad: 4,
      hovertext: `Citi Bike's own trip data has no rides<br>starting or ending here ${span}:<br>the station was out of service,<br>not a gap in this site's data`,
      hoverlabel: { bgcolor: isDark ? 'rgba(32,32,36,0.95)' : 'rgba(255,255,255,0.95)', font: { color: tickcolor } },
    }
  })

  return {
    autosize: true,
    shapes: inactiveShapes,
    annotations: inactiveNotes,
    barmode: 'stack',
    bargap: 0,
    dragmode: 'pan',
    uirevision: uiRevision,
    showlegend: showLegend,
    hovermode: 'x unified',
    hoverlabel: {
      bgcolor: isDark ? 'rgba(32,32,36,0.95)' : 'rgba(255,255,255,0.95)',
      bordercolor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
      font: { color: tickcolor },
    },
    legend: {
      x: 0.5,
      xanchor: 'center',
      yanchor: 'top',
      orientation: 'h',
      traceorder: 'normal',
      font: { color: tickcolor },
    },
    xaxis: {
      type: 'date',
      range: xAxisRange,
      tickfont: { size: 12, color: tickcolor },
      title: { font: { size: 14 } },
      tickangle: -45,
      dtick: tickDtick,
      tick0: '2013-01-01',
      tickformat: tickAxisFormat,
      gridcolor,
      hoverformat: "%b '%y",
    },
    yaxis: {
      automargin: true,
      gridcolor,
      tickfont: { size: 14, color: tickcolor },
      title: { font: { size: 14 } },
      tickformat: stackPercents ? '.0%' : undefined,
      range: stackPercents ? [0, 1.01] : undefined,
      fixedrange: true,
      ...(yAxisRevision !== undefined ? { uirevision: yAxisRevision } : {}),
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 0, r: 0, b: tickFormat === 'annual' ? 40 : 70, l: 0 },
  }
}
