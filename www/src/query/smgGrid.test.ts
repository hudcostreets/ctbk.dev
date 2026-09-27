import { describe, expect, it } from 'vitest'
import type { SmgBin } from './smg'
import { etDayMinute, smgGrid } from './smgGrid'

const bin = (dtS: number, counts: Record<number, number>): SmgBin => {
  const state = Array.from({ length: 10 }, (_, i) => counts[i] ?? 0)
  return { dtS, state, ff: state }
}

// 2026-09-21 00:00 EDT = 04:00Z.
const MON = Date.UTC(2026, 8, 21, 4) / 1000
const H = 3600

describe('etDayMinute', () => {
  it('maps to the ET calendar day and minute', () => {
    expect(etDayMinute(MON)).toEqual(['2026-09-21', 0])
    expect(etDayMinute(MON + 8.5 * H)).toEqual(['2026-09-21', 510])
    expect(etDayMinute(MON - 60)).toEqual(['2026-09-20', 1439])
  })
})

describe('smgGrid', () => {
  it('rows newest-first, cells at ET slot, empty slots null', () => {
    const rows = smgGrid([
      bin(MON, { 9: 60 }),
      bin(MON + 2 * H, { 5: 60 }),
      bin(MON + 24 * H + H, { 9: 30, 5: 30 }),
    ], H, false)
    expect(rows.map((r) => r.day)).toEqual(['2026-09-22', '2026-09-21'])
    expect(rows[1].cells.slice(0, 3)).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 60],
      null,
      [0, 0, 0, 0, 0, 60, 0, 0, 0, 0],
    ])
    expect(rows[0].cells[1]).toEqual([0, 0, 0, 0, 0, 30, 0, 0, 0, 30])
    expect(rows[0].cells.length).toBe(24)
  })
})
