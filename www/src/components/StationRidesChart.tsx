/**
 * Multiscale rides chart for a selected station set: starts + ends as
 * stepped uPlot series (colors match the map pies legend), drag-to-pan via
 * `useDragPan`. Each row's `dtS` is the bin START; a terminal point at
 * `last.dtS + binS` closes the final step. Hovering shows a tooltip with
 * the bin's time span and both counts.
 */
import { useEffect, useRef, useState } from 'react'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTheme } from '../contexts/ThemeContext'
import { useDragPan } from '../uplot'
import type { MultiRidesRow } from '../query/ridesMulti'

export const STARTS_COLOR = '#3498db'
export const ENDS_COLOR = '#e67e22'

type Hover = { left: number, row: MultiRidesRow }

const DAY_S = 86400
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })

/** Human label for the bin `[dtS, dtS + binS)`. */
export function binLabel(dtS: number, binS: number): string {
  const a = new Date(dtS * 1000)
  const b = new Date((dtS + binS) * 1000)
  if (binS >= 28 * DAY_S) return monthFmt.format(a)
  if (binS > DAY_S) return `${dateFmt.format(a)} – ${dateFmt.format(new Date((dtS + binS - DAY_S) * 1000))}`
  if (binS === DAY_S) return dateFmt.format(a)
  return `${dateFmt.format(a)} · ${timeFmt.format(a)}–${timeFmt.format(b)}`
}

interface Props {
  rows: MultiRidesRow[]
  fromS: number
  toS: number
  binS: number
  height?: number
  onPan?: (minS: number, maxS: number) => void
  clampMinS?: number
  clampMaxS?: number
}

export default function StationRidesChart({
  rows,
  fromS,
  toS,
  binS,
  height = 180,
  onPan,
  clampMinS,
  clampMaxS,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { actualTheme } = useTheme()
  const [hover, setHover] = useState<Hover | null>(null)

  useDragPan(plotRef, containerRef, {
    enabled: !!onPan,
    onPan: onPan ?? (() => {}),
    clampMinS,
    clampMaxS,
  })

  useEffect(() => {
    if (!containerRef.current) return

    const dark = actualTheme === 'dark'
    const axisColor = dark ? '#aaa' : '#444'
    const gridColor = dark ? '#333' : '#e5e5e5'

    const x: number[] = []
    const starts: (number | null)[] = []
    const ends: (number | null)[] = []
    for (const r of rows) {
      x.push(r.dtS)
      starts.push(r.starts)
      ends.push(r.ends)
    }
    if (rows.length > 0) {
      x.push(rows[rows.length - 1].dtS + binS)
      starts.push(null)
      ends.push(null)
    }
    const data: AlignedData = [x, starts, ends]

    // Clip the x-axis to the last bin that actually has data. In Latest mode
    // `toS` is "now", but rides data lands ~monthly, so the window's tail is
    // empty — without this the chart trails off into dead space on the right.
    const xMax = rows.length ? Math.min(toS, rows[rows.length - 1].dtS + binS) : toS

    const stepped = uPlot.paths.stepped!({ align: 1 })
    const yMax = Math.max(1, ...rows.map((r) => Math.max(r.starts, r.ends))) * 1.05

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height,
      cursor: { x: true, y: false, drag: { x: false, y: false } },
      scales: {
        x: { time: true, auto: false, range: () => [fromS, xMax] },
        y: { range: () => [0, yMax] },
      },
      axes: [
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: axisColor } },
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: axisColor }, size: 50 },
      ],
      legend: { show: false },
      // No fills: two translucent fills over a dark bg stack into a grey
      // smear that reads as a third (phantom) series.
      series: [
        { label: 'Time' },
        { label: 'Starts', stroke: STARTS_COLOR, paths: stepped, width: 2 },
        { label: 'Ends', stroke: ENDS_COLOR, paths: stepped, width: 2 },
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx
            if (idx == null || idx < 0 || idx >= rows.length) { setHover(null); return }
            // `cursor.left` is plot-area relative; the tooltip is positioned
            // in the outer wrapper (which includes the y-axis).
            setHover({ left: (u.cursor.left ?? 0) + u.bbox.left / devicePixelRatio, row: rows[idx] })
          },
        ],
      },
    }

    const plot = new uPlot(opts, data, containerRef.current)
    plotRef.current = plot

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        plot.setSize({ width: containerRef.current.clientWidth, height })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      plot.destroy()
      plotRef.current = null
    }
  }, [rows, height, fromS, toS, binS, actualTheme])

  const dark = actualTheme === 'dark'
  const flip = hover != null && hover.left > (containerRef.current?.clientWidth ?? 1000) * 0.6
  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }} onMouseLeave={() => setHover(null)}>
      {hover && (
        <div
          data-testid="rides-tt"
          style={{
            position: 'absolute',
            left: hover.left + (flip ? -10 : 14),
            top: 4,
            transform: flip ? 'translate(-100%, 0)' : undefined,
            pointerEvents: 'none',
            background: dark ? '#2d2d2d' : 'white',
            border: `1px solid ${dark ? '#555' : '#ccc'}`,
            borderRadius: 4,
            padding: '6px 9px',
            fontSize: 12,
            color: dark ? '#e0e0e0' : '#222',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            zIndex: 10,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 3 }}>{binLabel(hover.row.dtS, binS)}</div>
          <div><span style={{ color: STARTS_COLOR }}>●</span> starts <b>{hover.row.starts.toLocaleString()}</b></div>
          <div><span style={{ color: ENDS_COLOR }}>●</span> ends <b>{hover.row.ends.toLocaleString()}</b></div>
        </div>
      )}
    </div>
  )
}
