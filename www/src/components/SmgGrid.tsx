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
import { etDayMinute, etDayStartS, smgGrid, type GridRow } from '../query/smgGrid'
import { brushedState, isShown, useBrush } from './smgBrush'
import { canvasFill, inkOn, swatchStyle } from './smgStyle'
import css from './SmgPanel.module.css'

const SLOT_S = 300
const ROW_H = 14
const ROW_GAP = 2
const ROW_PITCH = ROW_H + ROW_GAP
// Left gutter, as table columns: weekday (left-aligned), M/D (right-aligned
// at MD_X), then the day's own state histogram (a 100% bar), then the grid.
const MD_X = 60
const HIST_X = 66
const HIST_W = 60
const LABEL_W = HIST_X + HIST_W + 6
/** Quartile ticks down the day-histogram column, so segment widths read. */
const HIST_TICKS = [0.25, 0.5, 0.75]
const HIST_FONT = '10px -apple-system, sans-serif'
const AXIS_H = 16
/** Rows shown before the grid scrolls (a month-long window, plus partial end
 *  days), so longer windows scroll inside a box instead of growing the page. */
const VISIBLE_ROWS = 32

const dayParts = (day: string): [string, string] => {
  const [y, m, d] = day.split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  return [wd, `${m}/${d}`]
}
const dayLabel = (day: string) => dayParts(day).join(' ')
const pctLabel = (p: number) => (p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`)
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
/** Start (unix s) of ET day `YYYY-MM-DD` (noon UTC is always that ET date). */
const dayStartS = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return etDayStartS(Date.UTC(y, m - 1, d, 12) / 1000)
}
const hourLabel = (h: number) => (h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`)

/** Size `cv` for `w`×`h` CSS px at the device pixel ratio; returns its context. */
function sized(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = devicePixelRatio || 1
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  const g = cv.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  g.font = '11px -apple-system, sans-serif'
  g.textBaseline = 'middle'
  return g
}

/** A hovered slot (`col`) or day histogram (`col` null), with its counts. */
interface Hover { x: number; y: number; row: GridRow; col: number | null; counts: number[] }

export default function SmgGrid({ sel, fromS, toS }: { sel: SmgSelection | null; fromS: number; toS: number }) {
  const [ff] = useUrlState('sff', boolParam)
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'
  // From ET midnight of the window's first day, so the oldest row is whole.
  const q = useSmgHist(sel, etDayStartS(fromS), Math.ceil(toS / SLOT_S) * SLOT_S, 0, SLOT_S)
  const binS = q.data?.binS ?? SLOT_S
  const rows = useMemo(() => (q.data ? smgGrid(q.data.bins, binS, ff) : []), [q.data, binS, ff])

  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(800)
  const [hover, setHover] = useState<Hover | null>(null)
  const hasRows = rows.length > 0
  const { brush, setBrush, clearBrush, visible } = useBrush()
  const hl = brushedState(brush)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Content box: excludes the scrollbar, so columns never sit under it.
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasRows])

  const nCols = Math.round(86400 / binS)
  const colW = (width - LABEL_W) / nCols
  const bodyH = rows.length * ROW_PITCH
  // Per-day station-minutes by state (the row's own histogram).
  const rowTotals = useMemo(() => rows.map((r) => {
    const t = new Array<number>(SMG_STATES.length).fill(0)
    for (const c of r.cells) if (c) c.forEach((v, i) => { t[i] += v })
    return t
  }), [rows])

  // Another plot's brush, as `[row, col0, col1)` cell runs (a time range) or
  // a column band (an hour of day).
  const rowOf = useMemo(() => new Map(rows.map((r, i) => [r.day, i])), [rows])
  const runs = useMemo(() => {
    if (!brush || brush.src === 'grid' || brush.kind !== 't') return []
    const out: [number, number, number][] = []
    const end = brush.tS + brush.spanS
    for (let t = Math.floor(brush.tS / binS) * binS; t < end; t += binS) {
      const [day, minute] = etDayMinute(t)
      const r = rowOf.get(day)
      if (r == null) continue
      const col = Math.floor((minute * 60) / binS)
      const last = out[out.length - 1]
      if (last && last[0] === r && last[2] === col) last[2] = col + 1
      else out.push([r, col, col + 1])
    }
    return out
  }, [brush, rowOf, binS])
  const band = brush && brush.src !== 'grid' && brush.kind === 'hod'
    ? [(brush.hour * 3600) / binS, ((brush.hour + 1) * 3600) / binS]
    : null

  // Bring a brushed row into view (within the grid only; never the page).
  const firstRun = runs[0]?.[0]
  useEffect(() => {
    const el = scrollRef.current
    if (!el || firstRun == null) return
    const y0 = firstRun * ROW_PITCH
    const view = el.clientHeight - AXIS_H
    if (y0 < el.scrollTop) el.scrollTop = y0
    else if (y0 + ROW_H > el.scrollTop + view) el.scrollTop = y0 + ROW_H - view
  }, [firstRun])

  useEffect(() => {
    const head = headRef.current
    const body = bodyRef.current
    if (!head || !body || !rows.length) return
    const ink = dark ? '#cfcfcf' : '#333'
    const rule = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)'
    const hg = sized(head, width, AXIS_H)
    const bg = sized(body, width, bodyH)
    hg.fillStyle = ink
    hg.globalAlpha = 0.7
    hg.textAlign = 'center'
    hg.fillText('whole day', HIST_X + HIST_W / 2, AXIS_H / 2)
    hg.globalAlpha = 1
    for (const q of HIST_TICKS) {
      hg.fillStyle = rule
      hg.fillRect(HIST_X + q * HIST_W, AXIS_H - 3, 1, 3)
    }
    // Hour ticks every 3h: labels + stubs in the sticky header, rules in the body.
    for (let h = 0; h <= 24; h += 3) {
      const x = LABEL_W + (h * 3600 / binS) * colW
      hg.fillStyle = rule
      hg.fillRect(x, AXIS_H - 3, 1, 3)
      bg.fillStyle = rule
      bg.fillRect(x, 0, 1, bodyH)
      if (h < 24) {
        hg.fillStyle = ink
        hg.textAlign = h === 0 ? 'left' : 'center'
        hg.fillText(hourLabel(h), x, AXIS_H / 2)
      }
    }
    const fade = (st: { id: number }) => (hl != null && hl !== st.id ? '30' : '')
    rows.forEach((row, r) => {
      const y0 = r * ROW_PITCH
      const tot = rowTotals[r]
      const [wd, md] = dayParts(row.day)
      // Days where a legend-hovered state never occurs fade out.
      bg.globalAlpha = hl != null && !tot[hl] ? 0.3 : 1
      bg.fillStyle = ink
      bg.textAlign = 'left'
      bg.fillText(wd, 0, y0 + ROW_H / 2)
      bg.textAlign = 'right'
      bg.fillText(md, MD_X, y0 + ROW_H / 2)
      bg.globalAlpha = 1
      const sum = tot.reduce((a, v) => a + v, 0)
      if (sum) {
        // Segments first, then each one's % where the text fits inside it
        // (hatched fills get a halo in the opposite ink).
        const segs: [number, number, typeof SMG_STATES[number]][] = []
        let x = HIST_X
        for (const st of SMG_STATES) {
          const w = (tot[st.id] / sum) * HIST_W
          if (!w || !isShown(visible, st.id)) continue
          bg.fillStyle = canvasFill(st, dark, fade(st))
          bg.fillRect(x, y0, w, ROW_H)
          segs.push([x, w, st])
          x += w
        }
        bg.font = HIST_FONT
        bg.textAlign = 'center'
        for (const [sx, w, st] of segs) {
          const label = pctLabel((100 * tot[st.id]) / sum)
          if (bg.measureText(label).width + 6 > w) continue
          const ink = inkOn(st, dark)
          bg.globalAlpha = fade(st) ? 0.3 : 1
          if (st.hatch) {
            bg.strokeStyle = ink === '#000' ? '#fff' : '#000'
            bg.lineWidth = 2.5
            bg.lineJoin = 'round'
            bg.strokeText(label, sx + w / 2, y0 + ROW_H / 2)
          }
          bg.fillStyle = ink
          bg.fillText(label, sx + w / 2, y0 + ROW_H / 2)
          bg.globalAlpha = 1
        }
        bg.font = '11px -apple-system, sans-serif'
      }
      row.cells.forEach((c, col) => {
        if (!c) return
        const total = c.reduce((a, v) => a + v, 0)
        if (!total) return
        const x = LABEL_W + col * colW
        let y = y0 + ROW_H
        for (const st of SMG_STATES) {
          const v = c[st.id]
          if (!v || !isShown(visible, st.id)) continue
          const h = (v / total) * ROW_H
          y -= h
          bg.fillStyle = canvasFill(st, dark, fade(st))
          bg.fillRect(x, y, Math.max(colW, 1), h)
        }
      })
    })
    bg.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.2)'
    for (const q of HIST_TICKS) bg.fillRect(HIST_X + q * HIST_W, 0, 1, bodyH)
  }, [rows, rowTotals, width, bodyH, colW, binS, dark, hl, visible])

  const onMove = (e: React.MouseEvent) => {
    const body = bodyRef.current!.getBoundingClientRect()
    const wrap = wrapRef.current!.getBoundingClientRect()
    const r = Math.floor((e.clientY - body.top) / ROW_PITCH)
    const x = e.clientX - body.left
    const at = { x: e.clientX - wrap.left, y: e.clientY - wrap.top }
    if (r >= 0 && r < rows.length && x >= HIST_X && x < HIST_X + HIST_W) {
      // A day's histogram brushes the whole day.
      setHover({ ...at, row: rows[r], col: null, counts: rowTotals[r] })
      setBrush({ kind: 't', tS: dayStartS(rows[r].day), spanS: 86400, src: 'grid' })
      return
    }
    const col = Math.floor((x - LABEL_W) / colW)
    const cell = r >= 0 && r < rows.length && col >= 0 && col < nCols ? rows[r].cells[col] : null
    if (!cell) { setHover(null); clearBrush('grid'); return }
    setHover({ ...at, row: rows[r], col, counts: cell })
    setBrush({ kind: 't', tS: dayStartS(rows[r].day) + col * binS, spanS: binS, src: 'grid' })
  }

  const legend = [...SMG_STATES].reverse()
  return (
    <div className={css.panel} data-smg data-testid="smg-grid">
      <div className={css.toolbar}>
        <span className={css.status}>Eastern time · {Math.round(binS / 60)}-minute slots · newest day first</span>
        {q.isFetching && <span className={css.status}>loading…</span>}
        {q.isError && <span className={css.error}>states fetch failed</span>}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }} onMouseLeave={() => { setHover(null); clearBrush('grid') }}>
        {hasRows && (
          <div
            ref={scrollRef}
            className={css.gridScroll}
            style={{ maxHeight: AXIS_H + VISIBLE_ROWS * ROW_PITCH }}
            onScroll={() => setHover(null)}
          >
            <canvas ref={headRef} className={css.gridHead} style={{ width, height: AXIS_H }} />
            <canvas ref={bodyRef} style={{ width, height: bodyH, display: 'block' }} onMouseMove={onMove} />
            {runs.map(([r, c0, c1]) => (
              <div
                key={`${r}-${c0}`}
                className={css.gridMark}
                style={{ left: LABEL_W + c0 * colW - 1, top: AXIS_H + r * ROW_PITCH - 1, width: Math.min((c1 - c0) * colW + 2, width - (LABEL_W + c0 * colW)), height: ROW_H + 2 }}
              />
            ))}
            {band && (
              <div
                className={css.gridBand}
                style={{ left: LABEL_W + band[0] * colW, top: AXIS_H, width: (band[1] - band[0]) * colW, height: bodyH }}
              />
            )}
          </div>
        )}
        {hover && (() => {
          const c = hover.counts
          const total = c.reduce((a, v) => a + v, 0)
          const start = hover.col == null ? 0 : Math.round((hover.col * binS) / 60)
          const title = hover.col == null
            ? `${dayLabel(hover.row.day)} · whole day`
            : `${dayLabel(hover.row.day)} ${hhmm(start)}–${hhmm(start + binS / 60)}`
          const flip = hover.x > width * 0.6
          return (
            <div
              className={css.gridTip}
              style={{ left: hover.x + (flip ? -12 : 12), top: hover.y + 12, transform: flip ? 'translateX(-100%)' : undefined }}
            >
              <div className={css.gridTipHead}>{title}</div>
              {legend.filter((s) => c[s.id] > 0).map((s) => (
                <div key={s.id} className={css.gridTipRow}>
                  <span className={css.dot} style={swatchStyle(s, dark)} />
                  <span>{s.label}</span>
                  <b>{pctLabel((100 * c[s.id]) / total)}</b>
                </div>
              ))}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
