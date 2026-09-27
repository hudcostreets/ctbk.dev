import { describe, expect, it } from 'vitest'
import { inactiveRuns, monthSpan } from './ymrgtb-traces'

describe('monthSpan', () => {
  it('spans year boundaries, inclusive', () => {
    expect(monthSpan('2023-11', '2024-02')).toEqual(['2023-11', '2023-12', '2024-01', '2024-02'])
    expect(monthSpan('2024-05', '2024-05')).toEqual(['2024-05'])
  })
})

describe('inactiveRuns', () => {
  const rows = (ms: string[]) => ms.map((m) => ({ m }))
  it('interior runs of ≥ 2 missing months', () => {
    expect(inactiveRuns(rows(['2023-12', '2024-01', '2024-12', '2025-01', '2025-03']))).toEqual([['2024-02', '2024-11']])
  })
  it('a single missing month, or none, is not a run', () => {
    expect(inactiveRuns(rows(['2024-01', '2024-03']))).toEqual([])
    expect(inactiveRuns(rows(['2024-01', '2024-02']))).toEqual([])
  })
})
