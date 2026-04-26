/**
 * Pure query planner for `/api/query`. Kept free of any Worker/R2/D1 runtime
 * dependencies so it can be unit-tested directly. See
 * `specs/multiscale-timeseries-backend.md` for the full design.
 */

export type Kind = 'trips' | 'availability';
export type Region = 'nyc' | 'jc' | 'hob';
export type Side = 'start' | 'end';

export const ALL_REGIONS: Region[] = ['nyc', 'jc', 'hob'];
export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Standard bin sizes (from <BinSelect /> spec). Used to snap auto-binning. */
export const STANDARD_BINS_MS: number[] = [
	1 * MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS,
	15 * MINUTE_MS, 20 * MINUTE_MS, 30 * MINUTE_MS,
	1 * HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS,
	6 * HOUR_MS, 8 * HOUR_MS, 12 * HOUR_MS,
	1 * DAY_MS, 2 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS,
	30 * DAY_MS, 60 * DAY_MS, 90 * DAY_MS, 180 * DAY_MS, 365 * DAY_MS,
];

export interface QueryInput {
	kind: Kind;
	station?: string;          // XOR with regions
	regions?: Region[];        // defaults to ALL_REGIONS on region-mode queries
	fromS: number;             // unix seconds, inclusive
	toS: number;               // unix seconds, inclusive
	binMs?: number;            // explicit; else derived from target/plotWidth
	targetPxPerBin?: number;   // auto-tier
	plotWidth?: number;        // auto-tier
	fields?: string[];         // projection (reserved; null = all)
	dims?: string[];           // reserved
	side?: Side;               // per-station only
}

export interface QueryPlan {
	paths: string[];           // R2 keys to read in parallel
	tier: 'raw' | 'h1' | 'n1' | 'avail-region';
	binMs: number;             // final bin size (explicit or snapped from target)
	mode: 'station' | 'region';
}

/** Snap an arbitrary ms value UP to the next standard bin (or return max). */
export function snapToStandardBin(ms: number): number {
	for (const b of STANDARD_BINS_MS) if (b >= ms) return b;
	return STANDARD_BINS_MS[STANDARD_BINS_MS.length - 1];
}

/** Derive bin size from `targetPxPerBin` + `plotWidth` + range. */
export function deriveBinMs(fromS: number, toS: number, targetPxPerBin: number, plotWidth: number): number {
	const rangeMs = (toS - fromS) * SECOND_MS;
	const nBins = Math.max(1, Math.floor(plotWidth / targetPxPerBin));
	return snapToStandardBin(Math.max(MINUTE_MS, Math.ceil(rangeMs / nBins)));
}

/** Enumerate YYYY years touching [fromS, toS] (UTC). */
export function yearsIn(fromS: number, toS: number): string[] {
	const y0 = new Date(fromS * SECOND_MS).getUTCFullYear();
	const y1 = new Date(toS * SECOND_MS).getUTCFullYear();
	const out: string[] = [];
	for (let y = y0; y <= y1; y++) out.push(String(y));
	return out;
}

/** Enumerate YYYYMM months touching [fromS, toS] (UTC). */
export function monthsIn(fromS: number, toS: number): string[] {
	const d0 = new Date(fromS * SECOND_MS);
	const d1 = new Date(toS * SECOND_MS);
	const out: string[] = [];
	let y = d0.getUTCFullYear();
	let m = d0.getUTCMonth();  // 0-indexed
	const yEnd = d1.getUTCFullYear();
	const mEnd = d1.getUTCMonth();
	while (y < yEnd || (y === yEnd && m <= mEnd)) {
		out.push(`${y}${String(m + 1).padStart(2, '0')}`);
		m++;
		if (m === 12) { m = 0; y++; }
	}
	return out;
}

/** Enumerate YYYY-MM months touching [fromS, toS] (UTC). */
export function monthsInDashed(fromS: number, toS: number): string[] {
	return monthsIn(fromS, toS).map((ym) => `${ym.slice(0, 4)}-${ym.slice(4, 6)}`);
}

// -----------------------------------------------------------------------------
// `/api/rides` — paginated raw-rides table per station
// (see specs/multiscale-timeseries-backend.md § "Paginated raw-rides table per station")
// -----------------------------------------------------------------------------

/** Allowlist of sortable columns for `/api/rides`. Keep in sync with the
 *  client's `SORTABLE_COLUMNS` (`www/src/query/ridesTable.ts`). */
export const RIDES_SORT_COLUMNS = [
	'dt',
	'side',
	'counterpart_short_name',
	'gender',
	'user_type',
	'rideable_type',
	'duration_s',
] as const;
export type RidesSortColumn = (typeof RIDES_SORT_COLUMNS)[number];

export type RidesSortDir = 'asc' | 'desc';

export interface RidesParams {
	station: string;
	fromS: number;
	toS: number;
	page: number;
	pageSize: number;
	sortBy: RidesSortColumn;
	sortDir: RidesSortDir;
	counterpart?: string;
	side?: Side;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const DEFAULT_SORT_BY: RidesSortColumn = 'dt';
const DEFAULT_SORT_DIR: RidesSortDir = 'desc';

/**
 * Parse and validate `/api/rides` query parameters. Pure; throws on invalid
 * input. Extracted for unit-testability.
 */
export function parseRidesParams(params: URLSearchParams): RidesParams {
	const station = params.get('station');
	if (!station) throw new Error('station= required');

	const fromS = parseInt(params.get('from') ?? '', 10);
	const toS = parseInt(params.get('to') ?? '', 10);
	if (!Number.isFinite(fromS) || !Number.isFinite(toS) || fromS > toS) {
		throw new Error('invalid from/to');
	}

	const pageRaw = params.get('page');
	const page = pageRaw === null ? 0 : parseInt(pageRaw, 10);
	if (!Number.isFinite(page) || page < 0) throw new Error(`invalid page: ${pageRaw}`);

	const pageSizeRaw = params.get('pageSize');
	const pageSize = pageSizeRaw === null ? DEFAULT_PAGE_SIZE : parseInt(pageSizeRaw, 10);
	if (!Number.isFinite(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
		throw new Error(`invalid pageSize: ${pageSizeRaw} (must be 1..${MAX_PAGE_SIZE})`);
	}

	const sortByRaw = params.get('sortBy');
	const sortBy: RidesSortColumn = sortByRaw === null
		? DEFAULT_SORT_BY
		: (RIDES_SORT_COLUMNS as readonly string[]).includes(sortByRaw)
			? (sortByRaw as RidesSortColumn)
			: (() => { throw new Error(`invalid sortBy: ${sortByRaw}`); })();

	const sortDirRaw = params.get('sortDir');
	let sortDir: RidesSortDir;
	if (sortDirRaw === null) sortDir = DEFAULT_SORT_DIR;
	else if (sortDirRaw === 'asc' || sortDirRaw === 'desc') sortDir = sortDirRaw;
	else throw new Error(`invalid sortDir: ${sortDirRaw}`);

	const counterpart = params.get('counterpart') ?? undefined;
	const sideRaw = params.get('side');
	if (sideRaw !== null && sideRaw !== 'start' && sideRaw !== 'end') {
		throw new Error(`invalid side: ${sideRaw}`);
	}
	const side = (sideRaw as Side | null) ?? undefined;

	return { station, fromS, toS, page, pageSize, sortBy, sortDir, counterpart, side };
}

/** R2 key for a per-station rides parquet. */
export function ridesStationKey(station: string): string {
	return `trips/stations/${station}.parquet`;
}

/**
 * Pure query planner. Resolves `{kind, station|regions, from, to, bin?, target?}`
 * into a concrete set of R2 keys + final bin size.
 *
 * Examples:
 *
 *   planQuery({ kind: 'trips', station: '6002.04', fromS: 1704067200, toS: 1735689600, binMs: HOUR_MS })
 *     → { paths: ['trips/stations/6002.04.parquet'], tier: 'raw', binMs: 3_600_000, mode: 'station' }
 *
 *   planQuery({ kind: 'trips', regions: ['nyc'], fromS: <2023-06-01>, toS: <2024-02-01>, binMs: HOUR_MS })
 *     → paths: ['trips/region/nyc/h1/2023.parquet', 'trips/region/nyc/h1/2024.parquet']
 *
 *   planQuery({ kind: 'trips', regions: ['nyc','jc'], fromS: <2024-03-01>, toS: <2024-04-05>, binMs: 5*MINUTE_MS })
 *     → paths: [
 *         'trips/region/nyc/n1/202403.parquet', 'trips/region/nyc/n1/202404.parquet',
 *         'trips/region/jc/n1/202403.parquet', 'trips/region/jc/n1/202404.parquet',
 *       ]
 *
 *   planQuery({ kind: 'availability', regions: ['nyc'], fromS: <2024-01-01>, toS: <2024-03-01>, binMs: MINUTE_MS })
 *     → paths: ['avail/region/nyc/2024-01.parquet', 'avail/region/nyc/2024-02.parquet', 'avail/region/nyc/2024-03.parquet']
 */
export function planQuery(q: QueryInput): QueryPlan {
	let binMs = q.binMs;
	if (binMs === undefined) {
		if (q.targetPxPerBin === undefined || q.plotWidth === undefined) {
			throw new Error('bin XOR (targetPxPerBin + plotWidth) required');
		}
		binMs = deriveBinMs(q.fromS, q.toS, q.targetPxPerBin, q.plotWidth);
	}

	// Per-station: one file, bin on the fly from raw.
	// Prefix matches the region-branch prefixes ('trips' / 'avail'), per spec.
	if (q.station) {
		const prefix = q.kind === 'availability' ? 'avail' : 'trips';
		return {
			paths: [`${prefix}/stations/${q.station}.parquet`],
			tier: 'raw',
			binMs,
			mode: 'station',
		};
	}

	const regions = q.regions && q.regions.length ? q.regions : ALL_REGIONS;

	if (q.kind === 'availability') {
		// No rollup tier — monthly region shards.
		const months = monthsInDashed(q.fromS, q.toS);
		return {
			paths: regions.flatMap((r) => months.map((ym) => `avail/region/${r}/${ym}.parquet`)),
			tier: 'avail-region',
			binMs,
			mode: 'region',
		};
	}

	// trips: h1 if bin ≥ 1h, n1 otherwise.
	const tier: 'h1' | 'n1' = binMs >= HOUR_MS ? 'h1' : 'n1';
	const windows = tier === 'h1' ? yearsIn(q.fromS, q.toS) : monthsIn(q.fromS, q.toS);
	return {
		paths: regions.flatMap((r) => windows.map((w) => `trips/region/${r}/${tier}/${w}.parquet`)),
		tier,
		binMs,
		mode: 'region',
	};
}
