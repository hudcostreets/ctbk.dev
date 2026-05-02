import { useEffect, useRef, useState } from 'react'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import './StationAvailabilityChart.css'
import { useTheme } from '../contexts/ThemeContext'
import { useDragPan } from '../uplot'

export interface AvailabilityRow {
  polled_at: number
  num_bikes_available: number
  num_ebikes_available: number
  num_docks_available: number
  num_bikes_disabled: number
  num_docks_disabled: number
  /** Number of minute-polls behind this row. Present when row came from
   *  `/api/totals` (binned, mean values), absent for raw 1-minute polls. */
  sample_count?: number
}

interface Props {
  rows: AvailabilityRow[]
  capacity: number | null
  height?: number
  /** Drag-to-pan commit handler. Called on mouseup with the new visible x-range
   *  (unix seconds). Parent should update URL state accordingly. If omitted,
   *  drag-pan is disabled. */
  onPan?: (minS: number, maxS: number) => void
  /** Override auto-fit x-scale to this window (unix seconds). `rows` may extend
   *  beyond — the extra data is used as buffer during drag-pan so the edges
   *  aren't empty while dragging. */
  visibleFromS?: number
  visibleToS?: number
  /** When `rows` are pre-binned aggregates from `/api/totals` (not raw
   *  1-min polls), bin width in seconds. Used to label the tooltip with
   *  the bin's time range. Absent → tooltip uses point timestamp. */
  binS?: number
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
  /** Number of source-minute polls behind this row, when binned. */
  sample_count?: number
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

export default function StationAvailabilityChart({ rows, capacity, height = 400, onPan, visibleFromS, visibleToS, binS }: Props) {
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
      cursor: { x: true, y: false, drag: { x: false, y: false } },
      scales: {
        // When caller provides a visible window, set `auto: false` so uPlot
        // respects `setScale('x', ...)` calls (both ours below and drag-pan's
        // live updates) without re-running a range callback that would clobber
        // them. Initial bounds are set via `setScale` after instantiation.
        x: { time: true, auto: visibleFromS == null || visibleToS == null },
        y: {
          range: () => [0, cap > 0 ? cap : Math.max(...s5) * 1.02],
        },
      },
      axes: [
        // Default sizes for x-axis (keep date labels readable)
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor } },
        // Y-axis: 40px is enough for 4-char labels like "22.5" (capacity-24
        // stations). 30px clipped the leading digit.
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor }, size: 40 },
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
            // `cursor.left/top` are relative to the plot area (inside the axes),
            // but the tooltip is absolute-positioned inside the outer wrapper
            // which includes the axes. Shift by bbox origin so the tooltip
            // sits right at the cursor.
            const dpr = devicePixelRatio
            const cx = (u.cursor.left ?? 0) + u.bbox.left / dpr
            const cy = (u.cursor.top ?? 0) + u.bbox.top / dpr
            const s = smoothed[idx]
            setTooltip({
              visible: true,
              left: cx,
              top: cy,
              ts: rows[idx].polled_at,
              ...s,
              sample_count: rows[idx].sample_count,
            })
          },
        ],
      },
    }

    const plot = new uPlot(opts, data, containerRef.current)
    plotRef.current = plot
    if (visibleFromS != null && visibleToS != null) {
      plot.setScale('x', { min: visibleFromS, max: visibleToS })
    }

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

  // Clamp drag to the fetched data's extents — user can't pan past the
  // earliest row or into the future beyond `now`. Prevents exposing the
  // data-retention gap (`HOT_DAYS_RETAIN=7` on the backend) via drag.
  const clampMinS = rows.length ? rows[0].polled_at : undefined
  const clampMaxS = Math.floor(Date.now() / 1000)
  useDragPan(plotRef, containerRef, {
    enabled: !!onPan,
    onPan: (minS, maxS) => onPan?.(minS, maxS),
    clampMinS,
    clampMaxS,
  })

  // Sync x-scale to the visible window when it changes (preset-button click,
  // Latest snap-back, etc.) without rebuilding the plot. The `range` callback
  // in `opts` handles the initial scale; this keeps it in sync on prop change.
  useEffect(() => {
    const plot = plotRef.current
    if (!plot || visibleFromS == null || visibleToS == null) return
    plot.setScale('x', { min: visibleFromS, max: visibleToS })
  }, [visibleFromS, visibleToS])

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
              <span style={{ textDecoration: shown ? 'none' : 'line-through' }}>
                {it.label}
              </span>
            </div>
          )
        })}
      </div>
      {tooltip && (() => {
        // Flip to the left of the cursor when close to the right edge so the
        // tooltip doesn't clip off-screen.
        const plotW = containerRef.current?.clientWidth ?? 1000
        const flipH = tooltip.left > plotW * 0.6
        return (
        <div
          ref={tooltipRef}
          style={{
            position: 'absolute',
            left: tooltip.left + (flipH ? -8 : 16),
            top: tooltip.top + 28,
            transform: flipH ? 'translate(-100%, 0)' : undefined,
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
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {formatTooltipTitle(tooltip.ts, binS)}
          </div>
          {binS != null && tooltip.sample_count != null && (
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
              mean over {tooltip.sample_count} {tooltip.sample_count === 1 ? 'minute' : 'minutes'}
            </div>
          )}
          {/* Order matches the stacked-area plot read top-to-bottom: pending
            * is on top of the stack, classic on the bottom. Always render all
            * 5 rows so the tooltip's vertical extent doesn't jitter as the
            * cursor moves between bins where Pending or Disabled drop to 0;
            * zero-valued rows fade to "-". */}
          <Row color={COLORS.pending}    label="Pending"       value={tooltip.pending} />
          <Row color={COLORS.disabled}   label="Disabled"      value={tooltip.disabled} />
          <Row color={COLORS.docks}      label="Empty docks"   value={tooltip.docks} />
          <Row color={COLORS.ebike}      label="eBikes"        value={tooltip.ebikes} />
          <Row color={COLORS.classic}    label="Classic bikes" value={tooltip.classic} />
        </div>
        )
      })()}
    </div>
  )
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  // value === 0 → faded placeholder ("-") so the tooltip's row count stays
  // constant across bins (no vertical jitter when Pending / Disabled drop
  // out at some bins).
  const empty = value === 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.5, opacity: empty ? 0.4 : 1 }}>
      <span style={{
        display: 'inline-block', width: 10, height: 10,
        background: color, borderRadius: 2,
      }} />
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
        {empty ? '–' : formatValue(value)}
      </span>
    </div>
  )
}

/** Round to integer when whole, else 1 decimal (raw poll values are integers;
 *  binned mean values may be fractional). Matches the ~precision a user can
 *  read off the stacked-area chart. */
function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(1)
}

const HOUR_S = 3600
const DAY_S = 86400

/** Tooltip title: "Apr 29, 11:00 AM" for raw / hourly bins; "Apr 29 (1d bin)"
 *  for daily bins; "Apr 2026 (1mo bin)" for monthly. Bin width drives the
 *  precision so the time label matches the bin's actual extent. */
function formatTooltipTitle(ts: number, binS: number | undefined): string {
  const d = new Date(ts * 1000)
  if (binS == null || binS < HOUR_S) {
    // Raw / sub-hour: show full timestamp.
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  }
  if (binS < DAY_S) {
    // Hourly: show the bin's hour range.
    const end = new Date(ts * 1000 + binS * 1000)
    const dateStr = d.toLocaleString(undefined, { month: 'short', day: 'numeric' })
    const startH = d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
    const endH   = end.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
    return `${dateStr}, ${startH}–${endH}`
  }
  if (binS < 28 * DAY_S) {
    // Daily.
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' (1d bin)'
  }
  // Monthly+ bins: just the month label.
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' }) + ' (1mo bin)'
}
