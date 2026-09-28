/**
 * `SmgChart` + its query, legend, and the forward-fill toggle, for one
 * selection over a visible window. The three surfaces differ only in the
 * selection and in where the window comes from:
 *   - `/`: system bbox, own range param (`ar`);
 *   - `/s/:slug`: `s:<short_name>`, the page's availability window (`r`);
 *   - `/stations?sel=`: the set's `s:` keys, the rides panel's window (`rr`).
 *
 * URL state (shared names — the surfaces never share a page):
 *   - `sff`: forward-filled partition (`state_ff`)
 *
 * Needs a `BrushProvider` above it (the legend's hover/solo state lives there).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { boolParam, useUrlState } from 'use-prms'
import SmgChart from './SmgChart'
import SmgLegend from './SmgLegend'
import { useSmgHist, type SmgSelection } from '../query/smg'
import { formatDuration } from '../time-range'
import { Tip } from './Tip'
import css from './SmgPanel.module.css'

interface Props {
  sel: SmgSelection | null
  fromS: number
  toS: number
  onPan?: (minS: number, maxS: number) => void
  clampMinS?: number
  clampMaxS?: number
  height?: number
  /** Rendered at the start of the toolbar (e.g. a range control). */
  toolbar?: ReactNode
  /** Manual bin override (seconds); undefined = auto from the viewport. */
  binOverrideS?: number
  /** Show the window's span + per-state shares in the legend (single-station pages). */
  summary?: boolean
}

const FF_TIP = 'Forward-fill: minutes with no measurement (no poll, stale feed, absent from the feed) take the station\'s last measured state, so the unmeasured band disappears and shares are of measured time.'

/** A stepped line that continues, dashed, past its last point. */
const FfIcon = () => (
  <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M1 10 H4.5 V6 H8" />
    <path d="M8 6 H13" strokeDasharray="2 1.6" />
  </svg>
)

export default function SmgPanel({ sel, fromS, toS, onPan, clampMinS, clampMaxS, height, toolbar, binOverrideS, summary }: Props) {
  const [ff, setFf] = useUrlState('sff', boolParam)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [viewportPx, setViewportPx] = useState(() =>
    typeof window === 'undefined' ? 1000 : Math.min(window.innerWidth, 1200) - 48,
  )
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      if (w > 0) setViewportPx(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const q = useSmgHist(sel, fromS, toS, viewportPx, binOverrideS)
  const bins = q.data?.bins ?? []
  const binS = q.data?.binS

  // SMG data lags to the last classified day (today's source is deferred),
  // so `toS` (= now) leaves empty space at the right. Trim the *display*
  // edge to the last bin's end; the query window stays [fromS, toS] so a
  // freshly-published day still shows up on the next fetch.
  const dataMaxS = bins.length && binS != null ? bins[bins.length - 1].dtS + binS : undefined
  const viewToS = dataMaxS != null ? Math.min(toS, dataMaxS) : toS

  return (
    <div className={css.panel} data-smg>
      <div className={css.toolbar}>
        {toolbar}
        <Tip content={FF_TIP} placement="bottom">
          <button type="button" className={css.toggle} aria-pressed={ff} onClick={() => setFf(!ff)}>
            <FfIcon /> forward-fill
          </button>
        </Tip>
        {binS != null && <span className={css.status}>bin: {formatDuration(binS * 1000)}</span>}
        {q.isFetching && <span className={css.status}>loading…</span>}
        {q.isError && <span className={css.error}>states fetch failed</span>}
      </div>
      {bins.length > 0 && binS != null && (
        <SmgLegend bins={bins} binS={binS} ff={ff} fromS={fromS} toS={viewToS} stats={summary} />
      )}
      <div ref={wrapRef} className={css.chart} style={{ opacity: q.isFetching && bins.length ? 0.5 : 1 }}>
        {bins.length > 0 && binS != null && (
          <SmgChart
            bins={bins}
            binS={binS}
            ff={ff}
            height={height}
            visibleFromS={fromS}
            visibleToS={viewToS}
            onPan={onPan}
            clampMinS={clampMinS}
            clampMaxS={clampMaxS}
          />
        )}
        {bins.length === 0 && !q.isFetching && !q.isError && sel && (
          <span className={css.status}>no station-state data in this window</span>
        )}
      </div>
    </div>
  )
}
