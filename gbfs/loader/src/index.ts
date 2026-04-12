/**
 * GBFS loader — Cloudflare Worker queue consumer.
 *
 * Triggered by R2 PutObject events on `gbfs/status/YYYY-MM-DD/HH-MM.json`.
 * Reads the JSON, parses ~2,360 station rows, batch-INSERTs into D1
 * `availability_YYYYMMDD` table (created on demand).
 */

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

interface Snapshot {
	ts: number;
	polled_at: number;
	stations: StationStatus[];
}

// R2 event message shape (Cloudflare Queues delivers these for R2 notifications)
interface R2EventMessage {
	account: string;
	bucket: string;
	object: { key: string; size: number; eTag: string };
	action: string;
	eventTime: string;
}

interface Env {
	BUCKET: R2Bucket;
	DB: D1Database;
}

const COLS = [
	'station_id', 'ts', 'polled_at',
	'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
	'num_bikes_disabled', 'num_docks_disabled',
	'is_installed', 'is_renting', 'is_returning', 'last_reported',
];

/** Extract YYYY-MM-DD from an object key like "gbfs/status/2026-04-12/00-15.json". */
function dateFromKey(key: string): string | null {
	const m = key.match(/^gbfs\/status\/(\d{4}-\d{2}-\d{2})\/\d{2}-\d{2}\.json$/);
	return m ? m[1] : null;
}

function tableNameForDate(dateStr: string): string {
	return `availability_${dateStr.replace(/-/g, '')}`;
}

async function ensureTable(db: D1Database, dateStr: string): Promise<string> {
	const table = tableNameForDate(dateStr);
	// CREATE TABLE IF NOT EXISTS — cheap if it already exists
	await db.exec(
		`CREATE TABLE IF NOT EXISTS ${table} (` +
		`station_id TEXT NOT NULL, ts INTEGER NOT NULL, polled_at INTEGER NOT NULL, ` +
		`num_bikes_available INTEGER NOT NULL, num_ebikes_available INTEGER NOT NULL, ` +
		`num_docks_available INTEGER NOT NULL, num_bikes_disabled INTEGER NOT NULL, ` +
		`num_docks_disabled INTEGER NOT NULL, is_installed INTEGER NOT NULL, ` +
		`is_renting INTEGER NOT NULL, is_returning INTEGER NOT NULL, last_reported INTEGER NOT NULL, ` +
		`PRIMARY KEY (station_id, ts))`
	);
	// Track in day_tables (idempotent)
	await db.prepare(
		`INSERT OR IGNORE INTO day_tables (date, table_name, created_at) VALUES (?, ?, ?)`
	).bind(dateStr, table, Math.floor(Date.now() / 1000)).run();
	return table;
}

async function insertSnapshot(db: D1Database, table: string, snap: Snapshot): Promise<void> {
	if (!snap.stations.length) return;

	// D1 limits variables per statement (~100). One row per statement (12 vars)
	// stays well under. Send all as a single batch for one round-trip.
	const sql = `INSERT OR REPLACE INTO ${table} (${COLS.join(',')}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
	const stmts = snap.stations.map((s) =>
		db.prepare(sql).bind(
			s.station_id, snap.ts, snap.polled_at,
			s.num_bikes_available, s.num_ebikes_available, s.num_docks_available,
			s.num_bikes_disabled, s.num_docks_disabled,
			s.is_installed, s.is_renting, s.is_returning, s.last_reported,
		)
	);
	await db.batch(stmts);
}

export default {
	async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
		const typed = batch as MessageBatch<R2EventMessage>;
		for (const msg of typed.messages) {
			try {
				const key = msg.body.object.key;
				const dateStr = dateFromKey(key);
				if (!dateStr) {
					console.log(`Ignoring non-WAL key: ${key}`);
					msg.ack();
					continue;
				}

				const obj = await env.BUCKET.get(key);
				if (!obj) {
					console.warn(`Object missing: ${key}`);
					msg.ack();
					continue;
				}

				const snap = JSON.parse(await obj.text()) as Snapshot;
				const table = await ensureTable(env.DB, dateStr);
				await insertSnapshot(env.DB, table, snap);

				console.log(`Loaded ${snap.stations.length} rows from ${key} → ${table}`);
				msg.ack();
			} catch (err) {
				console.error(`Failed to process ${msg.body?.object?.key}:`, err);
				msg.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
