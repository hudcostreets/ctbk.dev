import { describe, expect, test } from 'vitest'
import {
  capRange, clockLabel, editRange, fitRangeToBin, frameCount, isoDay, lastDataDay, maxDays, parseIsoDay, rangeFrames,
  shortLabel, spanEnding, spanRange, spanStarting, speedLabel, stepSpeed, suggestBin,
  type Range,
} from './timelapseControls'
import { BINS, frameIndex, frameStartMs, GENESIS_MS, originMs } from './timelapseFrames'

const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h)
const LO = GENESIS_MS
const HI = D(2026, 8, 31)
/** Ranges as `YYYY-MM-DD` pairs, for readable expectations. */
const iso = ([a, b]: Range) => [isoDay(a), isoDay(b)]

describe('frame grid for every tier (mirrors `/api/tl` chunk 0 `t0`s)', () => {
  test('originMs', () => {
    expect(BINS.map((b) => [b, isoDay(originMs(b))])).toEqual([
      ['1h', '2013-05-31'],
      ['3h', '2013-05-31'],
      ['6h', '2013-05-31'],
      ['12h', '2013-05-31'],
      ['1d', '2013-05-15'],
      ['3d', '2013-05-15'],
      ['7d', '2012-12-06'],
      ['14d', '2012-12-06'],
      ['1mo', '2012-01-01'],
    ])
  })
  test('1mo frames are calendar months', () => {
    expect(frameIndex('1mo', D(2013, 6, 1))).toBe(17)
    expect(frameIndex('1mo', D(2025, 6, 30, 23))).toBe(161)
    expect(frameStartMs('1mo', 161)).toBe(D(2025, 6, 1))
    expect(frameStartMs('1mo', 162)).toBe(D(2025, 7, 1))
  })
  test('fixed tiers', () => {
    expect(frameStartMs('3h', frameIndex('3h', D(2025, 6, 10, 19)))).toBe(D(2025, 6, 10, 18))
    expect(frameStartMs('7d', frameIndex('7d', D(2025, 6, 10)))).toBe(D(2025, 6, 5))
  })
})

describe('range → frames', () => {
  test('rangeFrames / frameCount', () => {
    const r: Range = [D(2025, 6, 9), D(2025, 6, 10)]
    expect(frameCount('1h', r)).toBe(48)
    expect(frameCount('3h', r)).toBe(16)
    expect(frameCount('1d', r)).toBe(2)
    expect(frameCount('7d', r)).toBe(1)
    expect(rangeFrames('1d', r)).toEqual([frameIndex('1d', D(2025, 6, 9)), frameIndex('1d', D(2025, 6, 10))])
    expect(frameCount('1mo', [D(2025, 1, 31), D(2025, 3, 1)])).toBe(3)
  })
  test('lastDataDay', () => {
    expect(lastDataDay('202608')).toBe(D(2026, 8, 31))
    expect(lastDataDay('202402')).toBe(D(2024, 2, 29))
    expect(lastDataDay('2026-08')).toBe(null)
  })
})

describe('spans + presets', () => {
  test('spanEnding / spanStarting', () => {
    expect(iso(spanEnding({ n: 7, u: 'd' }, D(2025, 6, 10), LO))).toEqual(['2025-06-04', '2025-06-10'])
    expect(iso(spanEnding({ n: 1, u: 'mo' }, D(2025, 6, 10), LO))).toEqual(['2025-05-11', '2025-06-10'])
    expect(iso(spanEnding({ n: 12, u: 'mo' }, D(2025, 12, 31), LO))).toEqual(['2025-01-01', '2025-12-31'])
    expect(iso(spanEnding({ n: 12, u: 'mo' }, D(2013, 9, 1), LO))).toEqual(['2013-06-01', '2013-09-01'])
    expect(iso(spanStarting({ n: 3, u: 'd' }, D(2025, 6, 10), HI))).toEqual(['2025-06-10', '2025-06-12'])
    expect(iso(spanStarting({ n: 1, u: 'mo' }, D(2025, 6, 10), HI))).toEqual(['2025-06-10', '2025-07-09'])
    expect(iso(spanStarting({ n: 1, u: 'mo' }, D(2026, 8, 20), HI))).toEqual(['2026-08-20', '2026-08-31'])
  })
  test('spanRange: keeps the end when the playhead fits, else starts at the playhead', () => {
    const cur: Range = [D(2025, 6, 9), D(2025, 6, 10)]
    // Widen: the week ending on the current end contains the playhead.
    expect(iso(spanRange({ n: 7, u: 'd' }, cur, D(2025, 6, 10), LO, HI))).toEqual(['2025-06-04', '2025-06-10'])
    // Narrow to 1 day while the playhead is on the first day: start there.
    expect(iso(spanRange({ n: 1, u: 'd' }, cur, D(2025, 6, 9), LO, HI))).toEqual(['2025-06-09', '2025-06-09'])
    // Playhead far before the end: window starts at the playhead.
    expect(iso(spanRange({ n: 1, u: 'mo' }, [D(2025, 1, 1), D(2025, 12, 31)], D(2025, 3, 3), LO, HI))).toEqual(['2025-03-03', '2025-04-02'])
    expect(iso(spanRange({ n: 14, u: 'd' }, [D(2026, 8, 1), D(2026, 8, 2)], D(2026, 8, 1), LO, HI))).toEqual(['2026-07-20', '2026-08-02'])
    // Playhead past the range end, and starting there would run past the data: end at `hi`.
    expect(iso(spanRange({ n: 14, u: 'd' }, [D(2026, 8, 1), D(2026, 8, 2)], D(2026, 8, 25), LO, HI))).toEqual(['2026-08-18', '2026-08-31'])
    // An end past the data is pulled back to `hi`.
    expect(iso(spanRange({ n: 12, u: 'mo' }, [D(2025, 9, 28), D(2026, 9, 27)], D(2026, 3, 1), LO, HI))).toEqual(['2025-09-01', '2026-08-31'])
    expect(iso(spanRange('all', cur, D(2025, 6, 9), LO, HI))).toEqual(['2013-06-01', '2026-08-31'])
  })
  test('editRange: clamps to [lo, hi] and pushes the other side', () => {
    const cur: Range = [D(2025, 6, 9), D(2025, 6, 10)]
    expect(iso(editRange(cur, 'start', D(2025, 6, 1), LO, HI))).toEqual(['2025-06-01', '2025-06-10'])
    expect(iso(editRange(cur, 'start', D(2025, 6, 20), LO, HI))).toEqual(['2025-06-20', '2025-06-20'])
    expect(iso(editRange(cur, 'end', D(2025, 6, 1), LO, HI))).toEqual(['2025-06-01', '2025-06-01'])
    expect(iso(editRange(cur, 'end', D(2027, 1, 1), LO, HI))).toEqual(['2025-06-09', '2026-08-31'])
    expect(iso(editRange(cur, 'start', D(2010, 1, 1), LO, HI))).toEqual(['2013-06-01', '2025-06-10'])
  })
})

describe('frame-count guard', () => {
  test('maxDays', () => {
    expect(BINS.map((b) => [b, maxDays(b)])).toEqual([
      ['1h', 250], ['3h', 750], ['6h', 1500], ['12h', 3000], ['1d', 6000], ['3d', 18000], ['7d', 42000], ['14d', 84000], ['1mo', 182621],
    ])
  })
  test('capRange keeps the edited side', () => {
    const yr: Range = [D(2025, 1, 1), D(2025, 12, 31)]
    expect(capRange('1d', yr, 'end')).toEqual({ range: yr, capped: false })
    expect(capRange('1h', yr, 'end')).toEqual({ range: [D(2025, 4, 26), D(2025, 12, 31)], capped: true })
    expect(capRange('1h', yr, 'start')).toEqual({ range: [D(2025, 1, 1), D(2025, 9, 7)], capped: true })
    expect(frameCount('1h', capRange('1h', yr, 'start').range)).toBe(6000)
  })
  test('suggestBin: finest bin with ≤ 1500 frames', () => {
    expect(suggestBin([D(2025, 6, 9), D(2025, 6, 10)])).toBe('1h')
    expect(suggestBin([D(2025, 1, 1), D(2025, 3, 31)])).toBe('3h')
    expect(suggestBin([D(2025, 1, 1), D(2025, 12, 31)])).toBe('6h')
    expect(suggestBin([LO, HI])).toBe('7d')
  })
  test('fitRangeToBin: re-fit only when finer + too many, or coarser + too few', () => {
    const two: Range = [D(2025, 6, 9), D(2025, 6, 10)]
    const t = D(2025, 6, 10)
    expect(fitRangeToBin('1h', '3h', two, t, LO, HI)).toEqual(two)
    // 2 frames at `1d` (< 4): the `1d` default (1y) ending on the range end.
    expect(iso(fitRangeToBin('3h', '1d', two, t, LO, HI))).toEqual(['2024-06-11', '2025-06-10'])
    expect(iso(fitRangeToBin('1d', '7d', two, t, LO, HI))).toEqual(['2022-06-11', '2025-06-10'])
    // All history at `1d` → `1h`: the `1h` default week around the playhead.
    expect(iso(fitRangeToBin('1d', '1h', [LO, HI], D(2019, 3, 5), LO, HI))).toEqual(['2019-03-05', '2019-03-11'])
    // Finer but still small: unchanged.
    const yr: Range = [D(2025, 1, 1), D(2025, 12, 31)]
    expect(fitRangeToBin('1d', '6h', yr, t, LO, HI)).toEqual(yr)
    // Coarser with plenty of frames: unchanged.
    expect(fitRangeToBin('1d', '7d', yr, t, LO, HI)).toEqual(yr)
  })
})

describe('labels', () => {
  const t = D(2025, 6, 10, 18)
  test('clockLabel', () => {
    expect(BINS.map((b) => [b, clockLabel(b, frameStartMs(b, frameIndex(b, t)))])).toEqual([
      ['1h', 'Tue, Jun 10, 2025 · 18:00'],
      ['3h', 'Tue, Jun 10, 2025 · 18:00–21:00'],
      ['6h', 'Tue, Jun 10, 2025 · 18:00–24:00'],
      ['12h', 'Tue, Jun 10, 2025 · 12:00–24:00'],
      ['1d', 'Tue, Jun 10, 2025'],
      ['3d', 'Jun 8–10, 2025'],
      ['7d', 'Jun 5–11, 2025'],
      ['14d', 'Jun 5–18, 2025'],
      ['1mo', 'June 2025'],
    ])
    expect(clockLabel('7d', D(2025, 12, 29))).toBe('Dec 29, 2025 – Jan 4, 2026')
  })
  test('shortLabel', () => {
    expect(BINS.map((b) => [b, shortLabel(b, frameStartMs(b, frameIndex(b, t)))])).toEqual([
      ['1h', 'Tue Jun 10 · 18:00'],
      ['3h', 'Tue Jun 10 · 18:00–21:00'],
      ['6h', 'Tue Jun 10 · 18:00–24:00'],
      ['12h', 'Tue Jun 10 · 12:00–24:00'],
      ['1d', 'Tue Jun 10, 2025'],
      ['3d', 'Jun 8–10, 2025'],
      ['7d', 'Jun 5–11, 2025'],
      ['14d', 'Jun 5–18, 2025'],
      ['1mo', 'Jun 2025'],
    ])
  })
  test('speedLabel', () => {
    expect(BINS.map((b) => [b, speedLabel(b, 8)])).toEqual([
      ['1h', '8 h/s'], ['3h', '24 h/s'], ['6h', '48 h/s'], ['12h', '96 h/s'],
      ['1d', '8 d/s'], ['3d', '24 d/s'], ['7d', '8 wk/s'], ['14d', '16 wk/s'], ['1mo', '8 mo/s'],
    ])
  })
  test('stepSpeed', () => {
    expect([1, 8, 30].map((s) => [stepSpeed(s, -1), stepSpeed(s, 1)])).toEqual([[1, 2], [4, 16], [16, 30]])
    // Off-list values (an old `sp=32` URL) step to the nearest listed one.
    expect([stepSpeed(32, -1), stepSpeed(32, 1), stepSpeed(5, 1)]).toEqual([30, 30, 8])
  })
  test('isoDay / parseIsoDay', () => {
    expect(isoDay(D(2025, 6, 9))).toBe('2025-06-09')
    expect(parseIsoDay('2025-06-09')).toBe(D(2025, 6, 9))
    expect([parseIsoDay(''), parseIsoDay('2025-02-30'), parseIsoDay('25-06-09')]).toEqual([null, null, null])
  })
})
