import { describe, expect, test } from 'vitest'
import {
  factorLabel, parseSize, radiusFactor, reduceSel, stationsInRect, zoomFactor, type SelAction, type SelState,
} from './timelapseSelection'

const S = (ids: string[], multi = false): SelState => ({ ids, multi })
const run = (s: SelState, ...as: SelAction[]) => as.reduce(reduceSel, s)

describe('reduceSel', () => {
  test('tap selects only that station', () => {
    expect(reduceSel(S(['a', 'b']), { t: 'tap', id: 'c', toggle: false })).toEqual(S(['c']))
  })
  test('tap on empty map clears', () => {
    expect(reduceSel(S(['a', 'b']), { t: 'tap', id: null, toggle: false })).toEqual(S([]))
  })
  test('shift/⌘ tap toggles without entering multi mode', () => {
    expect(run(S(['a']), { t: 'tap', id: 'b', toggle: true }, { t: 'tap', id: 'a', toggle: true })).toEqual(S(['b']))
    expect(reduceSel(S(['a']), { t: 'tap', id: null, toggle: true })).toEqual(S(['a']))
  })
  test('long-press enters multi mode, adding the station', () => {
    expect(reduceSel(S(['a']), { t: 'longpress', id: 'b' })).toEqual(S(['a', 'b'], true))
    expect(reduceSel(S(['a']), { t: 'longpress', id: 'a' })).toEqual(S(['a'], true))
    expect(reduceSel(S(['a']), { t: 'longpress', id: null })).toEqual(S(['a']))
  })
  test('in multi mode taps toggle; empty-map taps do nothing', () => {
    expect(run(S(['a'], true), { t: 'tap', id: 'b', toggle: false }, { t: 'tap', id: null, toggle: false })).toEqual(S(['a', 'b'], true))
    expect(reduceSel(S(['a', 'b'], true), { t: 'tap', id: 'a', toggle: false })).toEqual(S(['b'], true))
  })
  test('toggling out the last station leaves multi mode', () => {
    expect(reduceSel(S(['a'], true), { t: 'tap', id: 'a', toggle: false })).toEqual(S([]))
  })
  test('add: union in order, keeping the mode', () => {
    expect(reduceSel(S(['b'], true), { t: 'add', ids: ['a', 'b', 'c', 'a'] })).toEqual(S(['b', 'a', 'c'], true))
    expect(reduceSel(S([]), { t: 'add', ids: ['a'] })).toEqual(S(['a']))
  })
  test('add from a long-press rectangle enters multi mode (if anything is selected)', () => {
    expect(reduceSel(S(['a']), { t: 'add', ids: ['b'], multi: true })).toEqual(S(['a', 'b'], true))
    expect(reduceSel(S(['a']), { t: 'add', ids: ['a'], multi: true })).toEqual(S(['a'], true))
    expect(reduceSel(S([]), { t: 'add', ids: [], multi: true })).toEqual(S([]))
  })
  test('add of nothing new returns the same state', () => {
    const s = S(['a'], true)
    expect(reduceSel(s, { t: 'add', ids: ['a'] })).toBe(s)
  })
  test('remove / clear / done', () => {
    expect(reduceSel(S(['a', 'b'], true), { t: 'remove', id: 'a' })).toEqual(S(['b'], true))
    expect(reduceSel(S(['a'], true), { t: 'remove', id: 'a' })).toEqual(S([]))
    expect(reduceSel(S(['a', 'b'], true), { t: 'clear' })).toEqual(S([]))
    expect(reduceSel(S(['a', 'b'], true), { t: 'done' })).toEqual(S(['a', 'b']))
  })
})

describe('stationsInRect', () => {
  // [lng, lat] pairs; "projection" = (lng × 10, lat × 10).
  const positions = new Float64Array([1, 1, 2, 2, 3, 3, 5, 1])
  const project = (lng: number, lat: number): [number, number] => [lng * 10, lat * 10]
  test('inclusive bounds', () => {
    expect(stationsInRect(positions, project, { x0: 10, y0: 10, x1: 30, y1: 25 })).toEqual([0, 1])
    expect(stationsInRect(positions, project, { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([0, 1, 2, 3])
    expect(stationsInRect(positions, project, { x0: 40, y0: 40, x1: 45, y1: 45 })).toEqual([])
  })
  test('keep filter', () => {
    expect(stationsInRect(positions, project, { x0: 0, y0: 0, x1: 100, y1: 100 }, (i) => i % 2 === 1)).toEqual([1, 3])
  })
})

describe('sizing', () => {
  test('parseSize: default 1, clamped to [0.25, 2]', () => {
    expect([undefined, '', 'x', '0', '-1', '0.5', '0.1', '3', '1.4'].map((v) => parseSize(v))).toEqual([1, 1, 1, 1, 1, 0.5, 0.25, 2, 1.4])
  })
  test('zoomFactor: full size from z11, halving every 2 levels below, floored', () => {
    expect([13, 11, 10, 9, 7, 3].map((z) => Number(zoomFactor(z).toFixed(3)))).toEqual([1, 1, 0.707, 0.5, 0.35, 0.35])
  })
  test('radiusFactor = sz × zoomFactor', () => {
    expect(radiusFactor(2, 9)).toEqual(1)
    expect(radiusFactor(0.5, 12)).toEqual(0.5)
  })
  test('factorLabel', () => {
    expect([0.25, 0.5, 1, 1.4, 0.7071, 2].map(factorLabel)).toEqual(['×0.25', '×0.5', '×1', '×1.4', '×0.71', '×2'])
  })
})
