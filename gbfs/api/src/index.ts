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
 *   GET /api/totals?kind=&metric=&from=&to=&scope=[&dims=][&filter.short_name=]
 *                  [&filter.region=][&filter.side=]
 *                                      — windowed totals for monoid-aggregable
 *                                        metrics. trips path implemented; availability
 *                                        returns 501 pending histogram-schema EDA.
 *                                        See ./totals.ts.
 *   GET /api/rides?station=&from=&to=&page=&pageSize=&sortBy=&sortDir=
 *                  [&counterpart=&side=]
 *                                      — paginated raw-rides table per station
 *                                        (reads `trips/stations/<short_name>.parquet`).
 *   GET /health                         — sanity check
 *
 * Availability time-series is served from R2:
 *   - Today / current UTC date  → hourly h1 shards (`gbfs/avail/h1/<date>/<HH>.parquet`)
 *                                 + per-minute WAL JSONs for the still-incomplete current hour
 *   - Older dates                → per-station monthly parquet (`gbfs/stations/<uuid>/<yyyymm>.parquet`)
 *                                 produced by the daily GHA compaction
 *
 * D1 is used only for the `stations` metadata table (short_name → uuid lookups,
 * capacity, slug, etc.), not for the per-minute volume. See `specs/gbfs-r2-only.md`.
 */

interface Env {
	DB: D1Database;
	R2: R2Bucket;
	CORS_ORIGIN: string;
}

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
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

function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

interface AvailRow {
	station_id: string;
	ts: number;
	polled_at: number;
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

/**
 * Read one h1 parquet shard from R2, returning only rows for `stationId`.
 *
 * Two-level cache:
 *   1. Per-station decoded JSON (~10 KB) keyed by `(date, hour, stationId)` —
 *      typical case after warm-up; an .json() that returns ~60 rows.
 *   2. Raw parquet bytes (~6 MB) keyed by R2 key — saves the R2 GET when
 *      another station from the same hour was requested earlier.
 *
 * Per-station decode uses parquet's row-group min/max stats on `station_id`
 * (compactor sorts shards by (station_id, ts) with rowGroupSize=60), so we
 * decode just one row group (~60 rows × 12 cols) instead of the whole file.
 *
 * Returns `null` if the shard doesn't exist (backfill gap or cron hasn't
 * fired yet for the just-completed hour); the caller falls through to the
 * per-minute WAL JSONs in that case.
 */
async function readH1ShardForStation(
	r2: R2Bucket,
	date: string,
	hour: string,
	stationId: string,
): Promise<AvailRow[] | null> {
	const stationCacheUrl = `https://avail.cache.internal/h1/${date}/${hour}/${stationId}.json`;
	const stationCached = await caches.default.match(stationCacheUrl);
	if (stationCached) {
		return (await stationCached.json()) as AvailRow[];
	}

	const key = `gbfs/avail/h1/${date}/${hour}.parquet`;
	const bytesCacheUrl = `https://avail.cache.internal/${key}`;
	let buf: ArrayBuffer | null = null;

	const bytesCached = await caches.default.match(bytesCacheUrl);
	if (bytesCached) {
		buf = await bytesCached.arrayBuffer();
	} else {
		const obj = await r2.get(key);
		if (!obj) return null;
		buf = await obj.arrayBuffer();
		void caches.default.put(
			bytesCacheUrl,
			new Response(buf, {
				headers: { 'Cache-Control': 'public, max-age=86400' },
			}),
		);
	}

	const file = {
		byteLength: buf.byteLength,
		slice: (s: number, e?: number) => buf!.slice(s, e),
	};
	const { parquetMetadataAsync, parquetReadObjects } = await import('hyparquet');
	const meta = await parquetMetadataAsync(file);

	// Walk row groups; each one's `station_id` stats tell us whether `stationId`
	// is in range. With (station_id, ts)-sorted + rg=60, typically exactly one rg
	// matches (the one for this station × this hour).
	//
	// Stats on STRING/BYTE_ARRAY columns are prefix-truncated (~16 chars) by the
	// writer to bound metadata size. To compare correctly, truncate `stationId`
	// to the same length as the stat before checking ≤.
	let rowOffset = 0;
	const targetRanges: Array<{ rowStart: number; rowEnd: number }> = [];
	for (const rg of meta.row_groups) {
		const numRows = Number(rg.num_rows);
		const sidCol = rg.columns.find((c) => c.meta_data?.path_in_schema?.[0] === 'station_id');
		const stats = sidCol?.meta_data?.statistics;
		const min = stats?.min_value as string | undefined;
		const max = stats?.max_value as string | undefined;
		const inRange =
			min === undefined ||
			max === undefined ||
			(min <= stationId.slice(0, min.length) && stationId.slice(0, max.length) <= max);
		if (inRange) {
			targetRanges.push({ rowStart: rowOffset, rowEnd: rowOffset + numRows });
		}
		rowOffset += numRows;
	}

	const stationRows: AvailRow[] = [];
	for (const { rowStart, rowEnd } of targetRanges) {
		const rows = (await parquetReadObjects({ file, rowStart, rowEnd })) as Record<string, unknown>[];
		for (const r of rows) {
			if (r.station_id !== stationId) continue;
			for (const k of Object.keys(r)) {
				if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
			}
			stationRows.push(r as unknown as AvailRow);
		}
	}

	// Cache the per-station result for subsequent calls.
	void caches.default.put(
		stationCacheUrl,
		new Response(JSON.stringify(stationRows), {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'public, max-age=86400',
			},
		}),
	);

	return stationRows;
}

interface MinuteSnapshot {
	ts: number;
	polled_at: number;
	stations: Array<Record<string, number | string>>;
}

/**
 * Read all per-minute WAL JSONs for one (date, hour). Returns flat row list.
 * Used for the current (not-yet-compacted) hour, or as a fallback when an
 * h1 shard is missing.
 */
async function readMinuteJsonsForHour(r2: R2Bucket, date: string, hour: string): Promise<AvailRow[]> {
	const result = await r2.list({ prefix: `gbfs/status/${date}/${hour}-`, limit: 100 });
	const keys = result.objects.map((o) => o.key).filter((k) => k.endsWith('.json'));
	const reads = await Promise.all(
		keys.map(async (k) => {
			const obj = await r2.get(k);
			if (!obj) return null;
			try {
				return JSON.parse(await obj.text()) as MinuteSnapshot;
			} catch {
				return null;
			}
		}),
	);
	const rows: AvailRow[] = [];
	for (const snap of reads) {
		if (!snap) continue;
		for (const s of snap.stations) {
			rows.push({
				station_id: s.station_id as string,
				ts: snap.ts,
				polled_at: snap.polled_at,
				num_bikes_available: (s.num_bikes_available as number) ?? 0,
				num_ebikes_available: (s.num_ebikes_available as number) ?? 0,
				num_docks_available: (s.num_docks_available as number) ?? 0,
				num_bikes_disabled: (s.num_bikes_disabled as number) ?? 0,
				num_docks_disabled: (s.num_docks_disabled as number) ?? 0,
				is_installed: (s.is_installed as number) ?? 0,
				is_renting: (s.is_renting as number) ?? 0,
				is_returning: (s.is_returning as number) ?? 0,
				last_reported: (s.last_reported as number) ?? 0,
			});
		}
	}
	return rows;
}

/**
 * Get one station's rows for one UTC date. Reads from R2:
 *   - Hourly h1 shards for completed hours (for `today`, hours where
 *     the cron has fired and the shard is written; for other dates, all 24)
 *   - Per-minute WAL JSONs for hours where the h1 shard isn't ready yet
 *
 * Falls through JSON→shard if a shard is missing (backfill gap), so this
 * remains correct even before backfill completes.
 *
 * `sincePolledAt`, when set, filters to rows with `polled_at > sincePolledAt`.
 */
async function getStationDay(
	r2: R2Bucket,
	stationId: string,
	dateStr: string,
	sincePolledAt: number | null = null,
	now: Date = new Date(),
): Promise<Record<string, unknown>[]> {
	const isToday = dateStr === todayUtc();
	// Hours where the h1 shard *should* be written: every hour < currentHour,
	// with a 10-min slack for the cron+write to land. Conservative: treat the
	// just-finished hour as "still-incomplete" until :10 past the next hour.
	const currentHour = now.getUTCHours();
	const lastShardHour = isToday
		? (now.getUTCMinutes() < 10 ? currentHour - 2 : currentHour - 1)
		: 23;

	// For today, hours > currentHour haven't happened yet — no JSONs, no shard.
	// For older dates, all 24 hours have data.
	const maxHour = isToday ? currentHour : 23;
	type HourPlan = { hour: string; trySh: boolean };
	const plan: HourPlan[] = [];
	for (let h = 0; h <= maxHour; h++) {
		// For today, hours strictly after lastShardHour are not yet compacted.
		// For non-today dates, all 24 hours have shards (or fall through to JSONs).
		plan.push({ hour: pad2(h), trySh: h <= lastShardHour });
	}

	const hourResults = await Promise.all(
		plan.map(async ({ hour, trySh }) => {
			if (trySh) {
				const rows = await readH1ShardForStation(r2, dateStr, hour, stationId);
				if (rows !== null) return rows;
				// Shard missing: fall through to JSONs (backfill gap).
			}
			const rows = await readMinuteJsonsForHour(r2, dateStr, hour);
			return rows.filter((r) => r.station_id === stationId);
		}),
	);

	let rows = hourResults.flat() as unknown as Record<string, unknown>[];
	if (sincePolledAt !== null) {
		rows = rows.filter((r) => (r.polled_at as number) > sincePolledAt);
	}
	rows.sort((a, b) => {
		const dt = (a.ts as number) - (b.ts as number);
		return dt !== 0 ? dt : (a.polled_at as number) - (b.polled_at as number);
	});
	return rows;
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

/**
 * Enumerate UTC dates from fromS (inclusive) to toS (inclusive). Today and
 * yesterday are served from h1 shards + per-minute JSONs (`getStationDay`);
 * dates ≥ 2 days old use the per-station monthly parquet produced by the
 * daily GHA compaction.
 *
 * Yesterday is in the h1 path because the daily compaction runs at ~03:55 UTC,
 * so the monthly parquet is only guaranteed to contain D-2 (and earlier) at
 * any moment in day D. Querying D-1 from the monthly would intermittently
 * miss until the cron runs each morning.
 *
 * When `sincePolledAt` is set, only rows with `polled_at > since` are returned
 * — an incremental fetch for live refresh. Skips the monthly path entirely
 * (the archive is immutable, so once a poll has been seen it can't appear in
 * an older month).
 */
async function getStationRange(
	r2: R2Bucket,
	stationId: string,
	fromS: number,
	toS: number,
	sincePolledAt: number | null = null,
	now: Date = new Date(),
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

	// Cutoff: dates ≥ this are "h1 territory" (today + yesterday).
	const yesterday = new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10);
	const h1Dates = dates.filter((d) => d >= yesterday);
	const monthlyMonths = sincePolledAt === null
		? new Set(dates.filter((d) => d < yesterday).map(yyyymmOfDate))
		: new Set<string>();

	const [h1Results, monthlyResults] = await Promise.all([
		Promise.all(h1Dates.map((d) => getStationDay(r2, stationId, d, sincePolledAt, now))),
		Promise.all([...monthlyMonths].map((m) => getStationMonthFromR2(r2, stationId, m))),
	]);

	const rows: Record<string, unknown>[] = [];
	for (const dayRows of h1Results) {
		for (const r of dayRows) {
			const ts = r.ts as number;
			if (ts >= fromS && ts <= toS) rows.push(r);
		}
	}
	// Filter monthly rows to the requested window AND to dates strictly before
	// yesterday (yesterday's data lives in `h1Results` to avoid duplication).
	const yesterdayStartS = Math.floor(new Date(yesterday + 'T00:00:00Z').getTime() / 1000);
	for (const monthRows of monthlyResults) {
		for (const r of monthRows) {
			const ts = r.ts as number;
			if (ts >= fromS && ts <= toS && ts < yesterdayStartS) rows.push(r);
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
	parseRidesParams,
	planQuery,
	ridesStationKey,
	type QueryInput,
	type QueryPlan,
	type Region,
	type RidesParams,
	type Side,
} from './planQuery';
import { binAndAggregate } from './bin';
import {
	aggregateTotals,
	availAggKeys,
	availFinalize,
	availFold,
	parseTotalsParams,
	pickAvailAggTier,
	pickTripsAggTier,
	projectionForAvailTotals,
	tripsAggKeys,
	tripsTotalsFallbackPaths,
	type AvailHistRow,
	type TotalsParams,
	type TotalsResponse,
} from './totals';

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
	// carry `count` from the upstream aggregator. Availability dispatches
	// to a separate aggregator (mean/min/max/percentiles per metric col).
	const synthesizeCount = q.kind === 'trips' && plan.tier === 'raw';
	const binned = binAndAggregate(merged, {
		kind: q.kind,
		binMs: plan.binMs,
		fromS: q.fromS,
		toS: q.toS,
		dims: q.dims ?? [],
		synthesizeCount,
	});
	return { rows: binned, missing };
}

/**
 * Execute an `/api/totals` request (trips path). Tier-stitching:
 *
 *   1. Pick the coarsest agg tier that fits the window via `pickTripsAggTier`.
 *      For a window ≥ 1y: mo1; ≥ 1mo: d1; ≥ 1d: h1; else: skip step 2.
 *   2. Try reading the corresponding `trips/agg/<tier>/<window>.parquet`
 *      shards. If ALL shards are 404 (the agg pipeline hasn't produced them
 *      yet — `ctbk trips-agg` is not yet built), fall through to step 3.
 *   3. Fallback: per `tripsTotalsFallbackPaths` —
 *        scope=stations + filter.short_name → per-station rides parquets
 *        scope=regions / scope=all → per-region h1 yearly shards (already on R2)
 *      With `synthesizeCount=true` for the per-station fallback (raw rides files
 *      have no explicit `count` column).
 *
 * Once `ctbk trips-agg` is producing files, the fallback branch can be deleted
 * (mark and search for 'tripsTotalsFallbackPaths' to find it).
 */
async function executeTotalsQuery(
	r2: R2Bucket,
	p: TotalsParams,
): Promise<TotalsResponse> {
	// Step 1+2: try the agg-tier shards first. Only project columns we need.
	const projection = projectionForTotals(p);
	const aggTier = pickTripsAggTier(p.fromS, p.toS);
	if (aggTier) {
		const aggKeys = tripsAggKeys(aggTier, p.fromS, p.toS);
		const aggResults = await Promise.all(
			aggKeys.map((k) => readR2Parquet(r2, k, projection)),
		);
		const allMissing = aggResults.every((r) => r === null);
		if (!allMissing) {
			const merged: Record<string, unknown>[] = [];
			for (const r of aggResults) if (r) merged.push(...r);
			const rows = aggregateTotals(merged, p, /* synthesizeCount */ false);
			return { kind: p.kind, metric: p.metric, scope: p.scope, tier: aggTier, rows };
		}
	}

	// Step 3: fallback to existing R2 parquets (per-station or per-region).
	const fallback = tripsTotalsFallbackPaths(p);
	const fallbackResults = await Promise.all(
		fallback.paths.map((k) => readR2Parquet(r2, k, projection)),
	);
	const merged: Record<string, unknown>[] = [];
	for (const r of fallbackResults) if (r) merged.push(...r);
	// Per-station fallback files have no explicit `count`; per-region h1 shards do.
	const synthesizeCount = fallback.tier === 'fallback-stations';
	// Per-station fallback files lack `short_name` as a column (they're keyed by
	// filename). Inject it so `aggregateTotals` can group by station.
	if (fallback.tier === 'fallback-stations' && p.filterShortName) {
		// Re-walk results, tagging each row with its source short_name.
		merged.length = 0;
		fallbackResults.forEach((rows, i) => {
			if (!rows) return;
			const shortName = p.filterShortName![i];
			for (const r of rows) {
				if (r.short_name === undefined) r.short_name = shortName;
				merged.push(r);
			}
		});
	}
	const rows = aggregateTotals(merged, p, synthesizeCount);
	return { kind: p.kind, metric: p.metric, scope: p.scope, tier: fallback.tier, rows };
}

/**
 * Execute an `/api/totals` request (availability path). Reads the
 * `avail/agg/<tier>/<window>.parquet` shards (built by `ctbk avail-agg-*`)
 * one at a time, folding each into a per-group histogram, then finalizes
 * with the requested reducer.
 *
 * Streaming fold avoids holding all parsed rows in JS-object form at once
 * — h1 daily shards can be ~3.5M rows over a 7-day window which OOMs the
 * Worker at the 128MB cap. Per-group histogram state is bounded by
 * (n_stations × n_distinct_states) per metric — typically <5000 entries
 * even at a year-wide query.
 */
async function executeAvailTotalsQuery(
	r2: R2Bucket,
	p: TotalsParams,
): Promise<TotalsResponse> {
	const tier = pickAvailAggTier(p.fromS, p.toS);
	const projection = projectionForAvailTotals(p);
	const keys = availAggKeys(tier, p.fromS, p.toS);
	const groups = new Map<string, ReturnType<typeof initGroupsType>>();
	for (const key of keys) {
		const rows = await readR2Parquet(r2, key, projection);
		if (rows === null) continue;
		availFold(rows as unknown as AvailHistRow[], p, groups as never);
		// Drop the parsed batch ASAP so the GC can reclaim it before the
		// next file lands.
	}
	const rows = availFinalize(groups as never, p);
	return { kind: p.kind, metric: p.metric, scope: p.scope, tier, rows };
}

// Type-helper for the `groups` map; avoids importing the `AvailAcc` interface
// (it's an internal type of totals.ts). The actual shape is `Map<string,
// {key, dimVals, hist}>` — only used as an opaque accumulator here.
function initGroupsType(): never { throw new Error('not callable'); }

/** Columns to project from parquet for `/api/totals`. Keeps R2 byte-scan
 *  small. `dt` + scope key + dim columns + sum-monoid metric columns. */
function projectionForTotals(p: TotalsParams): string[] {
	const cols = new Set<string>(['dt', 'count', 'duration_s']);
	if (p.scope === 'stations') cols.add('short_name');
	if (p.scope === 'regions') cols.add('region');
	for (const d of p.dims) cols.add(d);
	if (p.filterShortName) cols.add('short_name');
	if (p.filterRegion) cols.add('region');
	if (p.filterSide) cols.add('side');
	return [...cols];
}

/**
 * Execute a `/api/rides` request: read the per-station parquet from R2, filter
 * by dt range / counterpart / side, sort, paginate. Returns `null` if the
 * station file doesn't exist (caller surfaces 404).
 */
async function executeRidesQuery(
	r2: R2Bucket,
	q: RidesParams,
): Promise<{ rows: Record<string, unknown>[]; totalRows: number; page: number; pageSize: number } | null> {
	const key = ridesStationKey(q.station);
	const rows = await readR2Parquet(r2, key);
	if (rows === null) return null;

	// Filter
	const filtered: Record<string, unknown>[] = [];
	for (const r of rows) {
		const dt = r.dt as number | undefined;
		if (dt === undefined || dt < q.fromS || dt > q.toS) continue;
		if (q.side !== undefined && r.side !== q.side) continue;
		if (q.counterpart !== undefined && r.counterpart_short_name !== q.counterpart) continue;
		filtered.push(r);
	}

	// Sort. Numeric columns compare as numbers; string columns lexicographically.
	const sortBy = q.sortBy;
	const dir = q.sortDir === 'asc' ? 1 : -1;
	filtered.sort((a, b) => {
		const av = a[sortBy];
		const bv = b[sortBy];
		// Stable secondary sort by dt to keep paging deterministic when the
		// primary key has ties (e.g. many rides at the same minute).
		const primary =
			typeof av === 'number' && typeof bv === 'number'
				? (av - bv)
				: String(av ?? '') < String(bv ?? '') ? -1
					: String(av ?? '') > String(bv ?? '') ? 1
						: 0;
		if (primary !== 0) return primary * dir;
		if (sortBy === 'dt') return 0;
		const aDt = (a.dt as number) ?? 0;
		const bDt = (b.dt as number) ?? 0;
		return (aDt - bDt) * dir;
	});

	const totalRows = filtered.length;
	const start = q.page * q.pageSize;
	const slice = filtered.slice(start, start + q.pageSize);
	return { rows: slice, totalRows, page: q.page, pageSize: q.pageSize };
}

export default {
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

		// /api/totals — windowed totals over monoid-aggregable metrics. trips path
		// only for now; availability returns 501 pending histogram-schema EDA
		// (see specs/multiscale-timeseries-backend.md § "Open EDA").
		if (url.pathname === '/api/totals') {
			let p: TotalsParams;
			try {
				p = parseTotalsParams(url.searchParams);
			} catch (err: any) {
				return errorResponse(err.message ?? 'invalid query', 400, env);
			}
			const result = p.kind === 'availability'
				? await executeAvailTotalsQuery(env.R2, p)
				: await executeTotalsQuery(env.R2, p);
			return jsonResponse(result, env);
		}

		// /api/rides — paginated raw-rides table per station (see specs/multiscale-timeseries-backend.md
		// § "Paginated raw-rides table per station"). Reads `trips/stations/<short_name>.parquet`.
		if (url.pathname === '/api/rides') {
			let q: RidesParams;
			try {
				q = parseRidesParams(url.searchParams);
			} catch (err: any) {
				return errorResponse(err.message ?? 'invalid query', 400, env);
			}
			const result = await executeRidesQuery(env.R2, q);
			if (result === null) {
				return jsonResponse({
					error: 'no data',
					path: ridesStationKey(q.station),
				}, env, { status: 404 });
			}
			return jsonResponse(result, env);
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
				getStationDay(env.R2, gbfsId, dateStr, since),
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
					getStationRange(env.R2, gbfsId, fromS, toS, since),
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
			// Route through `getStationRange` so non-today dates use the efficient
			// per-station monthly parquet (single-file read) instead of 24 hourly
			// h1 shards. `getStationRange` falls back to h1 shards only for today.
			const dayStartS = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
			const dayEndS = dayStartS + 86400 - 1;
			const [rows, capacity] = await Promise.all([
				getStationRange(env.R2, gbfsId, dayStartS, dayEndS),
				getStationCapacity(env.DB, gbfsId),
			]);
			return jsonResponse({ station_id: gbfsId, date: dateStr, capacity, rows }, env);
		}

		return errorResponse('Not found', 404, env);
	},
} satisfies ExportedHandler<Env>;
