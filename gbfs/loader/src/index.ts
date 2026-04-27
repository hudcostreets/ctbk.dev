/**
 * GBFS loader — Cloudflare Worker queue consumer.
 *
 * Triggered by R2 PutObject events on `gbfs/status/*` and `gbfs/info/*`.
 *
 * Per-minute availability JSONs are now ignored — the api worker reads
 * availability directly from R2 (h1 shards + monthly parquet); the D1
 * `availability_YYYYMMDD` hot-cache has been retired (P3 of
 * `specs/gbfs-r2-only.md`).
 *
 * Daily station_information snapshots are still upserted into D1's
 * `stations` metadata table (low-volume, used for slug/name/region
 * lookups).
 */

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

/** Detect a per-minute availability snapshot key like "gbfs/status/2026-04-12/00-15.json". */
function isAvailKey(key: string): boolean {
	return /^gbfs\/status\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.json$/.test(key);
}

/** Detect a station_information snapshot key like "gbfs/info/2026-04-12.json". */
function isInfoKey(key: string): boolean {
	return /^gbfs\/info\/\d{4}-\d{2}-\d{2}\.json$/.test(key);
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

export default {
	async queue(batch: MessageBatch<unknown>, _env: Env, _ctx: ExecutionContext): Promise<void> {
		const typed = batch as MessageBatch<R2EventMessage>;
		for (const msg of typed.messages) {
			try {
				const key = msg.body.object.key;

				// Per-minute availability JSON — ack without touching D1.
				// Availability is now served from R2 (h1 shards + monthly parquet)
				// directly by the api worker; no hot-cache needed.
				if (isAvailKey(key)) {
					msg.ack();
					continue;
				}

				// Daily station_information snapshot
				if (isInfoKey(key)) {
					const obj = await _env.BUCKET.get(key);
					if (!obj) {
						console.warn(`Object missing: ${key}`);
						msg.ack();
						continue;
					}
					const info = JSON.parse(await obj.text()) as InfoResponse;
					const n = await upsertStationsInfo(_env.DB, info);
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
