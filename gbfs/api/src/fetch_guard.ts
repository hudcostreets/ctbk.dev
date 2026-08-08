/** Isolate-wide guard on concurrent footer-parsing shard fetches.
 *
 * hyparquet materializes each shard's full parquet footer as a large JS
 * object graph (7-8MB serialized → tens of MB parsed for the big rides
 * shards); a few concurrent parses blow the isolate's 128MB limit
 * (`outcome: exceededMemory`, which kills every in-flight request with a
 * CORS-less 503). Workers forbid resuming one request's I/O from another
 * request's context, so a queuing semaphore is structurally impossible
 * (it 1101s) — instead we LOAD-SHED: beyond the cap, callers get an
 * immediate CORS'd 503 + `Retry-After` and the client retries (TSQ's
 * default retry absorbs this).
 *
 * The RG-manifest path (`rg_manifest.ts`) never parses footers and
 * bypasses this guard entirely; only footer-fallback fetches count.
 */

// 1: even two concurrent parses OOM when both hit the ladder's biggest
// footers (observed: start+end anchors' 1d/1024d shards, 7.9MB footers
// each, killed the end request at cap 2; 12h/512d pairs survived — the
// margin at 2 was razor-thin). Cold requests just parse in sequence;
// once the RG manifest is filled for a key, this path never runs for it
// again.
export const FOOTER_FETCH_MAX_INFLIGHT = 1;
let footerFetchesInFlight = 0;

export class FetchBusyError extends Error {
	constructor() {
		super('busy: too many concurrent rides fetches');
		this.name = 'FetchBusyError';
	}
}

function takeSlot(): (() => void) | null {
	if (footerFetchesInFlight >= FOOTER_FETCH_MAX_INFLIGHT) return null;
	footerFetchesInFlight++;
	let released = false;
	return () => {
		if (!released) {
			released = true;
			footerFetchesInFlight--;
		}
	};
}

/** Acquire a footer-fetch slot, poll-waiting up to `timeoutMs` before
 *  throwing `FetchBusyError`. Returns a release fn — call in `finally`.
 *
 *  Polling a timer is safe where a queuing semaphore is not: the waiter
 *  resumes via its OWN request's timer, never via another request's
 *  promise resolution (which Workers kill with a 1101). A cold multi-
 *  segment request whose misses exceed the cap just parses footers in
 *  waves of `FOOTER_FETCH_MAX_INFLIGHT` instead of failing. */
export async function acquireFooterSlot(timeoutMs = 15_000): Promise<() => void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const release = takeSlot();
		if (release) return release;
		if (Date.now() >= deadline) throw new FetchBusyError();
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

export function busyResponse(cors: string | null): Response {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Retry-After': '2',
	};
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	return new Response(JSON.stringify({ error: 'busy: too many concurrent rides fetches' }), { status: 503, headers });
}
