/**
 * GBFS API — Cloudflare Worker serving station availability queries.
 *
 * Endpoints:
 *   GET /api/stations/:id/today        — today's availability rows for one station
 *   GET /api/stations/:id/range?date=YYYY-MM-DD  — one specific day's rows
 *   GET /health                         — sanity check
 *
 * Reads from D1 `availability_YYYYMMDD` tables populated by the loader.
 */

interface Env {
	DB: D1Database;
	CORS_ORIGIN: string;
	HOT_DAYS_RETAIN: string;
}

const COLS = [
	'station_id', 'ts', 'polled_at',
	'num_bikes_available', 'num_ebikes_available', 'num_docks_available',
	'num_bikes_disabled', 'num_docks_disabled',
	'is_installed', 'is_renting', 'is_returning', 'last_reported',
];

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

function tableForDate(dateStr: string): string {
	return `availability_${dateStr.replace(/-/g, '')}`;
}

function corsHeaders(env: Env): HeadersInit {
	return {
		'Access-Control-Allow-Origin': env.CORS_ORIGIN,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Max-Age': '86400',
	};
}

function jsonResponse(data: unknown, env: Env, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=60',  // 1-min freshness
			...corsHeaders(env),
			...(init?.headers ?? {}),
		},
	});
}

function errorResponse(message: string, status: number, env: Env): Response {
	return jsonResponse({ error: message }, env, { status });
}

async function getStationDay(
	db: D1Database,
	stationId: string,
	dateStr: string,
	sincePolledAt: number | null = null,
): Promise<Record<string, unknown>[]> {
	const table = tableForDate(dateStr);
	try {
		const sql = sincePolledAt !== null
			? `SELECT ${COLS.join(',')} FROM ${table} WHERE station_id = ? AND polled_at > ? ORDER BY ts`
			: `SELECT ${COLS.join(',')} FROM ${table} WHERE station_id = ? ORDER BY ts`;
		const stmt = sincePolledAt !== null
			? db.prepare(sql).bind(stationId, sincePolledAt)
			: db.prepare(sql).bind(stationId);
		const result = await stmt.all();
		return result.results as Record<string, unknown>[];
	} catch (err: any) {
		// Table doesn't exist yet (e.g. start of UTC day before first poll lands)
		if (err.message?.includes('no such table')) return [];
		throw err;
	}
}

/** Detect ID format: slug | uuid | short_name. */
function detectIdKind(id: string): 'uuid' | 'slug' | 'short_name' {
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) return 'uuid';
	if (/^[a-z0-9-]+$/.test(id) && /[a-z]/.test(id)) return 'slug';
	return 'short_name';
}

/** Look up a station by any ID form (slug, UUID, short_name). */
async function lookupStation(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
	const kind = detectIdKind(id);
	const col = kind === 'uuid' ? 'gbfs_station_id' : kind === 'slug' ? 'slug' : 'short_name';
	const row = await db.prepare(`SELECT * FROM stations WHERE ${col} = ?`).bind(id).first();
	if (row) return row;
	// Fallback: try other columns (in case format detection was wrong)
	const fallbackOrder = (['slug', 'short_name', 'gbfs_station_id'] as const).filter((c) => c !== col);
	for (const c of fallbackOrder) {
		const r = await db.prepare(`SELECT * FROM stations WHERE ${c} = ?`).bind(id).first();
		if (r) return r;
	}
	return null;
}

/** Look up capacity (and other metadata) for a station, by GBFS UUID. */
async function getStationCapacity(db: D1Database, gbfsId: string): Promise<number | null> {
	const row = await db.prepare(
		`SELECT capacity FROM stations WHERE gbfs_station_id = ?`
	).bind(gbfsId).first<{ capacity: number | null }>();
	return row?.capacity ?? null;
}

/** Resolve any-form ID → GBFS UUID for availability lookups. */
async function resolveToGbfsId(db: D1Database, id: string): Promise<string | null> {
	const kind = detectIdKind(id);
	if (kind === 'uuid') return id;
	const station = await lookupStation(db, id);
	return (station?.gbfs_station_id as string | null) ?? null;
}

async function dropOldTables(db: D1Database, retainDays: number): Promise<string> {
	const cutoff = new Date(Date.now() - retainDays * 86400000).toISOString().slice(0, 10);
	const old = await db.prepare(
		`SELECT date, table_name FROM day_tables WHERE date < ?`
	).bind(cutoff).all();

	const dropped: string[] = [];
	for (const row of old.results as { date: string; table_name: string }[]) {
		// Validate table name (defense against injection — should always be availability_YYYYMMDD)
		if (!/^availability_\d{8}$/.test(row.table_name)) {
			console.warn(`Skipping suspicious table name: ${row.table_name}`);
			continue;
		}
		await db.exec(`DROP TABLE IF EXISTS ${row.table_name}`);
		await db.prepare(`DELETE FROM day_tables WHERE date = ?`).bind(row.date).run();
		dropped.push(row.date);
	}

	return `Dropped ${dropped.length} day-tables older than ${cutoff}: ${dropped.join(', ')}`;
}

export default {
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const retainDays = parseInt(env.HOT_DAYS_RETAIN, 10);
		ctx.waitUntil(
			dropOldTables(env.DB, retainDays).then((msg) => console.log(msg))
		);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(env) });
		}

		if (url.pathname === '/health') {
			return jsonResponse({ status: 'ok' }, env);
		}

		// /api/stations/:id/info — accepts slug, UUID, or short_name
		const infoMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/info$/);
		if (infoMatch) {
			const id = decodeURIComponent(infoMatch[1]);
			const result = await lookupStation(env.DB, id);
			if (!result) return errorResponse(`Station not found: ${id}`, 404, env);
			return jsonResponse(result, env);
		}

		// /api/stations/:id/today?since=<polled_at>  — incremental rows since the last poll
		const todayMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/today$/);
		if (todayMatch) {
			const id = decodeURIComponent(todayMatch[1]);
			const gbfsId = await resolveToGbfsId(env.DB, id);
			if (!gbfsId) return errorResponse(`Station not found: ${id}`, 404, env);
			const dateStr = todayUtc();
			const sinceStr = url.searchParams.get('since');
			const since = sinceStr ? parseInt(sinceStr, 10) : null;
			const [rows, capacity] = await Promise.all([
				getStationDay(env.DB, gbfsId, dateStr, since),
				getStationCapacity(env.DB, gbfsId),
			]);
			// `last_polled_at` = max polled_at across the returned rows, for client-side smart-polling.
			const lastPolledAt = rows.length
				? Math.max(...(rows as { polled_at: number }[]).map((r) => r.polled_at))
				: since;
			return jsonResponse({
				station_id: gbfsId,
				date: dateStr,
				capacity,
				rows,
				last_polled_at: lastPolledAt,
			}, env, {
				// Shorter cache for incremental; full /today still gets the 1-min default
				headers: since !== null
					? { 'Cache-Control': 'public, max-age=5' }
					: {},
			});
		}

		// /api/stations/:id/trips — monthly trip aggregates (start + end side)
		// Returns rows in homepage `Row` shape (Year/Month/Count/Duration/Region/...)
		// plus an `is_start` boolean. Frontend filters/groups as needed.
		const tripsMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/trips$/);
		if (tripsMatch) {
			const id = decodeURIComponent(tripsMatch[1]);
			const station = await lookupStation(env.DB, id);
			if (!station) return errorResponse(`Station not found: ${id}`, 404, env);
			const shortName = station.short_name as string;

			const result = await env.DB.prepare(
				`SELECT ym, is_start, region, gender, user_type, bike_type, trips, duration_s
				 FROM station_trips_monthly
				 WHERE short_name = ?
				 ORDER BY ym, is_start`
			).bind(shortName).all();

			// Reshape to homepage Row format
			const rows = (result.results as any[]).map((r) => ({
				Year: parseInt(r.ym.slice(0, 4), 10),
				Month: parseInt(r.ym.slice(4, 6), 10),
				Count: r.trips,
				Duration: r.duration_s,
				Region: r.region,
				'User Type': r.user_type,
				Gender: r.gender,
				'Rideable Type': r.bike_type,
				is_start: r.is_start === 1,
			}));

			return jsonResponse({
				station_id: shortName,
				short_name: shortName,
				slug: station.slug,
				rows,
			}, env, {
				headers: { 'Cache-Control': 'public, max-age=86400' },  // 1 day
			});
		}

		// /api/stations/:id/range?date=YYYY-MM-DD
		const rangeMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/range$/);
		if (rangeMatch) {
			const id = decodeURIComponent(rangeMatch[1]);
			const gbfsId = await resolveToGbfsId(env.DB, id);
			if (!gbfsId) return errorResponse(`Station not found: ${id}`, 404, env);
			const dateStr = url.searchParams.get('date') ?? todayUtc();
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
				return errorResponse(`Invalid date: ${dateStr} (expected YYYY-MM-DD)`, 400, env);
			}
			const [rows, capacity] = await Promise.all([
				getStationDay(env.DB, gbfsId, dateStr),
				getStationCapacity(env.DB, gbfsId),
			]);
			return jsonResponse({ station_id: gbfsId, date: dateStr, capacity, rows }, env);
		}

		return errorResponse('Not found', 404, env);
	},
} satisfies ExportedHandler<Env>;
