/**
 * Day × time-of-day grid of a station's `smg-v1` states: one row per ET day
 * (newest first, like `/health/feed`), one column per 5-minute slot, each
 * cell a tiny stack of that slot's state minutes (same order + fills as the
 * states chart). Unlike % rollups it shows how problem states actually
 * interleave with OK over time. Single-station pages; follows the page window.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { boolParam, useUrlState } from 'use-prms'
import { useTheme } from '../contexts/ThemeContext'
import { SMG_STATES, useSmgHist, type SmgSelection } from '../query/smg'
import { smgGrid, type GridRow } from '../query/smgGrid'
import { canvasFill, swatchStyle } from './smgStyle'
import css from './SmgPanel.module.css'

const SLOT_S = 300
const ROW_H = 14
const ROW_GAP = 2
const LABEL_W = 64
const AXIS_H = 16

const dayLabel = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  return `${wd} ${m}/${d}`
}
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

interface Hover { x: number; y: number; row: GridRow; col: number }

export default function SmgGrid({ sel, fromS, toS }: { sel: SmgSelection | null; fromS: number; toS: number }) {
  const [ff] = useUrlState('sff', boolParam)
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'
  const q = useSmgHist(sel, Math.floor(fromS / SLOT_S) * SLOT_S, Math.ceil(toS / SLOT_S) * SLOT_S, 0, SLOT_S)
  const binS = q.data?.binS ?? SLOT_S
  const rows = useMemo(() => (q.data ? smgGrid(q.data.bins, binS, ff) : []), [q.data, binS, ff])

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<Hover | null>(null)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const nCols = Math.round(86400 / binS)
  const colW = (width - LABEL_W) / nCols
  const height = AXIS_H + rows.length * (ROW_H + ROW_GAP)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !rows.length) return
    const dpr = devicePixelRatio || 1
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    const ink = dark ? '#cfcfcf' : '#333'
    g.font = '11px -apple-system, sans-serif'
    g.fillStyle = ink
    g.textBaseline = 'middle'
    // Hour ticks every 3h.
    for (let h = 0; h <= 24; h += 3) {
      const x = LABEL_W + (h * 3600 / binS) * colW
      g.fillStyle = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)'
      g.fillRect(x, AXIS_H - 3, 1, height - AXIS_H + 3)
      if (h < 24) {
        g.fillStyle = ink
        g.textAlign = h === 0 ? 'left' : 'center'
        g.fillText(h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`, x, AXIS_H / 2)
      }
    }
    rows.forEach((row, r) => {
      const y0 = AXIS_H + r * (ROW_H + ROW_GAP)
      g.fillStyle = ink
      g.textAlign = 'left'
      g.fillText(dayLabel(row.day), 0, y0 + ROW_H / 2)
      row.cells.forEach((c, col) => {
        if (!c) return
        const total = c.reduce((a, v) => a + v, 0)
        if (!total) return
        const x = LABEL_W + col * colW
        let y = y0 + ROW_H
        for (const st of SMG_STATES) {
          const v = c[st.id]
          if (!v) continue
          const h = (v / total) * ROW_H
          y -= h
          g.fillStyle = canvasFill(st, dark)
          g.fillRect(x, y, Math.max(colW, 1), h)
        }
      })
    })
  }, [rows, width, height, colW, binS, dark])

  const onMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const r = Math.floor((y - AXIS_H) / (ROW_H + ROW_GAP))
    const col = Math.floor((x - LABEL_W) / colW)
    if (r < 0 || r >= rows.length || col < 0 || col >= nCols || !rows[r].cells[col]) { setHover(null); return }
    setHover({ x, y, row: rows[r], col })
  }

  const legend = [...SMG_STATES].reverse()
  return (
    <div className={css.panel} data-testid="smg-grid">
      <div className={css.toolbar}>
        <span className={css.status}>Eastern time · {Math.round(binS / 60)}-minute slots · newest day first</span>
        {q.isFetching && <span className={css.status}>loading…</span>}
        {q.isError && <span className={css.error}>states fetch failed</span>}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }} onMouseLeave={() => setHover(null)}>
        {rows.length > 0 && (
          <canvas ref={canvasRef} style={{ width, height, display: 'block' }} onMouseMove={onMove} />
        )}
        {hover && (() => {
          const c = hover.row.cells[hover.col]!
          const total = c.reduce((a, v) => a + v, 0)
          const start = Math.round((hover.col * binS) / 60)
          const flip = hover.x > width * 0.6
          return (
            <div
              className={css.gridTip}
              style={{ left: hover.x + (flip ? -12 : 12), top: hover.y + 12, transform: flip ? 'translateX(-100%)' : undefined }}
            >
              <div className={css.gridTipHead}>{dayLabel(hover.row.day)} {hhmm(start)}–{hhmm(start + binS / 60)}</div>
              {legend.filter((s) => c[s.id] > 0).map((s) => (
                <div key={s.id} className={css.gridTipRow}>
                  <span className={css.dot} style={swatchStyle(s, dark)} />
                  <span>{s.label}</span>
                  <b>{Math.round((100 * c[s.id]) / total)}%</b>
                </div>
              ))}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
