import { describe, expect, test } from 'vitest'
import {
  accumulateFrame, buildStationTable, chunkFrames, chunkFromApi, chunkFromBlocks, chunkIndexMap, chunkMs, chunkOf,
  chunksCovering, daysInMonth, divergingRgb, flowAttributes, flowRadius, formatT, formatYmd, frameIndex, frameSlice,
  frameStartMs, hash01, netShare, originMs, parseT, parseYmd, pickShards, pivotBlock, pivotRows, prefetchOrder,
  snapToCached, synthChunk, TlUnavailable, weekdayFactor, ymOf,
  type ApiChunk, type ManifestRow,
} from './timelapseFrames'

const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h)

describe('frame / chunk index math (origin = genesis floored to the K·bin grid)', () => {
  test('originMs: 1d/32 → 2013-05-15 (epoch-aligned 32d grid), 1h/48 → 2013-05-31', () => {
    expect(originMs('1d')).toBe(D(2013, 5, 15))
    expect(originMs('1h')).toBe(D(2013, 5, 31))
  })
  test('frameIndex', () => {
    expect(frameIndex('1d', D(2013, 6, 1))).toBe(17)
    expect(frameIndex('1d', D(2013, 5, 15))).toBe(0)
    expect(frameIndex('1d', D(2013, 5, 14))).toBe(-1)
    expect(frameIndex('1d', D(2013, 6, 2, 12))).toBe(18)
    expect(frameIndex('1d', D(2025, 6, 10))).toBe(4409)
    expect(frameIndex('1h', D(2013, 6, 1))).toBe(24)
    expect(frameIndex('1h', D(2025, 6, 10, 8))).toBe(105440)
  })
  test('frameStartMs / chunkOf / chunkFrames / chunkMs land on the shard grid', () => {
    expect(frameStartMs('1d', 32)).toBe(D(2013, 6, 16))
    expect(chunkOf('1d', 31)).toBe(0)
    expect(chunkOf('1d', 32)).toBe(1)
    expect(chunkFrames('1d', 2)).toEqual([64, 96])
    expect(chunkMs('1d', 1)).toEqual([D(2013, 6, 16), D(2013, 7, 18)])
    expect(chunkMs('1d', 137)).toEqual([D(2025, 5, 16), D(2025, 6, 17)])
    expect(chunkOf('1h', 105440)).toBe(2196)
    expect(chunkMs('1h', 2196)).toEqual([D(2025, 6, 9), D(2025, 6, 11)])
  })
  test('chunksCovering / prefetchOrder', () => {
    expect(chunksCovering('1d', 31, 64)).toEqual([0, 1, 2])
    expect(prefetchOrder(5, 2)).toEqual([5, 6, 4, 7, 3])
  })
})

describe('pivotRows', () => {
  const chunk = pivotRows('start', '1d', 1, [
    { id: 'b', frame: 32, count: 2 },
    { id: 'a', frame: 32, count: 1 },
    { id: 'a', frame: 32, count: 4 },
    { id: 'a', frame: 33, count: 3 },
    { id: 'zz', frame: 10, count: 9 },
    { id: 'c', frame: 40, count: 0 },
  ], 'shard')
  test('dense frame-major block: sorted ids, summed dups, out-of-range + zero dropped', () => {
    const counts = new Uint32Array(64)
    counts[0] = 5
    counts[1] = 2
    counts[2] = 3
    const totals = new Float64Array(32)
    totals[0] = 7
    totals[1] = 3
    expect(chunk).toEqual({
      anchor: 'start', bin: '1d', chunk: 1, k: 32, i0: 32, n: 32, t0: D(2013, 6, 16),
      ids: ['a', 'b'], counts, totals, source: 'shard',
    })
  })
  test('frameSlice', () => {
    expect(frameSlice(chunk, 33)).toEqual(new Uint32Array([3, 0]))
    expect(frameSlice(chunk, 64)).toBeNull()
    expect(frameSlice(chunk, 31)).toBeNull()
  })
})

describe('chunkFromBlocks', () => {
  test('each frame from the first covering block; no double counting', () => {
    const x = pivotBlock('start', '1d', 30, 4, [
      { id: 'a', frame: 30, count: 1 }, { id: 'a', frame: 31, count: 2 }, { id: 'a', frame: 32, count: 3 }, { id: 'a', frame: 33, count: 4 },
    ], 'shard')
    const y = pivotBlock('start', '1d', 32, 4, [
      { id: 'a', frame: 32, count: 10 }, { id: 'b', frame: 33, count: 20 }, { id: 'a', frame: 34, count: 30 },
    ], 'shard')
    const counts = new Uint32Array(32)
    counts[0] = 3
    counts[1] = 4
    counts[2] = 30
    const totals = new Float64Array(32)
    totals[0] = 3
    totals[1] = 4
    totals[2] = 30
    expect(chunkFromBlocks('start', '1d', 1, [x, y])).toEqual({
      anchor: 'start', bin: '1d', chunk: 1, k: 32, i0: 32, n: 32, t0: D(2013, 6, 16),
      ids: ['a'], counts, totals, source: 'shard',
    })
  })
})

describe('chunkFromApi', () => {
  const body = (o: Partial<ApiChunk> = {}): ApiChunk => ({
    anchor: 'start', bin: '1h', chunk: 2196, k: 48, t0: '2025-06-09T00:00:00',
    ids: ['a', 'b'], counts: new Array<number>(96).fill(0), unmapped: new Array<number>(48).fill(0),
    partial: false, covered: [[0, 48]], ...o,
  })
  test('dense block → Chunk with per-frame totals, source api', () => {
    // 2025-06-10T08 = frame 105440 = chunk-relative 32 (chunk 2196 starts 2025-06-09T00).
    const counts = new Array<number>(96).fill(0)
    counts[32 * 2] = 5
    counts[32 * 2 + 1] = 7
    counts[33 * 2 + 1] = 1
    const c = chunkFromApi('start', '1h', 2196, body({ counts }))
    const totals = new Float64Array(48)
    totals[32] = 12
    totals[33] = 1
    expect(c).toEqual({
      anchor: 'start', bin: '1h', chunk: 2196, k: 48, i0: 2196 * 48, n: 48, t0: D(2025, 6, 9),
      ids: ['a', 'b'], counts: Uint32Array.from(counts), totals, source: 'api',
    })
    expect(frameSlice(c, 105440)).toEqual(new Uint32Array([5, 7]))
  })
  test('partial → TlUnavailable; mismatched identity or shape → Error', () => {
    expect(() => chunkFromApi('start', '1h', 2196, body({ partial: true, covered: [[0, 14]] })))
      .toThrow(TlUnavailable)
    expect(() => chunkFromApi('start', '1h', 2197, body())).toThrow('/api/tl returned 1h/2196/48, wanted 1h/2197/48')
    expect(() => chunkFromApi('start', '1d', 2196, body())).toThrow('/api/tl returned 1h/2196/48, wanted 1d/2196/32')
    expect(() => chunkFromApi('start', '1h', 2196, body({ counts: [1] }))).toThrow('/api/tl 1h chunk 2196: 1 counts for 48×2')
  })
})

describe('snapToCached', () => {
  test('own chunk cached → same frame', () => {
    expect(snapToCached(new Set([3]), '1d', 100, 1)).toBe(100)
  })
  test('nearest cached chunk edge, earlier wins ties', () => {
    expect(snapToCached(new Set([3]), '1d', 130, 1)).toBe(127)
    expect(snapToCached(new Set([3]), '1d', 70, 1)).toBe(96)
    expect(snapToCached(new Set([1, 5]), '1d', 100, 2)).toBe(63)
  })
  test('nothing within maxChunkDist → null', () => {
    expect(snapToCached(new Set([1, 5]), '1d', 100, 1)).toBeNull()
  })
})

describe('pickShards', () => {
  const row = (o: Partial<ManifestRow>): ManifestRow => ({
    tier: '1d', shard_dur: '64d', period_start: 100, period_end: 200, key: 'k', written_at: 1, bytes: 1, ...o,
  })
  test('latest build per slot, intersecting only, newest-then-smallest order', () => {
    const a = row({ key: 'a', written_at: 1 })
    const b = row({ key: 'b', written_at: 2 })
    const c = row({ key: 'c', tier: '1h', written_at: 9 })
    const d = row({ key: 'd', shard_dur: '128d', period_start: 0, period_end: 100, written_at: 3 })
    const e = row({ key: 'e', shard_dur: '32d', period_start: 200, period_end: 232, written_at: 2 })
    expect(pickShards([a, b, c, d, e], '1d', 150, 250)).toEqual([e, b])
  })
})

describe('synth source', () => {
  test('daysInMonth / ymOf / weekdayFactor', () => {
    expect(daysInMonth(D(2013, 2, 1))).toBe(28)
    expect(daysInMonth(D(2016, 2, 15))).toBe(29)
    expect(ymOf(D(2013, 6, 1))).toBe('201306')
    expect([weekdayFactor(0), weekdayFactor(3), weekdayFactor(6)]).toEqual([0.7, 1.12, 0.7])
  })
  test('synthChunk: month mean × weekday × anchor bias; months without data are empty', () => {
    // Chunk 0 = 2013-05-15 .. 2013-06-16; only June has data.
    const c = synthChunk('start', '1d', 0, { '201306': { s1: 300 } })
    const b = (hash01('s1') - 0.5) * 0.5
    // June 2013 = 30 days → mean 10/day; 2013-06-01 (frame 17) is a Saturday.
    const expected = new Uint32Array(32)
    for (let f = 17; f < 32; f++) expected[f] = Math.round(10 * weekdayFactor((6 + f - 17) % 7) * (1 + b))
    expect(c.ids).toEqual(['s1'])
    expect(c.source).toBe('synth')
    expect(c.counts).toEqual(expected)
    expect(Array.from(c.totals)).toEqual(Array.from(expected))
    expect(c.counts[17]).toBe(Math.round(7 * (1 + b)))
    expect(c.counts[19]).toBe(Math.round(11.2 * (1 + b)))
  })
  test('synthChunk 1h: the daily mean spread over 24 bins', () => {
    // Chunk 2196 = 2025-06-09 .. 2025-06-11 (Mon, Tue); June 2025 = 30 days.
    const c = synthChunk('start', '1h', 2196, { '202506': { s1: 30 * 24 * 100 } })
    const b = (hash01('s1') - 0.5) * 0.5
    expect(c.ids).toEqual(['s1'])
    expect(c.counts).toEqual(new Uint32Array(48).fill(Math.round(100 * 1.12 * (1 + b))))
  })
})

describe('station table + frame assembly', () => {
  const table = buildStationTable({ b: { lat: 1, lng: 2 }, a: { name: 'A', lat: 3, lng: 4 } })
  test('buildStationTable', () => {
    expect(table).toEqual({
      ids: ['a', 'b'], index: new Map([['a', 0], ['b', 1]]), names: ['A', 'b'], positions: new Float64Array([4, 3, 2, 1]),
    })
  })
  test('chunkIndexMap + accumulateFrame', () => {
    const chunk = pivotRows('start', '1d', 0, [
      { id: 'a', frame: 0, count: 5 }, { id: 'x', frame: 0, count: 7 }, { id: 'b', frame: 1, count: 1 },
    ], 'shard')
    const map = chunkIndexMap(chunk, table)
    expect(map).toEqual(new Int32Array([0, 1, -1]))
    const out = new Float32Array(2)
    expect(accumulateFrame(out, frameSlice(chunk, 0)!, map, 0.5)).toBe(7)
    expect(out).toEqual(new Float32Array([2.5, 0]))
  })
})

describe('flow preset styling', () => {
  test('divergingRgb / netShare / flowRadius', () => {
    expect(divergingRgb(0)).toEqual([150, 150, 150])
    expect(divergingRgb(1)).toEqual([235, 80, 30])
    expect(divergingRgb(-1)).toEqual([56, 120, 220])
    expect(divergingRgb(0.5)).toEqual([193, 115, 90])
    expect(netShare(1, 0)).toBe(0.25)
    expect(netShare(10, 10)).toBe(0)
    expect(flowRadius(0, '1d')).toBe(1.5)
    expect(flowRadius(1000, '1d')).toBe(11)
    expect(flowRadius(250, '1d')).toBe(6.5)
  })
  test('flowAttributes', () => {
    expect(flowAttributes(new Float32Array([1000, 0]), new Float32Array([0, 0]), '1d')).toEqual({
      radius: new Float32Array([11, 1.5]),
      color: new Uint8Array([235, 80, 30, 190, 150, 150, 150, 70]),
    })
  })
})

describe('YYMMDD / YYMMDDTHH codecs', () => {
  test('parseYmd / formatYmd', () => {
    expect(parseYmd('250609')).toBe(D(2025, 6, 9))
    expect(parseYmd('2506')).toBeNull()
    expect(parseYmd('251301')).toBeNull()
    expect(formatYmd(D(2025, 6, 9))).toBe('250609')
  })
  test('parseT / formatT', () => {
    expect(parseT('250610')).toBe(D(2025, 6, 10))
    expect(parseT('250610T08')).toBe(D(2025, 6, 10, 8))
    expect(parseT('250610T24')).toBeNull()
    expect(parseT('250610T8')).toBeNull()
    expect(formatT(D(2025, 6, 10))).toBe('250610')
    expect(formatT(D(2025, 6, 10, 8))).toBe('250610T08')
  })
})
