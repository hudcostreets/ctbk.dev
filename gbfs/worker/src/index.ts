/**
 * GBFS station status poller — Cloudflare Worker with cron trigger.
 *
 * Samples Citi Bike station_status.json every few seconds within each
 * minute tick, writing a JSON snapshot whenever the feed's
 * `last_updated` (LU) advances — WAL keys and `dt` attribution both use
 * the LU minute (specs/lu-attribution.md). Daily compaction to parquet
 * is handled by GHA (gbfs-compact.yml) using compact-r2.py.
 *
 * R2 layout:
 *   gbfs/status/YYYY-MM-DD/HH-MM.json     — per-LU-minute WAL snapshots (JSON)
 *   gbfs/heartbeat/YYYY-MM-DD/HH-MM.txt   — cron-fire trace (3 bytes/tick)
 *   gbfs/info/YYYY-MM-DD.json             — daily station_information
 *
 * Cron observability: heartbeat is the very first thing each tick writes,
 * so missing heartbeat ⇒ CF skipped the cron; heartbeat present + JSON
 * missing ⇒ pollStatus failed (fetch/put error).
 *
 * Note: an earlier revision (commit 6bf804a1) wrote a 1m@1m monoid parquet
 * shard inline alongside JSON. That added ~50–200 ms CPU + a sub-request
 * per tick and correlated with a ~10% drop in cron delivery
 * (2026-05-02 baseline 0/480; 2026-05-03 04–11 UTC 48/480 ≈ 10%). The
 * parquet write now happens in `gbfs/loader` (queue consumer for the
 * `gbfs/status/*` R2 PutObject events), fully decoupled from this cron.
 * Schema/monoid helpers live in `gbfs/lib/avail-monoid.ts`.
 */

// 2.3 for status: its CDN surfaces a new `last_updated` ~3-5s after the
// origin stamps it, vs the 1.1 URL's free-running ~60s cache (probe data
// in specs/lu-attribution.md). Info stays on 1.1 for now — its daily
// archive has downstream parsers and no freshness pressure; flip it
// deliberately, not as a side effect.
const STATUS_URL = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json';
const INFO_URL = 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json';

// Sub-minute sampling: LU advances every ~60s (stamped ~:05 past the
// minute, visible on the 2.3 CDN ~5s later); sampling every 6s for ~57s
// per cron tick catches each new LU ~≤10s after its stamp. Only LU
// *changes* are written, so steady-state R2 writes stay ~1/min.
const SAMPLE_INTERVAL_MS = 6_000;
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

import type { MinuteRecord, StationStatus } from '../../lib/avail-monoid';
// Re-export so this worker's existing test file can keep its import surface.
export { buildMinuteShard } from '../../lib/avail-monoid';

interface StatusResponse {
	last_updated: number;
	ttl: number;
	data: { stations: Record<string, unknown>[] };
}

interface Env {
	BUCKET: R2Bucket;
}

function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

function utcDateStr(d: Date): string {
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function utcTimeStr(d: Date): string {
	return `${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}`;
}

function slimStation(s: Record<string, unknown>): StationStatus {
	const slim: Record<string, unknown> = {};
	for (const col of KEEP_COLS) {
		slim[col] = s[col] ?? 0;
	}
	// 2.3 extra: per-type counts, compacted [{vehicle_type_id, count}] →
	// {id: count}. Inert for the minute-shard parquet (fixed columns);
	// recorded in the WAL for future per-type granularity.
	const vt = s['vehicle_types_available'];
	if (Array.isArray(vt)) {
		const m: Record<string, number> = {};
		for (const v of vt as { vehicle_type_id: string; count: number }[]) {
			m[v.vehicle_type_id] = v.count;
		}
		slim['vehicle_types_available'] = m;
	}
	return slim as unknown as StationStatus;
}

// Last LU written by this isolate. Cold starts reset it to 0 — the next
// sample then re-writes its LU's key, which is idempotent (same key,
// same content mod `polled_at`).
let lastLu = 0;

/** One sample: fetch the feed; if its LU is new, write the WAL record
 *  under the LU's minute key (`floor(LU/60)` — attribution and key agree;
 *  see specs/lu-attribution.md). Returns the LU when a write happened. */
async function sampleStatus(bucket: R2Bucket): Promise<number | null> {
	const polledAt = Math.floor(Date.now() / 1000);
	const resp = await fetch(STATUS_URL);
	if (!resp.ok) throw new Error(`station_status fetch failed: ${resp.status}`);

	const data = (await resp.json()) as StatusResponse;
	const lu = data.last_updated;
	if (lu <= lastLu) return null;

	const stations = data.data.stations.map(slimStation);
	const record: MinuteRecord = {
		ts: lu,
		polled_at: polledAt,
		stations,
	};

	const luDate = new Date(lu * 1000);
	const jsonKey = `gbfs/status/${utcDateStr(luDate)}/${utcTimeStr(luDate)}.json`;
	await bucket.put(jsonKey, JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
	});
	lastLu = lu;
	console.log(`Polled ${stations.length} stations, LU=${lu} (+${polledAt - lu}s) → ${jsonKey}`);
	return lu;
}

/** Cron-tick body: sample every SAMPLE_INTERVAL_MS across the minute,
 *  writing only on LU change. Individual fetch failures are logged and
 *  skipped — the next sample (or tick) retries. */
async function pollStatus(bucket: R2Bucket): Promise<void> {
	const t0 = Date.now();
	let writes = 0;
	let samples = 0;
	let lastErr: unknown = null;
	while (Date.now() - t0 < SAMPLE_WINDOW_MS) {
		samples++;
		try {
			if ((await sampleStatus(bucket)) !== null) writes++;
		} catch (e) {
			lastErr = e;
			console.warn(`sample ${samples} failed: ${e}`);
		}
		const next = t0 + samples * SAMPLE_INTERVAL_MS;
		const wait = next - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	}
	if (writes === 0 && lastErr !== null) throw lastErr;
	console.log(`tick: ${samples} samples, ${writes} LU writes`);
}

async function pollInfo(bucket: R2Bucket): Promise<void> {
	const now = new Date();
	const dateStr = utcDateStr(now);
	const key = `gbfs/info/${dateStr}.json`;

	// Check if already fetched today
	const existing = await bucket.head(key);
	if (existing) {
		console.log(`Station info already fetched today: ${key}`);
		return;
	}

	const resp = await fetch(INFO_URL);
	if (!resp.ok) throw new Error(`station_information fetch failed: ${resp.status}`);

	const data = await resp.arrayBuffer();
	await bucket.put(key, data, {
		httpMetadata: { contentType: 'application/json' },
	});

	console.log(`Saved station_information → ${key}`);
}

/** First action of every cron tick: write a 3-byte heartbeat to R2.
 *  Lets us distinguish "CF skipped the trigger" from "trigger fired but
 *  pollStatus failed" when JSON shards go missing. */
function writeHeartbeat(bucket: R2Bucket, scheduledTime: number): Promise<unknown> {
	const now = new Date(scheduledTime);
	const key = `gbfs/heartbeat/${utcDateStr(now)}/${utcTimeStr(now)}.txt`;
	return bucket.put(key, 'ok\n', { httpMetadata: { contentType: 'text/plain' } });
}

export default {
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(writeHeartbeat(env.BUCKET, event.scheduledTime));
		ctx.waitUntil(pollStatus(env.BUCKET));
		ctx.waitUntil(pollInfo(env.BUCKET));
	},

	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/poll') {
			// Single sample (not the full minute loop) — manual poke.
			const lu = await sampleStatus(env.BUCKET);
			await pollInfo(env.BUCKET);
			return new Response(lu === null ? 'OK (LU unchanged, no write)\n' : `OK (wrote LU ${lu})\n`);
		}
		return new Response('GBFS poller.\n  GET /poll — trigger poll\n');
	},
} satisfies ExportedHandler<Env>;
