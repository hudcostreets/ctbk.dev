/**
 * Cross-plot brushing on the station page: hovering any of the time plots
 * (availability, states, day × time grid) brushes an instant range; hovering
 * an hour-of-day bar brushes that ET hour. Every other plot draws the brush
 * (spikeline / range / band / highlighted bar), so one hover reads across all
 * four views. `src` names the emitting plot, which skips drawing its own.
 *
 * The same context carries the legend's solo/toggle set (`visible`), so one
 * legend (`SmgLegend`) drives every state plot.
 */
import { createContext, useCallback, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type uPlot from 'uplot'
import type { SmgBin } from '../query/smg'
import { etDayMinute, etDayStartS } from '../query/smgGrid'

export type Brush =
  | { kind: 't'; tS: number; spanS: number; src: string }
  | { kind: 'hod'; hour: number; src: string }
  /** A hovered legend state: `spans` are `[start, end, share]` runs where it
   *  occurs (share = its fraction of the run's station-minutes). */
  | { kind: 'state'; id: number; spans: [number, number, number][]; src: string }
  | null

interface Ctx {
  brush: Brush
  setBrush: (b: Brush) => void
  /** Clear the brush only if `src` set it (and it's of `kind`, if given): a
   *  plot re-initializing or losing its cursor mustn't wipe another plot's (or
   *  its own legend's) live brush. */
  clearBrush: (src: string, kind?: NonNullable<Brush>['kind']) => void
  /** Legend solo/toggle: null = every state shown, else the shown subset. */
  visible: Set<number> | null
  setVisible: Dispatch<SetStateAction<Set<number> | null>>
}
const BrushCtx = createContext<Ctx>({ brush: null, setBrush: () => {}, clearBrush: () => {}, visible: null, setVisible: () => {} })

export function BrushProvider({ children }: { children: ReactNode }) {
  const [brush, setBrush] = useState<Brush>(null)
  const [visible, setVisible] = useState<Set<number> | null>(null)
  const clearBrush = useCallback(
    (src: string, kind?: NonNullable<Brush>['kind']) => setBrush((b) => (b?.src === src && (!kind || b.kind === kind) ? null : b)),
    [],
  )
  const value = useMemo(() => ({ brush, setBrush, clearBrush, visible, setVisible }), [brush, clearBrush, visible])
  return <BrushCtx.Provider value={value}>{children}</BrushCtx.Provider>
}

export const useBrush = () => useContext(BrushCtx)

/** Whether state `id` is shown under the legend's solo/toggle set. */
export const isShown = (visible: Set<number> | null, id: number) => visible == null || visible.has(id)

const HOUR_S = 3600

/** Where state `id` occurs in `bins`, as `[start, end, share]` runs: adjacent
 *  bins merge (share = the run's pooled fraction). */
export function stateSpans(bins: readonly SmgBin[], binS: number, ff: boolean, id: number): [number, number, number][] {
  const out: [number, number, number, number, number][] = []  // start, end, share, v, total
  for (const b of bins) {
    const c = ff ? b.ff : b.state
    const v = c[id]
    if (!v) continue
    const total = c.reduce((a, x) => a + x, 0)
    const last = out[out.length - 1]
    if (last && last[1] === b.dtS) { last[1] = b.dtS + binS; last[3] += v; last[4] += total }
    else out.push([b.dtS, b.dtS + binS, 0, v, total])
  }
  return out.map(([a, b, , v, total]) => [a, b, total ? v / total : 0])
}

/** The state id a `state` brush highlights (null otherwise). */
export const brushedState = (b: Brush) => (b?.kind === 'state' ? b.id : null)

/** `[start, end)` instants of ET hour `hour` on each day overlapping `[fromS, toS)`. */
export function hodIntervals(hour: number, fromS: number, toS: number): [number, number][] {
  const out: [number, number][] = []
  for (let day = etDayStartS(fromS); day < toS; day = etDayStartS(day + 26 * HOUR_S)) {
    let start = day + hour * HOUR_S
    // DST days: the naive offset lands an hour off; nudge onto the ET hour.
    const [, minute] = etDayMinute(start)
    start += (hour * 60 - minute) * 60
    if (start + HOUR_S > fromS && start < toS) out.push([start, start + HOUR_S])
  }
  return out
}

/** ET hours of day touched by `[tS, tS + spanS)`; all 24 once it spans a day. */
export function etHoursOf(tS: number, spanS: number): number[] {
  if (spanS >= 86400) return Array.from({ length: 24 }, (_, h) => h)
  const hours = new Set<number>()
  for (let t = tS; t < tS + spanS; t += HOUR_S) hours.add(Math.floor(etDayMinute(t)[1] / 60))
  hours.add(Math.floor(etDayMinute(tS + spanS - 1)[1] / 60))
  return [...hours].sort((a, b) => a - b)
}

/** The brush drawn over a uPlot time chart, as absolutely positioned divs in
 *  the chart's (position: relative) wrapper: a spikeline for a narrow range,
 *  a shaded span for a wide one, and one band per day for an hour-of-day. */
export function BrushOverlay({ plot, self, dark }: { plot: uPlot | null; self: string; dark: boolean }) {
  const { brush } = useBrush()
  if (!plot || !brush || brush.src === self) return null
  const { min, max } = plot.scales.x
  if (min == null || max == null) return null
  const dpr = devicePixelRatio || 1
  const left = plot.bbox.left / dpr
  const top = plot.bbox.top / dpr
  const width = plot.bbox.width / dpr
  const height = plot.bbox.height / dpr
  if (brush.kind === 'state') {
    return (
      <>
        {brush.spans.map(([a, b, share]) => {
          const x0 = Math.max(0, plot.valToPos(a, 'x'))
          const x1 = Math.min(width, plot.valToPos(b, 'x'))
          if (x1 <= 0 || x0 >= width) return null
          return (
            <div
              key={a}
              style={{
                position: 'absolute', pointerEvents: 'none', zIndex: 5,
                left: left + x0, top, height, width: Math.max(1, x1 - x0),
                background: dark ? '#fff' : '#000', opacity: 0.12 + 0.4 * share,
              }}
            />
          )
        })}
      </>
    )
  }
  const spans: [number, number][] = brush.kind === 't'
    ? [[brush.tS, brush.tS + brush.spanS]]
    : hodIntervals(brush.hour, min, max)
  const ink = dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)'
  const shade = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.16)'
  return (
    <>
      {spans.map(([a, b]) => {
        const x0 = Math.max(0, plot.valToPos(a, 'x'))
        const x1 = Math.min(width, plot.valToPos(b, 'x'))
        if (x1 < 0 || x0 > width) return null
        const w = x1 - x0
        const line = w < 3
        return (
          <div
            key={a}
            style={{
              position: 'absolute', pointerEvents: 'none', zIndex: 5,
              left: left + (line ? (x0 + x1) / 2 : x0), top, height,
              width: line ? 0 : w,
              borderLeft: line ? `1px dashed ${ink}` : undefined,
              background: line ? undefined : shade,
              boxShadow: line ? undefined : `inset 1px 0 ${ink}, inset -1px 0 ${ink}`,
            }}
          />
        )
      })}
    </>
  )
}
