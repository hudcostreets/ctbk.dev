import { describe, expect, it } from 'vitest'
import { activeFractions, activeRollingAvg, dayX, inactiveSpans, spanDays, spanLabel } from './inactive'
import { monthToDate } from './ymrgtb-traces'

const t = (ym: string) => monthToDate(ym).getTime()

describe('dayX', () => {
  it('maps a month onto its slot, midpoint to midpoint between month starts', () => {
    expect(dayX('2023-09-01')).toBe((t('2023-08') + t('2023-09')) / 2)
    expect(dayX('2023-09-30', true)).toBe((t('2023-09') + t('2023-10')) / 2)
    expect(dayX('2023-10-01')).toBe(dayX('2023-09-30', true))
  })
  it('places days proportionally', () => {
    const lo = dayX('2023-09-01')
    const hi = dayX('2023-09-30', true)
    expect(dayX('2023-09-16')).toBeCloseTo(lo + (hi - lo) / 2)
  })
})

describe('inactiveSpans', () => {
  it('keeps exact closures, drops inferred runs they overlap, sorts', () => {
    expect(inactiveSpans(
      [['2023-08-31', '2023-10-29'], ['2021-03-05', '2021-03-20']],
      [['2023-09', '2023-09'], ['2019-02', '2019-04']],
    )).toEqual([
      { from: '2019-02-01', to: '2019-04-30', exact: false },
      { from: '2021-03-05', to: '2021-03-20', exact: true },
      { from: '2023-08-31', to: '2023-10-29', exact: true },
    ])
  })
})

describe('spanLabel / spanDays', () => {
  it('formats exact and whole-month spans', () => {
    expect(spanLabel({ from: '2023-08-31', to: '2023-10-29', exact: true })).toBe('Aug 31 – Oct 29, 2023')
    expect(spanLabel({ from: '2024-01-13', to: '2025-02-02', exact: true })).toBe('Jan 13, 2024 – Feb 2, 2025')
    expect(spanLabel({ from: '2024-02-01', to: '2024-11-30', exact: false })).toBe("Feb '24 – Nov '24")
    expect(spanLabel({ from: '2024-02-01', to: '2024-02-29', exact: false })).toBe("Feb '24")
  })
  it('counts calendar days inclusively', () => {
    expect(spanDays({ from: '2023-08-31', to: '2023-10-29', exact: true })).toBe(60)
    expect(spanDays({ from: '2024-01-13', to: '2024-12-04', exact: true })).toBe(327)
  })
})

describe('activeFractions', () => {
  it('fraction of each month outside the spans', () => {
    const spans = [{ from: '2024-01-13', to: '2024-12-04', exact: true }]
    expect(activeFractions(['2023-12', '2024-01', '2024-06', '2024-12', '2025-01'], spans)).toEqual([1, 12 / 31, 0, 27 / 31, 1])
  })
})

describe('activeRollingAvg', () => {
  it('skips inactive months and weights partial ones', () => {
    // n=2: [10, 20, (off), 5 over half a month, 30]
    expect(activeRollingAvg([10, 20, 0, 5, 30], [1, 1, 0, 0.5, 1], 2)).toEqual([null, 15, null, 25 / 1.5, 35 / 1.5])
  })
})
