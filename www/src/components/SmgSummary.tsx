/** One line of rider-facing shares for a station over the visible window,
 *  folded from the same `smg-v1` bins the chart draws (`query/smgStats.ts`). */
import { useTheme } from '../contexts/ThemeContext'
import { SMG_STATES, type SmgBin } from '../query/smg'
import { smgSummary, smgTotals, type SmgSummary as Summary } from '../query/smgStats'
import { Tip } from './Tip'
import css from './SmgPanel.module.css'

const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
/** "Sep 20 – Sep 27" (Eastern), the window the shares cover. */
const span = (fromS: number, toS: number) => `${day.format(fromS * 1000)} – ${day.format((toS - 1) * 1000)}`

const pct = (x: number) => `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`
const color = (id: number, dark: boolean) => {
  const s = SMG_STATES.find((st) => st.id === id)!
  return dark ? s.dark : s.light
}

const STATS: { key: keyof Summary; label: string; id: number; tip: string }[] = [
  { key: 'empty', label: 'empty', id: 5, tip: 'No bikes of any kind, as a share of minutes the station was usable (OK, empty, full, or partially stocked).' },
  { key: 'full', label: 'full', id: 6, tip: 'No open docks (with or without e-bikes), as a share of usable minutes.' },
  { key: 'noEbikes', label: 'no e-bikes', id: 8, tip: 'No e-bike available (empty, full with no e-bikes, or classic-only), as a share of usable minutes.' },
  { key: 'offline', label: 'offline', id: 3, tip: 'Reported offline (not renting or not returning), as a share of measured minutes.' },
  { key: 'unmeasured', label: 'unmeasured', id: 0, tip: 'Minutes with no measurement (no poll, stale feed, or absent from the feed), as a share of all minutes. 0 with forward-fill on.' },
]

export default function SmgSummary({ bins, ff, fromS, toS }: { bins: readonly SmgBin[]; ff: boolean; fromS: number; toS: number }) {
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'
  const s = smgSummary(smgTotals(bins, ff, fromS, toS))
  if (!s) return null
  return (
    <div className={css.summary} data-testid="smg-summary">
      <span className={css.summaryLead}>{span(fromS, toS)}:</span>
      {STATS.map(({ key, label, id, tip }) => (
        <Tip key={key} content={tip}>
          <span className={css.stat}>
            <span className={css.dot} style={{ background: color(id, dark) }} />
            <b>{pct(s[key] as number)}</b> {label}
          </span>
        </Tip>
      ))}
    </div>
  )
}
