import { describe, expect, it } from 'vitest'
import {
  arcAlpha, arcWidthPx, flowArcs, flowLens, lensColorT, lensRadiusPx, lensZoomScale, legendTicks, niceFloor,
  SIZE_KEY_FRACS, WIDTH_KEY_FRACS,
} from './flowLens'
import type { StationPairCounts, Stations } from './stationMapCommon'

describe('lensRadiusPx (px at base zoom; area ∝ trips)', () => {
  it('0 trips → dot; else R_MAX·sqrt(frac), floored at R_MIN', () => {
    expect([
      lensRadiusPx(0, 100),
      lensRadiusPx(1, 100),
      lensRadiusPx(25, 100),
      lensRadiusPx(9, 16),
      lensRadiusPx(100, 100),
      lensRadiusPx(200, 100),
      lensRadiusPx(5, 0),
    ]).toEqual([1.5, 2.5, 7, 10.5, 14, 14, 1.5])
  })
})

describe('lensColorT (log ramp position)', () => {
  it('1 trip → 0, max → 1, log-spaced between', () => {
    expect([
      lensColorT(0, 100),
      lensColorT(1, 100),
      lensColorT(10, 100),
      lensColorT(100, 100),
      lensColorT(1, 1),
    ]).toEqual([0, 0, 0.5, 1, 1])
  })
})

describe('lensZoomScale', () => {
  it('√2 per level from z12, clamped to [0.5, 2.5]', () => {
    expect([8, 10, 12, 13, 14, 16].map(lensZoomScale)).toEqual([0.5, 0.5, 1, Math.SQRT2, 2, 2.5])
  })
})

describe('arc width / alpha', () => {
  it('width linear in trips, 12px max, 1px floor', () => {
    expect([100, 50, 25, 1, 0].map((c) => arcWidthPx(c, 100))).toEqual([12, 6, 3, 1, 1])
  })
  it('alpha sqrt-scaled 110 → 235', () => {
    expect([100, 25, 0].map((c) => arcAlpha(c, 100))).toEqual([235, 173, 110])
  })
})

describe('legend ticks', () => {
  it('niceFloor: largest 1-2-5 ≤ x', () => {
    expect([1, 3, 7, 10, 22.16, 110.8, 554].map(niceFloor)).toEqual([1, 2, 5, 10, 20, 100, 500])
  })
  it('max itself, then nice values at each fraction, deduped, ≥ 1', () => {
    expect(legendTicks(554, SIZE_KEY_FRACS)).toEqual([554, 100, 20])
    expect(legendTicks(10, SIZE_KEY_FRACS)).toEqual([10, 2])
    expect(legendTicks(3, SIZE_KEY_FRACS)).toEqual([3])
    expect(legendTicks(100, WIDTH_KEY_FRACS)).toEqual([100, 50, 10])
    expect(legendTicks(1, WIDTH_KEY_FRACS)).toEqual([1])
    expect(legendTicks(0, WIDTH_KEY_FRACS)).toEqual([])
  })
})

const stations: Stations = {
  A: { name: 'A', lat: 40.7, lng: -74.0, ends: 500 },
  B: { name: 'B', lat: 40.71, lng: -74.01, ends: 300 },
  C: { name: 'C', lat: 40.72, lng: -74.02, ends: 200 },
  D: { name: 'D', lat: 40.73, lng: -74.03, ends: 100 },
  E: { name: 'E', lat: 40.74, lng: -74.04, ends: 50 },
}
const pairs: StationPairCounts = {
  A: { B: 100, C: 10, D: 3, A: 7 },
  B: { A: 4 },
}

describe('flowLens', () => {
  it('sizes + colors every ≥1-trip station (no floor); 0-trip → grey dot; source omitted', () => {
    expect(flowLens(stations, pairs, ['A'], 'cr')).toEqual({
      colors: { B: '#d1180b', C: '#c5bc8a', D: '#6785e7', E: '#888' },
      radii: { B: 14, C: 4.427188724235731, D: 2.5, E: 1.5 },
      total: 113,
      topCount: 100,
    })
  })
  it('channel `c` → colors only; `n` → null; inbound direction', () => {
    expect(flowLens(stations, pairs, ['A'], 'c')?.radii).toBe(null)
    expect(flowLens(stations, pairs, ['A'], 'n')).toBe(null)
    expect(flowLens(stations, pairs, ['A'], 'r', 'in')).toEqual({
      colors: null,
      radii: { B: 14, C: 1.5, D: 1.5, E: 1.5 },
      total: 4,
      topCount: 4,
    })
  })
})

describe('flowArcs', () => {
  it('drops pairs < 4% of the heaviest; sorted light → heavy', () => {
    expect(flowArcs(stations, pairs, ['A'], 'out')).toEqual([
      { from: 'A', to: 'C', source: [-74.0, 40.7], target: [-74.02, 40.72], count: 10 },
      { from: 'A', to: 'B', source: [-74.0, 40.7], target: [-74.01, 40.71], count: 100 },
    ])
  })
  it('merges a multi-station set into one arc per other station, set end at the count-weighted centroid', () => {
    const multi: StationPairCounts = { A: { C: 30, B: 5 }, B: { C: 10, D: 20 }, E: { A: 8, B: 2 } }
    const cLng = (-74.0 * 30 + -74.01 * 10) / 40
    const cLat = (40.7 * 30 + 40.71 * 10) / 40
    expect(flowArcs(stations, multi, ['A', 'B'], 'out')).toEqual([
      { from: 'B', to: 'D', source: [-74.01, 40.71], target: [-74.03, 40.73], count: 20 },
      { from: 'A', to: 'C', source: [cLng, cLat], target: [-74.02, 40.72], count: 40 },
    ])
    expect(flowArcs(stations, multi, ['A', 'B'], 'in')).toEqual([
      { from: 'E', to: 'A', source: [-74.04, 40.74], target: [(-74.0 * 8 + -74.01 * 2) / 10, (40.7 * 8 + 40.71 * 2) / 10], count: 10 },
    ])
  })
})
