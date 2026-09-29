/**
 * Timelapse frames: the pure half of `specs/timelapse-map.md` "Client cache
 * and prefetch" + "Rendering". No fetching, no React — frame/chunk index
 * math, the dense chunk block, snapping/prefetch order, the interim synthetic
 * source, and the `flow` preset's per-station styling. Unit-tested in
 * `timelapseFrames.test.ts`; `timelapse.ts` wires it to TanStack Query and
 * the shard reader.
 *
 * Time model: bins are local wall-clock time stored as if UTC (as the rides
 * pyramids do), so every date computation here uses `Date.UTC` / `getUTC*`
 * and the FE formats with `timeZone: 'UTC'`. Frames are numbered in units of
 * the bin from an origin at or before genesis (2013-06-01): genesis floored
 * to the `K·bin` grid, so a chunk of `K` frames aligned to `k·K` sits exactly
 * on the pyramid's (epoch-aligned) shard grid — a `1d` chunk is one `1d@32d`
 * shard, a `1h` chunk one `1h@2d`. Identical to `/api/tl`'s numbering
 * (`gbfs/api/src/tl.ts`), which is what the `api` source relies on.
 */

import { rampRgb } from '../components/flowLens'

export type Anchor = 'start' | 'end'
export const ANCHORS: readonly Anchor[] = ['start', 'end']
/** Every tier `/api/tl` serves (`TL_BINS` in `gbfs/api/src/tl.ts`); all of
 *  them are exposed (the selector + `b=`). */
export type TlBin = '1h' | '3h' | '6h' | '12h' | '1d' | '3d' | '7d' | '14d' | '1mo'
export type Bin = TlBin
export const BINS: readonly Bin[] = ['1h', '3h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo']
export type Source = 'api' | 'shard' | 'synth'

export const GENESIS_MS = Date.UTC(2013, 5, 1)
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
type FixedBin = Exclude<Bin, '1mo'>
/** Fixed bin widths; `1mo` is calendar-sized (see `binMs`). */
export const FIXED_MS: Record<FixedBin, number> = {
  '1h': HOUR_MS, '3h': 3 * HOUR_MS, '6h': 6 * HOUR_MS, '12h': 12 * HOUR_MS,
  '1d': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS, '14d': 14 * DAY_MS,
}
/** Nominal bin width (`1mo` ≈ 30.44 days), for estimates (frame counts,
 *  synthetic per-bin rates), never for frame math. */
export function binMs(bin: Bin): number {
  return bin === '1mo' ? 30.436875 * DAY_MS : FIXED_MS[bin]
}
/** Frames per chunk per tier, mirroring the worker's `TL_K`: `1h` → 2 days;
 *  every other fixed tier's `K·bin` is one of its shard rungs (`3h`→4d …
 *  `14d`→448d); `1mo` → 24 months, rung-aligned to the `2y` shards. */
export const TL_K: Record<TlBin, number> = {
  '1h': 48, '3h': 32, '6h': 32, '12h': 32, '1d': 32, '3d': 32, '7d': 32, '14d': 32, '1mo': 24,
}
export const CHUNK_K: Record<Bin, number> = TL_K

const monthIdx = (ms: number): number => {
  const d = new Date(ms)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}
const monthMs = (idx: number): number => Date.UTC(Math.floor(idx / 12), ((idx % 12) + 12) % 12)

/** Frame 0's start: genesis floored to the `K·bin` grid (see module doc);
 *  months floor on a year-0 month grid, as the worker's `originMs`. */
export function originMs(bin: Bin): number {
  const K = CHUNK_K[bin]
  if (bin === '1mo') return monthMs(Math.floor(monthIdx(GENESIS_MS) / K) * K)
  const grid = K * FIXED_MS[bin]
  return Math.floor(GENESIS_MS / grid) * grid
}

/** Frame index containing `ms` (a local-as-UTC instant). */
export function frameIndex(bin: Bin, ms: number): number {
  if (bin === '1mo') return monthIdx(ms) - monthIdx(originMs(bin))
  return Math.floor((ms - originMs(bin)) / FIXED_MS[bin])
}

/** Start instant (local-as-UTC ms) of frame `i`. */
export function frameStartMs(bin: Bin, i: number): number {
  if (bin === '1mo') return monthMs(monthIdx(originMs(bin)) + i)
  return originMs(bin) + i * FIXED_MS[bin]
}

export function chunkOf(bin: Bin, i: number): number {
  return Math.floor(i / CHUNK_K[bin])
}

/** `[i0, i1)` frame range of chunk `k`. */
export function chunkFrames(bin: Bin, k: number): [number, number] {
  const K = CHUNK_K[bin]
  return [k * K, (k + 1) * K]
}

/** `[t0, t1)` ms range of chunk `k`. */
export function chunkMs(bin: Bin, k: number): [number, number] {
  const [i0, i1] = chunkFrames(bin, k)
  return [frameStartMs(bin, i0), frameStartMs(bin, i1)]
}

/**
 * A dense frame-major block: `n` frames × `ids.length` stations
 * (`counts[f * S + s]`), so a frame is one contiguous slice. `totals[f]` =
 * Σ counts of frame `f` (for the scrubber's totals strip). `source` says
 * which interim path produced it.
 */
export interface Block {
  anchor: Anchor
  bin: Bin
  /** Frame index of frame 0 of the block. */
  i0: number
  /** Number of frames. */
  n: number
  /** Local-as-UTC ms of frame 0. */
  t0: number
  /** Canonical station ids with ≥1 count in the block, sorted. */
  ids: string[]
  counts: Uint32Array
  totals: Float64Array
  source: Source
  /** Block-relative frame ranges `[f0, f1)` that carry data (a full block is
   *  `[[0, n]]`); frames outside them are *unknown*, not zero — a tip chunk
   *  the pyramid hasn't reached yet (`/api/tl` `partial` + `covered`). */
  covered: [number, number][]
}

/** One chunk: a `Block` of exactly `k = K` frames aligned to `chunk · K`. */
export interface Chunk extends Block {
  chunk: number
  k: number
}

/** One `(station, frame, count)` triple, the input to `pivotBlock`. */
export interface Triple {
  id: string
  frame: number
  count: number
}

/**
 * Pivot triples into a dense frame-major block over frames `[i0, i0 + n)`.
 * Triples outside that range are ignored; duplicates (e.g. the pyramid's
 * `gender × user_type × bike_type` rows for one station-bin) sum. Zero-count
 * ids are dropped from `ids` (a block's id set is "stations with ≥1 count").
 */
export function pivotBlock(
  anchor: Anchor,
  bin: Bin,
  i0: number,
  n: number,
  triples: Iterable<Triple>,
  source: Source,
): Block {
  const perId = new Map<string, Float64Array>()
  for (const { id, frame, count } of triples) {
    const f = frame - i0
    if (f < 0 || f >= n || !(count > 0)) continue
    let arr = perId.get(id)
    if (!arr) {
      arr = new Float64Array(n)
      perId.set(id, arr)
    }
    arr[f] += count
  }
  const ids = Array.from(perId.keys()).sort()
  const S = ids.length
  const counts = new Uint32Array(n * S)
  const totals = new Float64Array(n)
  ids.forEach((id, s) => {
    const arr = perId.get(id)!
    for (let f = 0; f < n; f++) {
      const c = Math.round(arr[f])
      counts[f * S + s] = c
      totals[f] += c
    }
  })
  return { anchor, bin, i0, n, t0: frameStartMs(bin, i0), ids, counts, totals, source, covered: [[0, n]] }
}

/** Merge a per-frame coverage mask into `[f0, f1)` runs. */
export function coveredRuns(mask: readonly boolean[]): [number, number][] {
  const out: [number, number][] = []
  for (let f = 0; f < mask.length; f++) {
    if (!mask[f]) continue
    const last = out[out.length - 1]
    if (last && last[1] === f) last[1] = f + 1
    else out.push([f, f + 1])
  }
  return out
}

/** Whether block-relative frame `f` lies in one of `covered`'s runs. */
export function isCovered(covered: readonly (readonly [number, number])[], f: number): boolean {
  return covered.some(([a, b]) => f >= a && f < b)
}

/** `pivotBlock` for chunk `chunk` (frames `[chunk·K, (chunk+1)·K)`). */
export function pivotRows(
  anchor: Anchor,
  bin: Bin,
  chunk: number,
  triples: Iterable<Triple>,
  source: Source,
): Chunk {
  const K = CHUNK_K[bin]
  const [i0] = chunkFrames(bin, chunk)
  return { ...pivotBlock(anchor, bin, i0, K, triples, source), chunk, k: K }
}

/** Every `(id, frame, count)` of `block` with frame in `[iA, iB)`, count > 0. */
export function* blockTriples(block: Block, iA: number, iB: number): Generator<Triple> {
  const S = block.ids.length
  const fA = Math.max(0, iA - block.i0)
  const fB = Math.min(block.n, iB - block.i0)
  for (let f = fA; f < fB; f++) {
    for (let s = 0; s < S; s++) {
      const count = block.counts[f * S + s]
      if (count > 0) yield { id: block.ids[s], frame: block.i0 + f, count }
    }
  }
}

/**
 * Assemble chunk `chunk` from decoded shard blocks. Each frame is taken from
 * the FIRST block (in the given priority order) covering it, so overlapping
 * rungs never double-count. Frames no block covers are left uncovered.
 */
export function chunkFromBlocks(anchor: Anchor, bin: Bin, chunk: number, blocks: readonly Block[]): Chunk {
  const [i0, i1] = chunkFrames(bin, chunk)
  const triples: Triple[] = []
  const mask: boolean[] = []
  for (let i = i0; i < i1; i++) {
    const b = blocks.find((blk) => i >= blk.i0 && i < blk.i0 + blk.n && isCovered(blk.covered, i - blk.i0))
    mask.push(!!b)
    if (b) for (const t of blockTriples(b, i, i + 1)) triples.push(t)
  }
  const source: Source = blocks[0]?.source ?? 'shard'
  return { ...pivotRows(anchor, bin, chunk, triples, source), covered: coveredRuns(mask) }
}

/** Frame `i`'s slice of `block` (one `Uint32Array` entry per station in
 *  `ids` order), or null when `i` isn't in the block or isn't covered. */
export function frameSlice(block: Block, i: number): Uint32Array | null {
  const f = i - block.i0
  if (f < 0 || f >= block.n || !isCovered(block.covered, f)) return null
  const S = block.ids.length
  return block.counts.subarray(f * S, (f + 1) * S)
}

/** Whether `block` holds frame `i` but has no data for it (a tip frame the
 *  pyramid hasn't reached): known-missing, as opposed to not-yet-fetched. */
export function frameMissing(block: Block, i: number): boolean {
  const f = i - block.i0
  return f >= 0 && f < block.n && !isCovered(block.covered, f)
}

/** Whether the playhead's frame pair can render: each of `a`, `b` is either
 *  drawable (both anchors' slices in) or known-missing (its chunk is in but
 *  doesn't cover it). A missing `b` draws `a` alone; a missing `a` draws the
 *  idle skeleton under a "no data" badge. */
export function pairReady(aIn: boolean, aMissing: boolean, bIn: boolean, bMissing: boolean): boolean {
  return (aIn || aMissing) && (bIn || bMissing)
}

/**
 * Snap a requested frame to the nearest frame whose chunk is cached: the
 * frame itself when its chunk is in; else the nearest edge frame of the
 * nearest cached chunk within `maxChunkDist` chunks (ties → earlier chunk);
 * else null (nothing close enough → the caller shows a loading state).
 */
export function snapToCached(
  cached: ReadonlySet<number>,
  bin: Bin,
  i: number,
  maxChunkDist: number,
): number | null {
  const k = chunkOf(bin, i)
  if (cached.has(k)) return i
  for (let d = 1; d <= maxChunkDist; d++) {
    if (cached.has(k - d)) return chunkFrames(bin, k - d)[1] - 1
    if (cached.has(k + d)) return chunkFrames(bin, k + d)[0]
  }
  return null
}

/** Chunk fetch order around `k`: `k`, then `k+1`, `k-1`, `k+2`, `k-2`, … out
 *  to `radius` (forward first — playback runs forward). */
export function prefetchOrder(k: number, radius: number): number[] {
  const out = [k]
  for (let d = 1; d <= radius; d++) out.push(k + d, k - d)
  return out
}

/** Chunks intersecting the inclusive frame range `[iA, iB]`. */
export function chunksCovering(bin: Bin, iA: number, iB: number): number[] {
  const out: number[] = []
  for (let k = chunkOf(bin, iA); k <= chunkOf(bin, iB); k++) out.push(k)
  return out
}

// ---------------------------------------------------------------------------
// `api` source: `/api/tl` chunk bodies (`gbfs/api/src/tl.ts`).
// ---------------------------------------------------------------------------

/** `GET /api/tl?anchor=&bin=&chunk=` body. `counts` is `k × ids.length`
 *  frame-major; `partial` means some frames of the chunk have no shard
 *  (`covered` lists the frame sub-ranges that do). */
export interface ApiChunk {
  anchor: Anchor
  bin: string
  chunk: number
  k: number
  t0: string
  ids: string[]
  counts: number[]
  unmapped: number[]
  partial: boolean
  covered: [number, number][]
}

/** Thrown when a source can't serve a chunk (no covering shard, partial
 *  API coverage); `auto` falls through to the next source on it. */
export class TlUnavailable extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'TlUnavailable'
  }
}

/** An `/api/tl` body as a `Chunk`. Throws on a body for another
 *  (bin, chunk, K) than requested (a proxy/cache mix-up). A `partial` body
 *  keeps its `covered` frames (the tip chunk renders as far as the pyramid
 *  reaches; the rest is known-missing), unless it covers nothing at all, in
 *  which case `TlUnavailable` lets `auto` try another source. */
export function chunkFromApi(anchor: Anchor, bin: Bin, k: number, body: ApiChunk): Chunk {
  const K = CHUNK_K[bin]
  if (body.bin !== bin || body.chunk !== k || body.k !== K) {
    throw new Error(`/api/tl returned ${body.bin}/${body.chunk}/${body.k}, wanted ${bin}/${k}/${K}`)
  }
  if (body.partial && !body.covered.length) throw new TlUnavailable(`/api/tl ${bin} chunk ${k}: no coverage`)
  const S = body.ids.length
  if (body.counts.length !== K * S) throw new Error(`/api/tl ${bin} chunk ${k}: ${body.counts.length} counts for ${K}×${S}`)
  const counts = Uint32Array.from(body.counts)
  const totals = new Float64Array(K)
  for (let f = 0; f < K; f++) {
    let sum = 0
    for (let s = 0; s < S; s++) sum += counts[f * S + s]
    totals[f] = sum
  }
  const i0 = k * K
  const covered: [number, number][] = body.partial ? body.covered.map(([a, b]) => [a, b]) : [[0, K]]
  return { anchor, bin, chunk: k, k: K, i0, n: K, t0: frameStartMs(bin, i0), ids: body.ids, counts, totals, source: 'api', covered }
}

// ---------------------------------------------------------------------------
// Interim shard source: pick covering shards from a pyramid `manifest.jsonl`.
// ---------------------------------------------------------------------------

/** One `manifest.jsonl` row of a rides pyramid (`rides/{anchor}/manifest.jsonl`). */
export interface ManifestRow {
  tier: string
  shard_dur: string
  period_start: number
  period_end: number
  key: string
  written_at: number
  bytes: number
}

/**
 * Shards of tier `bin` covering any of `[t0, t1)`: one per `(shard_dur,
 * period_start)` slot (the latest `written_at` — R2 keeps older builds and
 * rollback copies under other hashes), ordered by preference for
 * `chunkFromBlocks`: latest `written_at` first, then smaller rungs (cheaper
 * to read; the same data either way).
 */
export function pickShards(rows: readonly ManifestRow[], bin: Bin, t0: number, t1: number): ManifestRow[] {
  const bySlot = new Map<string, ManifestRow>()
  for (const r of rows) {
    if (r.tier !== bin || r.period_end <= t0 || r.period_start >= t1) continue
    const slot = `${r.shard_dur}/${r.period_start}`
    const prev = bySlot.get(slot)
    if (!prev || r.written_at > prev.written_at) bySlot.set(slot, r)
  }
  return Array.from(bySlot.values()).sort((a, b) =>
    b.written_at - a.written_at || (a.period_end - a.period_start) - (b.period_end - b.period_start) || a.key.localeCompare(b.key),
  )
}

// ---------------------------------------------------------------------------
// Interim synthetic source (`specs/timelapse-map.md` P1 fallback).
// ---------------------------------------------------------------------------

/** Days in the UTC month containing `ms`. */
export function daysInMonth(ms: number): number {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

/** `YYYYMM` of the UTC month containing `ms`. */
export function ymOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Small deterministic string hash → [0, 1). */
export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h / 4294967296
}

/** Weekday rhythm for the synthetic frames: weekdays busier than weekends. */
export function weekdayFactor(dow: number): number {
  return dow === 0 || dow === 6 ? 0.7 : 1.12
}

/**
 * Synthesize a chunk from monthly per-station ride totals (`stations[ym].json`
 * `ends`): each frame gets the month's daily mean (× the bin's fraction of a
 * day) × a weekday factor, and the two anchors are pushed apart by a
 * per-station bias so the `flow` preset has something to color (`start` =
 * mean × (1 + b), `end` = mean × (1 − b), `b` ∈ [−0.25, 0.25] from
 * `hash01(id)`). Deterministic; clearly marked `source: 'synth'` so the UI
 * can badge it. INTERIM — the fallback where `/api/tl` has no coverage yet.
 */
export function synthChunk(
  anchor: Anchor,
  bin: Bin,
  chunk: number,
  monthEnds: Record<string, Record<string, number>>,
): Chunk {
  const [i0, i1] = chunkFrames(bin, chunk)
  const triples: Triple[] = []
  for (let i = i0; i < i1; i++) {
    const ms = frameStartMs(bin, i)
    const month = monthEnds[ymOf(ms)]
    if (!month) continue
    const dim = daysInMonth(ms)
    const wf = weekdayFactor(new Date(ms).getUTCDay()) * ((frameStartMs(bin, i + 1) - ms) / DAY_MS)
    for (const [id, ends] of Object.entries(month)) {
      const b = (hash01(id) - 0.5) * 0.5
      const count = Math.round((ends / dim) * wf * (anchor === 'start' ? 1 + b : 1 - b))
      if (count > 0) triples.push({ id, frame: i, count })
    }
  }
  return pivotRows(anchor, bin, chunk, triples, 'synth')
}

// ---------------------------------------------------------------------------
// Frame assembly + `flow` preset styling.
// ---------------------------------------------------------------------------

/** Static station geometry: one row per drawable station, index-stable for
 *  the page's lifetime (the deck `data` never changes; only attributes do). */
export interface StationTable {
  ids: string[]
  index: Map<string, number>
  names: string[]
  /** `[lng, lat]` pairs, `2 * ids.length` (float64: deck positions are fp64). */
  positions: Float64Array
}

export function buildStationTable(
  stations: Record<string, { name?: string; lat: number; lng: number }>,
): StationTable {
  const ids = Object.keys(stations).sort()
  const index = new Map<string, number>()
  const names: string[] = []
  const positions = new Float64Array(ids.length * 2)
  ids.forEach((id, i) => {
    const s = stations[id]
    index.set(id, i)
    names.push(s.name ?? id)
    positions[2 * i] = s.lng
    positions[2 * i + 1] = s.lat
  })
  return { ids, index, names, positions }
}

/** Chunk-local station index → table index (−1 = no position; unmapped). */
export function chunkIndexMap(chunk: Chunk, table: StationTable): Int32Array {
  const m = new Int32Array(chunk.ids.length)
  chunk.ids.forEach((id, s) => { m[s] = table.index.get(id) ?? -1 })
  return m
}

/** `out[table idx] += w × frame count` for every mapped station in the slice;
 *  returns the unmapped count sum (stations without a position). */
export function accumulateFrame(
  out: Float32Array,
  slice: Uint32Array,
  map: Int32Array,
  w: number,
): number {
  let unmapped = 0
  for (let s = 0; s < slice.length; s++) {
    const c = slice[s]
    if (c === 0) continue
    const t = map[s]
    if (t < 0) unmapped += c
    else out[t] += w * c
  }
  return unmapped
}

// ---------------------------------------------------------------------------
// Global scale: every preset sizes stations against one per-tier number
// (starts + ends at which the radius saturates), never the per-frame max, so
// the map "breathes" with the system.
// ---------------------------------------------------------------------------

/** Fallback scale per bin, used until the first chunk pair lands. The
 *  spec's `tl-scale.json` sidecar (builder-computed p99 per tier) doesn't
 *  exist yet, so the session derives its scale client-side
 *  (`scaleFromChunks`) and freezes it. */
export const DEFAULT_SCALE: Record<Bin, number> = {
  '1h': 80, '3h': 200, '6h': 350, '12h': 600, '1d': 1000, '3d': 2800, '7d': 6000, '14d': 11000, '1mo': 22000,
}

/** Quantile `q` (default p99) of the per-station-frame `starts + ends`
 *  totals (> 0) over the covered frames of the given chunk pairs, or null
 *  when there's nothing to measure. */
export function scaleFromChunks(pairs: readonly { start: Chunk; end: Chunk }[], q: number = 0.99): number | null {
  const values: number[] = []
  for (const { start, end } of pairs) {
    const endIdx = new Map<string, number>()
    end.ids.forEach((id, s) => endIdx.set(id, s))
    const S = start.ids.length
    const E = end.ids.length
    for (let f = 0; f < start.n; f++) {
      if (!isCovered(start.covered, f) || !isCovered(end.covered, f)) continue
      const seen = new Set<number>()
      for (let s = 0; s < S; s++) {
        const e = endIdx.get(start.ids[s])
        if (e !== undefined) seen.add(e)
        const total = start.counts[f * S + s] + (e === undefined ? 0 : end.counts[f * E + e])
        if (total > 0) values.push(total)
      }
      for (let e = 0; e < E; e++) {
        if (seen.has(e)) continue
        const total = end.counts[f * E + e]
        if (total > 0) values.push(total)
      }
    }
  }
  if (!values.length) return null
  values.sort((a, b) => a - b)
  // Nearest-rank quantile.
  return values[Math.max(0, Math.min(values.length - 1, Math.ceil(q * values.length) - 1))]
}

// ---------------------------------------------------------------------------
// Presets.
// ---------------------------------------------------------------------------

export type Preset = 'flow' | 'act' | 'split'
export const PRESETS: readonly Preset[] = ['flow', 'act', 'split']

/** Shared sizing: radius (px) ∝ √(count / scale), saturating at `rMax`. */
export const SIZE = {
  rMin: 2,
  rMax: 11,
  /** Radius (px) of an alive-but-idle station (the network's skeleton). */
  rIdle: 1.5,
} as const

/** `flow` preset constants. */
export const FLOW = {
  /** Pseudo-counts damping net share: 1 start / 0 ends shouldn't max the ramp. */
  damp: 3,
  /** Ramp gain on the damped share: daily net shares are small (a busy
   *  station rarely departs from balance by more than ~25%), so |f| = 1/gain
   *  saturates the ramp. */
  gain: 4,
  alpha: 190,
} as const

/** `act` preset: single-hue ramp by total, drawn with additive blending. */
export const ACT = {
  alpha: 110,
} as const

/** `split` preset: filled disk = starts, ring = ends. */
export const SPLIT = {
  alpha: 170,
  ringWidth: 1.5,
} as const

/** Diverging ramp: net sink (cool) ← neutral grey → net source (warm). */
export const COOL: [number, number, number] = [56, 120, 220]
export const NEUTRAL: [number, number, number] = [150, 150, 150]
export const WARM: [number, number, number] = [235, 80, 30]

function putRgba(color: Uint8Array, i: number, rgb: readonly [number, number, number], a: number): void {
  color[4 * i] = rgb[0]
  color[4 * i + 1] = rgb[1]
  color[4 * i + 2] = rgb[2]
  color[4 * i + 3] = a
}

/** `f` ∈ [−1, 1] → `[r, g, b]`. */
export function divergingRgb(f: number): [number, number, number] {
  const c = f < -1 ? -1 : f > 1 ? 1 : f
  const [a, b, t] = c < 0 ? [NEUTRAL, COOL, -c] : [NEUTRAL, WARM, c]
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/** Damped net share: `(starts − ends) / (starts + ends + damp)`. */
export function netShare(starts: number, ends: number, damp: number = FLOW.damp): number {
  return (starts - ends) / (starts + ends + damp)
}

/** Radius (px) for `count` rides against the global `scale`; the idle dot
 *  when there are none. */
export function scaledRadius(count: number, scale: number): number {
  if (!(count > 0)) return SIZE.rIdle
  const t = Math.min(1, Math.sqrt(count / scale))
  return SIZE.rMin + (SIZE.rMax - SIZE.rMin) * t
}

/** Per-station binary attributes for one rendered frame of the `flow`
 *  preset: radius by `starts + ends`, diverging color on the damped net
 *  share. `starts`/`ends` are per-table-index (already interpolated).
 *  Stations with no activity draw as a faint idle dot. */
export function flowAttributes(
  starts: Float32Array,
  ends: Float32Array,
  scale: number,
): { radius: Float32Array; color: Uint8Array } {
  const n = starts.length
  const radius = new Float32Array(n)
  const color = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const s = starts[i]
    const e = ends[i]
    const total = s + e
    radius[i] = scaledRadius(total, scale)
    if (total > 0) putRgba(color, i, divergingRgb(netShare(s, e) * FLOW.gain), FLOW.alpha)
    else putRgba(color, i, NEUTRAL, 70)
  }
  return { radius, color }
}

/** `act` preset: radius AND color (the `flowLens` cool→hot ramp) by
 *  `√(total / scale)`; idle stations are a faint dot. Meant to be drawn with
 *  additive blending so dense clusters glow. */
export function actAttributes(
  starts: Float32Array,
  ends: Float32Array,
  scale: number,
): { radius: Float32Array; color: Uint8Array } {
  const n = starts.length
  const radius = new Float32Array(n)
  const color = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const total = starts[i] + ends[i]
    radius[i] = scaledRadius(total, scale)
    if (total > 0) putRgba(color, i, rampRgb(Math.min(1, Math.sqrt(total / scale))), ACT.alpha)
    else putRgba(color, i, NEUTRAL, 70)
  }
  return { radius, color }
}

/** `split` preset: two radii per station on the same scale — the filled
 *  disk (starts) and the ring (ends). A glyph with no rides has radius 0
 *  (hidden), except that a fully idle station keeps the idle dot as its
 *  disk so the skeleton still shows. */
export function splitAttributes(
  starts: Float32Array,
  ends: Float32Array,
  scale: number,
): { rStart: Float32Array; rEnd: Float32Array } {
  const n = starts.length
  const rStart = new Float32Array(n)
  const rEnd = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const s = starts[i]
    const e = ends[i]
    rStart[i] = s > 0 ? scaledRadius(s, scale) : e > 0 ? 0 : SIZE.rIdle
    rEnd[i] = e > 0 ? scaledRadius(e, scale) : 0
  }
  return { rStart, rEnd }
}

// ---------------------------------------------------------------------------
// Pinned-station sparkline.
// ---------------------------------------------------------------------------

/** `starts + ends` per frame for station `id` over the inclusive frame range
 *  `[iA, iB]`, from whatever chunk pairs are cached: NaN where the frame's
 *  chunk isn't in (or isn't covered), 0 where it is but the station had no
 *  rides. Nothing is fetched for this — it's the drawer's sparkline. */
export function stationSeries(
  pairs: readonly { start: Chunk | undefined; end: Chunk | undefined }[],
  id: string,
  iA: number,
  iB: number,
): Float64Array {
  const out = new Float64Array(Math.max(0, iB - iA + 1)).fill(NaN)
  for (const { start, end } of pairs) {
    if (!start || !end) continue
    const s = start.ids.indexOf(id)
    const e = end.ids.indexOf(id)
    const S = start.ids.length
    const E = end.ids.length
    for (let f = 0; f < start.n; f++) {
      const i = start.i0 + f
      if (i < iA || i > iB || !isCovered(start.covered, f) || !isCovered(end.covered, f)) continue
      out[i - iA] = (s < 0 ? 0 : start.counts[f * S + s]) + (e < 0 ? 0 : end.counts[f * E + e])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// URL codecs' pure halves: `YYMMDD` dates, `YYMMDD[THH]` instants (local-as-UTC).
// ---------------------------------------------------------------------------

/** `YYMMDD` or `YYMMDDTHH` → local-as-UTC ms, or null when malformed. */
export function parseT(s: string): number | null {
  const m = /^(\d{6})(?:T(\d{2}))?$/.exec(s)
  if (!m) return null
  const day = parseYmd(m[1])
  if (day === null) return null
  const hh = m[2] === undefined ? 0 : Number(m[2])
  if (hh > 23) return null
  return day + hh * HOUR_MS
}

/** Local-as-UTC ms → `YYMMDD` at midnight, else `YYMMDDTHH` (whole hours). */
export function formatT(ms: number): string {
  const hh = new Date(ms).getUTCHours()
  return hh === 0 ? formatYmd(ms) : `${formatYmd(ms)}T${String(hh).padStart(2, '0')}`
}

/** `YYMMDD` → local-as-UTC ms at midnight, or null when malformed. */
export function parseYmd(s: string): number | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(s)
  if (!m) return null
  const [yy, mm, dd] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return Date.UTC(2000 + yy, mm - 1, dd)
}

/** Local-as-UTC ms → `YYMMDD`. */
export function formatYmd(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
}
