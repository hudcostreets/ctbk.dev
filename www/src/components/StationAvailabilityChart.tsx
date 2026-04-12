import { useEffect, useRef, useState } from 'react'
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
  pending: '#ff9800',
}

interface TooltipState {
  visible: boolean
  left: number
  top: number
  ts: number
  classic: number
  ebikes: number
  docks: number
  disabled: number
  pending: number
  raw_sum: number
}

/** Smooth a row to sum to capacity:
 *  - sum < capacity: add `pending` for the gap (bikes/docks mid-transaction)
 *  - sum > capacity: trim from `num_bikes_available` (most likely overcounted)
 *  Returns adjusted classic/ebike/docks/disabled/pending (always sum to capacity). */
function smoothRow(r: AvailabilityRow, capacity: number) {
  let classic = r.num_bikes_available - r.num_ebikes_available
  let ebikes = r.num_ebikes_available
  const docks = r.num_docks_available
  const disabled = r.num_bikes_disabled + r.num_docks_disabled
  const sum = classic + ebikes + docks + disabled
  let pending = 0
  if (sum < capacity) {
    pending = capacity - sum
  } else if (sum > capacity) {
    // Over-count: trim from bikes (classic first, then ebikes)
    let excess = sum - capacity
    const fromClassic = Math.min(classic, excess)
    classic -= fromClassic
    excess -= fromClassic
    if (excess > 0) ebikes = Math.max(0, ebikes - excess)
  }
  return { classic, ebikes, docks, disabled, pending, raw_sum: sum }
}

// Series indices for legend interactions (1-based; 0 is the time series).
const SERIES_KEYS = ['classic', 'ebike', 'docks', 'disabled', 'pending'] as const
type SeriesKey = (typeof SERIES_KEYS)[number]

export default function StationAvailabilityChart({ rows, capacity, height = 400 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { actualTheme } = useTheme()
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  // null = all visible. Otherwise set of visible keys (used for solo / hidden).
  const [visible, setVisible] = useState<Set<SeriesKey> | null>(null)
  const [hovered, setHovered] = useState<SeriesKey | null>(null)

  useEffect(() => {
    if (!containerRef.current || !rows.length) return

    const isDark = actualTheme === 'dark'
    const axisColor = isDark ? '#e0e0e0' : '#222'
    const gridColor = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'
    const tickColor = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)'

    const cap = capacity ?? 0
    const x = rows.map((r) => Math.floor(r.polled_at / 60) * 60)
    const smoothed = rows.map((r) => (cap > 0 ? smoothRow(r, cap) : {
      classic: r.num_bikes_available - r.num_ebikes_available,
      ebikes: r.num_ebikes_available,
      docks: r.num_docks_available,
      disabled: r.num_bikes_disabled + r.num_docks_disabled,
      pending: 0,
      raw_sum: r.num_bikes_available + r.num_docks_available + r.num_bikes_disabled + r.num_docks_disabled,
    }))

    // Apply visibility/solo: hidden series contribute 0
    const isShown = (key: SeriesKey) => visible == null || visible.has(key)
    const adj = smoothed.map((s) => ({
      classic: isShown('classic') ? s.classic : 0,
      ebikes: isShown('ebike') ? s.ebikes : 0,
      docks: isShown('docks') ? s.docks : 0,
      disabled: isShown('disabled') ? s.disabled : 0,
      pending: isShown('pending') ? s.pending : 0,
      raw_sum: s.raw_sum,
    }))

    // Cumulative bands
    const s1 = adj.map((s) => s.classic)
    const s2 = adj.map((s, i) => s1[i] + s.ebikes)
    const s3 = adj.map((s, i) => s2[i] + s.docks)
    const s4 = adj.map((s, i) => s3[i] + s.disabled)
    const s5 = adj.map((s, i) => s4[i] + s.pending)

    const data: AlignedData = [x, s1, s2, s3, s4, s5]

    // Hover dimming: when hovered != null, fade other series
    const dim = (key: SeriesKey, base: string) =>
      hovered != null && hovered !== key ? base + '40' : base

    const stepped = uPlot.paths.stepped!({ align: 1 })

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height,
      cursor: { x: true, y: false, drag: { x: true, y: false } },
      scales: {
        x: { time: true },
        y: {
          range: () => [0, cap > 0 ? cap : Math.max(...s5) * 1.02],
        },
      },
      axes: [
        // Default sizes for x-axis (keep date labels readable)
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor } },
        // Y-axis: drop "Count" label + shrink to ~30px (enough for 2-digit numbers)
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor }, size: 30 },
      ],
      legend: { show: false },
      series: [
        { label: 'Time' },
        { label: 'Classic bikes', stroke: dim('classic',  COLORS.classic),  fill: dim('classic', COLORS.classic), paths: stepped },
        { label: 'eBikes',        stroke: dim('ebike',    COLORS.ebike),    paths: stepped },
        { label: 'Empty docks',   stroke: dim('docks',    COLORS.docks),    paths: stepped },
        { label: 'Disabled',      stroke: dim('disabled', COLORS.disabled), paths: stepped },
        { label: 'Pending',       stroke: dim('pending',  COLORS.pending),  paths: stepped },
      ],
      bands: [
        { series: [2, 1], fill: dim('ebike',    COLORS.ebike) },
        { series: [3, 2], fill: dim('docks',    COLORS.docks) },
        { series: [4, 3], fill: dim('disabled', COLORS.disabled) },
        { series: [5, 4], fill: dim('pending',  COLORS.pending) },
      ],
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx
            if (idx == null || idx < 0 || idx >= rows.length) {
              setTooltip(null)
              return
            }
            const cx = u.cursor.left ?? 0
            const cy = u.cursor.top ?? 0
            const s = smoothed[idx]
            setTooltip({
              visible: true,
              left: cx,
              top: cy,
              ts: rows[idx].polled_at,
              ...s,
            })
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
      setTooltip(null)
    }
  }, [rows, capacity, height, actualTheme, visible, hovered])

  const legendItems: { key: SeriesKey; color: string; label: string }[] = [
    { key: 'classic',  color: COLORS.classic,  label: 'Classic bikes' },
    { key: 'ebike',    color: COLORS.ebike,    label: 'eBikes' },
    { key: 'docks',    color: COLORS.docks,    label: 'Empty docks' },
    { key: 'disabled', color: COLORS.disabled, label: 'Disabled' },
    { key: 'pending',  color: COLORS.pending,  label: 'Pending' },
  ]

  const isShown = (key: SeriesKey) => visible == null || visible.has(key)
  const onLegendClick = (e: React.MouseEvent, key: SeriesKey) => {
    e.preventDefault()
    if (e.shiftKey) {
      // Shift+click toggles individual series in/out of current set
      setVisible((v) => {
        const cur = v ?? new Set(SERIES_KEYS)
        const next = new Set(cur)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next.size === SERIES_KEYS.length ? null : next
      })
    } else {
      // Click solos. Click a soloed series to restore all.
      setVisible((v) => {
        if (v && v.size === 1 && v.has(key)) return null  // restore all
        return new Set([key])
      })
    }
  }
  const onLegendDoubleClick = () => setVisible(null)

  return (
    <div
      style={{ position: 'relative', width: '100%' }}
      onMouseLeave={() => setTooltip(null)}
    >
      <div
        ref={containerRef}
        className={`station-availability-chart ${actualTheme}`}
        style={{ width: '100%' }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: '4px 0',  // no horizontal gap; LIs use padding for spacing
          padding: '8px 12px',
          fontSize: 12,
          color: actualTheme === 'dark' ? '#e0e0e0' : '#222',
          userSelect: 'none',
        }}
        onDoubleClick={onLegendDoubleClick}
        onMouseLeave={() => setHovered(null)}
        title="Click to solo · Shift-click to toggle · Double-click to reset"
      >
        {legendItems.map((it) => {
          const shown = isShown(it.key)
          return (
            <div
              key={it.key}
              onClick={(e) => onLegendClick(e, it.key)}
              onMouseEnter={() => setHovered(it.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                opacity: shown ? 1 : 0.4,
                padding: '2px 8px',  // wider padding fills horizontal gaps so adjacent LIs touch
                borderRadius: 3,
                background: hovered === it.key ? (actualTheme === 'dark' ? '#3a3a3a' : '#f0f0f0') : 'transparent',
              }}
            >
              <span style={{
                display: 'inline-block', width: 12, height: 12,
                background: it.color, borderRadius: 2,
                opacity: shown ? 1 : 0.5,
              }} />
              <span style={{ textDecoration: shown ? 'none' : 'line-through' }}>{it.label}</span>
            </div>
          )
        })}
      </div>
      {tooltip && (
        <div
          ref={tooltipRef}
          style={{
            position: 'absolute',
            left: tooltip.left + 12,
            top: tooltip.top + 12,
            pointerEvents: 'none',
            background: actualTheme === 'dark' ? '#2d2d2d' : 'white',
            border: `1px solid ${actualTheme === 'dark' ? '#555' : '#ccc'}`,
            borderRadius: 4,
            padding: '8px 10px',
            fontSize: 12,
            fontFamily: '-apple-system, sans-serif',
            color: actualTheme === 'dark' ? '#e0e0e0' : '#222',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            whiteSpace: 'nowrap',
            zIndex: 10,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {new Date(tooltip.ts * 1000).toLocaleString(undefined, {
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              month: 'short', day: 'numeric',
            })}
          </div>
          <Row color={COLORS.classic}    label="Classic bikes" value={tooltip.classic} />
          <Row color={COLORS.ebike}      label="eBikes"        value={tooltip.ebikes} />
          <Row color={COLORS.docks}      label="Empty docks"   value={tooltip.docks} />
          {tooltip.disabled > 0 && (
            <Row color={COLORS.disabled} label="Disabled"      value={tooltip.disabled} />
          )}
          {tooltip.pending > 0 && (
            <Row color={COLORS.pending} label="Pending"  value={tooltip.pending} />
          )}
        </div>
      )}
    </div>
  )
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.5 }}>
      <span style={{
        display: 'inline-block', width: 10, height: 10,
        background: color, borderRadius: 2,
      }} />
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{value}</span>
    </div>
  )
}
