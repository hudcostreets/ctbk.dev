/**
 * `/timelapse` station selection (`sel=`) and circle sizing: the pure half.
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
import type { Rect } from '../lib/tlGesture'

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

// ---------------------------------------------------------------------------
// Circle size (`sz=`).
// ---------------------------------------------------------------------------

/** The size control's steps (radius multipliers). */
export const SIZES = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2] as const
export const SIZE_MIN = SIZES[0]
export const SIZE_MAX = SIZES[SIZES.length - 1]

/** `sz` URL value → multiplier (absent / malformed → 1; clamped). */
export function parseSize(raw: string | undefined): number {
  const v = raw === undefined ? NaN : Number(raw)
  return v === v && v > 0 ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)) : 1
}

/** Zoom at and above which circles draw at full size. */
export const ZOOM_FULL = 11
/** Floor of the zoomed-out shrink. */
export const ZOOM_MIN_FACTOR = 0.35

/** Zoomed-out shrink: radius halves every 2 zoom levels below `ZOOM_FULL`
 *  (area tracks the map's), floored at `ZOOM_MIN_FACTOR`. */
export function zoomFactor(zoom: number): number {
  return Math.min(1, Math.max(ZOOM_MIN_FACTOR, 2 ** ((zoom - ZOOM_FULL) / 2)))
}

/** Radius multiplier on the presets' `√(rides ÷ scale)` radii. */
export function radiusFactor(sz: number, zoom: number): number {
  return sz * zoomFactor(zoom)
}

/** `×0.5` / `×1.4` (two significant digits, no trailing zeros). */
export function factorLabel(f: number): string {
  return `×${Number(f.toPrecision(2))}`
}
