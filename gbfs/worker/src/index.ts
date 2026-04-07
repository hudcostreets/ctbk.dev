/**
 * GBFS station status poller — Cloudflare Worker with cron trigger.
 *
 * Fetches Citi Bike station_status.json every minute, writes per-minute
 * parquet-like snapshots to R2. A separate compaction step (or this worker
 * at midnight) consolidates daily WAL into a single file.
 *
 * R2 layout:
 *   gbfs/status/YYYY-MM-DD/HH-MM.json  — per-minute WAL snapshots
 *   gbfs/status/YYYY-MM-DD.json         — compacted daily file
 *   gbfs/info/YYYY-MM-DD.json           — daily station_information
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

interface StationStatus {
	station_id: string;
	num_bikes_available: number;
	num_ebikes_available: number;
	num_docks_available: number;
	num_bikes_disabled: number;
	num_docks_disabled: number;
	is_installed: number;
	is_renting: number;
	is_returning: number;
	last_reported: number;
}

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
	return slim as StationStatus;
}

async function pollStatus(bucket: R2Bucket): Promise<void> {
	const now = new Date();
	const resp = await fetch(STATUS_URL);
	if (!resp.ok) throw new Error(`station_status fetch failed: ${resp.status}`);

	const data = (await resp.json()) as StatusResponse;
	const ts = data.last_updated;
	const stations = data.data.stations.map(slimStation);

	const record = {
		ts,
		polled_at: Math.floor(now.getTime() / 1000),
		stations,
	};

	const dateStr = utcDateStr(now);
	const timeStr = utcTimeStr(now);
	const key = `gbfs/status/${dateStr}/${timeStr}.json`;

	await bucket.put(key, JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
	});

	console.log(`Polled ${stations.length} stations, ts=${ts} → ${key}`);
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

export default {
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(pollStatus(env.BUCKET));
		ctx.waitUntil(pollInfo(env.BUCKET));
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/poll') {
			await pollStatus(env.BUCKET);
			await pollInfo(env.BUCKET);
			return new Response('OK\n');
		}
		return new Response('GBFS poller. POST /poll to trigger manually.\n', { status: 200 });
	},
} satisfies ExportedHandler<Env>;
