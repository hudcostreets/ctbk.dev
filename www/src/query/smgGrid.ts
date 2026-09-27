/**
 * Day × time-of-day layout for `smg-v1` bins (the station page's state grid):
 * each bin lands in the row of its Eastern-time calendar day, at the column
 * of its ET minute-of-day / bin width. DST days just leave a slot empty (spring)
 * or merge two bins into one slot (fall).
 */
import { N_STATES, type SmgBin } from './smg'

export interface GridRow {
  /** ET calendar day, `YYYY-MM-DD`. */
  day: string
  /** Per column: the slot's station-minutes by state id, or null (no bin). */
  cells: (number[] | null)[]
}

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
})

/** ET `[YYYY-MM-DD, minute of day]` of a unix-seconds instant. */
export function etDayMinute(tS: number): [string, number] {
  const p: Record<string, string> = {}
  for (const x of etParts.formatToParts(new Date(tS * 1000))) p[x.type] = x.value
  return [`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute)]
}

/** Rows newest-first; `binS` must divide a day. */
export function smgGrid(bins: readonly SmgBin[], binS: number, ff: boolean): GridRow[] {
  const nCols = Math.round(86400 / binS)
  const byDay = new Map<string, (number[] | null)[]>()
  for (const b of bins) {
    const [day, minute] = etDayMinute(b.dtS)
    let cells = byDay.get(day)
    if (!cells) { cells = new Array(nCols).fill(null); byDay.set(day, cells) }
    const col = Math.floor((minute * 60) / binS)
    const src = ff ? b.ff : b.state
    const cur = cells[col]
    if (cur) for (let i = 0; i < N_STATES; i++) cur[i] += src[i]
    else cells[col] = [...src]
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, cells]) => ({ day, cells }))
}
