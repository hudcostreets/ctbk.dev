/**
 * "Station inactive" bands on the monthly trips chart: exact-date closures
 * from `station-closures.json` (`ctbk station-harmonize gaps -o …`), plus any
 * whole-month gaps inferred from the rows that no closure covers. Bars sit on
 * month starts, so a date is placed proportionally within its month's slot
 * (midpoint to midpoint between adjacent month starts).
 */
import { monthToDate } from './ymrgtb-traces'

export interface InactiveSpan {
  /** First and last day with no rides (`YYYY-MM-DD`, inclusive). */
  from: string
  to: string
  /** Exact days (vs. a run of whole empty months). */
  exact: boolean
}

const ym = (iso: string) => iso.slice(0, 7)

function addMonths(m: string, n: number): string {
  const d = monthToDate(m)
  d.setMonth(d.getMonth() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const daysIn = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo, 0).getDate()
}

/** Chart x (ms) of the start (or, with `end`, the end) of day `iso`. */
export function dayX(iso: string, end = false): number {
  const m = ym(iso)
  const at = monthToDate(m).getTime()
  const lo = (monthToDate(addMonths(m, -1)).getTime() + at) / 2
  const hi = (at + monthToDate(addMonths(m, 1)).getTime()) / 2
  const day = Number(iso.slice(8, 10)) - (end ? 0 : 1)
  return lo + (hi - lo) * day / daysIn(m)
}

/** Exact `closures`, then inferred month runs (`[first, last]` `YYYY-MM`)
 *  that overlap none of them, chronologically. */
export function inactiveSpans(
  closures: readonly (readonly [string, string])[],
  monthRuns: readonly (readonly [string, string])[],
): InactiveSpan[] {
  const exact = closures.map(([from, to]): InactiveSpan => ({ from, to, exact: true }))
  const inferred = monthRuns
    .map(([a, b]): InactiveSpan => ({ from: `${a}-01`, to: `${b}-${daysIn(b)}`, exact: false }))
    .filter((r) => !exact.some((c) => c.from <= r.to && r.from <= c.to))
  return [...exact, ...inferred].sort((x, y) => x.from.localeCompare(y.from))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Aug 31 – Oct 29, 2023", "Jan 13, 2024 – Feb 2, 2025"; whole months:
 *  "Feb '24 – Nov '24". */
export function spanLabel({ from, to, exact }: InactiveSpan): string {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  if (!exact) {
    const f = `${MONTHS[fm - 1]} '${String(fy).slice(2)}`
    const t = `${MONTHS[tm - 1]} '${String(ty).slice(2)}`
    return f === t ? f : `${f} – ${t}`
  }
  const f = `${MONTHS[fm - 1]} ${fd}`
  const t = `${MONTHS[tm - 1]} ${td}`
  if (fy !== ty) return `${f}, ${fy} – ${t}, ${ty}`
  return from === to ? `${f}, ${fy}` : `${f} – ${t}, ${fy}`
}

/** Calendar days in `span`, inclusive. */
export const spanDays = ({ from, to }: InactiveSpan) =>
  Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8))) / 864e5) + 1

/** Fraction of each `YYYY-MM` month not covered by `spans` (0 = inactive
 *  all month). */
export function activeFractions(months: readonly string[], spans: readonly InactiveSpan[]): number[] {
  return months.map((m) => {
    const n = daysIn(m)
    let off = 0
    for (const s of spans) {
      const a = s.from <= `${m}-01` ? 1 : ym(s.from) === m ? Number(s.from.slice(8)) : n + 1
      const b = s.to >= `${m}-${n}` ? n : ym(s.to) === m ? Number(s.to.slice(8)) : 0
      if (b >= a) off += b - a + 1
    }
    return Math.max(0, n - off) / n
  })
}

/** Rolling mean over the last `n` active months (`weights[i] > 0`), skipping
 *  inactive ones, so the line resumes after an outage where it left off.
 *  Each value is normalized by its month's active fraction (a half-open month
 *  counts as half a month). Null for inactive months, and until `n` active
 *  months have accrued. */
export function activeRollingAvg(values: readonly number[], weights: readonly number[], n: number): (number | null)[] {
  const win: number[] = []
  return values.map((_, i) => {
    if (!(weights[i] > 0)) return null
    win.push(i)
    if (win.length > n) win.shift()
    if (win.length < n) return null
    let sv = 0, sw = 0
    for (const j of win) { sv += values[j]; sw += weights[j] }
    return sv / sw
  })
}
