import { useEffect, useRef } from 'react'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useTheme } from '../contexts/ThemeContext'

export interface AvailabilityRow {
  polled_at: number
  num_bikes_available: number
  num_ebikes_available: number
  num_docks_available: number
  num_bikes_disabled: number
  num_docks_disabled: number
}

interface Props {
  rows: AvailabilityRow[]
  capacity: number | null
  height?: number
}

const COLORS = {
  classic: '#1976d2',
  ebike: '#9c27b0',
  docks: '#388e3c',
  disabled: '#9e9e9e',
}

export default function StationAvailabilityChart({ rows, capacity, height = 400 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { actualTheme } = useTheme()

  useEffect(() => {
    if (!containerRef.current || !rows.length) return

    const isDark = actualTheme === 'dark'
    const axisColor = isDark ? '#e0e0e0' : '#222'
    const gridColor = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'
    const tickColor = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)'

    // Align polled_at to minute boundaries
    const x = rows.map((r) => Math.floor(r.polled_at / 60) * 60)
    const classic = rows.map((r) => r.num_bikes_available - r.num_ebikes_available)
    const ebikes = rows.map((r) => r.num_ebikes_available)
    const docks = rows.map((r) => r.num_docks_available)
    const disabled = rows.map((r) => r.num_bikes_disabled + r.num_docks_disabled)

    // Stacked cumulative bands
    const s1 = classic
    const s2 = classic.map((v, i) => v + ebikes[i])
    const s3 = s2.map((v, i) => v + docks[i])
    const s4 = s3.map((v, i) => v + disabled[i])

    const data: AlignedData = [x, s1, s2, s3, s4]

    const stepped = uPlot.paths.stepped!({ align: 1 })

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height,
      cursor: { x: true, y: false, drag: { x: true, y: false } },
      scales: {
        x: { time: true },
        y: {
          range: (_u, _min, max) => [0, Math.max(capacity ?? max, max) * 1.02],
        },
      },
      axes: [
        {
          stroke: axisColor,
          grid: { stroke: gridColor },
          ticks: { stroke: tickColor },
        },
        {
          label: 'Count',
          stroke: axisColor,
          grid: { stroke: gridColor },
          ticks: { stroke: tickColor },
        },
      ],
      series: [
        { label: 'Time' },
        // Bottom band: classic bikes — fills from baseline (0) up to s1
        { label: 'Classic bikes', stroke: COLORS.classic, fill: COLORS.classic, paths: stepped, value: () => '' },
        // Upper bands drawn via `bands`, no fill on the series itself
        { label: 'eBikes',        stroke: COLORS.ebike,    paths: stepped, value: () => '' },
        { label: 'Empty docks',   stroke: COLORS.docks,    paths: stepped, value: () => '' },
        { label: 'Disabled',      stroke: COLORS.disabled, paths: stepped, value: () => '' },
      ],
      bands: [
        // [highIdx, lowIdx] — fill between lower-cumulative and higher-cumulative
        { series: [2, 1], fill: COLORS.ebike },
        { series: [3, 2], fill: COLORS.docks },
        { series: [4, 3], fill: COLORS.disabled },
      ],
      legend: {
        show: true,
        live: true,
      },
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx
            if (idx == null) return
            // Custom live values: show each component's raw count, not cumulative
            const raw = [classic[idx], ebikes[idx], docks[idx], disabled[idx]]
            const seriesEls = u.root.querySelectorAll<HTMLElement>('.u-series .u-value')
            for (let i = 0; i < raw.length; i++) {
              if (seriesEls[i]) seriesEls[i].textContent = String(raw[i])
            }
          },
        ],
      },
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
  }, [rows, capacity, height, actualTheme])

  return (
    <div
      ref={containerRef}
      className={`station-availability-chart ${actualTheme}`}
      style={{ width: '100%' }}
    />
  )
}
