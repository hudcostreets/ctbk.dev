/**
 * GBFS station status poller — Cloudflare Worker with cron trigger.
 *
 * Fetches Citi Bike station_status.json every minute, writes per-minute
 * JSON snapshots to R2 plus a 1m@1m parquet shard (Phase 0 of the
 * multi-scale grid; see specs/avail-perf-pass.md). Daily compaction to
 * parquet is handled by GHA (gbfs-compact.yml) using compact-r2.py.
 *
 * R2 layout:
 *   gbfs/status/YYYY-MM-DD/HH-MM.json     — per-minute WAL snapshots (JSON)
 *   avail/agg=1m/cons=1m/YYYY-MM-DD/HHMM.parquet — per-minute monoid shard
 *   gbfs/info/YYYY-MM-DD.json             — daily station_information
 *
 * JSON write is the durable record (cron tick succeeds even if parquet
 * write fails). Parquet is best-effort; the cascade compactor (TBD)
 * tolerates missing 1m@1m shards via existence-check barriers, and a
 * periodic backfill from JSON archive repairs any gaps.
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

function utcTimeStrCompact(d: Date): string {
	return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
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

async function pollStatus(bucket: R2Bucket, ctx?: ExecutionContext): Promise<void> {
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

	const dateStr = utcDateStr(now);
	const timeStr = utcTimeStr(now);
	const jsonKey = `gbfs/status/${dateStr}/${timeStr}.json`;

	// JSON is the durable write; parquet is best-effort. If parquet write
	// fails (e.g. hyparquet-writer regression, R2 hiccup), the cron tick
	// still succeeds and the JSON archive remains the source of truth.
	await bucket.put(jsonKey, JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
	});
	console.log(`Polled ${stations.length} stations, ts=${ts} → ${jsonKey}`);

	const pqKey = `avail/agg=1m/cons=1m/${dateStr}/${utcTimeStrCompact(now)}.parquet`;
	const pqWrite = (async () => {
		const buf = await buildMinuteParquet(record);
		if (!buf) return;
		await bucket.put(pqKey, buf, {
			httpMetadata: { contentType: 'application/octet-stream' },
		});
		console.log(`Wrote 1m@1m shard (${buf.byteLength} bytes) → ${pqKey}`);
	})().catch((err) => {
		console.warn(`1m@1m parquet write failed for ${pqKey}: ${err}`);
	});
	if (ctx) ctx.waitUntil(pqWrite);
	else await pqWrite;
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
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(pollStatus(env.BUCKET, ctx));
		ctx.waitUntil(pollInfo(env.BUCKET));
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/poll') {
			await pollStatus(env.BUCKET, ctx);
			await pollInfo(env.BUCKET);
			return new Response('OK\n');
		}
		return new Response('GBFS poller.\n  GET /poll — trigger poll\n');
	},
} satisfies ExportedHandler<Env>;
