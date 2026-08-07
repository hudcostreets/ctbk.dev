/**
 * Bounded retry for transient R2 binding errors.
 *
 * R2 occasionally fails a read with an internal error — observed in prod
 * (2026-07-15) as `get: We encountered an internal error. Please try
 * again. (10001)` — which previously propagated straight to a user-facing
 * HTTP 500. The same request succeeds on immediate retry. R2 binding
 * errors carry no structured code, so transience is detected from the
 * message text.
 */
import type { Storage } from 'pyrmts';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [100, 400];

function isTransient(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes('(10001)')
		|| msg.includes('internal error')
		|| msg.includes('Please try again')
		// R2 `get(key, {range})` intermittently returns null for keys that
		// verifiably exist (observed 2026-08-07: rides-v5 shards present on
		// R2 + registered in D1, ~3/8 requests failing). Inventory-driven
		// serving only fetches registered shards, so not-found is far more
		// likely R2 flaking than a real gap — retry; a genuinely-missing
		// shard just burns two quick retries before the same 500.
		|| msg.includes('object not found');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withR2Retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 400);
		try {
			return await fn();
		} catch (err) {
			if (!isTransient(err)) throw err;
			lastErr = err;
			console.warn(`r2-retry: ${label} attempt ${attempt + 1}/${MAX_ATTEMPTS} failed transiently:`, err instanceof Error ? err.message : err);
		}
	}
	throw lastErr;
}

/** Wrap a pyrmts `Storage`'s read methods with `withR2Retry`. Writes and
 *  `list` (an async generator — a retry there could double-yield) pass
 *  through untouched. */
export function retryingStorage(storage: Storage): Storage {
	return {
		...storage,
		head: (key) => withR2Retry(`head ${key}`, () => storage.head(key)),
		get: (key) => withR2Retry(`get ${key}`, () => storage.get(key)),
		getRange: (key, start, end) => withR2Retry(`getRange ${key}`, () => storage.getRange(key, start, end)),
	};
}
