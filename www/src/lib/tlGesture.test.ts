import { describe, expect, test } from 'vitest'
import { IDLE, LONG_PRESS_MS, step, type GestureEvent, type GestureOut, type GestureState } from './tlGesture'

/** Run `events` from idle; the final state's kind + every output, in order. */
function run(events: GestureEvent[]): { k: GestureState['k']; out: GestureOut[] } {
  let s: GestureState = IDLE
  const out: GestureOut[] = []
  for (const e of events) {
    const r = step(s, e)
    s = r.s
    out.push(...r.out)
  }
  return { k: s.k, out }
}

const at = (x: number, y: number) => ({ x, y })
const down = (x: number, y: number, o: { touch?: boolean; shift?: boolean; mod?: boolean; time?: number; id?: number } = {}): GestureEvent => ({
  t: 'down', id: o.id ?? 1, at: at(x, y), time: o.time ?? 0, touch: o.touch ?? false, shift: o.shift ?? false, mod: o.mod ?? false,
})
const move = (x: number, y: number, id = 1): GestureEvent => ({ t: 'move', id, at: at(x, y) })
const up = (x: number, y: number, id = 1): GestureEvent => ({ t: 'up', id, at: at(x, y) })
const timer = (time: number): GestureEvent => ({ t: 'timer', time })

describe('tlGesture', () => {
  test('tap: press + release within tolerance', () => {
    expect(run([down(10, 10), move(13, 12), up(13, 12)])).toEqual({ k: 'idle', out: [{ t: 'tap', at: at(10, 10), mod: false }] })
  })
  test('⌘-click is a modified tap', () => {
    expect(run([down(10, 10, { mod: true }), up(10, 10)])).toEqual({ k: 'idle', out: [{ t: 'tap', at: at(10, 10), mod: true }] })
  })
  test('immediate drag pans (no outputs), and a timer tick during it is ignored', () => {
    expect(run([down(10, 10), move(30, 10), timer(LONG_PRESS_MS + 1), up(40, 10)])).toEqual({ k: 'idle', out: [] })
  })
  test('touch tolerates more jitter before it counts as a drag', () => {
    expect(run([down(10, 10, { touch: true }), move(18, 10), up(18, 10)])).toEqual({ k: 'idle', out: [{ t: 'tap', at: at(10, 10), mod: false }] })
    expect(run([down(10, 10), move(18, 10), up(18, 10)])).toEqual({ k: 'idle', out: [] })
  })
  test('the long-press timer only fires once the hold is long enough', () => {
    expect(run([down(10, 10, { touch: true }), timer(LONG_PRESS_MS - 1)])).toEqual({ k: 'press', out: [] })
  })
  test('long-press, release: longpress (map held, then released)', () => {
    expect(run([down(10, 10, { touch: true }), timer(LONG_PRESS_MS), up(10, 10)])).toEqual({
      k: 'idle',
      out: [{ t: 'hold' }, { t: 'longpress', at: at(10, 10) }, { t: 'release' }],
    })
  })
  test('long-press, then drag: a rectangle from the press point', () => {
    expect(run([down(10, 10, { touch: true }), timer(600), move(15, 12), move(50, 40), move(5, 60), up(5, 60)])).toEqual({
      k: 'idle',
      out: [
        { t: 'hold' },
        { t: 'longpress', at: at(10, 10) },
        { t: 'rect', rect: { x0: 10, y0: 10, x1: 50, y1: 40 } },
        { t: 'rect', rect: { x0: 5, y0: 10, x1: 10, y1: 60 } },
        { t: 'rectEnd', rect: { x0: 5, y0: 10, x1: 10, y1: 60 } },
        { t: 'release' },
      ],
    })
  })
  test('shift-drag (mouse): holds the map at once and draws a rectangle', () => {
    expect(run([down(10, 10, { shift: true, mod: true }), move(40, 30), up(40, 30)])).toEqual({
      k: 'idle',
      out: [
        { t: 'hold' },
        { t: 'rect', rect: { x0: 10, y0: 10, x1: 40, y1: 30 } },
        { t: 'rectEnd', rect: { x0: 10, y0: 10, x1: 40, y1: 30 } },
        { t: 'release' },
      ],
    })
  })
  test('shift-click without moving is a modified tap', () => {
    expect(run([down(10, 10, { shift: true, mod: true }), up(10, 10)])).toEqual({
      k: 'idle',
      out: [{ t: 'hold' }, { t: 'tap', at: at(10, 10), mod: true }, { t: 'release' }],
    })
  })
  test('a second finger mid-rectangle cancels it and becomes a pinch', () => {
    expect(run([down(10, 10, { touch: true }), timer(600), move(50, 50), down(80, 80, { touch: true, id: 2 }), move(60, 60), up(60, 60)])).toEqual({
      k: 'idle',
      out: [
        { t: 'hold' },
        { t: 'longpress', at: at(10, 10) },
        { t: 'rect', rect: { x0: 10, y0: 10, x1: 50, y1: 50 } },
        { t: 'rectCancel' },
        { t: 'release' },
      ],
    })
  })
  test('a second finger during a press is a pinch: no tap on release', () => {
    expect(run([down(10, 10, { touch: true }), down(80, 80, { touch: true, id: 2 }), up(10, 10)])).toEqual({ k: 'idle', out: [] })
  })
  test('other pointers\' moves / ups are ignored', () => {
    expect(run([down(10, 10), move(90, 90, 7), up(90, 90, 7)])).toEqual({ k: 'press', out: [] })
  })
  test('cancel (pointercancel / blur) mid-rectangle', () => {
    expect(run([down(10, 10, { shift: true }), move(40, 40), { t: 'cancel' }])).toEqual({
      k: 'idle',
      out: [{ t: 'hold' }, { t: 'rect', rect: { x0: 10, y0: 10, x1: 40, y1: 40 } }, { t: 'rectCancel' }, { t: 'release' }],
    })
  })
})
