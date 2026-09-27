import { describe, expect, it } from 'vitest'
import { decodeTimeRange } from './time-range'

const DAY = 86_400_000

describe('decodeTimeRange', () => {
  it('reads `-<dur>` and a bare `<dur>` as latest + that width', () => {
    expect(decodeTimeRange('-14d', 7 * DAY)).toEqual({ timestamp: null, duration: 14 * DAY })
    expect(decodeTimeRange('14d', 7 * DAY)).toEqual({ timestamp: null, duration: 14 * DAY })
    expect(decodeTimeRange('1mo2d', 7 * DAY)).toEqual({ timestamp: null, duration: 32 * DAY })
  })
  it('falls back to the default width when absent', () => {
    expect(decodeTimeRange(undefined, 7 * DAY)).toEqual({ timestamp: null, duration: 7 * DAY })
  })
})
