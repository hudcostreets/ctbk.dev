/**
 * Map selection gestures for `/timelapse` (`specs/timelapse-map.md` "UX" →
 * selection), as a pure state machine over pointer events; the page feeds it
 * native pointer events from the map's canvas container, a long-press timer
 * tick, and acts on its outputs (pick + select, suppress map panning, draw
 * the drag rectangle).
 *
 * - press + release within `MOVE_TOL` (before `LONG_PRESS_MS`) → `tap`
 * - press + move past `MOVE_TOL` → `pan` (the map's own drag-pan handles it)
 * - press held `LONG_PRESS_MS` without moving → `longpress`, then `armed`:
 *   a release ends it, a move past `MOVE_TOL` starts a rectangle
 * - mouse shift+press + move → rectangle straight away (desktop)
 * - a second pointer (pinch) → `pan`, cancelling any rectangle
 */

export interface Pt { x: number; y: number }
/** Normalized: `x0 ≤ x1`, `y0 ≤ y1`. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const LONG_PRESS_MS = 500
/** Movement (px) a press tolerates before it's a drag: touch is jittery. */
export const MOVE_TOL = { mouse: 5, touch: 10 } as const

export type GestureState =
  | { k: 'idle' }
  | { k: 'press'; id: number; start: Pt; t0: number; touch: boolean; shift: boolean; mod: boolean }
  | { k: 'armed'; id: number; start: Pt; touch: boolean }
  | { k: 'rect'; id: number; start: Pt; cur: Pt }
  | { k: 'pan'; id: number }

export type GestureEvent =
  | { t: 'down'; id: number; at: Pt; time: number; touch: boolean; shift: boolean; mod: boolean }
  | { t: 'move'; id: number; at: Pt }
  | { t: 'up'; id: number; at: Pt }
  | { t: 'timer'; time: number }
  | { t: 'cancel' }

export type GestureOut =
  /** Click/tap; `mod` = shift/⌘/ctrl held (toggle membership). */
  | { t: 'tap'; at: Pt; mod: boolean }
  | { t: 'longpress'; at: Pt }
  /** Map panning must be off from here until the gesture ends. */
  | { t: 'hold' }
  | { t: 'rect'; rect: Rect }
  | { t: 'rectEnd'; rect: Rect }
  | { t: 'rectCancel' }
  /** Back to idle: map panning may resume. */
  | { t: 'release' }

export const IDLE: GestureState = { k: 'idle' }

export function normRect(a: Pt, b: Pt): Rect {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

export function step(s: GestureState, e: GestureEvent): { s: GestureState; out: GestureOut[] } {
  const same = (x: GestureState, s2: GestureState = x) => ({ s: s2, out: [] as GestureOut[] })
  switch (e.t) {
    case 'down': {
      if (s.k === 'idle') {
        const out: GestureOut[] = e.shift && !e.touch ? [{ t: 'hold' }] : []
        return { s: { k: 'press', id: e.id, start: e.at, t0: e.time, touch: e.touch, shift: e.shift, mod: e.mod }, out }
      }
      // A second pointer: a pinch/zoom, never a selection.
      if (s.k === 'rect') return { s: { k: 'pan', id: s.id }, out: [{ t: 'rectCancel' }, { t: 'release' }] }
      if (s.k === 'armed') return { s: { k: 'pan', id: s.id }, out: [{ t: 'release' }] }
      if (s.k === 'press') return { s: { k: 'pan', id: s.id }, out: s.shift && !s.touch ? [{ t: 'release' }] : [] }
      return same(s)
    }
    case 'move': {
      if (s.k === 'idle' || s.id !== e.id) return same(s)
      if (s.k === 'press') {
        if (dist(s.start, e.at) <= (s.touch ? MOVE_TOL.touch : MOVE_TOL.mouse)) return same(s)
        if (s.shift && !s.touch) return { s: { k: 'rect', id: s.id, start: s.start, cur: e.at }, out: [{ t: 'rect', rect: normRect(s.start, e.at) }] }
        return same(s, { k: 'pan', id: s.id })
      }
      if (s.k === 'armed') {
        if (dist(s.start, e.at) <= (s.touch ? MOVE_TOL.touch : MOVE_TOL.mouse)) return same(s)
        return { s: { k: 'rect', id: s.id, start: s.start, cur: e.at }, out: [{ t: 'rect', rect: normRect(s.start, e.at) }] }
      }
      if (s.k === 'rect') return { s: { ...s, cur: e.at }, out: [{ t: 'rect', rect: normRect(s.start, e.at) }] }
      return same(s)
    }
    case 'up': {
      if (s.k === 'idle' || s.id !== e.id) return same(s)
      if (s.k === 'press') {
        const out: GestureOut[] = [{ t: 'tap', at: s.start, mod: s.mod }]
        if (s.shift && !s.touch) out.push({ t: 'release' })
        return { s: IDLE, out }
      }
      if (s.k === 'armed') return { s: IDLE, out: [{ t: 'release' }] }
      if (s.k === 'rect') return { s: IDLE, out: [{ t: 'rectEnd', rect: normRect(s.start, e.at) }, { t: 'release' }] }
      return same(s, IDLE)
    }
    case 'timer': {
      if (s.k !== 'press' || e.time - s.t0 < LONG_PRESS_MS) return same(s)
      const out: GestureOut[] = [{ t: 'longpress', at: s.start }]
      // A shift+press already holds the map.
      if (!(s.shift && !s.touch)) out.unshift({ t: 'hold' })
      return { s: { k: 'armed', id: s.id, start: s.start, touch: s.touch }, out }
    }
    case 'cancel': {
      if (s.k === 'rect') return { s: IDLE, out: [{ t: 'rectCancel' }, { t: 'release' }] }
      if (s.k === 'armed' || (s.k === 'press' && s.shift && !s.touch)) return { s: IDLE, out: [{ t: 'release' }] }
      return same(s, IDLE)
    }
  }
}
