/**
 * Station-minute state chart ("L" view of `specs/avail-smg-pyramid.md` §5):
 * a stacked area of the 10-state partition per time bin, from the `smg-v1`
 * pyramid's `reducer=hist` rows (`useSmgHist`).
 *
 * Stack order (bottom → top) is `SMG_STATES`: the live states (`ok` on the
 * axis, then no-e-bikes / full / empty), the dead band (bogus, offline),
 * then the gap band (absent, stale feed, no poll). In `pct` mode each
 * state is its share of ALL station-minutes in the bin, so soloing e.g.
 * `Empty` reads directly as "% of station-minutes with no bikes".
 *
 * Legend: click solos, shift-click toggles, double-click resets. Era
 * boundaries (`SMG_ERAS`) are drawn as dashed verticals when in view.
 * Drag-pan mirrors `StationAvailabilityChart` (`useDragPan`).
 */
import { useEffect, useRef, useState } from 'react'
import uPlot, { type AlignedData, type Options } from 'uplot'
import 'uplot/dist/uPlot.min.css'
import './StationAvailabilityChart.css'
import { useTheme } from '../contexts/ThemeContext'
import { useDragPan } from '../uplot'
import { N_STATES, SMG_ERAS, SMG_STATES, type SmgBin, type SmgState } from '../query/smg'

const { floor, max } = Math

interface Props {
  bins: SmgBin[]
  binS: number
  /** Plot shares of the bin's station-minutes (0–100%) instead of counts. */
  pct: boolean
  /** Plot the forward-filled partition (`state_ff`) instead of the raw one. */
  ff: boolean
  height?: number
  visibleFromS?: number
  visibleToS?: number
  onPan?: (minS: number, maxS: number) => void
  clampMinS?: number
  clampMaxS?: number
}

interface TooltipState {
  left: number
  top: number
  dtS: number
  counts: number[]
  total: number
}

const HOUR_S = 3600
const DAY_S = 86400

export function fmtCount(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`
  return String(Math.round(v))
}

function fmtPct(v: number): string {
  if (v >= 10) return `${v.toFixed(0)}%`
  if (v >= 1) return `${v.toFixed(1)}%`
  return `${v.toFixed(2)}%`
}

/** Tooltip title: the bin's extent at the precision its width warrants. */
function binTitle(dtS: number, binS: number): string {
  const d = new Date(dtS * 1000)
  if (binS < HOUR_S) {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
  if (binS < DAY_S) {
    const end = new Date((dtS + binS) * 1000)
    const date = d.toLocaleString(undefined, { month: 'short', day: 'numeric' })
    const h0 = d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
    const h1 = end.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
    return `${date}, ${h0}–${h1}`
  }
  const date = d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return binS === DAY_S ? date : `${date} (${binS / DAY_S}d bin)`
}

export default function SmgChart({
  bins, binS, pct, ff, height = 260, visibleFromS, visibleToS, onPan, clampMinS, clampMaxS,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  // null = all states shown; otherwise the visible subset (solo / toggles).
  const [visible, setVisible] = useState<Set<number> | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)

  const colorOf = (s: SmgState) => (isDark ? s.dark : s.light)
  const isShown = (id: number) => visible == null || visible.has(id)

  useEffect(() => {
    if (!containerRef.current || !bins.length) return

    const axisColor = isDark ? '#e0e0e0' : '#222'
    const gridColor = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'
    const tickColor = isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)'

    const counts = bins.map((b) => (ff ? b.ff : b.state))
    const totals = counts.map((c) => c.reduce((a, v) => a + v, 0))
    // Cumulative stack in SMG_STATES order; hidden states contribute 0 but
    // the denominator stays the full partition.
    const x = bins.map((b) => b.dtS)
    const cum: (number | null)[][] = SMG_STATES.map(() => [])
    for (let i = 0; i < bins.length; i++) {
      let acc = 0
      const denom = pct ? (totals[i] || 1) / 100 : 1
      SMG_STATES.forEach((s, j) => {
        if (isShown(s.id)) acc += counts[i][s.id] / denom
        cum[j].push(acc)
      })
    }
    // Terminal point so the last stepped bin is drawn to its full width.
    x.push(bins[bins.length - 1].dtS + binS)
    cum.forEach((c) => c.push(null))
    const data: AlignedData = [x, ...cum] as AlignedData

    const stepped = uPlot.paths.stepped!({ align: 1 })
    const dim = (id: number, base: string) => (hovered != null && hovered !== id ? base + '40' : base)
    const yMax = pct ? 100 : max(...totals) * 1.02 || 1

    const erasInView = (u: uPlot) => {
      const { min, max: mx } = u.scales.x
      if (min == null || mx == null) return []
      return SMG_ERAS.filter((e) => e.atS > min && e.atS < mx)
    }

    const opts: Options = {
      width: containerRef.current.clientWidth,
      height,
      cursor: { x: true, y: false, drag: { x: false, y: false } },
      scales: {
        x: { time: true, auto: visibleFromS == null || visibleToS == null },
        y: { range: () => [0, yMax] },
      },
      axes: [
        { stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor } },
        {
          stroke: axisColor, grid: { stroke: gridColor }, ticks: { stroke: tickColor }, size: 46,
          values: (_u, vals) => vals.map((v) => (pct ? `${v}%` : fmtCount(v))),
        },
      ],
      legend: { show: false },
      series: [
        { label: 'Time' },
        ...SMG_STATES.map((s, j) => ({
          label: s.label,
          stroke: dim(s.id, colorOf(s)),
          fill: j === 0 ? dim(s.id, colorOf(s)) : undefined,
          paths: stepped,
          width: 1,
        })),
      ],
      bands: SMG_STATES.slice(1).map((s, j) => ({
        // series indices are 1-based (0 is time): band j+2 over j+1.
        series: [j + 2, j + 1] as [number, number],
        fill: dim(s.id, colorOf(s)),
      })),
      hooks: {
        setCursor: [
          (u) => {
            const idx = u.cursor.idx
            if (idx == null || idx < 0 || idx >= bins.length) { setTooltip(null); return }
            const dpr = devicePixelRatio
            setTooltip({
              left: (u.cursor.left ?? 0) + u.bbox.left / dpr,
              top: (u.cursor.top ?? 0) + u.bbox.top / dpr,
              dtS: bins[idx].dtS,
              counts: counts[idx],
              total: totals[idx],
            })
          },
        ],
        draw: [
          (u) => {
            const eras = erasInView(u)
            if (!eras.length) return
            const ctx = u.ctx
            ctx.save()
            ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio])
            ctx.lineWidth = devicePixelRatio
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)'
            ctx.fillStyle = ctx.strokeStyle
            ctx.font = `${11 * devicePixelRatio}px -apple-system, sans-serif`
            ctx.textBaseline = 'top'
            for (const e of eras) {
              const px = u.valToPos(e.atS, 'x', true)
              ctx.beginPath()
              ctx.moveTo(px, u.bbox.top)
              ctx.lineTo(px, u.bbox.top + u.bbox.height)
              ctx.stroke()
              ctx.fillText(` ${e.label}`, px, u.bbox.top + 2 * devicePixelRatio)
            }
            ctx.restore()
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
      if (containerRef.current) plot.setSize({ width: containerRef.current.clientWidth, height })
    }
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      plot.destroy()
      plotRef.current = null
      setTooltip(null)
    }
    // `visibleFromS/ToS` are synced via `setScale` below, not a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bins, binS, pct, ff, height, isDark, visible, hovered])

  useEffect(() => {
    const plot = plotRef.current
    if (!plot || visibleFromS == null || visibleToS == null) return
    plot.setScale('x', { min: visibleFromS, max: visibleToS })
  }, [visibleFromS, visibleToS])

  useDragPan(plotRef, containerRef, {
    enabled: !!onPan,
    onPan: (minS, maxS) => onPan?.(minS, maxS),
    clampMinS: clampMinS ?? (bins.length ? bins[0].dtS : undefined),
    clampMaxS: clampMaxS ?? floor(Date.now() / 1000),
  })

  const onLegendClick = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    if (e.shiftKey) {
      setVisible((v) => {
        const next = new Set(v ?? SMG_STATES.map((s) => s.id))
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next.size === N_STATES ? null : next
      })
    } else {
      setVisible((v) => (v && v.size === 1 && v.has(id) ? null : new Set([id])))
    }
  }

  // Legend reads top-of-stack first (gap band → live band), like the plot.
  const legend = [...SMG_STATES].reverse()
  const textColor = isDark ? '#e0e0e0' : '#222'

  return (
    <div style={{ position: 'relative', width: '100%' }} onMouseLeave={() => setTooltip(null)}>
      <div ref={containerRef} className={`station-availability-chart ${actualTheme}`} style={{ width: '100%' }} />
      <div
        style={{
          display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '4px 0',
          padding: '6px 12px', fontSize: 12, color: textColor, userSelect: 'none',
        }}
        onDoubleClick={() => setVisible(null)}
        onMouseLeave={() => setHovered(null)}
        title="Click to solo · Shift-click to toggle · Double-click to reset"
      >
        {legend.map((s) => {
          const shown = isShown(s.id)
          return (
            <div
              key={s.id}
              onClick={(e) => onLegendClick(e, s.id)}
              onMouseEnter={() => setHovered(s.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                opacity: shown ? 1 : 0.4, padding: '2px 8px', borderRadius: 3,
                background: hovered === s.id ? (isDark ? '#3a3a3a' : '#f0f0f0') : 'transparent',
              }}
            >
              <span style={{ display: 'inline-block', width: 12, height: 12, background: colorOf(s), borderRadius: 2 }} />
              <span style={{ textDecoration: shown ? 'none' : 'line-through' }}>{s.label}</span>
            </div>
          )
        })}
      </div>
      {tooltip && (() => {
        const plotW = containerRef.current?.clientWidth ?? 1000
        const flipH = tooltip.left > plotW * 0.6
        return (
          <div
            style={{
              position: 'absolute',
              left: tooltip.left + (flipH ? -8 : 16),
              top: tooltip.top + 28,
              transform: flipH ? 'translate(-100%, 0)' : undefined,
              pointerEvents: 'none',
              background: isDark ? '#2d2d2d' : 'white',
              border: `1px solid ${isDark ? '#555' : '#ccc'}`,
              borderRadius: 4, padding: '8px 10px', fontSize: 12,
              fontFamily: '-apple-system, sans-serif', color: textColor,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)', whiteSpace: 'nowrap', zIndex: 10,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{binTitle(tooltip.dtS, binS)}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
              {fmtCount(tooltip.total)} station-minutes{ff ? ', forward-filled' : ''}
            </div>
            {legend.map((s) => {
              const v = tooltip.counts[s.id]
              const empty = v === 0
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.5, opacity: empty ? 0.4 : 1 }}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, background: colorOf(s), borderRadius: 2 }} />
                  <span style={{ flex: 1, paddingRight: 12 }}>{s.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7, paddingRight: 8 }}>
                    {empty ? '' : fmtCount(v)}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 44, textAlign: 'right' }}>
                    {empty ? '–' : fmtPct(tooltip.total ? (v / tooltip.total) * 100 : 0)}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}
