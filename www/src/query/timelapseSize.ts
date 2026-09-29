/** `/timelapse` circle sizing (`sz=`) + zoomed-out shrink: the pure half. */

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
