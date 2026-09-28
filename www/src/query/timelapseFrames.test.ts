import { describe, expect, test } from 'vitest'
import {
  accumulateFrame, buildStationTable, chunkFrames, chunkFromBlocks, chunkIndexMap, chunkMs, chunkOf, chunksCovering,
  daysInMonth, divergingRgb, flowAttributes, flowRadius, formatYmd, frameIndex, frameSlice, frameStartMs, hash01,
  netShare, parseYmd, pickShards, pivotBlock, pivotRows, prefetchOrder, snapToCached, synthChunk, weekdayFactor, ymOf,
  type ManifestRow,
} from './timelapseFrames'

const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d)

describe('frame / chunk index math (1d, genesis 2013-06-01)', () => {
  test('frameIndex', () => {
    expect(frameIndex('1d', D(2013, 6, 1))).toBe(0)
    expect(frameIndex('1d', D(2013, 6, 2))).toBe(1)
    expect(frameIndex('1d', D(2013, 5, 31))).toBe(-1)
    expect(frameIndex('1d', D(2013, 6, 2) + 12 * 3_600_000)).toBe(1)
  })
  test('frameStartMs / chunkOf / chunkFrames / chunkMs', () => {
    expect(frameStartMs('1d', 32)).toBe(D(2013, 7, 3))
    expect(chunkOf('1d', 31)).toBe(0)
    expect(chunkOf('1d', 32)).toBe(1)
    expect(chunkFrames('1d', 2)).toEqual([64, 96])
    expect(chunkMs('1d', 1)).toEqual([D(2013, 7, 3), D(2013, 8, 4)])
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
      anchor: 'start', bin: '1d', chunk: 1, k: 32, i0: 32, n: 32, t0: D(2013, 7, 3),
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
      anchor: 'start', bin: '1d', chunk: 1, k: 32, i0: 32, n: 32, t0: D(2013, 7, 3),
      ids: ['a'], counts, totals, source: 'shard',
    })
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
    const c = synthChunk('start', '1d', 0, { '201306': { s1: 300 } })
    const b = (hash01('s1') - 0.5) * 0.5
    // June 2013 = 30 days → mean 10/day; 2013-06-01 is a Saturday.
    const expected = new Uint32Array(32)
    for (let f = 0; f < 30; f++) expected[f] = Math.round(10 * weekdayFactor((6 + f) % 7) * (1 + b))
    expect(c.ids).toEqual(['s1'])
    expect(c.source).toBe('synth')
    expect(c.counts).toEqual(expected)
    expect(Array.from(c.totals)).toEqual(Array.from(expected))
    expect(c.counts[0]).toBe(Math.round(7 * (1 + b)))
    expect(c.counts[2]).toBe(Math.round(11.2 * (1 + b)))
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

describe('YYMMDD codecs', () => {
  test('parseYmd / formatYmd', () => {
    expect(parseYmd('250609')).toBe(D(2025, 6, 9))
    expect(parseYmd('2506')).toBeNull()
    expect(parseYmd('251301')).toBeNull()
    expect(formatYmd(D(2025, 6, 9))).toBe('250609')
  })
})
