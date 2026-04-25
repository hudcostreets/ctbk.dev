/**
 * GBFS API — Cloudflare Worker serving station availability queries.
 *
 * Endpoints:
 *   GET /api/stations/:id/today        — today's availability rows for one station
 *   GET /api/stations/:id/range?date=YYYY-MM-DD  — one specific day's rows
 *   GET /api/stations/:id/range?from=&to=[&since=] — arbitrary window (unix seconds);
 *                                                    `since` filters by polled_at for
 *                                                    incremental polling.
 *   GET /api/query?kind=&station=|region=&from=&to=&(bin=|targetPxPerBin=&plotWidth=)
 *                                      — unified multi-scale time-series query
 *                                        (trips + availability). See planQuery() below.
 *   GET /health                         — sanity check
 *
 * Reads from D1 `availability_YYYYMMDD` tables populated by the loader.
 */

interface Env {
	DB: D1Database;
	R2: R2Bucket;
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

/**
 * Read one station's per-month parquet from R2 (`gbfs/stations/<gbfsId>/<yyyymm>.parquet`)
 * and return rows as plain objects (same shape as D1 queries). Returns `[]` if
 * the object doesn't exist.
 */
async function getStationMonthFromR2(
	r2: R2Bucket,
	stationId: string,
	yyyymm: string,
): Promise<Record<string, unknown>[]> {
	const key = `gbfs/stations/${stationId}/${yyyymm}.parquet`;
	const obj = await r2.get(key);
	if (!obj) return [];
	const buf = await obj.arrayBuffer();
	const file = {
		byteLength: buf.byteLength,
		slice: (start: number, end?: number) => buf.slice(start, end),
	};
	const { parquetReadObjects } = await import('hyparquet');
	const rows = await parquetReadObjects({ file }) as Record<string, unknown>[];
	// hyparquet returns int64 columns (ts, polled_at, last_reported) as BigInt;
	// coerce to Number so downstream comparisons (and JSON serialization) work.
	for (const r of rows) {
		for (const k of Object.keys(r)) {
			if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
		}
	}
	return rows;
}

function yyyymmOfDate(dateStr: string): string {
	// "2026-04-07" → "2026-04"
	return dateStr.slice(0, 7);
}

function hotCutoffDate(retainDays: number): string {
	const ms = Date.now() - retainDays * 86400 * 1000;
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Enumerate UTC dates from fromS (inclusive) to toS (inclusive), pulling from D1
 * for dates within `HOT_DAYS_RETAIN` and falling back to R2 per-station monthly
 * parquets for older dates. Rows outside [fromS, toS] are filtered out. When
 * `sincePolledAt` is set, only rows with polled_at > since are returned
 * (for incremental refresh — skips the R2 path entirely since the archive is
 * immutable per-day once compacted).
 */
async function getStationRange(
	db: D1Database,
	r2: R2Bucket,
	stationId: string,
	fromS: number,
	toS: number,
	retainDays: number,
	sincePolledAt: number | null = null,
): Promise<Record<string, unknown>[]> {
	const MS_PER_DAY = 86400 * 1000;
	const scanFromS = sincePolledAt !== null ? Math.max(fromS, sincePolledAt) : fromS;
	const startDay = new Date(scanFromS * 1000);
	startDay.setUTCHours(0, 0, 0, 0);
	const endDayMs = toS * 1000;

	const dates: string[] = [];
	for (let t = startDay.getTime(); t <= endDayMs; t += MS_PER_DAY) {
		dates.push(new Date(t).toISOString().slice(0, 10));
	}

	const cutoff = hotCutoffDate(retainDays);
	// Partition dates: `hot` served from D1; `cold` served from R2 monthly parquets.
	// Skip R2 entirely when polling incrementally — the archive is immutable.
	const hotDates: string[] = [];
	const coldMonths = new Set<string>();
	for (const d of dates) {
		if (d >= cutoff) hotDates.push(d);
		else if (sincePolledAt === null) coldMonths.add(yyyymmOfDate(d));
	}

	const [hotDayResults, coldMonthResults] = await Promise.all([
		Promise.all(hotDates.map((d) => getStationDay(db, stationId, d, sincePolledAt))),
		Promise.all([...coldMonths].map((m) => getStationMonthFromR2(r2, stationId, m))),
	]);

	const rows: Record<string, unknown>[] = [];
	for (const dayRows of hotDayResults) {
		for (const r of dayRows) {
			const ts = r.ts as number;
			if (ts >= fromS && ts <= toS) rows.push(r);
		}
	}
	// R2 month covers ~30 days; filter to the requested window + hot boundary
	// so cold rows don't duplicate hot ones. Cutoff is exclusive of `cutoff` day
	// (that day is served by D1).
	const cutoffS = Math.floor(new Date(cutoff + 'T00:00:00Z').getTime() / 1000);
	for (const monthRows of coldMonthResults) {
		for (const r of monthRows) {
			const ts = r.ts as number;
			if (ts >= fromS && ts <= toS && ts < cutoffS) rows.push(r);
		}
	}
	rows.sort((a, b) => (a.ts as number) - (b.ts as number));
	return rows;
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

// -----------------------------------------------------------------------------
// Multi-scale time-series query (`/api/query`)
// See specs/multiscale-timeseries-backend.md for the full design.
// Planner + helpers live in ./planQuery.ts (pure, unit-testable).
// -----------------------------------------------------------------------------

import {
	ALL_REGIONS,
	planQuery,
	type QueryInput,
	type QueryPlan,
	type Region,
	type Side,
} from './planQuery';

const SECOND_MS = 1000;

/**
 * Read one parquet from R2, returning rows as plain objects. Returns `null` if
 * the object doesn't exist (so the caller can distinguish missing shards from
 * empty ones). BigInt columns (int64) are coerced to Number.
 */
async function readR2Parquet(
	r2: R2Bucket,
	key: string,
	columns?: string[],
): Promise<Record<string, unknown>[] | null> {
	const obj = await r2.get(key);
	if (!obj) return null;
	const buf = await obj.arrayBuffer();
	const file = {
		byteLength: buf.byteLength,
		slice: (start: number, end?: number) => buf.slice(start, end),
	};
	const { parquetReadObjects } = await import('hyparquet');
	const rows = await parquetReadObjects({ file, columns }) as Record<string, unknown>[];
	for (const r of rows) {
		for (const k of Object.keys(r)) {
			if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
		}
	}
	return rows;
}

/**
 * Allowlist of column names that are aggregated (summed) per bin. Other
 * columns — even numeric ones like `gender` (a 0/1/2 enum) — are categorical
 * and should never be silently summed. They're either kept as a group-key
 * via `dims` or dropped from the output entirely.
 */
const METRIC_COLUMNS = new Set(['count', 'duration_s']);

/**
 * Bin and aggregate rows. Assumes each row has a numeric `dt` column (unix
 * seconds). Groups by `(bin, ...dims)`: when `dims` is empty the result has
 * exactly one row per bin (totals); when `dims` lists e.g. `['side']` the
 * result has one row per `(bin × side)` combo. Only `METRIC_COLUMNS` are
 * summed; all other columns are either group keys (in `dims`) or dropped.
 *
 * Raw per-station files store one ride per row with no explicit count
 * column; `synthesizeCount=true` injects `count: 1` per source row so the
 * aggregation produces a usable count metric. Region pre-aggs already
 * carry a `count` column, so we leave them alone.
 */
function binAndAggregate(
	rows: Record<string, unknown>[],
	binMs: number,
	fromS: number,
	toS: number,
	dims: string[] = [],
	synthesizeCount = false,
): Record<string, unknown>[] {
	const binS = Math.max(1, Math.floor(binMs / SECOND_MS));
	// Group key = bin || dim values. Empty `dims` → key is just the bin.
	const buckets = new Map<string, Record<string, unknown>>();
	for (const r of rows) {
		const dt = r.dt as number | undefined;
		if (dt === undefined || dt < fromS || dt > toS) continue;
		const bin = Math.floor(dt / binS) * binS;
		const key = dims.length === 0
			? String(bin)
			: `${bin}|${dims.map((d) => String(r[d] ?? '')).join('|')}`;
		let acc = buckets.get(key);
		if (!acc) {
			acc = { dt: bin };
			for (const d of dims) acc[d] = r[d];
			buckets.set(key, acc);
		}
		// Synthesize count for raw rows (one ride per row, no source `count`).
		if (synthesizeCount) {
			acc.count = ((acc.count as number) ?? 0) + 1;
		}
		// Sum recognized metric columns. Numeric categoricals (e.g. `gender`)
		// fall through here — they're either dim group keys or get dropped.
		for (const k of METRIC_COLUMNS) {
			if (synthesizeCount && k === 'count') continue;  // already incremented
			const v = r[k];
			if (typeof v === 'number') {
				acc[k] = ((acc[k] as number) ?? 0) + v;
			}
		}
	}
	return [...buckets.values()].sort((a, b) => {
		const aDt = a.dt as number;
		const bDt = b.dt as number;
		if (aDt !== bDt) return aDt - bDt;
		// Stable secondary sort by dim values for deterministic output.
		for (const d of dims) {
			const av = String(a[d] ?? '');
			const bv = String(b[d] ?? '');
			if (av !== bv) return av < bv ? -1 : 1;
		}
		return 0;
	});
}

/** Parse and validate `/api/query` params; throws on invalid input. */
function parseQueryParams(params: URLSearchParams): QueryInput {
	const kind = params.get('kind');
	if (kind !== 'trips' && kind !== 'availability') {
		throw new Error(`kind must be 'trips' or 'availability' (got ${kind})`);
	}
	const station = params.get('station') ?? undefined;
	const regionRaw = params.get('region');
	if ((station === undefined) === (regionRaw === null)) {
		throw new Error(`exactly one of station= or region= required`);
	}
	let regions: Region[] | undefined;
	if (regionRaw !== null) {
		regions = regionRaw.split(',').map((s) => s.trim()) as Region[];
		for (const r of regions) {
			if (!ALL_REGIONS.includes(r)) throw new Error(`invalid region: ${r}`);
		}
	}
	const fromS = parseInt(params.get('from') ?? '', 10);
	const toS = parseInt(params.get('to') ?? '', 10);
	if (!Number.isFinite(fromS) || !Number.isFinite(toS) || fromS > toS) {
		throw new Error(`invalid from/to`);
	}
	const binRaw = params.get('bin');
	const targetPxPerBinRaw = params.get('targetPxPerBin');
	const plotWidthRaw = params.get('plotWidth');
	const hasBin = binRaw !== null;
	const hasTarget = targetPxPerBinRaw !== null && plotWidthRaw !== null;
	if (hasBin === hasTarget) {
		throw new Error(`exactly one of bin= or (targetPxPerBin= + plotWidth=) required`);
	}
	const binMs = hasBin ? parseInt(binRaw, 10) : undefined;
	const targetPxPerBin = hasTarget ? parseInt(targetPxPerBinRaw, 10) : undefined;
	const plotWidth = hasTarget ? parseInt(plotWidthRaw, 10) : undefined;
	if (hasBin && (!Number.isFinite(binMs) || (binMs as number) <= 0)) {
		throw new Error(`invalid bin: ${binRaw}`);
	}
	if (hasTarget && (!Number.isFinite(targetPxPerBin) || !Number.isFinite(plotWidth))) {
		throw new Error(`invalid targetPxPerBin/plotWidth`);
	}

	const fields = params.get('fields')?.split(',').map((s) => s.trim()) ?? undefined;
	const dims = params.get('dims')?.split(',').map((s) => s.trim()) ?? undefined;
	const sideRaw = params.get('side');
	if (sideRaw !== null && sideRaw !== 'start' && sideRaw !== 'end') {
		throw new Error(`side must be 'start' or 'end'`);
	}
	if (sideRaw !== null && station === undefined) {
		throw new Error(`side= only valid with station=`);
	}
	const side = (sideRaw as Side | null) ?? undefined;
	return { kind, station, regions, fromS, toS, binMs, targetPxPerBin, plotWidth, fields, dims, side };
}

/** Execute a planned query: read all shards in parallel, filter, bin, merge. */
async function executeQuery(
	r2: R2Bucket,
	q: QueryInput,
	plan: QueryPlan,
): Promise<{ rows: Record<string, unknown>[]; missing: string[] }> {
	const results = await Promise.all(
		plan.paths.map(async (key) => ({ key, rows: await readR2Parquet(r2, key, q.fields) })),
	);
	const missing: string[] = [];
	const merged: Record<string, unknown>[] = [];
	for (const { key, rows } of results) {
		if (rows === null) { missing.push(key); continue; }
		for (const r of rows) {
			// Per-station filter by side (if requested).
			if (q.side !== undefined && r.side !== undefined && r.side !== q.side) continue;
			merged.push(r);
		}
	}
	// Per-station trips files store one record per ride with no explicit
	// `count` column — synthesize one. Region pre-aggs (h1/n1) already
	// carry `count` from the upstream aggregator. Availability is state
	// data (one record per poll), where sum-aggregation isn't meaningful
	// — we'll wire up mean/min/max aggs alongside availability rollups.
	const synthesizeCount = q.kind === 'trips' && plan.tier === 'raw';
	const binned = binAndAggregate(merged, plan.binMs, q.fromS, q.toS, q.dims ?? [], synthesizeCount);
	return { rows: binned, missing };
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

		// /api/query — unified multi-scale time-series (trips + availability).
		// See planQuery() above + specs/multiscale-timeseries-backend.md.
		if (url.pathname === '/api/query') {
			let q: QueryInput;
			try {
				q = parseQueryParams(url.searchParams);
			} catch (err: any) {
				return errorResponse(err.message ?? 'invalid query', 400, env);
			}
			let plan: QueryPlan;
			try {
				plan = planQuery(q);
			} catch (err: any) {
				return errorResponse(err.message ?? 'plan failed', 400, env);
			}
			const { rows, missing } = await executeQuery(env.R2, q, plan);
			// If every planned file is missing, surface 404 so the client can
			// distinguish "no data yet" from "empty window".
			if (missing.length === plan.paths.length && plan.paths.length > 0) {
				return jsonResponse({
					error: 'no data',
					tier: plan.tier,
					binMs: plan.binMs,
					paths: plan.paths,
					missing,
				}, env, { status: 404 });
			}
			return jsonResponse({
				kind: q.kind,
				tier: plan.tier,
				binMs: plan.binMs,
				mode: plan.mode,
				paths: plan.paths,
				missing,
				rows,
			}, env);
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

		// /api/stations/:id/range?date=YYYY-MM-DD        (single day)
		//                        ?from=<unix_s>&to=<unix_s>  (time window)
		const rangeMatch = url.pathname.match(/^\/api\/stations\/([^/]+)\/range$/);
		if (rangeMatch) {
			const id = decodeURIComponent(rangeMatch[1]);
			const gbfsId = await resolveToGbfsId(env.DB, id);
			if (!gbfsId) return errorResponse(`Station not found: ${id}`, 404, env);

			const fromParam = url.searchParams.get('from');
			const toParam = url.searchParams.get('to');
			if (fromParam !== null || toParam !== null) {
				const fromS = fromParam !== null ? parseInt(fromParam, 10) : NaN;
				const toS = toParam !== null ? parseInt(toParam, 10) : Math.floor(Date.now() / 1000);
				if (!Number.isFinite(fromS) || !Number.isFinite(toS) || fromS > toS) {
					return errorResponse(`Invalid from/to: from=${fromParam} to=${toParam}`, 400, env);
				}
				const maxSpanDays = 62;
				if ((toS - fromS) / 86400 > maxSpanDays) {
					return errorResponse(`Range exceeds ${maxSpanDays} days`, 400, env);
				}
				const sinceParam = url.searchParams.get('since');
				const since = sinceParam !== null ? parseInt(sinceParam, 10) : null;
				if (sinceParam !== null && !Number.isFinite(since)) {
					return errorResponse(`Invalid since: ${sinceParam}`, 400, env);
				}
				const [rows, capacity] = await Promise.all([
					getStationRange(env.DB, env.R2, gbfsId, fromS, toS, parseInt(env.HOT_DAYS_RETAIN, 10), since),
					getStationCapacity(env.DB, gbfsId),
				]);
				const lastPolledAt = rows.length
					? Math.max(...(rows as { polled_at: number }[]).map((r) => r.polled_at))
					: since;
				return jsonResponse({
					station_id: gbfsId,
					from: fromS,
					to: toS,
					capacity,
					rows,
					last_polled_at: lastPolledAt,
				}, env, {
					headers: since !== null
						? { 'Cache-Control': 'public, max-age=5' }
						: {},
				});
			}

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
