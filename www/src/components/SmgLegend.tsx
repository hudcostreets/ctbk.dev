/**
 * The one legend for the station-state plots (`SmgChart`, `SmgGrid`,
 * `SmgByHour`): a swatch per state present in the window and, on
 * single-station pages, each state's share of the window's station-minutes
 * (folded from the same `smg-v1` bins the chart draws, `query/smgStats.ts`).
 *
 * Hovering an item brushes that state across every plot (`smgBrush`); click
 * solos it, shift-click toggles, double-click resets, and a click anywhere
 * outside the state panels resets too. Item tooltips carry the spec's
 * rider-facing folds (e.g. "no e-bikes" = empty + full-no-e-bikes +
 * classic-only, over usable minutes), which the per-state shares don't.
 */
import { useEffect, type MouseEvent } from 'react'
import { useTheme } from '../contexts/ThemeContext'
import { N_STATES, SMG_STATES, type SmgBin, type SmgState } from '../query/smg'
import { smgShares, smgSummary, smgTotals, type SmgSummary } from '../query/smgStats'
import { brushedState, isShown, stateSpans, useBrush } from './smgBrush'
import { swatchStyle } from './smgStyle'
import { Tip } from './Tip'
import css from './SmgPanel.module.css'

const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
/** "Sep 20 – Sep 27" (Eastern), the window the shares cover. */
const span = (fromS: number, toS: number) => `${day.format(fromS * 1000)} – ${day.format((toS - 1) * 1000)}`

/** "9.6%", "18%"; a present-but-tiny state reads "<0.1%", never "0.0%". */
const pct = (x: number) => (x > 0 && x < 0.001 ? '<0.1%' : `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`)

/** What each state means, plus the rider-facing fold it belongs to. */
const DESC: Record<number, { what: string; fold?: (s: SmgSummary) => string }> = {
  5: { what: 'No bikes of any kind.', fold: (s) => `Empty ${pct(s.empty)} of usable minutes.` },
  6: { what: 'No open docks.', fold: (s) => `Full (with or without e-bikes) ${pct(s.full)} of usable minutes.` },
  7: { what: 'No open docks, and no e-bike either.', fold: (s) => `Full (with or without e-bikes) ${pct(s.full)} of usable minutes.` },
  8: { what: 'Classic bikes only: no e-bike available (but not empty or full).', fold: (s) => `No e-bike available (empty, full without e-bikes, or classic-only) ${pct(s.noEbikes)} of usable minutes.` },
  3: { what: 'Reported not renting or not returning.', fold: (s) => `Offline ${pct(s.offline)} of measured minutes.` },
  4: { what: 'Feed reported 0 bikes and 0 docks.' },
  9: { what: 'Bikes, e-bikes, and open docks all available.' },
  2: { what: 'Not in the feed\'s station list.', fold: (s) => `Unmeasured (no poll, stale feed, or absent) ${pct(s.unmeasured)} of all minutes.` },
  1: { what: 'The feed\'s timestamp hadn\'t advanced.', fold: (s) => `Unmeasured (no poll, stale feed, or absent) ${pct(s.unmeasured)} of all minutes.` },
  0: { what: 'No snapshot for the minute (the poller missed it).', fold: (s) => `Unmeasured (no poll, stale feed, or absent) ${pct(s.unmeasured)} of all minutes.` },
}

interface Props {
  bins: readonly SmgBin[]
  binS: number
  ff: boolean
  fromS: number
  toS: number
  /** Show the window's span and each state's share (single-station pages). */
  stats?: boolean
}

export default function SmgLegend({ bins, binS, ff, fromS, toS, stats }: Props) {
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'
  const { brush, setBrush, clearBrush, visible, setVisible } = useBrush()
  const hovered = brushedState(brush)
  const totals = smgTotals(bins, ff, fromS, toS)
  const shares = smgShares(totals)
  const folds = smgSummary(totals)
  // States absent from the window are left out.
  const items = SMG_STATES.filter((s) => totals[s.id] > 0)

  // A pinned (solo / toggled) legend resets on a click anywhere outside the
  // state panels (`data-smg`).
  useEffect(() => {
    if (visible == null) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-smg]')) setVisible(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [visible, setVisible])

  const hover = (s: SmgState | null) => {
    if (s == null) clearBrush('smg', 'state')
    else setBrush({ kind: 'state', id: s.id, spans: stateSpans(bins, binS, ff, s.id), src: 'smg' })
  }
  const onClick = (e: MouseEvent, id: number) => {
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

  if (!items.length) return null
  return (
    <div className={css.legend} data-smg data-testid="smg-summary" onDoubleClick={() => setVisible(null)}>
      {stats && (
        <Tip content={`Each state's share of the window's station-minutes${ff ? ' (forward-filled)' : ''}.`}>
          <span className={css.legendLead}>{span(fromS, toS)}:</span>
        </Tip>
      )}
      {items.map((s) => {
        const { what, fold } = DESC[s.id]
        const shown = isShown(visible, s.id)
        return (
          <Tip
            key={s.id}
            content={
              <>
                <div>{what}</div>
                {stats && fold && folds && <div>{fold(folds)}</div>}
                <div className={css.legendHint}>Click to solo · Shift-click to toggle · Double-click to reset</div>
              </>
            }
          >
            <span
              className={`${css.legendItem}${shown ? '' : ` ${css.legendOff}`}${hovered === s.id ? ` ${css.legendHot}` : ''}`}
              onClick={(e) => onClick(e, s.id)}
              onMouseEnter={() => hover(s)}
              onMouseLeave={() => hover(null)}
            >
              <span className={css.dot} style={swatchStyle(s, dark)} />
              <span className={css.legendLabel}>{s.label}</span>
              {stats && <b>{pct(shares[s.id])}</b>}
            </span>
          </Tip>
        )
      })}
    </div>
  )
}
