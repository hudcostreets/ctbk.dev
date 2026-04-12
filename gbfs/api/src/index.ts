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
): Promise<Record<string, unknown>[]> {
	const table = tableForDate(dateStr);
	try {
		const result = await db.prepare(
			`SELECT ${COLS.join(',')} FROM ${table} WHERE station_id = ? ORDER BY ts`
		).bind(stationId).all();
		return result.results as Record<string, unknown>[];
	} catch (err: any) {
		// Table doesn't exist yet (e.g. start of UTC day before first poll lands)
		if (err.message?.includes('no such table')) return [];
		throw err;
	}
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

		// /api/stations/:id/today
		const todayMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/today$/);
		if (todayMatch) {
			const stationId = decodeURIComponent(todayMatch[1]);
			const dateStr = todayUtc();
			const rows = await getStationDay(env.DB, stationId, dateStr);
			return jsonResponse({ station_id: stationId, date: dateStr, rows }, env);
		}

		// /api/stations/:id/range?date=YYYY-MM-DD
		const rangeMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/range$/);
		if (rangeMatch) {
			const stationId = decodeURIComponent(rangeMatch[1]);
			const dateStr = url.searchParams.get('date') ?? todayUtc();
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
				return errorResponse(`Invalid date: ${dateStr} (expected YYYY-MM-DD)`, 400, env);
			}
			const rows = await getStationDay(env.DB, stationId, dateStr);
			return jsonResponse({ station_id: stationId, date: dateStr, rows }, env);
		}

		return errorResponse('Not found', 404, env);
	},
} satisfies ExportedHandler<Env>;
