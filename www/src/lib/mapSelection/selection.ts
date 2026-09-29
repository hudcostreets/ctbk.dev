/**
 * Station selection on the GL maps (`/stations`, `/timelapse`, the Home
 * embed): the pure half. `useSelection` holds it; `useSelectionGestures`
 * feeds it from pointer gestures (`gesture.ts`).
 *
 * Selection model (Google-Photos-like):
 * - tap a station: select just it; tap empty map: clear
 * - long-press: enter multi-select mode (`multi`) with that station added;
 *   in the mode, taps toggle membership and empty-map taps do nothing (a
 *   stray tap mustn't wipe a hand-built set)
 * - shift/⌘-click toggles membership without entering the mode
 * - a drag rectangle adds the stations inside it
 * - Done keeps the set and leaves the mode; Clear / Esc empty it; emptying
 *   the set any way leaves the mode
 */
import type { GestureOut, Pt, Rect } from './gesture'
import type { Param } from 'use-prms'

export interface SelState {
  ids: string[]
  multi: boolean
}

export type SelAction =
  | { t: 'tap'; id: string | null; toggle: boolean }
  | { t: 'longpress'; id: string | null }
  /** A drag rectangle's stations; `multi`: it started from a long-press
   *  (enters the mode, when it adds anything). */
  | { t: 'add'; ids: readonly string[]; multi?: boolean }
  | { t: 'remove'; id: string }
  | { t: 'clear' }
  | { t: 'done' }

const EMPTY: SelState = { ids: [], multi: false }

/** `ids` → state, leaving multi mode when the set empties. */
const withIds = (s: SelState, ids: string[]): SelState => (ids.length ? { ids, multi: s.multi } : EMPTY)

export function reduceSel(s: SelState, a: SelAction): SelState {
  switch (a.t) {
    case 'tap': {
      const toggle = a.toggle || s.multi
      if (a.id === null) return toggle ? s : EMPTY
      if (!toggle) return { ids: [a.id], multi: false }
      return withIds(s, s.ids.includes(a.id) ? s.ids.filter((x) => x !== a.id) : [...s.ids, a.id])
    }
    case 'longpress':
      if (a.id === null) return s
      return { ids: s.ids.includes(a.id) ? s.ids : [...s.ids, a.id], multi: true }
    case 'add': {
      const have = new Set(s.ids)
      const extra: string[] = []
      for (const id of a.ids) {
        if (have.has(id)) continue
        have.add(id)
        extra.push(id)
      }
      if (!extra.length) return s.ids.length && a.multi && !s.multi ? { ids: s.ids, multi: true } : s
      return { ids: [...s.ids, ...extra], multi: s.multi || !!a.multi }
    }
    case 'remove':
      return withIds(s, s.ids.filter((x) => x !== a.id))
    case 'clear':
      return EMPTY
    case 'done':
      return { ids: s.ids, multi: false }
  }
}

/** The selection action a gesture output means (`null`: not a selection
 *  event). `pickAt` / `pickRect` resolve screen points / rectangles to
 *  station ids; `fromLongPress`: the gesture began with a long-press (so its
 *  rectangle enters multi-select mode). */
export function gestureSelAction(
  o: GestureOut,
  pickAt: (at: Pt) => string | null,
  pickRect: (rect: Rect) => string[],
  fromLongPress: boolean,
): SelAction | null {
  switch (o.t) {
    case 'tap': return { t: 'tap', id: pickAt(o.at), toggle: o.mod }
    case 'longpress': return { t: 'longpress', id: pickAt(o.at) }
    case 'rectEnd': return { t: 'add', ids: pickRect(o.rect), multi: fromLongPress }
    default: return null
  }
}

/** Table indices of the stations whose projected position (`project`:
 *  `[lng, lat]` → screen px) falls in `rect`, among those `keep` accepts.
 *  `positions` are `[lng, lat]` pairs (`StationTable.positions`). */
export function stationsInRect(
  positions: ArrayLike<number>,
  project: (lng: number, lat: number) => [number, number],
  rect: Rect,
  keep: (i: number) => boolean = () => true,
): number[] {
  const out: number[] = []
  const n = positions.length / 2
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue
    const [x, y] = project(positions[2 * i], positions[2 * i + 1])
    if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) out.push(i)
  }
  return out
}

/** URL codec for a station set (`?sel=`): comma-joined ids (short_names),
 *  order-preserving (selection order = chip / panel order). */
export const selParam: Param<string[]> = {
  encode: (v) => (v.length ? v.join(',') : undefined),
  decode: (raw) => (raw ? raw.split(',').filter(Boolean) : []),
}
