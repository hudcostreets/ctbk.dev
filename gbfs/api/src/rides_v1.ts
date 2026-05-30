/**
 * pyrmts-geo CFW glue for ctbk's rides pyramids (`rides-v1`).
 *
 * Two sibling pyramids built by `ctbk/rides_v1.py`, identical except for the
 * h3 anchor:
 *   rides-v1/start/<tier>/<period>.parquet — `start_h3_cell`-anchored
 *   rides-v1/end/<tier>/<period>.parquet   — `end_h3_cell`-anchored
 *
 * 11-tier ladder: 1h / 3h / 6h / 12h / 1d / 3d / 7d / 14d / 1mo / 3mo / 1y.
 * h3 resolutions: 9 / 7 / 5 (same as avail-v2).
 *
 *  Schema (per row, sum-monoid):
 *    {anchor}_h3_cell : STRING       (resolution encoded in high bits)
 *    dt               : INT64        unix ms — bucket start
 *    gender           : STRING       'unknown' | 'male' | 'female'
 *    user_type        : STRING       'Subscriber' | 'Customer' | …
 *    bike_type        : STRING       'classic_bike' | 'electric_bike' | …
 *    count_n          : INT64
 *    count_sum        : INT64
 *    count_sumsq      : INT64
 *    duration_n       : INT64
 *    duration_sum     : INT64        seconds
 *    duration_sumsq   : INT64        seconds²
 *
 * Endpoints (mounted from `index.ts`):
 *   GET /api/rides-v1?anchor=start|end&from=&to=&bbox=&bin_budget=&cell_budget=&reducer=
 *   GET /api/rides-v1/cells?anchor=start|end&… (per-cell breakdown)
 *
 * Reducers (sum monoid → scalar collapse):
 *   `sum` (default)  → `sum`         (additive total)
 *   `count`          → `n`           (# of contributions)
 *   `mean`           → `sum / n`
 *   `stddev`         → sqrt((sumsq − sum²/n) / max(1, n−1))
 *   `raw`            → pass through `{n, sum, sumsq}` triplet (no collapse)
 *
 * Filters: `filter.gender=…&filter.user_type=…&filter.bike_type=…` plumbed
 * as hyparquet RG-prune filters via pyrmts §2 `FetchOptions.filters`.
 */
import {
	fetchSegmentRows,
	stitch,
	type Pyramid,
	type Row,
	type Tier,
} from 'pyrmts';
import { r2Storage } from 'pyrmts-cfw';
import { filterCellsAndRes, planGeoQuery, type BBox } from 'pyrmts-geo';

const METRICS = ['count', 'duration'] as const;
type Metric = typeof METRICS[number];

const DIMS = ['gender', 'user_type', 'bike_type'] as const;
type Dim = typeof DIMS[number];

export const REDUCERS = ['sum', 'count', 'mean', 'stddev', 'raw'] as const;
export type Reducer = typeof REDUCERS[number];
const DEFAULT_REDUCER: Reducer = 'sum';

export const ANCHORS = ['start', 'end'] as const;
export type Anchor = typeof ANCHORS[number];
const DEFAULT_ANCHOR: Anchor = 'start';

const TIERS: Tier[] = [
	{ name: '1h',  bin: '1h',  shard: '1mo' },
	{ name: '3h',  bin: '3h',  shard: '1mo' },
	{ name: '6h',  bin: '6h',  shard: '1mo' },
	{ name: '12h', bin: '12h', shard: '1mo' },
	{ name: '1d',  bin: '1d',  shard: '1y'  },
	{ name: '3d',  bin: '3d',  shard: '1y'  },
	{ name: '7d',  bin: '7d',  shard: '1y'  },
	{ name: '14d', bin: '14d', shard: '1y'  },
	{ name: '1mo', bin: '1mo', shard: '1y'  },
	{ name: '3mo', bin: '3mo', shard: '1y'  },
	{ name: '1y',  bin: '1y',  shard: 'all' },
];

function cellCol(anchor: Anchor): string {
	return `${anchor}_h3_cell`;
}

function keyTemplate(anchor: Anchor): string {
	return `rides-v1/${anchor}/{tier}/{period}.parquet`;
}

/** Shared pyramid skeleton; only key-template + cellCol + `dims` vary. */
function makeBaseProps(bucket: R2Bucket, anchor: Anchor): Omit<Pyramid, 'dims'> {
	return {
		storage: r2Storage(bucket),
		keyTemplate: keyTemplate(anchor),
		axis: 'time',
		binCol: 'dt',
		// pyrmts's `sum` monoid stores state as `<name>{_n,_sum,_sumsq}` —
		// one metric per logical quantity, monoid handles the triplet.
		metrics: METRICS.map((name) => ({ name, monoid: 'sum' as const })),
		tiers: TIERS,
		geo: {
			cellCol: cellCol(anchor),
			resolutions: [9, 7, 5],
		},
	};
}

/** Rollup pyramid — `dims: []` so `stitch` collapses cells, leaving
 *  one row per (dt, dim-tuple) summed across the bbox-covering cell set. */
export function ridesPyramid(bucket: R2Bucket, anchor: Anchor): Pyramid {
	return { ...makeBaseProps(bucket, anchor), dims: DIMS.map((d) => ({ name: d, type: 'string' as const })) };
}

/** Per-cell pyramid — adds `{anchor}_h3_cell` to dims so stitch preserves
 *  cell-level breakdown. */
export function ridesCellsPyramid(bucket: R2Bucket, anchor: Anchor): Pyramid {
	return {
		...makeBaseProps(bucket, anchor),
		dims: [
			{ name: cellCol(anchor), type: 'string' as const },
			...DIMS.map((d) => ({ name: d, type: 'string' as const })),
		],
	};
}

// ─────────────────────────────────────────────────────────────────────
// Sum-monoid reducer math.

/** Collapse a `{n, sum, sumsq}` triplet to a scalar per the requested reducer.
 *  Returns `null` for `mean`/`stddev` when `n === 0` (no contributions). */
function applyReducer(n: number, sum: number, sumsq: number, r: Reducer): number | null {
	if (r === 'sum') return sum;
	if (r === 'count') return n;
	if (n === 0) return null;
	if (r === 'mean') return sum / n;
	if (r === 'stddev') {
		if (n < 2) return 0;
		const variance = (sumsq - (sum * sum) / n) / (n - 1);
		return variance > 0 ? Math.sqrt(variance) : 0;
	}
	throw new Error(`unknown reducer: ${r}`);
}

/** Collapse each metric's `{n, sum, sumsq}` triplet to a single scalar per
 *  the requested reducer. Non-metric columns pass through unchanged. `raw`
 *  returns rows untouched.
 *
 *  `dropCols` strips the named columns from each output row — used by the
 *  rollup handler to scrub the `{anchor}_h3_cell` value that pyrmts leaves
 *  on stitched rows (it's a stale label from one of the summed source rows
 *  — the rollup endpoint logically has no cell). */
export function reduceRows(rows: Row[], reducer: Reducer, dropCols: string[] = []): Row[] {
	if (reducer === 'raw') {
		if (!dropCols.length) return rows;
		return rows.map((row) => {
			const out: Row = { ...row };
			for (const c of dropCols) delete out[c];
			return out;
		});
	}
	return rows.map((row) => {
		const out: Row = {};
		for (const k in row) {
			out[k] = row[k];
		}
		for (const m of METRICS) {
			const n = Number(row[`${m}_n`] ?? 0);
			const sum = Number(row[`${m}_sum`] ?? 0);
			const sumsq = Number(row[`${m}_sumsq`] ?? 0);
			out[m] = applyReducer(n, sum, sumsq, reducer);
			delete out[`${m}_n`];
			delete out[`${m}_sum`];
			delete out[`${m}_sumsq`];
		}
		for (const c of dropCols) delete out[c];
		return out;
	});
}

// ─────────────────────────────────────────────────────────────────────
// Request parsing + handler.

function parseInstant(s: string | null): Date | null {
	if (s === null) return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

function parseBBox(s: string | null): BBox | null {
	if (s === null) return null;
	const parts = s.split(',').map((x) => Number(x.trim()));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
	const [minLat, minLng, maxLat, maxLng] = parts as [number, number, number, number];
	return { minLat, minLng, maxLat, maxLng };
}

function parsePositiveInt(s: string | null, fallback: number): number | null {
	if (s === null) return fallback;
	const n = Number.parseInt(s, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function errorResponse(status: number, message: string, cors: string | null): Response {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	return new Response(JSON.stringify({ error: message }), { status, headers });
}

/** Read `filter.<dim>=v1,v2,...` for each declared dim; return a
 *  pyrmts-shape `filters` array (or `undefined` if none specified). */
function parseDimFilters(url: URL): { col: string; values: string[] }[] | undefined {
	const out: { col: string; values: string[] }[] = [];
	for (const d of DIMS) {
		const raw = url.searchParams.get(`filter.${d}`);
		if (!raw) continue;
		const values = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
		if (values.length) out.push({ col: d, values });
	}
	return out.length ? out : undefined;
}

/** Core handler — runs plan/fetch/filter/stitch and applies reducer. */
async function serveRidesReduced(
	pyramid: Pyramid,
	request: Request,
	cors: string | null,
	dropCellCol: boolean,
): Promise<Response> {
	const url = new URL(request.url);
	const from = parseInstant(url.searchParams.get('from'));
	const to = parseInstant(url.searchParams.get('to'));
	if (from === null || to === null) {
		return errorResponse(400, 'from and to query params required (ISO-8601)', cors);
	}
	const binBudget = parsePositiveInt(url.searchParams.get('bin_budget'), 1024);
	if (binBudget === null) return errorResponse(400, 'invalid bin_budget', cors);
	const cellBudget = parsePositiveInt(url.searchParams.get('cell_budget'), 1024);
	if (cellBudget === null) return errorResponse(400, 'invalid cell_budget', cors);
	const bbox = parseBBox(url.searchParams.get('bbox'));
	if (bbox === null) return errorResponse(400, 'bbox required (minLat,minLng,maxLat,maxLng)', cors);

	const reducerRaw = url.searchParams.get('reducer') ?? DEFAULT_REDUCER;
	if (!REDUCERS.includes(reducerRaw as Reducer)) {
		return errorResponse(400, `bad reducer '${reducerRaw}'; one of ${REDUCERS.join('|')}`, cors);
	}
	const reducer = reducerRaw as Reducer;

	const rgFilters = parseDimFilters(url);

	// Optional caller-supplied cell list — overrides bbox-derived
	// `plan.outputCells`. Used for region stacking: caller provides the
	// h3-covering of each region. The cells' resolution is inferred from
	// the hash (`char[1]`), overriding `plan.outputRes` too — otherwise
	// the planner's bbox-derived `outputRes` could mismatch the cells'
	// resolution and `filterCellsAndRes` silently drops everything.
	const cellsRaw = url.searchParams.get('cells');
	const userCells = cellsRaw
		? cellsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: null;
	if (userCells !== null && userCells.length === 0) {
		return errorResponse(400, '`cells` param given but empty', cors);
	}

	const plan = planGeoQuery(pyramid, { range: { from, to }, binBudget, bbox, cellBudget });
	const outputCells = userCells ?? plan.outputCells;
	// h3 cell-id hex string: char at index 1 encodes resolution (single hex
	// digit, max h3 res = 15). When caller passes cells, derive from those.
	const outputRes = userCells !== null
		? parseInt(userCells[0]![1]!, 16)
		: plan.outputRes;
	const shardRows = await Promise.all(
		plan.segments.map((seg) => fetchSegmentRows(pyramid.storage, seg.keys, {
			binCol: pyramid.binCol,
			range: { from: seg.from, to: seg.to },
			filters: rgFilters,
		})),
	);
	const filtered = shardRows.map((rows) =>
		filterCellsAndRes(rows, pyramid.geo!.cellCol, outputRes, outputCells),
	);
	const stitched = stitch({ pyramid, plan, shardRows: filtered });
	const dropCols = dropCellCol ? [pyramid.geo!.cellCol] : [];
	const reduced = reduceRows(stitched, reducer, dropCols);

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	return new Response(JSON.stringify({
		records: reduced,
		reducer,
		anchor: (pyramid.keyTemplate.includes('/start/') ? 'start' : 'end') as Anchor,
		plan: {
			outputTier: plan.outputTier.name,
			outputBin: plan.outputBin,
			outputRes,
			outputCells,
			authoritativeEnd: plan.authoritativeEnd?.toISOString() ?? null,
			segments: plan.segments.map((s) => ({
				tier: s.shardTier.name,
				from: s.from.toISOString(),
				to: s.to.toISOString(),
				reaggregate: s.reaggregate,
				keys: s.keys,
			})),
		},
	}), { headers });
}

function parseAnchor(url: URL, cors: string | null): Anchor | Response {
	const raw = url.searchParams.get('anchor') ?? DEFAULT_ANCHOR;
	if (!ANCHORS.includes(raw as Anchor)) {
		return errorResponse(400, `bad anchor '${raw}'; one of ${ANCHORS.join('|')}`, cors);
	}
	return raw as Anchor;
}

/** HTTP handler for `/api/rides-v1` — bbox rollup, one row per (dt, dims).
 *  Strips the `{anchor}_h3_cell` column from response rows (rollup has no
 *  meaningful cell value). */
export async function serveRidesV1(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	const cors = corsOrigin || null;
	const anchor = parseAnchor(new URL(request.url), cors);
	if (anchor instanceof Response) return anchor;
	return serveRidesReduced(ridesPyramid(bucket, anchor), request, cors, true);
}

/** HTTP handler for `/api/rides-v1/cells` — per-cell breakdown preserved. */
export async function serveRidesV1Cells(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	const cors = corsOrigin || null;
	const anchor = parseAnchor(new URL(request.url), cors);
	if (anchor instanceof Response) return anchor;
	return serveRidesReduced(ridesCellsPyramid(bucket, anchor), request, cors, false);
}
