import { useEffect, useRef } from 'react'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTheme } from '../contexts/ThemeContext'
import type { AvailabilityOverviewRow } from '../query/stations'

interface Props {
  rows: AvailabilityOverviewRow[]
  capacity: number | null
  /** Pixel height of the chart. */
  height?: number
  /** Window-span seconds covered by `rows` — informs the time axis. */
  fromS: number
  toS: number
  /** Bin size in seconds. Used to space the stepped line correctly so the
   *  trailing edge of each bar covers the whole bin. */
  binS: number
}

/**
 * Long-window availability overview chart. Renders the binned `mean` field
 * from `/api/totals?kind=availability&bin=<seconds>` as a stepped line.
 *
 * Each row's `dt` is the bin START. To make the visual bin width match the
 * actual bucket size, we plot a stepped path (uPlot's `stepped` paths) with
 * an extra terminal point at `last.dt + binS` so the final bin is also
 * fully drawn.
 */
export default function OverviewAvailabilityChart({
  rows,
  capacity,
  height = 200,
  fromS,
  toS,
  binS,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { actualTheme } = useTheme()

  useEffect(() => {
    if (!containerRef.current) return

    const dark = actualTheme === 'dark'
    const axisColor = dark ? '#aaa' : '#444'
    const gridColor = dark ? '#333' : '#e5e5e5'
    const tickColor = axisColor
    const lineColor = dark ? '#64b5f6' : '#1976d2'

    // Plot data: x = dt array, y = mean array. Append a terminal point so the
    // last stepped bin is drawn to its full bucket width.
    const x: number[] = []
    const y: (number | null)[] = []
    for (const r of rows) {
      x.push(r.dt)
      y.push(r.mean ?? null)
    }
    if (rows.length > 0) {
      x.push(rows[rows.length - 1].dt + binS)
      y.push(null)
    }
    const data: AlignedData = [x, y]

    const stepped = uPlot.paths.stepped!({ align: 1 })

    const cap = capacity ?? 0
    const yMax = cap > 0
      ? cap
      : Math.max(...rows.map((r) => r.mean ?? 0)) * 1.05 || 1

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height,
      cursor: { x: true, y: false, drag: { x: false, y: false } },
      scales: {
        x: { time: true, auto: false, range: () => [fromS, toS] },
        y: { range: () => [0, yMax] },
      },
      axes: [
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor } },
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor }, size: 30 },
      ],
      legend: { show: false },
      series: [
        { label: 'Time' },
        { label: 'Mean bikes', stroke: lineColor, fill: lineColor + '40', paths: stepped, width: 2 },
      ],
    }

    const plot = new uPlot(opts, data, containerRef.current)
    plotRef.current = plot

    const resize = () => {
      if (containerRef.current) {
        plot.setSize({ width: containerRef.current.clientWidth, height })
      }
    }
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      plot.destroy()
      plotRef.current = null
    }
  }, [rows, capacity, height, fromS, toS, binS, actualTheme])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%' }}
    />
  )
}

/**
 * Pick a "nice" bin size (seconds) for a given span + chart pixel width.
 *
 * Two competing constraints:
 *   - Visual: ~30px per bin → bin ≥ span / (widthPx/30).
 *   - Server cost: each tier reads 1 file/period (h1=daily, d1=monthly,
 *     mo1=yearly). For wide windows, force a coarser tier even if the visual
 *     target would tolerate a finer bin — otherwise we'd read 30+ daily
 *     parquets per request, blowing the Worker's CPU/memory budget.
 *
 * Tier floors:
 *   - span > 7d  → bin ≥ 86400  (force d1, ≤ 12 monthly files per query)
 *   - span > 1y  → bin ≥ 2592000 (force mo1, 1 yearly file per query)
 */
export function pickOverviewBin(spanS: number, widthPx: number): number {
  const NICE_BINS = [
    3600,         //  1 h
    7200,         //  2 h
    21600,        //  6 h
    43200,        // 12 h
    86400,        //  1 d
    86400 * 2,    //  2 d
    86400 * 7,    //  1 w
    2592000,      //  ~30 d (1 mo)
    2592000 * 3,  //  ~3 mo
  ]
  const DAY_S = 86400
  const MONTH_S = 30 * DAY_S
  const YEAR_S = 365 * DAY_S
  // Cutoffs match useStationAvailability's tier-floor (post-rg-pruning).
  // Overview is always full-station-history → typically falls at d1 or mo1.
  const tierFloor = spanS > YEAR_S ? MONTH_S : spanS > 30 * DAY_S ? DAY_S : 3600
  const targetPxPerBin = 30
  const targetBins = Math.max(8, Math.floor(widthPx / targetPxPerBin))
  const target = Math.max(tierFloor, spanS / targetBins)
  return NICE_BINS.find((n) => n >= target) ?? NICE_BINS[NICE_BINS.length - 1]
}
