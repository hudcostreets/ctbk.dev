/**
 * GBFS station status poller — Cloudflare Worker with cron trigger.
 *
 * Fetches Citi Bike station_status.json every minute, writes per-minute
 * JSON snapshots to R2. Daily compaction to parquet is handled by GHA
 * (gbfs-compact.yml) using compact-r2.py.
 *
 * R2 layout:
 *   gbfs/status/YYYY-MM-DD/HH-MM.json     — per-minute WAL snapshots (JSON)
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

const STATUS_URL = 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_status.json';
const INFO_URL = 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json';

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
	return slim as unknown as StationStatus;
}

async function pollStatus(bucket: R2Bucket): Promise<void> {
	const now = new Date();
	const resp = await fetch(STATUS_URL);
	if (!resp.ok) throw new Error(`station_status fetch failed: ${resp.status}`);

	const data = (await resp.json()) as StatusResponse;
	const ts = data.last_updated;
	const stations = data.data.stations.map(slimStation);

	const record: MinuteRecord = {
		ts,
		polled_at: Math.floor(now.getTime() / 1000),
		stations,
	};

	const jsonKey = `gbfs/status/${utcDateStr(now)}/${utcTimeStr(now)}.json`;
	await bucket.put(jsonKey, JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
	});
	console.log(`Polled ${stations.length} stations, ts=${ts} → ${jsonKey}`);
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
			await pollStatus(env.BUCKET);
			await pollInfo(env.BUCKET);
			return new Response('OK\n');
		}
		return new Response('GBFS poller.\n  GET /poll — trigger poll\n');
	},
} satisfies ExportedHandler<Env>;
