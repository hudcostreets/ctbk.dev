import { describe, expect, it } from 'vitest'
import type { SmgBin } from '../query/smg'
import { etHoursOf, hodIntervals, stateSpans } from './smgBrush'

const H = 3600
// 2026-09-21 00:00 EDT = 04:00Z.
const MON = Date.UTC(2026, 8, 21, 4) / 1000
// 2026-11-01 (fall back): 00:00 EDT = 04:00Z; 1am repeats; 2am EST = 07:00Z.
const NOV1 = Date.UTC(2026, 10, 1, 4) / 1000

describe('hodIntervals', () => {
  it('one ET-hour interval per overlapping day', () => {
    expect(hodIntervals(9, MON + 12 * H, MON + 3 * 24 * H)).toEqual([
      [MON + 33 * H, MON + 34 * H],
      [MON + 57 * H, MON + 58 * H],
    ])
  })
  it('lands on the ET hour across a DST change', () => {
    expect(hodIntervals(9, NOV1, NOV1 + 24 * H)).toEqual([[NOV1 + 10 * H, NOV1 + 11 * H]])
  })
})

describe('etHoursOf', () => {
  it('hours a range touches', () => {
    expect(etHoursOf(MON + 8 * H + 1800, 300)).toEqual([8])
    expect(etHoursOf(MON + 22 * H, 3 * H)).toEqual([0, 22, 23])
    expect(etHoursOf(MON, 24 * H)).toEqual(Array.from({ length: 24 }, (_, h) => h))
  })
})

describe('stateSpans', () => {
  const bin = (dtS: number, counts: Record<number, number>): SmgBin => {
    const state = Array.from({ length: 10 }, (_, i) => counts[i] ?? 0)
    return { dtS, state, ff: state }
  }
  it('merges adjacent bins where the state occurs, pooling its share', () => {
    expect(stateSpans([
      bin(0, { 6: 30, 9: 30 }),
      bin(H, { 6: 60 }),
      bin(2 * H, { 9: 60 }),
      bin(3 * H, { 6: 15, 9: 45 }),
    ], H, false, 6)).toEqual([
      [0, 2 * H, 0.75],
      [3 * H, 4 * H, 0.25],
    ])
  })
})
