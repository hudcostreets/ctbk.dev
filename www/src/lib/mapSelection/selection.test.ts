import { describe, expect, test } from 'vitest'
import { IDLE, LONG_PRESS_MS, step, type GestureEvent, type GestureState, type Pt, type Rect } from './gesture'
import { gestureSelAction, reduceSel, selParam, stationsInRect, type SelAction, type SelState } from './selection'

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

describe('selParam', () => {
  test('encode: comma-joined, empty → absent', () => {
    expect([[], ['a'], ['6450.12', 'HB101']].map((v) => selParam.encode(v))).toEqual([undefined, 'a', '6450.12,HB101'])
  })
  test('decode: order-preserving, empties dropped', () => {
    expect([undefined, '', 'a', 'b,a', 'a,,b,'].map((v) => selParam.decode(v))).toEqual([[], [], ['a'], ['b', 'a'], ['a', 'b']])
  })
})

/**
 * Gesture events → `gesture.step` → `gestureSelAction` → `reduceSel`, as
 * `useSelectionGestures` + `useSelection` wire them (minus the DOM). Stations
 * sit on a 10px grid: `a` at (10,10), `b` at (20,10), `c` at (30,10); a pick
 * hits a station exactly at its point.
 */
describe('gestures → selection', () => {
  const STATIONS: Record<string, Pt> = { a: { x: 10, y: 10 }, b: { x: 20, y: 10 }, c: { x: 30, y: 10 } }
  const pickAt = (at: Pt) => Object.keys(STATIONS).find((id) => STATIONS[id].x === at.x && STATIONS[id].y === at.y) ?? null
  const pickRect = (r: Rect) => Object.keys(STATIONS).filter((id) => {
    const { x, y } = STATIONS[id]
    return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1
  })
  type Ev = GestureEvent
  const down = (x: number, y: number, o: { touch?: boolean; shift?: boolean; mod?: boolean; time?: number } = {}): Ev => ({
    t: 'down', id: 1, at: { x, y }, time: o.time ?? 0, touch: o.touch ?? false, shift: o.shift ?? false, mod: o.mod ?? false,
  })
  const move = (x: number, y: number): Ev => ({ t: 'move', id: 1, at: { x, y } })
  const up = (x: number, y: number): Ev => ({ t: 'up', id: 1, at: { x, y } })
  const timer: Ev = { t: 'timer', time: LONG_PRESS_MS }

  /** Run gestures (one array per gesture) from `sel`; the final selection. */
  function play(sel: SelState, ...gestures: Ev[][]): SelState {
    for (const events of gestures) {
      let g: GestureState = IDLE
      let fromLongPress = false
      for (const e of events) {
        const r = step(g, e)
        g = r.s
        for (const o of r.out) {
          if (o.t === 'longpress') fromLongPress = true
          const a = gestureSelAction(o, pickAt, pickRect, fromLongPress)
          if (a) sel = reduceSel(sel, a)
        }
      }
    }
    return sel
  }
  const tap = (x: number, y: number, o: { mod?: boolean; touch?: boolean } = {}) => [down(x, y, o), up(x, y)]
  const longPress = (x: number, y: number) => [down(x, y, { touch: true }), timer, up(x, y)]

  test('tap selects one; tapping another replaces; empty-map tap clears', () => {
    expect(play(S([]), tap(10, 10))).toEqual(S(['a']))
    expect(play(S(['a']), tap(20, 10))).toEqual(S(['b']))
    expect(play(S(['a', 'b']), tap(50, 50))).toEqual(S([]))
  })
  test('⌘/shift-click toggles', () => {
    expect(play(S(['a']), tap(20, 10, { mod: true }), tap(10, 10, { mod: true }))).toEqual(S(['b']))
  })
  test('long-press → multi mode; taps toggle; empty taps keep the set; Done leaves the mode', () => {
    const s = play(S([]), longPress(10, 10), tap(20, 10, { touch: true }), tap(50, 50, { touch: true }), tap(10, 10, { touch: true }))
    expect(s).toEqual(S(['b'], true))
    expect(reduceSel(s, { t: 'done' })).toEqual(S(['b']))
  })
  test('long-press + drag box-selects into multi mode', () => {
    expect(play(S([]), [down(5, 5, { touch: true }), timer, move(25, 15), up(25, 15)])).toEqual(S(['a', 'b'], true))
  })
  test('shift-drag (mouse) adds the box without entering multi mode', () => {
    expect(play(S(['c']), [down(5, 5, { shift: true, mod: true }), move(25, 15), up(25, 15)])).toEqual(S(['c', 'a', 'b']))
  })
  test('a plain drag pans: no selection change', () => {
    expect(play(S(['a']), [down(5, 5), move(25, 15), up(25, 15)])).toEqual(S(['a']))
  })
})
