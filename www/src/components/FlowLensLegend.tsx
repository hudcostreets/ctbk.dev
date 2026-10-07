/**
 * Legend for the flow lens (`flowLens.ts`) on `/stations`: names the
 * selected source(s), reports the set's total flow, offers a direction
 * toggle (⇄), an Arcs checkbox synced with the URL, and keys the encodings
 * with real trip counts:
 *   - a **size/color key**: 2–3 reference circles (sized by `lensRadiusPx`,
 *     colored by `lensColorT`, both at the base zoom), plus a grey "no trips"
 *     dot;
 *   - a **width key** (when the arc fan is on): reference strokes sized by
 *     `arcWidthPx`.
 *
 * `compact` (phones): renders inline (inside the page's header strip, not
 * fixed top-right) as a one-line summary that expands on tap.
 */
import {
  ARC_W_MAX, NON_DST_COLOR, R_MAX, SIZE_KEY_FRACS, WIDTH_KEY_FRACS,
  arcWidthPx, lensColorT, lensRadiusPx, legendTicks, rampColor,
  type FlowDirection, type LensChannel,
} from './flowLens'
import css from '../stations.module.css'

/** Key circle radius when the radius channel is off (color-only lens). */
const R_COLOR_ONLY = 6

const fmt = (n: number) => n.toLocaleString()

export default function FlowLensLegend({
  sourceNames,
  channel,
  direction,
  onToggleDirection,
  arcsEnabled,
  onArcsChange,
  total,
  topCount,
  arcMax,
  compact = false,
  open = true,
  onToggleOpen,
}: {
  sourceNames: string[]
  channel: LensChannel
  direction: FlowDirection
  onToggleDirection: () => void
  arcsEnabled: boolean
  onArcsChange: (enabled: boolean) => void
  total: number
  topCount: number
  /** Heaviest arc's trip count, when the arc fan is drawn (→ width key). */
  arcMax?: number | null
  compact?: boolean
  /** Compact only: expanded (keys shown) vs. one-line summary. */
  open?: boolean
  onToggleOpen?: () => void
}) {
  const source = sourceNames.length === 0
    ? '—'
    : sourceNames.length === 1
      ? sourceNames[0]
      : `${sourceNames[0]} +${sourceNames.length - 1} more`
  const hasColor = channel === 'c' || channel === 'cr'
  const hasRadius = channel === 'r' || channel === 'cr'
  const out = direction === 'out'
  const showBody = !compact || open

  const sizeTicks = legendTicks(topCount, SIZE_KEY_FRACS)
  const keyR = (n: number) => (hasRadius ? lensRadiusPx(n, topCount) : R_COLOR_ONLY)
  const keyFill = (n: number) => (hasColor ? rampColor(lensColorT(n, topCount)) : '#e67e22')
  const svgH = 2 * (hasRadius ? R_MAX : R_COLOR_ONLY) + 2
  const widthTicks = arcMax ? legendTicks(arcMax, WIDTH_KEY_FRACS) : []

  const summary = (
    <div className={css.lensSource}>
      Trips {out ? 'from' : 'to'} <strong>{source}</strong>
      <span className={css.lensTotal}>{fmt(total)} total</span>
    </div>
  )
  return (
    <div className={compact ? css.lensLegendCompact : `${css.legend} ${css.lensLegend}`} data-testid="lens-legend">
      {compact ? (
        <button
          type="button"
          className={css.lensSummaryBtn}
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-label={open ? 'Hide legend' : 'Show legend'}
        >
          {summary}
          <span className={css.chevron} aria-hidden>{open ? '▴' : '▾'}</span>
        </button>
      ) : summary}
      {showBody && (
        <>
          <button type="button" className={css.lensDirBtn} onClick={onToggleDirection}>
            ⇄ {out ? 'where riders go' : 'where riders come from'}
          </button>
          <label className={css.lensArcsToggle}>
            <input type="checkbox" checked={arcsEnabled} onChange={(event) => onArcsChange(event.target.checked)} />
            Arcs
          </label>
          <div className={css.keyTitle}>trips per station</div>
          <div className={css.sizeKey} data-testid="lens-size-key">
            {sizeTicks.map((n) => {
              const r = keyR(n)
              return (
                <span key={n} className={css.keyItem}>
                  <svg width={2 * r + 2} height={svgH} aria-hidden>
                    <circle cx={r + 1} cy={svgH / 2} r={r} fill={keyFill(n)} fillOpacity={0.85} stroke="rgba(127,127,127,0.6)" strokeWidth={0.75} />
                  </svg>
                  <span>{fmt(n)}</span>
                </span>
              )
            })}
            <span className={css.keyItem}>
              <svg width={6} height={svgH} aria-hidden>
                <circle cx={3} cy={svgH / 2} r={hasRadius ? 1.5 : 3} fill={NON_DST_COLOR} />
              </svg>
              <span>{out ? 'no trips' : 'none from there'}</span>
            </span>
          </div>
          {widthTicks.length > 0 && (
            <>
              <div className={css.keyTitle}>trips per arc {out ? '(set → station)' : '(station → set)'}</div>
              <div className={css.widthKey} data-testid="lens-width-key">
                {widthTicks.map((n) => (
                  <span key={n} className={css.keyItem}>
                    <svg width={28} height={ARC_W_MAX + 2} aria-hidden>
                      <line x1={1} x2={27} y1={ARC_W_MAX / 2 + 1} y2={ARC_W_MAX / 2 + 1} stroke="currentColor" strokeOpacity={0.8} strokeWidth={arcWidthPx(n, arcMax!)} />
                    </svg>
                    <span>{fmt(n)}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
