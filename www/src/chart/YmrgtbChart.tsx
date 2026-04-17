/**
 * Reusable stacked-bar + rolling-avg chart, shared between the homepage
 * and the station detail page. Takes pre-processed rows and a config
 * object; internally delegates to `buildTraces` + `buildLayout`.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plot } from 'pltly/react'
import type { PlotRelayoutEvent } from 'plotly.js'
import { useTheme } from '../contexts/ThemeContext'
import { buildTraces, type BuildTracesConfig, type ProcessedRow } from './ymrgtb-traces'
import { buildLayout } from './ymrgtb-layout'

export interface YmrgtbChartProps {
  rows: ProcessedRow[] | null
  /** Trace-building options (filters, stacking, etc.). */
  config: Omit<
    BuildTracesConfig,
    'isDark' | 'rollingAvgColor' | 'lineOutlineColor' | 'lineDarkenFactor'
  >
  /** Show the legend (defaults to true when stacking). */
  showLegend?: boolean
  /** Cache-busting key for Plotly's uirevision (resets pan/zoom). */
  uiRevision?: string
  onRelayout?: (e: Readonly<PlotRelayoutEvent>) => void
  className?: string
  style?: React.CSSProperties
}

export default function YmrgtbChart({
  rows, config, showLegend, uiRevision, onRelayout, className, style,
}: YmrgtbChartProps) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const rollingAvgColor = isDark ? '#e0e0e0' : 'black'
  const lineOutlineColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.15)'
  const lineDarkenFactor = isDark ? 0.6 : 0.75
  const gridcolor = isDark ? '#505050' : '#ccc'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 800)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const { traces, months } = useMemo(() => buildTraces(rows, {
    ...config,
    isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor,
  }), [rows, config, isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor])

  const showLegendEffective = showLegend ?? config.stackBy !== 'None'

  const layout = useMemo(() => buildLayout({
    months,
    plotWidth: windowWidth,
    stackPercents: config.stackPercents,
    showLegend: showLegendEffective,
    tickcolor, gridcolor,
    uiRevision: uiRevision ?? 'static',
  }), [months, windowWidth, config.stackPercents, showLegendEffective, tickcolor, gridcolor, uiRevision])

  return (
    <div className={className} style={style}>
      <Plot
        data={traces}
        layout={layout}
        style={{ height: '100%' }}
        config={{ displayModeBar: false, scrollZoom: false }}
        onRelayout={onRelayout}
      />
    </div>
  )
}
