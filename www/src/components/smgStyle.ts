/** Fills for `smg-v1` states across the three renderers (uPlot canvas, CSS
 *  swatches, plotly bars): the base color, plus a diagonal hatch for the
 *  no-e-bike states (`SmgState.hatch`). */
import type { CSSProperties } from 'react'
import type { SmgState } from '../query/smg'

export const colorOf = (s: SmgState, dark: boolean) => (dark ? s.dark : s.light)
const hatchInk = (dark: boolean) => (dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)')

/** Black or white, whichever contrasts with the state's fill (for text
 *  drawn on it). */
export function inkOn(s: SmgState, dark: boolean): string {
  const c = colorOf(s, dark)
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#000' : '#fff'
}

/** CSS background for a legend / summary swatch. */
export function swatchStyle(s: SmgState, dark: boolean): CSSProperties {
  const c = colorOf(s, dark)
  return s.hatch
    ? { background: `repeating-linear-gradient(135deg, ${c} 0 2.5px, ${hatchInk(dark)} 2.5px 4px)` }
    : { background: c }
}

/** Plotly bar marker (base color + `/` pattern for hatched states). */
export function plotlyMarker(s: SmgState, dark: boolean) {
  const color = colorOf(s, dark)
  return s.hatch
    ? { color, pattern: { shape: '/' as const, fgcolor: hatchInk(dark), bgcolor: color, size: 6, solidity: 0.35 } }
    : { color }
}

const patterns = new Map<string, CanvasPattern>()

/** uPlot fill: a canvas pattern for hatched states (cached per color). `alpha`
 *  is the 2-hex-digit suffix the chart uses to dim non-hovered bands. */
export function canvasFill(s: SmgState, dark: boolean, alpha = ''): string | CanvasPattern {
  const c = colorOf(s, dark) + alpha
  if (!s.hatch) return c
  const key = `${c}|${dark}`
  let p = patterns.get(key)
  if (!p) {
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    const n = Math.round(6 * dpr)
    const cv = document.createElement('canvas')
    cv.width = cv.height = n
    const g = cv.getContext('2d')!
    g.fillStyle = c
    g.fillRect(0, 0, n, n)
    g.strokeStyle = hatchInk(dark)
    g.lineWidth = 1.5 * dpr
    g.beginPath()
    // Diagonal stripes, drawn across the tile's corners so they seam.
    for (const o of [-n, 0, n]) { g.moveTo(o, n); g.lineTo(o + n, 0) }
    g.stroke()
    p = g.createPattern(cv, 'repeat')!
    patterns.set(key, p)
  }
  return p
}
