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
 * parquet write is being moved to a decoupled R2-event consumer; helpers
 * (buildMinuteShard, buildMinuteParquet) remain exported for that
 * consumer's use.
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
	return slim as unknown as StationStatus;
}

/**
 * 1m@1m monoid shard: per-(station, minute-bucket) row, sortable by
 * (station_id, dt) so per-station readers can prune via parquet's
 * row-group min/max stats on `station_id`. Per-metric columns are flat
 * (`<metric>_n`, `<metric>_sum`, `<metric>_sum_sq`) so callers projecting
 * a single metric only decode 3 cols out of 17.
 *
 * v1 schema defers `samples: LIST<DOUBLE>` (top-K/bot-K outlier signal
 * per spec) — adding it later is non-breaking since readers project by
 * column. See specs/avail-perf-pass.md § "Monoid schema".
 *
 * For the cron path n=1 per row (one poll per minute): sum=value,
 * sum_sq=value², which the cascade compactor merges by simple addition
 * into higher cons levels.
 */
const AVAIL_METRICS = [
	{ name: 'bikes',    src: 'num_bikes_available'  as const },
	{ name: 'ebikes',   src: 'num_ebikes_available' as const },
	{ name: 'docks',    src: 'num_docks_available'  as const },
	{ name: 'disabled', src: 'num_bikes_disabled'   as const },
	{ name: 'pending',  src: 'num_docks_disabled'   as const },
] as const;

interface ColumnSource {
	name: string;
	data: (string | number | bigint)[];
	type: 'STRING' | 'INT32' | 'INT64' | 'DOUBLE';
}

interface MinuteRecord {
	ts: number;
	polled_at: number;
	stations: StationStatus[];
}

/** Build columnar data for one 1m@1m shard. Sorts by station_id so
 *  per-station queries can prune by row-group station_id stats. */
export function buildMinuteShard(record: MinuteRecord): ColumnSource[] {
	const stations = [...record.stations].sort((a, b) =>
		a.station_id < b.station_id ? -1 : a.station_id > b.station_id ? 1 : 0,
	);
	const n = stations.length;
	const dt = BigInt(Math.floor(record.polled_at / 60) * 60);

	const stationIds: string[] = new Array(n);
	const dts: bigint[] = new Array(n);
	const perMetric: Record<string, { n: number[]; sum: number[]; sum_sq: number[] }> = {};
	for (const m of AVAIL_METRICS) {
		perMetric[m.name] = { n: new Array(n), sum: new Array(n), sum_sq: new Array(n) };
	}

	for (let i = 0; i < n; i++) {
		const s = stations[i];
		stationIds[i] = s.station_id;
		dts[i] = dt;
		for (const m of AVAIL_METRICS) {
			const v = s[m.src] ?? 0;
			perMetric[m.name].n[i] = 1;
			perMetric[m.name].sum[i] = v;
			perMetric[m.name].sum_sq[i] = v * v;
		}
	}

	const cols: ColumnSource[] = [
		{ name: 'station_id', data: stationIds, type: 'STRING' },
		{ name: 'dt',         data: dts,        type: 'INT64'  },
	];
	for (const m of AVAIL_METRICS) {
		cols.push({ name: `${m.name}_n`,      data: perMetric[m.name].n,      type: 'INT32'  });
		cols.push({ name: `${m.name}_sum`,    data: perMetric[m.name].sum,    type: 'DOUBLE' });
		cols.push({ name: `${m.name}_sum_sq`, data: perMetric[m.name].sum_sq, type: 'DOUBLE' });
	}
	return cols;
}

async function buildMinuteParquet(record: MinuteRecord): Promise<ArrayBuffer | null> {
	const cols = buildMinuteShard(record);
	if (cols[0].data.length === 0) return null;
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	// rowGroupSize=600 ≈ 10 stations/rg — same profile the h1 compactor
	// settled on (specs/done/h1-stats-fix.md). Keeps station_id min/max
	// stats useful for pruning while bounding rg-count to a low single
	// digit per shard (~2400 stations → ~4 rgs).
	return parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
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
