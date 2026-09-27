/**
 * Folds over `smg-v1` state histograms (`specs/avail-smg-pyramid.md`):
 * window totals → rider-facing shares, and an Eastern-time hour-of-day
 * profile filtered by day of week.
 *
 * State ids: 0 no_poll, 1 stale_feed, 2 absent (gap); 3 offline, 4 bogus
 * (dead); 5 empty, 6 full, 7 full_no_ebikes, 8 classic_only, 9 ok (live).
 */
import { N_STATES, type SmgBin } from './smg'

/** Sum each state's station-minutes over bins starting in `[fromS, toS)`. */
export function smgTotals(bins: readonly SmgBin[], ff: boolean, fromS: number, toS: number): number[] {
  const out = new Array<number>(N_STATES).fill(0)
  for (const b of bins) {
    if (b.dtS < fromS || b.dtS >= toS) continue
    const counts = ff ? b.ff : b.state
    for (let i = 0; i < N_STATES; i++) out[i] += counts[i]
  }
  return out
}

export interface SmgSummary {
  /** Fractions of *live* minutes (ids 5–9: the station was usable). */
  empty: number
  /** Full, with or without e-bikes (6, 7). */
  full: number
  /** No e-bike available: empty, full-no-ebikes, classic-only (5, 7, 8). */
  noEbikes: number
  /** Offline share of measured minutes (3 / Σ3–9). */
  offline: number
  /** Share of all minutes with no measurement (Σ0–2 / Σ0–9). */
  unmeasured: number
  liveMin: number
  totalMin: number
}

const sum = (c: readonly number[], ids: readonly number[]) => ids.reduce((s, i) => s + c[i], 0)

/** The spec's folds; null when there are no live minutes to divide by. */
export function smgSummary(c: readonly number[]): SmgSummary | null {
  const live = sum(c, [5, 6, 7, 8, 9])
  if (live === 0) return null
  const measured = sum(c, [3, 4, 5, 6, 7, 8, 9])
  const total = measured + sum(c, [0, 1, 2])
  return {
    empty: c[5] / live,
    full: (c[6] + c[7]) / live,
    noEbikes: (c[5] + c[7] + c[8]) / live,
    offline: c[3] / measured,
    unmeasured: sum(c, [0, 1, 2]) / total,
    liveMin: live,
    totalMin: total,
  }
}

/** ISO-ish day index: 0 = Mon … 6 = Sun. */
export type Dow = 0 | 1 | 2 | 3 | 4 | 5 | 6
export const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
})
const WEEKDAY_IDX: Record<string, Dow> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }

/** Eastern-time (day of week, hour of day) of a unix-seconds instant. */
export function etDowHour(tS: number): [Dow, number] {
  let dow: Dow = 0
  let hour = 0
  for (const p of etParts.formatToParts(new Date(tS * 1000))) {
    if (p.type === 'weekday') dow = WEEKDAY_IDX[p.value]
    else if (p.type === 'hour') hour = Number(p.value)
  }
  return [dow, hour]
}

/** Per ET hour of day (24 rows), each state's station-minutes summed over
 *  hourly bins whose ET day of week is in `days`. Bins must be ≤1h wide
 *  (an hour bin starting at :00 ET lies within one ET hour). */
export function smgByEtHour(bins: readonly SmgBin[], ff: boolean, days: ReadonlySet<Dow>): number[][] {
  const out = Array.from({ length: 24 }, () => new Array<number>(N_STATES).fill(0))
  for (const b of bins) {
    const [dow, hour] = etDowHour(b.dtS)
    if (!days.has(dow)) continue
    const counts = ff ? b.ff : b.state
    const row = out[hour]
    for (let i = 0; i < N_STATES; i++) row[i] += counts[i]
  }
  return out
}
