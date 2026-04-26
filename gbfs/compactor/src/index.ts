/**
 * GBFS hourly compactor — Cloudflare Worker with cron trigger.
 *
 * On each fire (cron `5 * * * *`), compacts the previous UTC hour's
 * per-minute WAL JSONs into a single parquet shard:
 *
 *   gbfs/status/YYYY-MM-DD/HH-MM.json   (n0, ~580 KB / file × ≤60)
 *      ↓
 *   gbfs/avail/h1/YYYY-MM-DD/HH.parquet  (h1)
 *
 * Schema mirrors `compact-r2.py`'s daily compaction so downstream readers
 * (`gbfs/api`) see one consistent format across tiers:
 *   station_id   STRING
 *   ts           INT64    (GBFS last_updated)
 *   polled_at    INT64    (our poll time)
 *   num_*        INT32    (daily compaction uses INT16, but hyparquet-writer
 *   is_*         INT32     has no INT16; Snappy handles the high-zero bytes
 *                          and `parquetReadObjects` returns plain numbers
 *                          either way)
 *   last_reported INT64
 *
 * Idempotent: re-runs overwrite the same h1 key. Manual trigger:
 *
 *   GET /compact?date=YYYY-MM-DD&hour=HH
 *
 * Useful for backfill or testing.
 */

interface StationRow {
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

interface Snapshot {
	ts: number;
	polled_at: number;
	stations: StationRow[];
}

interface Env {
	R2: R2Bucket;
}

const INT16_COLS = [
	'num_bikes_available',
	'num_ebikes_available',
	'num_docks_available',
	'num_bikes_disabled',
	'num_docks_disabled',
	'is_installed',
	'is_renting',
	'is_returning',
] as const;

const INT64_COLS = ['ts', 'polled_at', 'last_reported'] as const;

function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

/** UTC date+hour of the hour that *just ended* (1h before `now`). */
export function targetHour(now: Date): { date: string; hour: string } {
	const t = new Date(now.getTime() - 60 * 60 * 1000);
	const date = `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
	const hour = pad2(t.getUTCHours());
	return { date, hour };
}

/** R2 prefix for the per-minute JSONs of a given (date, hour). */
function statusPrefix(date: string, hour: string): string {
	return `gbfs/status/${date}/${hour}-`;
}

/** Output key for the h1 parquet shard. */
function h1Key(date: string, hour: string): string {
	return `gbfs/avail/h1/${date}/${hour}.parquet`;
}

/**
 * List all minute-JSON keys under `gbfs/status/<date>/<hour>-*.json`. R2's
 * prefix listing is what we need; the trailing `MM.json` filter is implicit
 * in the prefix when we use `gbfs/status/<date>/<hour>-`.
 */
async function listMinuteKeys(r2: R2Bucket, date: string, hour: string): Promise<string[]> {
	const prefix = statusPrefix(date, hour);
	const keys: string[] = [];
	let cursor: string | undefined;
	while (true) {
		const result = await r2.list({ prefix, cursor, limit: 1000 });
		for (const obj of result.objects) {
			if (obj.key.endsWith('.json')) keys.push(obj.key);
		}
		if (!result.truncated) break;
		cursor = result.cursor;
	}
	return keys.sort();
}

/** Fetch + parse one WAL JSON. Returns `null` if the object is missing/corrupt. */
async function readSnapshot(r2: R2Bucket, key: string): Promise<Snapshot | null> {
	const obj = await r2.get(key);
	if (!obj) return null;
	try {
		return JSON.parse(await obj.text()) as Snapshot;
	} catch (err) {
		console.warn(`Bad JSON at ${key}: ${err}`);
		return null;
	}
}

interface ColumnData {
	name: string;
	data: (string | number | bigint | null)[];
	type: 'STRING' | 'INT32' | 'INT64';
}

/**
 * Pivot a flat list of (snapshot × station) rows into columnar arrays
 * matching the daily-compaction parquet schema.
 *
 * Sorted by (ts, station_id) for deterministic output and cheap row-group
 * min/max stats on `ts`.
 */
export function buildColumnData(snapshots: Snapshot[]): ColumnData[] {
	const flatRows: (StationRow & { ts: number; polled_at: number })[] = [];
	for (const snap of snapshots) {
		for (const s of snap.stations) {
			flatRows.push({ ...s, ts: snap.ts, polled_at: snap.polled_at });
		}
	}
	flatRows.sort((a, b) =>
		a.ts !== b.ts ? a.ts - b.ts : a.station_id < b.station_id ? -1 : a.station_id > b.station_id ? 1 : 0,
	);

	const n = flatRows.length;
	const stationIds = new Array<string>(n);
	const ts = new Array<bigint>(n);
	const polledAt = new Array<bigint>(n);
	const lastReported = new Array<bigint>(n);
	const int32: Record<string, number[]> = {};
	for (const c of INT16_COLS) int32[c] = new Array<number>(n);

	for (let i = 0; i < n; i++) {
		const r = flatRows[i];
		stationIds[i] = r.station_id;
		ts[i] = BigInt(r.ts);
		polledAt[i] = BigInt(r.polled_at);
		lastReported[i] = BigInt(r.last_reported ?? 0);
		for (const c of INT16_COLS) int32[c][i] = (r[c] ?? 0) | 0;
	}

	return [
		{ name: 'station_id', data: stationIds, type: 'STRING' },
		{ name: 'ts', data: ts, type: 'INT64' },
		{ name: 'polled_at', data: polledAt, type: 'INT64' },
		...INT16_COLS.map((c) => ({ name: c, data: int32[c], type: 'INT32' as const })),
		{ name: 'last_reported', data: lastReported, type: 'INT64' },
	];
}

/** Build a parquet buffer from snapshots. Returns `null` if there are no rows. */
async function snapshotsToParquet(snapshots: Snapshot[]): Promise<ArrayBuffer | null> {
	if (snapshots.length === 0) return null;
	const columnData = buildColumnData(snapshots);
	if (columnData[0].data.length === 0) return null;

	const { parquetWriteBuffer } = await import('hyparquet-writer');
	// codec defaults to 'SNAPPY'; statistics on by default → free dt-index on (ts, polled_at).
	return parquetWriteBuffer({ columnData });
}

/** Compact one (date, hour) window. Returns the count of minutes compacted. */
export async function compactHour(r2: R2Bucket, date: string, hour: string): Promise<{ minutes: number; rows: number; bytes: number }> {
	const keys = await listMinuteKeys(r2, date, hour);
	if (keys.length === 0) {
		console.log(`No minute JSONs for ${date} hour ${hour}; skipping`);
		return { minutes: 0, rows: 0, bytes: 0 };
	}

	const results = await Promise.all(keys.map((k) => readSnapshot(r2, k)));
	const snapshots = results.filter((s): s is Snapshot => s !== null);
	const buf = await snapshotsToParquet(snapshots);
	if (!buf) {
		console.warn(`No rows for ${date} hour ${hour}; skipping write`);
		return { minutes: snapshots.length, rows: 0, bytes: 0 };
	}

	const outKey = h1Key(date, hour);
	await r2.put(outKey, buf, { httpMetadata: { contentType: 'application/octet-stream' } });
	const rows = snapshots.reduce((acc, s) => acc + s.stations.length, 0);
	console.log(`Compacted ${snapshots.length} minutes (${rows} rows, ${buf.byteLength} bytes) → ${outKey}`);
	return { minutes: snapshots.length, rows, bytes: buf.byteLength };
}

export default {
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const { date, hour } = targetHour(new Date(event.scheduledTime));
		ctx.waitUntil(
			compactHour(env.R2, date, hour).catch((err) =>
				console.error(`Compaction failed for ${date}/${hour}:`, err),
			),
		);
	},

	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/compact') {
			const date = url.searchParams.get('date');
			const hour = url.searchParams.get('hour');
			if (!date || !hour || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}$/.test(hour)) {
				return new Response('usage: /compact?date=YYYY-MM-DD&hour=HH\n', { status: 400 });
			}
			const result = await compactHour(env.R2, date, hour);
			return new Response(JSON.stringify({ date, hour, ...result }, null, 2) + '\n', {
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response('GBFS hourly compactor.\n  GET /compact?date=YYYY-MM-DD&hour=HH\n');
	},
} satisfies ExportedHandler<Env>;
