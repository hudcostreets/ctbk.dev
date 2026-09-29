import { describe, expect, test } from 'vitest'
import { fanOutDistances, fanOutOrder, fillOrder, PrefetchQueue } from './timelapsePrefetch'

describe('fan-out order', () => {
  test('fanOutDistances: 1, 2, then every second chunk to 6, then doubling', () => {
    expect(fanOutDistances(0)).toEqual([])
    expect(fanOutDistances(1)).toEqual([1])
    expect(fanOutDistances(6)).toEqual([1, 2, 4, 6])
    expect(fanOutDistances(40)).toEqual([1, 2, 4, 6, 8, 16, 32])
  })
  test('fanOutOrder: playhead first, forward before back, clipped to the range', () => {
    expect(fanOutOrder(10, 0, 100)).toEqual([10, 11, 9, 12, 8, 14, 6, 16, 4, 18, 2, 26, 42, 74])
    expect(fanOutOrder(0, 0, 3)).toEqual([0, 1, 2])
    expect(fanOutOrder(5, 5, 5)).toEqual([5])
  })
  test('fillOrder: the fan-out, then every other chunk in the range by distance', () => {
    expect(fillOrder(10, 0, 20)).toEqual([
      10, 11, 9, 12, 8, 14, 6, 16, 4, 18, 2,
      13, 7, 15, 5, 17, 3, 19, 1, 20, 0,
    ])
    expect(fillOrder(0, 0, 3)).toEqual([0, 1, 2, 3])
    expect(fillOrder(5, 5, 5)).toEqual([5])
  })
})

/** A fetch whose completion the test controls per chunk. */
function controlled() {
  const calls: number[] = []
  const resolvers = new Map<number, () => void>()
  const fetch = (k: number) => {
    calls.push(k)
    return new Promise<void>((resolve) => resolvers.set(k, resolve))
  }
  const finish = async (k: number) => {
    resolvers.get(k)!()
    // Let `.catch().then()` + the next `pump` run.
    await new Promise((r) => setTimeout(r, 0))
  }
  return { calls, fetch, finish }
}

describe('PrefetchQueue', () => {
  test('one in flight; the next starts when the previous finishes', async () => {
    const { calls, fetch, finish } = controlled()
    const q = new PrefetchQueue(fetch, () => false)
    q.retarget([3, 4, 2])
    expect(calls).toEqual([3])
    expect(q.inflight).toEqual([3])
    expect(q.pending).toEqual([4, 2])
    await finish(3)
    expect(calls).toEqual([3, 4])
    await finish(4)
    await finish(2)
    expect(calls).toEqual([3, 4, 2])
    expect(q.inflight).toEqual([])
    expect(q.pending).toEqual([])
  })
  test('retarget replaces the queue but lets the in-flight request finish', async () => {
    const { calls, fetch, finish } = controlled()
    const q = new PrefetchQueue(fetch, () => false)
    q.retarget([3, 4, 2])
    q.retarget([9, 3, 10])
    expect(calls).toEqual([3])
    expect(q.pending).toEqual([9, 10])
    await finish(3)
    expect(calls).toEqual([3, 9])
  })
  test('cached chunks are skipped; a failed fetch doesn\'t stall the queue', async () => {
    const { calls, fetch, finish } = controlled()
    const cached = new Set([4])
    const failing = (k: number) => (k === 3 ? Promise.reject(new Error('boom')) : fetch(k))
    const q = new PrefetchQueue(failing, (k) => cached.has(k))
    q.retarget([3, 4, 5])
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([5])
    await finish(5)
    expect(q.inflight).toEqual([])
  })
  test('concurrency: up to N in flight, refilled as each finishes', async () => {
    const { calls, fetch, finish } = controlled()
    const q = new PrefetchQueue(fetch, () => false, 2)
    q.retarget([1, 2, 3, 4])
    expect(calls).toEqual([1, 2])
    expect(q.inflight).toEqual([1, 2])
    expect(q.pending).toEqual([3, 4])
    await finish(2)
    expect(calls).toEqual([1, 2, 3])
    expect(q.inflight).toEqual([1, 3])
    q.retarget([9, 1, 3, 8])
    expect(q.pending).toEqual([9, 8])
    await finish(1)
    expect(calls).toEqual([1, 2, 3, 9])
    expect(q.inflight).toEqual([3, 9])
  })
  test('dispose drops the queue and ignores the in-flight completion', async () => {
    const { calls, fetch, finish } = controlled()
    const q = new PrefetchQueue(fetch, () => false)
    q.retarget([1, 2])
    q.dispose()
    await finish(1)
    q.retarget([7])
    expect(calls).toEqual([1])
    expect(q.pending).toEqual([])
  })
})
