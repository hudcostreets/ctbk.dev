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

/** Detect a station_information snapshot key like "gbfs/info/2026-04-12.json". */
function isInfoKey(key: string): boolean {
	return /^gbfs\/info\/\d{4}-\d{2}-\d{2}\.json$/.test(key);
}

interface InfoStation {
	station_id: string;       // GBFS UUID
	short_name?: string;
	name?: string;
	lat?: number;
	lon?: number;
	capacity?: number;
	station_type?: string;
}

interface InfoResponse {
	data: { stations: InfoStation[] };
}

/** Upsert all stations from a station_information snapshot.
 * Marks them in_gbfs=1 and updates GBFS-only fields. Preserves
 * tripdata-sourced fields via COALESCE in the conflict handler. */
async function upsertStationsInfo(db: D1Database, info: InfoResponse): Promise<number> {
	const now = Math.floor(Date.now() / 1000);
	const stmts = info.data.stations
		.filter((s) => s.short_name)  // need short_name as the join key
		.map((s) =>
			db.prepare(
				`INSERT INTO stations (short_name, gbfs_station_id, name, lat, lon, capacity, station_type, in_gbfs, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
				 ON CONFLICT(short_name) DO UPDATE SET
				   gbfs_station_id = excluded.gbfs_station_id,
				   name            = COALESCE(excluded.name, stations.name),
				   lat             = COALESCE(excluded.lat, stations.lat),
				   lon             = COALESCE(excluded.lon, stations.lon),
				   capacity        = COALESCE(excluded.capacity, stations.capacity),
				   station_type    = COALESCE(excluded.station_type, stations.station_type),
				   in_gbfs         = 1,
				   updated_at      = excluded.updated_at`
			).bind(
				s.short_name!,
				s.station_id,
				s.name ?? null,
				s.lat ?? null,
				s.lon ?? null,
				s.capacity ?? null,
				s.station_type ?? null,
				now,
			)
		);
	await db.batch(stmts);
	return stmts.length;
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

				// Per-minute availability JSON
				const dateStr = dateFromKey(key);
				if (dateStr) {
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
					continue;
				}

				// Daily station_information snapshot
				if (isInfoKey(key)) {
					const obj = await env.BUCKET.get(key);
					if (!obj) {
						console.warn(`Object missing: ${key}`);
						msg.ack();
						continue;
					}
					const info = JSON.parse(await obj.text()) as InfoResponse;
					const n = await upsertStationsInfo(env.DB, info);
					console.log(`Upserted ${n} stations from ${key}`);
					msg.ack();
					continue;
				}

				console.log(`Ignoring unknown key: ${key}`);
				msg.ack();
			} catch (err) {
				console.error(`Failed to process ${msg.body?.object?.key}:`, err);
				msg.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
