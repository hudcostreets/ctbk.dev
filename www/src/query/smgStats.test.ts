import { describe, expect, it } from 'vitest'
import type { SmgBin } from './smg'
import { etDowHour, smgByEtHour, smgSummary, smgTotals, type Dow } from './smgStats'

/** A bin with `counts[id]` station-minutes; `ff` = the raw counts with gap
 *  states (0–2) folded into `ok` (enough to tell the two apart). */
function bin(dtS: number, counts: Record<number, number>): SmgBin {
  const state = Array.from({ length: 10 }, (_, i) => counts[i] ?? 0)
  const ff = [...state]
  ff[9] += ff[0] + ff[1] + ff[2]
  ff[0] = ff[1] = ff[2] = 0
  return { dtS, state, ff }
}

// 2026-09-21 is a Monday; 04:00Z = 00:00 EDT.
const MON_0000_ET = Date.UTC(2026, 8, 21, 4) / 1000
const H = 3600

describe('smgTotals', () => {
  const bins = [
    bin(MON_0000_ET, { 5: 10, 9: 50, 0: 5 }),
    bin(MON_0000_ET + H, { 6: 20, 9: 40 }),
    bin(MON_0000_ET + 2 * H, { 9: 60 }),
  ]
  it('sums bins starting in [from, to)', () => {
    expect(smgTotals(bins, false, MON_0000_ET, MON_0000_ET + 2 * H)).toEqual([5, 0, 0, 0, 0, 10, 20, 0, 0, 90])
  })
  it('uses the forward-filled partition when ff', () => {
    expect(smgTotals(bins, true, MON_0000_ET, MON_0000_ET + H)).toEqual([0, 0, 0, 0, 0, 10, 0, 0, 0, 55])
  })
})

describe('smgSummary', () => {
  it('folds live / measured / total denominators', () => {
    //          no_poll offline empty full full_noeb classic ok
    const c = [4, 0, 0, 10, 0, 20, 10, 5, 15, 50]
    expect(smgSummary(c)).toEqual({
      empty: 20 / 100,
      full: 15 / 100,
      noEbikes: 40 / 100,
      offline: 10 / 110,
      unmeasured: 4 / 114,
      liveMin: 100,
      totalMin: 114,
    })
  })
  it('is null with no live minutes', () => {
    expect(smgSummary([60, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
  })
})

describe('etDowHour', () => {
  it('maps UTC instants to Eastern (DST-aware) day + hour', () => {
    expect(etDowHour(MON_0000_ET)).toEqual([0, 0])
    expect(etDowHour(MON_0000_ET - 1)).toEqual([6, 23])
    // 2026-01-05 (Mon, EST): 05:00Z = 00:00 EST.
    expect(etDowHour(Date.UTC(2026, 0, 5, 5) / 1000)).toEqual([0, 0])
  })
})

describe('smgByEtHour', () => {
  const sat = MON_0000_ET - 2 * 24 * H  // Sat 00:00 ET
  const bins = [
    bin(MON_0000_ET + 8 * H, { 5: 30, 9: 30 }),   // Mon 08:00
    bin(MON_0000_ET + 32 * H, { 5: 10, 9: 50 }),  // Tue 08:00
    bin(sat + 8 * H, { 9: 60 }),                  // Sat 08:00
  ]
  it('groups by ET hour over the chosen days only', () => {
    const weekdays = new Set<Dow>([0, 1, 2, 3, 4])
    const rows = smgByEtHour(bins, false, weekdays)
    expect(rows.length).toBe(24)
    expect(rows[8]).toEqual([0, 0, 0, 0, 0, 40, 0, 0, 0, 80])
    expect(rows.filter((r, h) => h !== 8 && r.some((v) => v > 0))).toEqual([])
  })
  it('weekend-only picks Saturday', () => {
    expect(smgByEtHour(bins, false, new Set<Dow>([5, 6]))[8]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 60])
  })
})
