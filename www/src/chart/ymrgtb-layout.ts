/**
 * Pure layout builder for ymrgtb Plotly charts (used by Home + StationDetail).
 */
import type { Layout } from 'plotly.js'
import { monthToDate } from './ymrgtb-traces'

export interface BuildLayoutConfig {
  /** Visible months (YYYY-MM strings). */
  months: string[]
  /** Estimated plot width in px (for tick-density heuristic). */
  plotWidth: number
  /** Show stack percents on y-axis (0–100%). */
  stackPercents: boolean
  /** Show the legend. */
  showLegend: boolean
  /** Theme colors. */
  tickcolor: string
  gridcolor: string
  /** Any string that uniquely IDs the plot state; Plotly resets UI state on change. */
  uiRevision: string
}

export function buildLayout(cfg: BuildLayoutConfig): Partial<Layout> {
  const {
    months, plotWidth, stackPercents, showLegend,
    tickcolor, gridcolor, uiRevision,
  } = cfg

  // Adaptive tick intervals based on date range AND viewport width
  const totalMonths = months.length
  const maxTicks = Math.floor((plotWidth * 0.9) / 50)
  const quarterlyTicks = Math.ceil(totalMonths / 3)
  const semiAnnualTicks = Math.ceil(totalMonths / 6)

  let tickDtick: string
  let tickAxisFormat: string
  let tickFormat: 'quarterly' | 'semiannual' | 'annual'

  if (quarterlyTicks <= maxTicks && totalMonths <= 60) {
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

  return {
    autosize: true,
    barmode: 'stack',
    bargap: 0,
    dragmode: 'pan',
    uirevision: uiRevision,
    showlegend: showLegend,
    hovermode: 'x unified',
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
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 0, r: 0, b: tickFormat === 'annual' ? 40 : 70, l: 0 },
  }
}
