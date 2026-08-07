/**
 * Multiscale rides chart for a selected station set: starts + ends as
 * stepped uPlot series (colors match the map pies legend), drag-to-pan via
 * `useDragPan`. Each row's `dtS` is the bin START; a terminal point at
 * `last.dtS + binS` closes the final step.
 */
import { useEffect, useRef } from 'react'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTheme } from '../contexts/ThemeContext'
import { useDragPan } from '../uplot'
import type { MultiRidesRow } from '../query/ridesMulti'

export const STARTS_COLOR = '#3498db'
export const ENDS_COLOR = '#e67e22'

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

    const stepped = uPlot.paths.stepped!({ align: 1 })
    const yMax = Math.max(1, ...rows.map((r) => Math.max(r.starts, r.ends))) * 1.05

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height,
      cursor: { x: true, y: false, drag: { x: false, y: false } },
      scales: {
        x: { time: true, auto: false, range: () => [fromS, toS] },
        y: { range: () => [0, yMax] },
      },
      axes: [
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: axisColor } },
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: axisColor }, size: 50 },
      ],
      legend: { show: false },
      series: [
        { label: 'Time' },
        { label: 'Starts', stroke: STARTS_COLOR, fill: STARTS_COLOR + '30', paths: stepped, width: 2 },
        { label: 'Ends', stroke: ENDS_COLOR, fill: ENDS_COLOR + '30', paths: stepped, width: 2 },
      ],
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

  return <div ref={containerRef} style={{ position: 'relative', width: '100%' }} />
}
