/**
 * Flow lens: when one or more stations are "selected" (the set), restyle every
 * other station by how much trip flow connects it to the set — either
 * *outbound* ("where riders from the set go") or *inbound* ("where riders to
 * the set come from"). Reads the same `pairCounts` (src → { dst: count }) the
 * destination-line fan uses.
 *
 * Drives up to two visual channels:
 *   - `colors`: connected stations on a cool→hot ramp (by rank, see below),
 *     everything else dim grey (so non-connected stations recede).
 *   - `radii`: connected stations sized by flow (pixel radius), the rest a dot.
 * Source-set stations are omitted from both. Also returns legend metadata
 * (`total`/`topCount`/`floorCount`) so the caller can label the ramp.
 */
import type { StationPairCounts, Stations } from './StationMap'

/** Which channel(s) the lens drives. `n` = off. */
export type LensChannel = 'c' | 'r' | 'cr' | 'n'

/** `out` = trips FROM the selected set to each other station; `in` = trips TO
 *  the set from each other station ("where riders come from"). */
export type FlowDirection = 'out' | 'in'

export type LensStyle = {
  /** Per-station fill color (every non-source station when color is on), else null. */
  colors: Record<string, string> | null
  /** Per-station radius override in **pixels** (non-source stations when radius
   *  is on), else null. */
  radii: Record<string, number> | null
  /** Sum of all directed trips between the set and other stations (excludes
   *  within-set trips) — the set's total in/out flow, for the legend. */
  total: number
  /** Trip count of the single most-connected station (ramp's hot end). */
  topCount: number
  /** Trip count of the least-connected station still shown (ramp's cool end). */
  floorCount: number
}

/** Destinations receiving less than this fraction of the top destination's
 *  flow are treated as non-destinations (grey). Over a month a busy source
 *  sends *at least one* rider almost everywhere, so without a floor the whole
 *  map reads as a "destination" and the long tail of 1–3-trip stations swamps
 *  the ramp. The floor collapses that noise into grey so the ramp spends its
 *  range on where riders actually go. */
const FLOOR_FRAC = 0.04

/** Sequential ramp stops, low→high flow. Cool→hot reads on both light and
 *  dark tiles; positions in [0, 1]. Kept in sync with the CSS gradient in the
 *  `FlowLensLegend` (`Stations.tsx`). */
type Stop = { at: number; rgb: [number, number, number] }
const RAMP: readonly Stop[] = [
  { at: 0.0, rgb: [59, 76, 192] },   // indigo
  { at: 0.35, rgb: [123, 159, 249] }, // sky
  { at: 0.6, rgb: [247, 208, 64] },  // amber
  { at: 0.8, rgb: [244, 119, 46] },  // orange
  { at: 1.0, rgb: [209, 24, 11] },   // red
]

/** Fill for stations not (meaningfully) connected to the set. */
const NON_DST_COLOR = '#888'

/** Radius channel (pixels): unconnected stations shrink to a dot; connected
 *  ones grow with flow so the ranking reads by size. */
const R_DIM = 2
const R_MIN = 4
const R_MAX = 22

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
  const c = (a: number, b: number) => Math.round(a + (b - a) * f)
  return [c(lo.rgb[0], hi.rgb[0]), c(lo.rgb[1], hi.rgb[1]), c(lo.rgb[2], hi.rgb[2])]
}

function rampColor(t: number): string {
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
  const maxCount = Math.max(...Object.values(totals))
  const fracs: Record<string, number> = {}
  for (const [id, count] of Object.entries(totals)) fracs[id] = count / maxCount
  return fracs
}

/**
 * Compute the lens style for a source set + channel + direction.
 *
 * Position on the ramp is by **rank**, not raw fraction: one dominant sink
 * would otherwise compress every other station into the ramp's cool end (a
 * wall of blue). Ranking the above-floor stations spreads the hues evenly from
 * the most-connected (hot) to the least (cool). Sub-floor / unconnected go
 * grey. Returns null when there's nothing to show.
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

  const entries = Object.entries(totals)
  const maxCount = Math.max(...entries.map(([, c]) => c))
  const grandTotal = entries.reduce((s, [, c]) => s + c, 0)

  // Above-floor stations, ranked high→low; ramp position = rank fraction.
  const survivors = entries
    .filter(([, c]) => c >= maxCount * FLOOR_FRAC)
    .sort((a, b) => b[1] - a[1])
  const n = survivors.length
  const rankT: Record<string, number> = {}
  survivors.forEach(([id], i) => { rankT[id] = n <= 1 ? 1 : 1 - i / (n - 1) })

  const set = new Set(selIds)
  const colors: Record<string, string> = {}
  const radii: Record<string, number> = {}
  for (const id of Object.keys(stations)) {
    if (set.has(id)) continue
    const t = rankT[id]
    const connected = t !== undefined
    if (wantColor) colors[id] = connected ? rampColor(t) : NON_DST_COLOR
    if (wantRadius) radii[id] = connected ? R_MIN + (R_MAX - R_MIN) * t : R_DIM
  }
  return {
    colors: wantColor ? colors : null,
    radii: wantRadius ? radii : null,
    total: grandTotal,
    topCount: maxCount,
    floorCount: n ? survivors[n - 1][1] : 0,
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
  /** Rank position on the lens ramp (1 = heaviest pair, 0 = lightest shown). */
  t: number
}

/**
 * Arc fan for a source set: one arc per directed (set ↔ other) station pair,
 * in riding direction (`out`: set → other; `in`: other → set). Same data as
 * the Leaflet destination fan (`pairCounts`), but with the lens's
 * `FLOOR_FRAC` cut (pairs below 4% of the heaviest pair are dropped — the
 * long 1–3-trip tail is what stacked into the SVG fan's red blob) and ranked
 * so each arc can take its ramp color. Sorted light→heavy, so heavy arcs draw
 * on top.
 */
export function flowArcs(
  stations: Stations,
  pairCounts: StationPairCounts | null,
  selIds: readonly string[],
  direction: FlowDirection = 'out',
): FlowArc[] {
  const pairs = directedPairs(stations, pairCounts, selIds, direction)
  if (!pairs.length) return []
  const maxCount = Math.max(...pairs.map((p) => p.count))
  const kept = pairs.filter((p) => p.count >= maxCount * FLOOR_FRAC).sort((a, b) => a.count - b.count)
  const n = kept.length
  return kept.map(({ from, to, count }, i) => {
    const a = stations[from]
    const b = stations[to]
    return {
      from,
      to,
      source: [a.lng, a.lat],
      target: [b.lng, b.lat],
      count,
      t: n <= 1 ? 1 : i / (n - 1),
    }
  })
}
