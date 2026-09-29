/**
 * Timelapse chunk cache (`specs/timelapse-map.md` "Client cache and
 * prefetch"), on TanStack Query: `['tl', src, anchor, bin, chunk]` with
 * `staleTime: Infinity` (chunks are immutable), `ensureQueryData` as the
 * fetch primitive, ±1-chunk prefetch, and a cache-version subscription so
 * React re-renders when a chunk lands. The pure math lives in
 * `timelapseFrames.ts`.
 *
 * `fetchChunk` is pluggable, with three sources:
 *
 * - `api` (P2, the real one): `GET ${API_BASE}/api/tl?anchor=&bin=&chunk=`
 *   (`gbfs/api/src/tl.ts`) over the time-first `rides-tl` pyramids — one
 *   edge-cacheable JSON block per chunk. A `partial` chunk (the tip: frames
 *   past the last published month) keeps its `covered` frames; the rest are
 *   known-missing (`frameMissing`), badged "no data" rather than drawn as
 *   zeros. Only a chunk with no coverage at all is `TlUnavailable`, so
 *   `auto` falls through to the interim sources below.
 * - `shard`: read the existing station-first rides pyramid straight from
 *   `data.ctbk.dev` (public, range-readable, CORS-open) with hyparquet —
 *   resolve the covering `1d` shard(s) through `manifest.jsonl`, project
 *   `cell,dt,count_sum` over the station row groups (the `s:`/`c:` tail of
 *   the `cell`-sorted file; one range request per row group, ~8 KB each), and
 *   pivot to the frame-major block. Works where the tier's shards are small
 *   (≤ `MAX_SHARD_BYTES`): today that's `1d` from 2026-01-27 on (`128d` +
 *   `64d` rungs); earlier days live in 1024-day shards (285–360 MB) that a
 *   browser can't reasonably tail-read (the station RGs alone are ~45 MB per
 *   anchor per chunk), which is exactly why the spec builds `rides-tl`.
 * - `synth`: frames synthesized from the monthly `stations[ym].json` `ends`
 *   (`synthChunk`), so the UI is exercisable over any range. Badged in the UI.
 *
 * `auto` (the default) tries `api`, then `shard`, then `synth`, per chunk.
 * Delete the interim two once `rides-tl` covers all of history.
 *
 * Prefetch: `useTlFrames` kicks the chunk under the playhead (+ its ±1
 * neighbours) directly; `useTlPrefetch` runs the idle fill
 * (`timelapsePrefetch.ts`) behind it — the fan-out near the playhead, then
 * the rest of the range — two chunks at a time.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { asyncBufferFromUrl, parquetMetadataAsync, parquetRead, type AsyncBuffer, type FileMetaData } from 'hyparquet'
import { API_BASE } from './stations'
import { dbgFetch } from '../lib/dbg'
import {
  ANCHORS, chunkFromApi, chunkFromBlocks, chunkMs, chunkOf, chunksCovering, frameIndex, frameMissing, frameSlice,
  pairReady, pickShards, pivotBlock, prefetchOrder, stationSeries, synthChunk, TlUnavailable, ymOf,
  type Anchor, type ApiChunk, type Bin, type Block, type Chunk, type ManifestRow, type Triple,
} from './timelapseFrames'
import { lastDataDay } from './timelapseControls'
import { fillOrder, PrefetchQueue } from './timelapsePrefetch'

export { TlUnavailable }
export type SourceMode = 'auto' | 'api' | 'shard' | 'synth'

const DATA_BASE = 'https://data.ctbk.dev'
const STATION_URLS = '/assets/station-urls.json'
const MERGES_URL = '/assets/station-merges.json'
/** Refuse to tail-read shards bigger than this (see module doc). */
export const MAX_SHARD_BYTES = 64 * 1024 * 1024
/** Concurrent range requests per shard read. */
const MAX_INFLIGHT = 16
const CHUNK_GC_MS = 10 * 60_000

// ---------------------------------------------------------------------------
// Shared static inputs (manifests, id-map), all `staleTime: Infinity`.
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

function manifestRows(qc: QueryClient, anchor: Anchor): Promise<ManifestRow[]> {
  return qc.ensureQueryData({
    queryKey: ['tl-manifest', anchor],
    staleTime: Infinity,
    queryFn: async () => {
      const url = `${DATA_BASE}/rides/${anchor}/manifest.jsonl`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      const text = await res.text()
      return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ManifestRow)
    },
  })
}

type Merges = { clusters: Record<string, { members: { id: string }[] }> }

/** Ids that are members of a merged cluster: their `s:` leaves are counted in
 *  the cluster's `c:` row, so canonical frames skip them (`selectLeaves(…,
 *  'canonical')` in `gbfs/api/src/canon.ts`). */
function clusterMembers(qc: QueryClient): Promise<Set<string>> {
  return qc.ensureQueryData({
    queryKey: ['tl-merges'],
    staleTime: Infinity,
    queryFn: async () => {
      const m = await fetchJson<Merges>(MERGES_URL)
      const out = new Set<string>()
      for (const c of Object.values(m.clusters)) for (const { id } of c.members) out.add(id)
      return out
    },
  })
}

type StationUrls = { stations: Record<string, string>; latestMonth: string }

function stationUrls(qc: QueryClient): Promise<StationUrls> {
  return qc.ensureQueryData({ queryKey: ['tl-station-urls'], staleTime: Infinity, queryFn: () => fetchJson<StationUrls>(STATION_URLS) })
}

/** The data's last day: the end of `station-urls.json`'s `latestMonth`
 *  (the last month the pipeline published; `rides-tl` is built to the same
 *  cap), or null while loading. Shares `stationUrls`' cache entry. */
export function useTlLastDay(): number | null {
  const q = useQuery({ queryKey: ['tl-station-urls'], staleTime: Infinity, queryFn: () => fetchJson<StationUrls>(STATION_URLS) })
  return q.data ? lastDataDay(q.data.latestMonth) : null
}

type MonthStations = Record<string, { ends: number }>

function monthEnds(qc: QueryClient, url: string): Promise<Record<string, number>> {
  return qc.ensureQueryData({
    queryKey: ['tl-month', url],
    staleTime: Infinity,
    queryFn: async () => {
      const m = await fetchJson<MonthStations>(url)
      const out: Record<string, number> = {}
      for (const [id, s] of Object.entries(m)) out[id] = s.ends
      return out
    },
  })
}

// ---------------------------------------------------------------------------
// `api` source: `/api/tl`.
// ---------------------------------------------------------------------------

async function fetchApiChunk(_qc: QueryClient, anchor: Anchor, bin: Bin, k: number): Promise<Chunk> {
  const url = new URL(`${API_BASE}/api/tl`)
  url.searchParams.set('anchor', anchor)
  url.searchParams.set('bin', bin)
  url.searchParams.set('chunk', String(k))
  const res = await dbgFetch(url.toString())
  if (!res.ok) throw new Error(`/api/tl ${bin} chunk ${k}: HTTP ${res.status}`)
  return chunkFromApi(anchor, bin, k, (await res.json()) as ApiChunk)
}

// ---------------------------------------------------------------------------
// `shard` source: hyparquet tail-read of a station-first pyramid shard.
// ---------------------------------------------------------------------------

const COLS = ['cell', 'dt', 'count_sum']

/** `[start, end)` byte span per row group covering just the projected columns. */
function rgSpans(md: FileMetaData): { rowStart: number; rowEnd: number; spans: [number, number][] } {
  let rows = 0
  let rowStart = -1
  const spans: [number, number][] = []
  for (const rg of md.row_groups) {
    const n = Number(rg.num_rows)
    const stats = rg.columns[0].meta_data?.statistics
    const maxCell = stats?.max_value
    // Station rows (`c:…`, `s:…`) sort after every hex S2 token, so the
    // station tail starts at the first RG whose max cell reaches `c`.
    if (typeof maxCell === 'string' && maxCell >= 'c') {
      if (rowStart < 0) rowStart = rows
      let a = Infinity
      let b = -Infinity
      for (const c of rg.columns) {
        const m = c.meta_data
        if (!m || !COLS.includes(m.path_in_schema[0])) continue
        const off = Number(m.dictionary_page_offset || m.data_page_offset)
        a = Math.min(a, off)
        b = Math.max(b, off + Number(m.total_compressed_size))
      }
      spans.push([a, b])
    }
    rows += n
  }
  return { rowStart, rowEnd: rows, spans }
}

/** An `AsyncBuffer` that serves any slice inside one of `spans` from a single
 *  memoized range request for that span (hyparquet otherwise fetches each
 *  column chunk separately: 3× the requests), with bounded concurrency. */
function spanBuffer(base: AsyncBuffer, spans: [number, number][]): AsyncBuffer {
  const cache = new Map<number, Promise<ArrayBuffer>>()
  let inflight = 0
  const waiters: (() => void)[] = []
  const acquire = () => new Promise<void>((resolve) => {
    if (inflight < MAX_INFLIGHT) { inflight++; resolve() } else waiters.push(() => { inflight++; resolve() })
  })
  const release = () => { inflight--; waiters.shift()?.() }
  const fetchSpan = async (i: number) => {
    await acquire()
    try { return await base.slice(spans[i][0], spans[i][1]) } finally { release() }
  }
  return {
    byteLength: base.byteLength,
    slice(start, end = base.byteLength) {
      const i = spans.findIndex(([a, b]) => a <= start && end <= b)
      if (i < 0) return base.slice(start, end)
      let p = cache.get(i)
      if (!p) { p = fetchSpan(i); cache.set(i, p) }
      return p.then((buf) => buf.slice(start - spans[i][0], end - spans[i][0]))
    },
  }
}

/** Decode one shard's station tail into a block over its whole period. */
async function readShardBlock(row: ManifestRow, anchor: Anchor, bin: Bin, members: Set<string>): Promise<Block> {
  const base = await asyncBufferFromUrl({ url: `${DATA_BASE}/${row.key}`, byteLength: row.bytes })
  const md = await parquetMetadataAsync(base)
  const { rowStart, rowEnd, spans } = rgSpans(md)
  const i0 = frameIndex(bin, row.period_start)
  const n = frameIndex(bin, row.period_end) - i0
  if (rowStart < 0) return pivotBlock(anchor, bin, i0, n, [], 'shard')
  const file = spanBuffer(base, spans)
  const rows = await new Promise<unknown[][]>((resolve, reject) => {
    parquetRead({ file, metadata: md, columns: COLS, rowStart, rowEnd, onComplete: (r) => resolve(r as unknown[][]) }).catch(reject)
  })
  const triples: Triple[] = []
  for (const [cell, dt, count] of rows) {
    const c = cell as string
    let id: string
    if (c.startsWith('c:')) id = c.slice(2)
    else if (c.startsWith('s:')) {
      id = c.slice(2)
      if (members.has(id)) continue
    } else continue
    triples.push({ id, frame: frameIndex(bin, Number(dt)), count: Number(count) })
  }
  return pivotBlock(anchor, bin, i0, n, triples, 'shard')
}

function shardBlock(qc: QueryClient, row: ManifestRow, anchor: Anchor, bin: Bin): Promise<Block> {
  return qc.ensureQueryData({
    queryKey: ['tl-shard', row.key],
    staleTime: Infinity,
    gcTime: CHUNK_GC_MS,
    queryFn: async () => readShardBlock(row, anchor, bin, await clusterMembers(qc)),
  })
}

async function fetchShardChunk(qc: QueryClient, anchor: Anchor, bin: Bin, k: number): Promise<Chunk> {
  const [t0, t1] = chunkMs(bin, k)
  const rows = pickShards(await manifestRows(qc, anchor), bin, t0, t1)
  if (!rows.length) throw new TlUnavailable(`no ${bin} shard covers chunk ${k}`)
  const big = rows.find((r) => r.bytes > MAX_SHARD_BYTES)
  if (big) throw new TlUnavailable(`${bin}/${big.shard_dur} shard is ${(big.bytes / 1e6).toFixed(0)} MB (> ${MAX_SHARD_BYTES / 1e6} MB cap)`)
  const blocks = await Promise.all(rows.map((r) => shardBlock(qc, r, anchor, bin)))
  return chunkFromBlocks(anchor, bin, k, blocks)
}

// ---------------------------------------------------------------------------
// `synth` source.
// ---------------------------------------------------------------------------

async function fetchSynthChunk(qc: QueryClient, anchor: Anchor, bin: Bin, k: number): Promise<Chunk> {
  const urls = await stationUrls(qc)
  const [t0, t1] = chunkMs(bin, k)
  const yms = new Set<string>()
  for (let t = t0; t < t1; t += 86_400_000) yms.add(ymOf(t))
  const ends: Record<string, Record<string, number>> = {}
  await Promise.all(Array.from(yms).map(async (ym) => {
    const url = urls.stations[ym]
    if (url) ends[ym] = await monthEnds(qc, url)
  }))
  return synthChunk(anchor, bin, k, ends)
}

// ---------------------------------------------------------------------------
// Chunk cache API.
// ---------------------------------------------------------------------------

export type FetchChunk = (qc: QueryClient, anchor: Anchor, bin: Bin, k: number) => Promise<Chunk>

/** Try each source in order; a `TlUnavailable` falls through, anything
 *  else (network, HTTP, decode) surfaces. */
function firstAvailable(...sources: FetchChunk[]): FetchChunk {
  return async (qc, anchor, bin, k) => {
    for (let i = 0; i < sources.length; i++) {
      try {
        return await sources[i](qc, anchor, bin, k)
      } catch (e) {
        if (!(e instanceof TlUnavailable) || i === sources.length - 1) throw e
      }
    }
    throw new Error('unreachable')
  }
}

const SOURCES: Record<SourceMode, FetchChunk> = {
  api: fetchApiChunk,
  shard: fetchShardChunk,
  synth: fetchSynthChunk,
  auto: firstAvailable(fetchApiChunk, fetchShardChunk, fetchSynthChunk),
}

export const chunkKey = (src: SourceMode, anchor: Anchor, bin: Bin, k: number) => ['tl', src, anchor, bin, k] as const

/** Fetch (or return the cached) chunk. */
export function ensureChunk(qc: QueryClient, src: SourceMode, anchor: Anchor, bin: Bin, k: number): Promise<Chunk> {
  return qc.ensureQueryData({
    queryKey: chunkKey(src, anchor, bin, k),
    staleTime: Infinity,
    gcTime: CHUNK_GC_MS,
    retry: 1,
    queryFn: () => SOURCES[src](qc, anchor, bin, k),
  })
}

export function getChunk(qc: QueryClient, src: SourceMode, anchor: Anchor, bin: Bin, k: number): Chunk | undefined {
  return qc.getQueryData<Chunk>(chunkKey(src, anchor, bin, k))
}

export function chunkError(qc: QueryClient, src: SourceMode, anchor: Anchor, bin: Bin, k: number): Error | null {
  return (qc.getQueryState(chunkKey(src, anchor, bin, k))?.error as Error | undefined) ?? null
}

/** Bumps whenever any `tl*` query updates, so components reading the cache
 *  synchronously (`getChunk`) re-render when a chunk lands. */
export function useTlCacheVersion(): number {
  const qc = useQueryClient()
  const [v, setV] = useState(0)
  useEffect(() => qc.getQueryCache().subscribe((e) => {
    const key = e.query.queryKey[0]
    if (typeof key === 'string' && key.startsWith('tl') && (e.type === 'updated' || e.type === 'added' || e.type === 'removed')) setV((x) => x + 1)
  }), [qc])
  return v
}

/** Frames `⌊t⌋` and `⌊t⌋+1` for both anchors (null while not cached), plus
 *  whether the pair the playhead needs is ready. Kicks the chunk under `t`
 *  and its ±`radius` neighbours (`prefetchOrder`). */
export interface FramePair {
  a: number
  b: number
  startA: Uint32Array | null
  startB: Uint32Array | null
  endA: Uint32Array | null
  endB: Uint32Array | null
  chunkA: { start: Chunk | undefined; end: Chunk | undefined }
  chunkB: { start: Chunk | undefined; end: Chunk | undefined }
  /** Frame `a`'s chunk is in but has no data for it (past the pyramid's tip). */
  aMissing: boolean
  /** Frame `b` is known-missing: render `a` alone (no lerp) instead of stalling. */
  bMissing: boolean
  /** Each of `a`, `b` is drawable or known-missing (`pairReady`): a tip
   *  frame past the pyramid shows the "no data" badge instead of stalling. */
  ready: boolean
  error: Error | null
}

export function useTlFrames(src: SourceMode, bin: Bin, t: number, radius: number = 1): FramePair {
  const qc = useQueryClient()
  const version = useTlCacheVersion()
  const a = Math.floor(t)
  const b = a + 1
  const ka = chunkOf(bin, a)
  const kb = chunkOf(bin, b)
  useEffect(() => {
    const ks = Array.from(new Set([...prefetchOrder(ka, radius), kb]))
    // `ensureChunk` rejections are surfaced via `chunkError`; swallow here.
    for (const k of ks) for (const anchor of ['start', 'end'] as const) ensureChunk(qc, src, anchor, bin, k).catch(() => {})
  }, [qc, src, bin, ka, kb, radius])
  return useMemo(() => {
    const cs = (k: number) => ({ start: getChunk(qc, src, 'start', bin, k), end: getChunk(qc, src, 'end', bin, k) })
    const chunkA = cs(ka)
    const chunkB = cs(kb)
    const sl = (c: Chunk | undefined, i: number) => (c ? frameSlice(c, i) : null)
    const startA = sl(chunkA.start, a)
    const endA = sl(chunkA.end, a)
    const startB = sl(chunkB.start, b)
    const endB = sl(chunkB.end, b)
    const missing = (c: { start: Chunk | undefined; end: Chunk | undefined }, i: number) =>
      !!(c.start && c.end) && (frameMissing(c.start, i) || frameMissing(c.end, i))
    const aMissing = missing(chunkA, a)
    const bMissing = missing(chunkB, b)
    const error = chunkError(qc, src, 'start', bin, ka) ?? chunkError(qc, src, 'end', bin, ka)
    const ready = pairReady(!!(startA && endA), aMissing, !!(startB && endB), bMissing)
    return { a, b, startA, startB, endA, endB, chunkA, chunkB, aMissing, bMissing, ready, error }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, src, bin, a, b, ka, kb, version])
}

/** Chunk fetches the idle fill keeps in flight (each = both anchors): low,
 *  so the playhead's own chunks (`useTlFrames`) never queue behind it. */
const PREFETCH_CONCURRENCY = 2

/** Idle fill (`PrefetchQueue`) around chunk `k` over `[kMin, kMax]`: the
 *  fan-out near the playhead first, then every other chunk in the range
 *  (`fillOrder`), so the range's sparklines fill completely. Re-prioritized
 *  whenever `k` (the playhead's chunk) or the range moves; a bin / source
 *  change drops the queue. Both anchors of a chunk count as one fetch. */
export function useTlPrefetch(src: SourceMode, bin: Bin, k: number, kMin: number, kMax: number): void {
  const qc = useQueryClient()
  // Created in an effect (not a memo) so StrictMode's mount → unmount →
  // mount gets a live queue, not the one the first cleanup disposed.
  const queueRef = useRef<PrefetchQueue | null>(null)
  useEffect(() => {
    const fetch = (c: number) => Promise.all(ANCHORS.map((anchor) => ensureChunk(qc, src, anchor, bin, c)))
    const isCached = (c: number) => ANCHORS.every((anchor) => !!getChunk(qc, src, anchor, bin, c))
    const q = new PrefetchQueue(fetch, isCached, PREFETCH_CONCURRENCY)
    queueRef.current = q
    return () => {
      q.dispose()
      queueRef.current = null
    }
  }, [qc, src, bin])
  useEffect(() => queueRef.current?.retarget(fillOrder(k, kMin, kMax)), [qc, src, bin, k, kMin, kMax])
}

/** `starts + ends` per frame for one station over `[iA, iB]` from cached
 *  chunks (NaN where not cached) — the pinned-station sparkline. */
export function useTlStationSeries(src: SourceMode, bin: Bin, id: string | null, iA: number, iB: number): Float64Array {
  const qc = useQueryClient()
  const version = useTlCacheVersion()
  return useMemo(() => {
    if (id === null) return new Float64Array(0)
    const pairs = chunksCovering(bin, iA, iB).map((k) => ({ start: getChunk(qc, src, 'start', bin, k), end: getChunk(qc, src, 'end', bin, k) }))
    return stationSeries(pairs, id, iA, iB)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, src, bin, id, iA, iB, version])
}

/** Σ starts per frame over the inclusive frame range `[iA, iB]` from cached
 *  chunks (NaN where the chunk isn't in yet) — the scrubber's totals strip. */
export function useTlTotals(src: SourceMode, bin: Bin, iA: number, iB: number): Float64Array {
  const qc = useQueryClient()
  const version = useTlCacheVersion()
  return useMemo(() => {
    const out = new Float64Array(Math.max(0, iB - iA + 1)).fill(NaN)
    for (const k of chunksCovering(bin, iA, iB)) {
      const c = getChunk(qc, src, 'start', bin, k)
      if (!c) continue
      for (let f = 0; f < c.n; f++) {
        const i = c.i0 + f
        if (i >= iA && i <= iB && frameSlice(c, i)) out[i - iA] = c.totals[f]
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, src, bin, iA, iB, version])
}

/** Chunk numbers currently cached (either anchor's chunk landing counts as
 *  "cached" for snapping purposes only when both are in). */
export function cachedChunks(qc: QueryClient, src: SourceMode, bin: Bin, ks: Iterable<number>): Set<number> {
  const out = new Set<number>()
  for (const k of ks) if (getChunk(qc, src, 'start', bin, k) && getChunk(qc, src, 'end', bin, k)) out.add(k)
  return out
}
