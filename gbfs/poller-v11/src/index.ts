/**
 * GBFS 1.1 side-poller — an independent stack beside the 2.3 primary
 * (`gbfs/worker`), for a few weeks' comparison (2026-09-26).
 *
 * The 2.3 feed loses ~1 LU per ~13 min: its first-seen lag saws 0→60s and
 * each wrap skips a generation (WAL holes). 1.1 is a separate generation
 * (stamped ~:01 vs 2.3's ~:48; its content is ~10s newer by max
 * `last_reported`), and in probes showed steady lag and no skips. This
 * stack records it so we can measure whether 1.1 fills 2.3's holes and
 * whether it's worth merging into the normalized series.
 *
 * Two URLs serve 1.1 station_status — Lyft's (what Citi Bike's discovery
 * advertises) and the legacy `gbfs.citibikenyc.com` alias. Identical
 * content in probes, different lag. Each LU is saved once:
 *
 *   gbfs/probe/v11/YYYY-MM-DD/HH-MM.json          full snapshot, by the first
 *                                                  source to see the LU
 *   gbfs/probe/v11-alt/<src>/YYYY-MM-DD/HH-MM.json full snapshot from a source
 *                                                  whose content differed
 *   gbfs/probe/v11-obs/<src>/YYYY-MM-DD/HH-MM.json per-source sighting
 *                                                  {ts, polled_at, hash, full}
 *   gbfs/probe/v11-err/<src>/YYYY-MM-DD/HH-MM.json a source failed every
 *                                                  sample in a tick
 *   gbfs/probe/v11-heartbeat/YYYY-MM-DD/HH-MM.txt  cron-fire trace
 *
 * Keys use the LU minute, like the primary. Nothing here is under
 * `gbfs/status/`, so the loader's R2-event queue never sees it.
 */

export const SOURCES = {
	lyft: 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json',
	cb: 'https://gbfs.citibikenyc.com/gbfs/en/station_status.json',
} as const;
export type Source = keyof typeof SOURCES;

// 1.1's lag has been steady (each LU live ≥45s), so 15s sampling catches
// every LU with margin; 4 samples/tick/source.
const SAMPLE_INTERVAL_MS = 15_000;
const SAMPLE_WINDOW_MS = 57_000;

const KEEP_COLS = [
	'station_id',
	'num_bikes_available',
	'num_ebikes_available',
	'num_docks_available',
	'num_bikes_disabled',
	'num_docks_disabled',
	'is_installed',
	'is_renting',
	'is_returning',
	'last_reported',
] as const;

interface StatusResponse {
	last_updated: number;
	data: { stations: Record<string, unknown>[] };
}

export interface Env {
	BUCKET: R2Bucket;
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const utcDateStr = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const utcTimeStr = (d: Date) => `${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}`;
const minutePath = (epochS: number) => {
	const d = new Date(epochS * 1000);
	return `${utcDateStr(d)}/${utcTimeStr(d)}`;
};

function slim(s: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const col of KEEP_COLS) out[col] = s[col] ?? 0;
	return out;
}

async function contentHash(stations: Record<string, unknown>[]): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stations)));
	return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Per-isolate: last LU seen per source, and the content hash of each
 *  recently saved LU (the R2 object's `customMetadata.hash` backs it up
 *  across cold starts). */
const lastLu: Record<Source, number> = { lyft: 0, cb: 0 };
const savedHash = new Map<number, string>();

/** Handle one fetched document from `src`: on a new LU, record the
 *  sighting, and save the snapshot unless an identical one (same LU,
 *  same content) is already saved. Returns true if anything was written. */
export async function observe(bucket: R2Bucket, src: Source, doc: StatusResponse, polledAt: number): Promise<boolean> {
	const lu = doc.last_updated;
	if (lu <= lastLu[src]) return false;
	const stations = doc.data.stations.map(slim);
	const hash = await contentHash(stations);
	const path = minutePath(lu);
	const fullKey = `gbfs/probe/v11/${path}.json`;

	let prior = savedHash.get(lu);
	if (prior === undefined) {
		const head = await bucket.head(fullKey);
		const h = head?.customMetadata?.hash;
		// Same minute key but a different LU (cadence jitter) is not "saved".
		if (h && head?.customMetadata?.ts === String(lu)) prior = h;
	}
	let full = false;
	const record = JSON.stringify({ ts: lu, polled_at: polledAt, src, hash, stations });
	if (prior === undefined) {
		await bucket.put(fullKey, record, {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: { hash, ts: String(lu), src },
		});
		savedHash.set(lu, hash);
		full = true;
	} else if (prior !== hash) {
		await bucket.put(`gbfs/probe/v11-alt/${src}/${path}.json`, record, {
			httpMetadata: { contentType: 'application/json' },
		});
		full = true;
	}
	await bucket.put(
		`gbfs/probe/v11-obs/${src}/${path}.json`,
		JSON.stringify({ ts: lu, polled_at: polledAt, hash, full }),
		{ httpMetadata: { contentType: 'application/json' } },
	);
	lastLu[src] = lu;
	for (const k of savedHash.keys()) if (k < lu - 600) savedHash.delete(k);
	console.log(`${src}: LU=${lu} (+${polledAt - lu}s) hash=${hash}${full ? ' saved' : ' dup'}`);
	return true;
}

async function fetchStatus(src: Source): Promise<StatusResponse> {
	const resp = await fetch(SOURCES[src]);
	if (!resp.ok) throw new Error(`${src} ${resp.status}`);
	return (await resp.json()) as StatusResponse;
}

/** Cron-tick body: sample both sources every SAMPLE_INTERVAL_MS; results
 *  are observed sequentially (lyft, then cb) so a same-sample duplicate
 *  sees the first's saved hash. A source that fails every sample of the
 *  tick gets an error marker. */
export async function pollTick(bucket: R2Bucket, scheduledTime: number, fetcher = fetchStatus): Promise<void> {
	const t0 = Date.now();
	const errors: Record<Source, string[]> = { lyft: [], cb: [] };
	const ok: Record<Source, number> = { lyft: 0, cb: 0 };
	const srcs = Object.keys(SOURCES) as Source[];
	let samples = 0;
	while (Date.now() - t0 < SAMPLE_WINDOW_MS) {
		samples++;
		const polledAt = Math.floor(Date.now() / 1000);
		const results = await Promise.allSettled(srcs.map((s) => fetcher(s)));
		for (const [i, src] of srcs.entries()) {
			const r = results[i];
			if (r.status === 'rejected') {
				errors[src].push(String(r.reason));
				continue;
			}
			ok[src]++;
			try {
				await observe(bucket, src, r.value, polledAt);
			} catch (e) {
				errors[src].push(`write: ${e}`);
			}
		}
		const wait = t0 + samples * SAMPLE_INTERVAL_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	}
	const path = minutePath(Math.floor(scheduledTime / 1000));
	for (const src of srcs) {
		if (ok[src] === 0 && errors[src].length) {
			await bucket.put(
				`gbfs/probe/v11-err/${src}/${path}.json`,
				JSON.stringify({ scheduled: scheduledTime, samples, errors: errors[src].slice(0, 5) }),
				{ httpMetadata: { contentType: 'application/json' } },
			);
			console.warn(`${src}: all ${samples} samples failed: ${errors[src][0]}`);
		}
	}
}

export default {
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const path = minutePath(Math.floor(event.scheduledTime / 1000));
		ctx.waitUntil(env.BUCKET.put(`gbfs/probe/v11-heartbeat/${path}.txt`, 'ok\n'));
		ctx.waitUntil(pollTick(env.BUCKET, event.scheduledTime));
	},

	async fetch(): Promise<Response> {
		return new Response('GBFS 1.1 side-poller (cron only).\n');
	},
} satisfies ExportedHandler<Env>;

/** Test hook: reset per-isolate state. */
export function _reset(): void {
	lastLu.lyft = 0;
	lastLu.cb = 0;
	savedHash.clear();
}
