/** In-memory API-request log backing the hidden DbgPanel (shift+d).
 *  `dbgFetch` is a drop-in `fetch` wrapper the query modules route their
 *  data requests through; each call lands in a ring buffer with latency +
 *  response metadata (X-Cache / X-Pyramid / Server-Timing, exposed by the
 *  api worker via Access-Control-Expose-Headers). Module-level on purpose:
 *  the log survives route changes and is read via `useSyncExternalStore`. */

export interface DbgReq {
  at: number            // epoch ms
  path: string          // e.g. /api/avail-v3
  params: string        // abbreviated query string
  ms: number            // client-observed wall time
  status: number        // 0 = network error
  xCache: string | null // 'HIT' | null (worker only sets it on hits)
  pyramid: string | null
  serverMs: number | null  // Server-Timing `worker;dur=`
  bytes: number | null
}

const CAP = 200
const reqs: DbgReq[] = []
let version = 0
const listeners = new Set<() => void>()

export function dbgSubscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function dbgVersion(): number { return version }
export function dbgReqs(): readonly DbgReq[] { return reqs }
export function dbgClear(): void {
  reqs.length = 0
  version++
  listeners.forEach((f) => f())
}

function push(r: DbgReq) {
  reqs.unshift(r)
  if (reqs.length > CAP) reqs.pop()
  version++
  listeners.forEach((f) => f())
}

function abbrevParams(url: URL): string {
  const parts: string[] = []
  url.searchParams.forEach((v, k) => {
    parts.push(`${k}=${v.length > 24 ? `${v.slice(0, 21)}…` : v}`)
  })
  const s = parts.join(' ')
  return s.length > 160 ? `${s.slice(0, 157)}…` : s
}

/** `fetch` wrapper: records latency + response metadata into the ring
 *  buffer, then returns the Response untouched. */
export async function dbgFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), window.location.origin)
  const base = {
    at: Date.now(),
    path: url.pathname,
    params: abbrevParams(url),
    pyramid: url.searchParams.get('pyramid'),
  }
  const t0 = performance.now()
  try {
    const res = await fetch(String(input), init)
    const dur = res.headers.get('Server-Timing')?.match(/dur=(\d+(?:\.\d+)?)/)
    push({
      ...base,
      ms: Math.round(performance.now() - t0),
      status: res.status,
      xCache: res.headers.get('X-Cache'),
      pyramid: res.headers.get('X-Pyramid') ?? base.pyramid,
      serverMs: dur ? Math.round(Number(dur[1])) : null,
      bytes: Number(res.headers.get('Content-Length')) || null,
    })
    return res
  } catch (e) {
    push({ ...base, ms: Math.round(performance.now() - t0), status: 0, xCache: null, serverMs: null, bytes: null })
    throw e
  }
}
