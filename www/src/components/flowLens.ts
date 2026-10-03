/**
 * Flow lens: when one or more stations are "selected" (the set), restyle every
 * other station by how many trips connect it to the set — either *outbound*
 * ("where riders from the set go") or *inbound* ("where riders to the set
 * come from"). Reads the same `pairCounts` (src → { dst: count }) the
 * destination-line fan uses.
 *
 * Encoding (both channels encode the same quantity, trips, redundantly):
 *   - `radii`: connected stations (≥ 1 trip) get a pixel radius ∝ sqrt(trips)
 *     (`lensRadiusPx`, area ∝ trips, clamped to `R_MIN..R_MAX`); stations with
 *     no trips shrink to an `R_DIM` dot. The GL map scales these by zoom
 *     (`lensZoomScale`).
 *   - `colors`: connected stations on the cool→hot ramp by **log** trips
 *     (`lensColorT`), stations with no trips grey.
 * Source-set stations are omitted from both. Also returns legend metadata
 * (`total`/`topCount`) so the caller can draw a size/color key.
 */
import type { StationPairCounts, Stations } from './StationMap'

const { floor, log, log10, max, min, pow, round, sqrt } = Math

/** Which channel(s) the lens drives. `n` = off. */
export type LensChannel = 'c' | 'r' | 'cr' | 'n'

/** `out` = trips FROM the selected set to each other station; `in` = trips TO
 *  the set from each other station ("where riders come from"). */
export type FlowDirection = 'out' | 'in'

export type LensStyle = {
  /** Per-station fill color (every non-source station when color is on), else null. */
  colors: Record<string, string> | null
  /** Per-station radius override in **pixels** at the base zoom (non-source
   *  stations when radius is on), else null. */
  radii: Record<string, number> | null
  /** Sum of all directed trips between the set and other stations (excludes
   *  within-set trips) — the set's total in/out flow, for the legend. */
  total: number
  /** Trip count of the single most-connected station (size/color max). */
  topCount: number
}

/** Arc fan only: pairs carrying less than this fraction of the heaviest
 *  pair's trips are dropped. Over a month a busy source sends *at least one*
 *  rider almost everywhere; drawn, that 1–3-trip tail piles into a blob at
 *  the origin. (The circles don't need the cut: sub-`R_MIN` flows all draw at
 *  `R_MIN`, so the tail stays small without being hidden.) */
export const FLOOR_FRAC = 0.04

/** Sequential ramp stops, low→high flow. Cool→hot reads on both light and
 *  dark tiles; positions in [0, 1]. Also the `/timelapse` `act` ramp. */
type Stop = { at: number; rgb: [number, number, number] }
const RAMP: readonly Stop[] = [
  { at: 0.0, rgb: [59, 76, 192] },   // indigo
  { at: 0.35, rgb: [123, 159, 249] }, // sky
  { at: 0.6, rgb: [247, 208, 64] },  // amber
  { at: 0.8, rgb: [244, 119, 46] },  // orange
  { at: 1.0, rgb: [209, 24, 11] },   // red
]

/** Fill for stations with no trips to/from the set. */
export const NON_DST_COLOR = '#888'

/** Radius channel (pixels, at `LENS_BASE_ZOOM`): no-trip stations shrink to a
 *  dot; connected ones get area ∝ trips, from `R_MIN` up to `R_MAX` at the
 *  top station. */
export const R_DIM = 1.5
export const R_MIN = 2.5
export const R_MAX = 14

/** Zoom at which `R_*` apply as-is; `lensZoomScale` grows/shrinks them by
 *  √2 per zoom level from here, within `[ZOOM_SCALE_MIN, ZOOM_SCALE_MAX]`. */
export const LENS_BASE_ZOOM = 12
const ZOOM_SCALE_MIN = 0.5
const ZOOM_SCALE_MAX = 2.5

/** Arc width (pixels): linear in trips, `ARC_W_MAX` at the heaviest pair,
 *  never thinner than `ARC_W_MIN`. */
export const ARC_W_MIN = 1
export const ARC_W_MAX = 12
/** Arc opacity at the destination end (0–255): `ARC_A_MIN` for the lightest
 *  pair up to `ARC_A_MAX` for the heaviest (sqrt-scaled). The origin end
 *  takes `ARC_SRC_FRAC` of that, so direction reads as a fade-in. */
export const ARC_A_MIN = 110
export const ARC_A_MAX = 235
export const ARC_SRC_FRAC = 0.15

/** Station radius in pixels (at the base zoom) for `count` trips when the
 *  top station has `maxCount`: 0 trips → `R_DIM`; else area ∝ trips,
 *  `R_MAX · sqrt(count / maxCount)`, floored at `R_MIN`. */
export function lensRadiusPx(count: number, maxCount: number): number {
  if (!(count > 0) || !(maxCount > 0)) return R_DIM
  return max(R_MIN, R_MAX * sqrt(min(1, count / maxCount)))
}

/** Ramp position for `count` trips: log-scaled so the long tail spreads out
 *  (1 trip → 0, `maxCount` → 1). A lone max of 1 trip is 1. */
export function lensColorT(count: number, maxCount: number): number {
  if (!(count > 0)) return 0
  if (maxCount <= 1) return 1
  return min(1, log(count) / log(maxCount))
}

/** Multiplier for the lens's pixel radii at `zoom`: √2 per zoom level from
 *  `LENS_BASE_ZOOM` (half the map's own 2×/level, so marks grow as stations
 *  spread apart zooming in, without swallowing their neighbors), clamped to
 *  `[0.5, 2.5]`. */
export function lensZoomScale(zoom: number): number {
  return min(ZOOM_SCALE_MAX, max(ZOOM_SCALE_MIN, pow(2, (zoom - LENS_BASE_ZOOM) / 2)))
}

/** Arc width in pixels: `ARC_W_MAX · count / maxCount`, at least `ARC_W_MIN`. */
export function arcWidthPx(count: number, maxCount: number): number {
  if (!(maxCount > 0)) return ARC_W_MIN
  return max(ARC_W_MIN, ARC_W_MAX * min(1, count / maxCount))
}

/** Arc alpha (0–255, integer) at the destination end. */
export function arcAlpha(count: number, maxCount: number): number {
  const f = maxCount > 0 ? sqrt(min(1, max(0, count / maxCount))) : 1
  return round(ARC_A_MIN + (ARC_A_MAX - ARC_A_MIN) * f)
}

/** Largest "1-2-5" number (1, 2, 5, 10, 20, 50, …) ≤ `x` (`x` ≥ 1). */
export function niceFloor(x: number): number {
  const e = pow(10, floor(log10(x)))
  const m = x / e
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e
}

/** Legend reference values for a key topping out at `maxCount`: `maxCount`
 *  itself, then a "nice" (1-2-5) value at or below each `fracs[i] ·
 *  maxCount`, descending, deduped, all ≥ 1. */
export function legendTicks(maxCount: number, fracs: readonly number[]): number[] {
  if (!(maxCount >= 1)) return []
  const out = [maxCount]
  for (const f of fracs) {
    const x = maxCount * f
    if (x < 1) continue
    const v = niceFloor(x)
    if (v < out[out.length - 1]) out.push(v)
  }
  return out
}

/** Size-key fractions (the circles' key): top, ~1/5, ~1/25 of it. */
export const SIZE_KEY_FRACS = [0.2, 0.04] as const
/** Width-key fractions (the arcs' key): top, ~1/2, ~1/6. */
export const WIDTH_KEY_FRACS = [0.5, 0.17] as const

/** Ramp position `t` ∈ [0, 1] → `[r, g, b]`. */
export function rampRgb(t: number): [number, number, number] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  let lo = RAMP[0]
  let hi = RAMP[RAMP.length - 1]
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (clamped >= RAMP[i].at && clamped <= RAMP[i + 1].at) {
      lo = RAMP[i]
      hi = RAMP[i + 1]
      break
    }
  }
  const span = hi.at - lo.at || 1
  const f = (clamped - lo.at) / span
  const c = (a: number, b: number) => round(a + (b - a) * f)
  return [c(lo.rgb[0], hi.rgb[0]), c(lo.rgb[1], hi.rgb[1]), c(lo.rgb[2], hi.rgb[2])]
}

/** `rampRgb` as `#rrggbb`. */
export function rampColor(t: number): string {
  return `#${rampRgb(t).map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** One directed (riding-direction) station pair between the set and another
 *  station: `from` → `to`, `count` trips. `other` is the non-set end. */
type DirectedPair = { from: string; to: string; other: string; count: number }

/** Every directed pair between the selected set and every *other* station.
 *  `out`: `pairCounts[src][other]` for each set member. `in`:
 *  `pairCounts[other][t]` for each set member. Within-set pairs and stations
 *  missing from `stations` are excluded. Shared by the lens (summed per
 *  `other`) and the arc fan (one arc per pair). */
function directedPairs(
  stations: Stations,
  pairCounts: StationPairCounts | null,
  selIds: readonly string[],
  direction: FlowDirection,
): DirectedPair[] {
  if (!pairCounts || selIds.length === 0) return []
  const set = new Set(selIds)
  const out: DirectedPair[] = []
  if (direction === 'out') {
    for (const src of selIds) {
      const dsts = pairCounts[src]
      if (!dsts || !stations[src]) continue
      for (const [dst, count] of Object.entries(dsts)) {
        if (set.has(dst) || !stations[dst] || !(count > 0)) continue
        out.push({ from: src, to: dst, other: dst, count })
      }
    }
  } else {
    for (const [origin, dsts] of Object.entries(pairCounts)) {
      if (set.has(origin) || !stations[origin]) continue
      for (const t of selIds) {
        const count = dsts[t] ?? 0
        if (count > 0 && stations[t]) out.push({ from: origin, to: t, other: origin, count })
      }
    }
  }
  return out
}

/** Directed trip counts between the selected set and every *other* station
 *  (`directedPairs` summed per non-set station). */
function flowTotals(
  stations: Stations,
  pairCounts: StationPairCounts | null,
  selIds: readonly string[],
  direction: FlowDirection,
): Record<string, number> | null {
  const totals: Record<string, number> = {}
  for (const { other, count } of directedPairs(stations, pairCounts, selIds, direction)) {
    totals[other] = (totals[other] ?? 0) + count
  }
  return Object.keys(totals).length ? totals : null
}

/** Per-destination fraction of the top destination's flow (legacy shape kept
 *  for any external callers). */
export function flowFractions(
  stations: Stations,
  pairCounts: StationPairCounts | null,
  selIds: readonly string[],
  direction: FlowDirection = 'out',
): Record<string, number> | null {
  const totals = flowTotals(stations, pairCounts, selIds, direction)
  if (!totals) return null
  const maxCount = max(...Object.values(totals))
  const fracs: Record<string, number> = {}
  for (const [id, count] of Object.entries(totals)) fracs[id] = count / maxCount
  return fracs
}

/**
 * Compute the lens style for a source set + channel + direction: every
 * non-source station with ≥ 1 trip to/from the set is sized
 * (`lensRadiusPx`) and colored (`lensColorT`) by its trip count; the rest are
 * grey `R_DIM` dots. Returns null when there's nothing to show.
 */
export function flowLens(
  stations: Stations,
  pairCounts: StationPairCounts | null,
  selIds: readonly string[],
  channel: LensChannel,
  direction: FlowDirection = 'out',
): LensStyle | null {
  if (channel === 'n') return null
  const totals = flowTotals(stations, pairCounts, selIds, direction)
  if (!totals) return null
  const wantColor = channel === 'c' || channel === 'cr'
  const wantRadius = channel === 'r' || channel === 'cr'

  const counts = Object.values(totals)
  const maxCount = max(...counts)
  const grandTotal = counts.reduce((s, c) => s + c, 0)

  const set = new Set(selIds)
  const colors: Record<string, string> = {}
  const radii: Record<string, number> = {}
  for (const id of Object.keys(stations)) {
    if (set.has(id)) continue
    const count = totals[id] ?? 0
    if (wantColor) colors[id] = count > 0 ? rampColor(lensColorT(count, maxCount)) : NON_DST_COLOR
    if (wantRadius) radii[id] = lensRadiusPx(count, maxCount)
  }
  return {
    colors: wantColor ? colors : null,
    radii: wantRadius ? radii : null,
    total: grandTotal,
    topCount: maxCount,
  }
}

/** One flow arc (riding direction) for the GPU fan (`ArcLayer`). */
export type FlowArc = {
  from: string
  to: string
  /** `[lng, lat]` of the riding-direction origin / destination. */
  source: [number, number]
  target: [number, number]
  count: number
}

/**
 * Arc fan for a source set: one arc per *other* station, in riding direction
 * (`out`: set → other; `in`: other → set), carrying that station's total
 * flow with the whole set. With several stations selected, the set end sits
 * at the count-weighted centroid of the set stations that trade with that
 * station, so N sources × M destinations collapse to ≤ M arcs (one width per
 * destination) instead of an N×M hairball; a single source keeps its exact
 * position. `FLOOR_FRAC` cut (arcs below 4% of the heaviest are dropped).
 * Sorted light→heavy, so heavy arcs draw on top; width/alpha come from
 * `arcWidthPx`/`arcAlpha` against the last (heaviest) arc's count. The set
 * end's id is its heaviest contributor.
 */
export function flowArcs(
  stations: Stations,
  pairCounts: StationPairCounts | null,
  selIds: readonly string[],
  direction: FlowDirection = 'out',
): FlowArc[] {
  type Acc = { count: number, lng: number, lat: number, top: string, topCount: number }
  const byOther = new Map<string, Acc>()
  for (const { from, to, other, count } of directedPairs(stations, pairCounts, selIds, direction)) {
    const setId = other === to ? from : to
    const s = stations[setId]
    const acc = byOther.get(other) ?? { count: 0, lng: 0, lat: 0, top: setId, topCount: 0 }
    acc.count += count
    acc.lng += s.lng * count
    acc.lat += s.lat * count
    if (count > acc.topCount) { acc.top = setId; acc.topCount = count }
    byOther.set(other, acc)
  }
  if (!byOther.size) return []
  const maxCount = max(...[...byOther.values()].map((a) => a.count))
  const arcs: FlowArc[] = []
  for (const [other, { count, lng, lat, top }] of byOther) {
    if (count < maxCount * FLOOR_FRAC) continue
    const o = stations[other]
    const setEnd: [number, number] = [lng / count, lat / count]
    const otherEnd: [number, number] = [o.lng, o.lat]
    arcs.push(direction === 'out'
      ? { from: top, to: other, source: setEnd, target: otherEnd, count }
      : { from: other, to: top, source: otherEnd, target: setEnd, count })
  }
  return arcs.sort((a, b) => a.count - b.count)
}
