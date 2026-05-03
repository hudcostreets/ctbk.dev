/**
 * GBFS loader — Cloudflare Worker queue consumer.
 *
 * Triggered by R2 PutObject events on `gbfs/status/*` and `gbfs/info/*`,
 * delivered via the `gbfs-status-events` queue.
 *
 * Per-minute availability (`gbfs/status/<date>/HH-MM.json`):
 *   - Build the 1m@1m monoid parquet shard and write it to
 *     `avail/agg=1m/cons=1m/<date>/HHMM.parquet`. (avail-perf-pass
 *     Phase 0; was inline in the cron worker until 609512e9, where
 *     it correlated with ~10% cron-tick loss — see worker docstring.)
 *
 * Daily station_information (`gbfs/info/<date>.json`):
 *   - Upsert into D1's `stations` metadata table (low-volume, used for
 *     slug/name/region lookups).
 *
 * Per-minute availability is no longer cached in D1 (the
 * `availability_YYYYMMDD` table was retired in P3 of
 * `specs/gbfs-r2-only.md`); the api worker reads from R2 directly.
 */

import {
	AVAIL_1M_ROW_GROUP_SIZE,
	availParquetKeyFromStatusKey,
	buildMinuteShard,
	type MinuteRecord,
} from '../../lib/avail-monoid';

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

/** Build + write the 1m@1m parquet shard for a per-minute availability JSON.
 *  Idempotent: re-deliveries overwrite with byte-identical output. */
async function writeAvailShard(bucket: R2Bucket, statusKey: string): Promise<void> {
	const obj = await bucket.get(statusKey);
	if (!obj) {
		// R2 PutObject event may arrive before the object is globally readable
		// in extreme cases; treat as transient and let the queue retry.
		throw new Error(`status object missing: ${statusKey}`);
	}
	const record = (await obj.json()) as MinuteRecord;
	const cols = buildMinuteShard(record);
	if (cols[0].data.length === 0) {
		console.warn(`empty status (no stations): ${statusKey}`);
		return;
	}
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize: AVAIL_1M_ROW_GROUP_SIZE });
	const pqKey = availParquetKeyFromStatusKey(statusKey);
	await bucket.put(pqKey, buf, {
		httpMetadata: { contentType: 'application/octet-stream' },
	});
	console.log(`Wrote 1m@1m shard (${buf.byteLength} bytes, ${cols[0].data.length} rows) → ${pqKey}`);
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
	async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
		const typed = batch as MessageBatch<R2EventMessage>;
		for (const msg of typed.messages) {
			try {
				const key = msg.body.object.key;

				// Per-minute availability JSON — write the 1m@1m parquet
				// shard. msg.retry() (in the outer catch) puts the message
				// back; max_retries in wrangler.toml caps the attempt count.
				if (isAvailKey(key)) {
					await writeAvailShard(env.BUCKET, key);
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
