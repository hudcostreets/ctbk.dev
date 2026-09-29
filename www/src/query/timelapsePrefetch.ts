/**
 * Idle prefetch fan-out (`specs/timelapse-map.md` "Client cache and
 * prefetch" → "Idle fill"): a priority queue over chunk numbers ordered by
 * distance from the playhead's chunk — ±1, ±2, then every second chunk out to
 * ±6, then doubling — with ONE request in flight at a time, re-prioritized
 * whenever the playhead moves (a scrub or a chunk boundary during playback).
 * Pure scheduling: the fetch and the cache check are injected, so
 * `timelapse.ts` wires it to TanStack Query and the tests drive it with
 * hand-resolved promises.
 *
 * "Cancel" here means the not-yet-started queue is dropped and rebuilt; the
 * one request already in flight is left to finish (its chunk lands in the
 * cache and is useful wherever the playhead went — `ensureQueryData` has no
 * abort handle anyway).
 */

/** Fan-out distances up to `maxDist`: 1, 2, 4, 6, 8, 16, 32, … */
export function fanOutDistances(maxDist: number): number[] {
  const out: number[] = []
  for (const d of [1, 2, 4, 6]) if (d <= maxDist) out.push(d)
  for (let d = 8; d <= maxDist; d *= 2) out.push(d)
  return out
}

/** Chunk fetch order around `k` within `[kMin, kMax]`: `k` itself, then for
 *  each fan-out distance the forward chunk before the backward one (playback
 *  runs forward). Chunks outside the range are skipped. */
export function fanOutOrder(k: number, kMin: number, kMax: number): number[] {
  const out: number[] = []
  const push = (x: number) => { if (x >= kMin && x <= kMax && !out.includes(x)) out.push(x) }
  push(k)
  const maxDist = Math.max(kMax - k, k - kMin)
  for (const d of fanOutDistances(maxDist)) {
    push(k + d)
    push(k - d)
  }
  return out
}

export class PrefetchQueue {
  /** Chunk currently being fetched, if any. */
  inflight: number | null = null
  /** Chunks waiting, highest priority first. */
  pending: number[] = []
  private disposed = false

  constructor(
    private readonly fetch: (k: number) => Promise<unknown>,
    private readonly isCached: (k: number) => boolean,
  ) {}

  /** Replace the queue with `order` (minus what's cached or in flight) and
   *  start fetching if idle. */
  retarget(order: readonly number[]): void {
    if (this.disposed) return
    this.pending = order.filter((k) => k !== this.inflight && !this.isCached(k))
    this.pump()
  }

  /** Drop the queue; the in-flight request's completion is ignored. */
  dispose(): void {
    this.disposed = true
    this.pending = []
  }

  private pump(): void {
    if (this.disposed || this.inflight !== null) return
    const k = this.pending.shift()
    if (k === undefined) return
    this.inflight = k
    // Rejections are the cache's business (`chunkError`); the queue moves on.
    this.fetch(k).catch(() => {}).then(() => {
      this.inflight = null
      this.pump()
    })
  }
}
