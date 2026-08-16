/** S2 cell → lat/lng geometry helpers.
 *
 *  Extracted from `pages/CellsDebug.tsx` so the parquet viewer's cell
 *  tooltips can draw the same footprints the debug map does. Pure
 *  geometry — no React, no Leaflet — so it's usable from an SVG
 *  renderer as well as from map overlays. */
import { s2 } from 's2js'

const { cellid, Cell } = s2
const { atan2, hypot, abs, min, max, PI } = Math
const R2D = 180 / PI

/** Mean Earth radius (m), for edge-length estimates. */
const EARTH_R = 6371008.8

export type LatLng = [number, number]

/** S2 cell → 4 sampled boundary arcs (edge k = vertex k → k+1, CCW).
 *  Each edge is a great-circle arc (constant u/v on the cube face = a
 *  plane through the origin), so sample along it — normalized lerp
 *  between the endpoint vectors stays on the arc. Straight lat/lng
 *  segments visibly bow off-course at coarse levels. Each arc includes
 *  both endpoints (polyline-ready). */
export function s2CellEdgeArcs(token: string): LatLng[][] {
  const ci = cellid.fromToken(token)
  const cell = Cell.fromCellID(ci)
  const level = cellid.level(ci)
  const perEdge = max(1, min(32, 2 ** (12 - level)))
  const edges: LatLng[][] = []
  for (let i = 0; i < 4; i++) {
    const a = cell.vertex(i), b = cell.vertex((i + 1) & 3)
    const pts: LatLng[] = []
    for (let s = 0; s <= perEdge; s++) {
      const t = s / perEdge
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t
      pts.push([atan2(z, hypot(x, y)) * R2D, atan2(y, x) * R2D])
    }
    edges.push(pts)
  }
  return edges
}

export function s2CellVertices(token: string): LatLng[] {
  return s2CellEdgeArcs(token).flatMap((pts) => pts.slice(0, -1))
}

/** The edges of `token` that lie on its PARENT's boundary. Every cell is
 *  one quadrant of its parent, so exactly 2 adjacent edges qualify.
 *  Rendered thicker as a merge cue: when sibling cells jointly tile a
 *  parent, the thick edges form the parent's full ring with only thin
 *  seams inside — i.e. "these could collapse to the parent (± subtractions)".
 *  Vertex k ↔ uv corner in order (uLo,vLo),(uHi,vLo),(uHi,vHi),(uLo,vHi)
 *  (verified against s2js: sibling quadrants' facing edges coincide). */
export function s2ParentEdgeArcs(token: string): LatLng[][] {
  const ci = cellid.fromToken(token)
  const lvl = cellid.level(ci)
  if (lvl === 0) return []
  const uv = cellid.boundUV(ci)
  const puv = cellid.boundUV(cellid.parent(ci, lvl - 1))
  const eps = 1e-12
  const shared = [
    abs(uv.y.lo - puv.y.lo) < eps,  // edge 0: v = vLo
    abs(uv.x.hi - puv.x.hi) < eps,  // edge 1: u = uHi
    abs(uv.y.hi - puv.y.hi) < eps,  // edge 2: v = vHi
    abs(uv.x.lo - puv.x.lo) < eps,  // edge 3: u = uLo
  ]
  return s2CellEdgeArcs(token).filter((_, k) => shared[k])
}

/** Level of a hex S2 token, or `null` if it isn't one.
 *
 *  `cellid.fromToken` is lenient — it happily consumes non-hex input
 *  and returns a garbage id — so the shape is checked first. Needed
 *  because the v5 `cell` column mixes S2 tokens with `s:<short_name>`
 *  identity keys (`gbfs/api/src/avail_geo.ts`), and a mislabelled
 *  identity key would render a nonsense footprint. */
export function s2CellLevel(token: string): number | null {
  if (!/^[0-9a-f]{1,16}$/.test(token)) return null
  let ci: bigint
  try { ci = cellid.fromToken(token) } catch { return null }
  if (!cellid.valid(ci)) return null
  const lvl = cellid.level(ci)
  return lvl >= 0 && lvl <= 30 ? lvl : null
}

export function isS2Token(s: string): boolean {
  return s2CellLevel(s) !== null
}

export interface LatLngBounds { latMin: number; latMax: number; lngMin: number; lngMax: number }

export function s2CellBounds(token: string): LatLngBounds {
  const vs = s2CellVertices(token)
  let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180
  for (const [lat, lng] of vs) {
    latMin = min(latMin, lat); latMax = max(latMax, lat)
    lngMin = min(lngMin, lng); lngMax = max(lngMax, lng)
  }
  return { latMin, latMax, lngMin, lngMax }
}

/** Great-circle distance (m) between two lat/lng points. */
export function haversine([aLat, aLng]: LatLng, [bLat, bLng]: LatLng): number {
  const p = PI / 180
  const dLat = (bLat - aLat) * p, dLng = (bLng - aLng) * p
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(s))
}

/** Mean edge length (m). S2 cells aren't square — the distortion runs
 *  to ~1.4× within a face — so this is a scale cue, not a measurement. */
export function s2CellEdgeMeters(token: string): number {
  const ci = cellid.fromToken(token)
  const cell = Cell.fromCellID(ci)
  const toLL = (v: { x: number; y: number; z: number }): LatLng =>
    [atan2(v.z, hypot(v.x, v.y)) * R2D, atan2(v.y, v.x) * R2D]
  let total = 0
  for (let i = 0; i < 4; i++) total += haversine(toLL(cell.vertex(i)), toLL(cell.vertex((i + 1) & 3)))
  return total / 4
}

export function fmtMeters(m: number): string {
  if (m >= 10000) return `${(m / 1000).toFixed(0)} km`
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`
  if (m >= 100) return `${Math.round(m / 10) * 10} m`
  return `${m.toFixed(0)} m`
}
