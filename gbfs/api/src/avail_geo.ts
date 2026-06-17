/**
 * pyrmts-geo CFW glue for ctbk's avail-v3 pyramid (S2-keyed).
 *
 *   Storage: `avail-v3/<tier>/<period>.parquet`
 *            (built by `ctbk avail-v3-build`, see `ctbk/avail_v3.py` +
 *            `specs/avail-pyramid-v3-s2.md`)
 *   Tiers:   18 — 1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h,
 *                 1d, 3d, 7d, 1mo, 3mo, 1y
 *   Levels:  S2 [10..15] — matches `rides-v3`, so FE covers computed
 *            via `s2Index.minimalCover` are reusable across both pyramids.
 *
 *   Row schema:
 *     s2_cell : STRING       S2 hex token (level encoded in length)
 *     dt      : INT64        unix ms — bucket start
 *     bikes   : STRING       JSON {state_str: observation_count}
 *     ebikes  : STRING       JSON
 *     docks   : STRING       JSON
 *     disabled: STRING       JSON
 *     pending : STRING       JSON
 *
 * Endpoints (mounted from `index.ts`):
 *   GET /api/avail-v3[/cells]?from=&to=&bbox=&bin_budget=&cell_budget=&reducer=
 *                            [&cells=…&cells.exclude=…]
 *
 * Server-side reducer dispatch: when `?reducer=mean|p50|min|max|...` (default
 * `mean`), each metric's histogram column collapses to a scalar before the
 * response is serialized. ~10–20× smaller payloads than `?reducer=hist`.
 *
 */
import {
	stitch,
	type Row,
	type Tier,
} from 'pyrmts';
import { parquetBackend } from 'pyrmts';
import { r2Storage } from 'pyrmts-cfw';
import {
	filterCellsAndRes,
	planGeoQuery,
	s2Index,
	type BBox,
	type GeoPyramid,
} from 'pyrmts-geo';

const METRICS = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;
type Metric = typeof METRICS[number];

export const REDUCERS = ['mean', 'min', 'max', 'p05', 'p25', 'p50', 'p75', 'p95', 'hist'] as const;
export type Reducer = typeof REDUCERS[number];
const DEFAULT_REDUCER: Reducer = 'mean';

/** Full 18-tier ladder mirroring `ctbk/avail_v3.py:TIER_SPECS`.
 *  R2 path `name`s use `<N>m` for minutes (matching the builder's
 *  `TIER_SPECS` keys); pyrmts `bin`/`shard` Duration strings use the
 *  typed `<N>min` form (`m` collides with `mo` in pyrmts's TimeUnit). */
const TIERS: Tier[] = [
	{ name: '1m',  bin: '1min',  shard: '1h'  },
	{ name: '2m',  bin: '2min',  shard: '1h'  },
	{ name: '3m',  bin: '3min',  shard: '1h'  },
	{ name: '5m',  bin: '5min',  shard: '1d'  },
	{ name: '10m', bin: '10min', shard: '1d'  },
	{ name: '15m', bin: '15min', shard: '1d'  },
	{ name: '30m', bin: '30min', shard: '1d'  },
	{ name: '1h',  bin: '1h',    shard: '1mo' },
	{ name: '2h',  bin: '2h',    shard: '1mo' },
	{ name: '3h',  bin: '3h',    shard: '1mo' },
	{ name: '6h',  bin: '6h',    shard: '1mo' },
	{ name: '12h', bin: '12h',   shard: '1mo' },
	{ name: '1d',  bin: '1d',    shard: '1y'  },
	{ name: '3d',  bin: '3d',    shard: '1y'  },
	{ name: '7d',  bin: '7d',    shard: '1y'  },
	{ name: '1mo', bin: '1mo',   shard: '1y'  },
	{ name: '3mo', bin: '3mo',   shard: '1y'  },
	{ name: '1y',  bin: '1y',    shard: 'all' },
];

const KEY_TEMPLATE = 'avail-v3/{tier}/{period}.parquet';
const RESOLUTIONS = [15, 14, 13, 12, 11, 10];

function makeBaseProps(bucket: R2Bucket): Omit<GeoPyramid, 'dims'> {
	return {
		storage: parquetBackend(r2Storage(bucket)),
		keyTemplate: KEY_TEMPLATE,
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'histogram' as const })),
		tiers: TIERS,
		geo: { cellCol: 's2_cell', resolutions: RESOLUTIONS, index: s2Index },
	};
}

/** Rollup pyramid — empty `dims` so `stitch` collapses cells, leaving
 *  one row per (dt) summed across the bbox/cells covering set. */
export function availV3Pyramid(bucket: R2Bucket): GeoPyramid {
	return { ...makeBaseProps(bucket), dims: [] };
}

/** Per-cell pyramid — adds `s2_cell` to dims so stitch preserves
 *  cell-level breakdown. */
export function availV3CellsPyramid(bucket: R2Bucket): GeoPyramid {
	return { ...makeBaseProps(bucket), dims: [{ name: 's2_cell', type: 'string' }] };
}

// ─────────────────────────────────────────────────────────────────────
// Histogram reducer math.

function histogramMean(h: Record<string, number>): number | null {
	let total = 0;
	let weighted = 0;
	for (const k in h) {
		const w = h[k]!;
		weighted += Number(k) * w;
		total += w;
	}
	return total > 0 ? weighted / total : null;
}

function histogramMin(h: Record<string, number>): number | null {
	let m: number | null = null;
	for (const k in h) {
		if (h[k]! <= 0) continue;
		const v = Number(k);
		if (m === null || v < m) m = v;
	}
	return m;
}

function histogramMax(h: Record<string, number>): number | null {
	let m: number | null = null;
	for (const k in h) {
		if (h[k]! <= 0) continue;
		const v = Number(k);
		if (m === null || v > m) m = v;
	}
	return m;
}

function histogramQuantile(h: Record<string, number>, p: number): number | null {
	const entries = Object.entries(h)
		.map(([k, v]) => [Number(k), v] as const)
		.filter(([, v]) => v > 0)
		.sort((a, b) => a[0] - b[0]);
	if (entries.length === 0) return null;
	let total = 0;
	for (const [, v] of entries) total += v;
	if (total <= 0) return null;
	const target = p * (total - 1);
	let cum = 0;
	for (let i = 0; i < entries.length; i++) {
		const [state, w] = entries[i]!;
		const next = cum + w;
		if (target <= next - 1) {
			const frac = target - Math.floor(target);
			if (frac === 0 || target < next - 1) return state;
			const nextState = entries[i + 1]?.[0] ?? state;
			return state + frac * (nextState - state);
		}
		cum = next;
	}
	return entries[entries.length - 1]![0];
}

const PCT_FOR_REDUCER: Record<string, number> = {
	p05: 0.05, p25: 0.25, p50: 0.5, p75: 0.75, p95: 0.95,
};

function applyOne(h: Record<string, number>, r: Reducer): number | null {
	if (r === 'mean') return histogramMean(h);
	if (r === 'min') return histogramMin(h);
	if (r === 'max') return histogramMax(h);
	if (r === 'hist') return null;  // unreached; caller passes histogram through
	const pct = PCT_FOR_REDUCER[r];
	if (pct === undefined) throw new Error(`unknown reducer: ${r}`);
	return histogramQuantile(h, pct);
}

/** Collapse each metric column from `Record<string, number>` (histogram) to a
 *  single scalar per the requested reducer. Non-histogram columns
 *  (dt / s2_cell / other dims) pass through unchanged. `hist` returns the
 *  rows untouched (caller wants the full distribution). */
export function reduceRows(rows: Row[], reducer: Reducer): Row[] {
	if (reducer === 'hist') return rows;
	const metricsSet = new Set<string>(METRICS);
	return rows.map((row) => {
		const out: Row = {};
		for (const k in row) {
			const v = row[k];
			if (metricsSet.has(k) && typeof v === 'object' && v !== null) {
				out[k] = applyOne(v as Record<string, number>, reducer);
			} else {
				out[k] = v;
			}
		}
		return out;
	});
}

// ─────────────────────────────────────────────────────────────────────
// Request parsing + handler

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

/** Core handler — runs plan/fetch/filter/stitch and applies reducer.
 *
 * URL contract mirrors `/api/rides-v{1,2,3}` (`serveRidesReduced`):
 *   - Either `bbox=…` (planner picks output cells via `pickResolution`),
 *     or `cells=` + optional `cells.exclude=` (caller-supplied cover, e.g.
 *     `s2Index.minimalCover` output for an I/E station-set).
 *   - When `cells=` is provided, `bbox` is ignored. The cover may be
 *     mixed-resolution (S2 `minimalCover` emits parent + leaf entries);
 *     the planner skips `pickResolution` and the post-fetch filter uses
 *     `filterCellsByCover` (lineage walk) instead of single-level
 *     `filterCellsAndRes`.
 *   - No I/E sign-flip arithmetic here (avail uses the histogram monoid;
 *     subtraction is ill-defined). The lineage walk just drops rows under
 *     exclude ancestors, keeping rows under include ancestors. */
async function serveGeoReduced(
	pyramid: GeoPyramid,
	request: Request,
	cors: string | null,
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

	// Optional caller-supplied cover. When present, `bbox` is unused.
	const cellsRaw = url.searchParams.get('cells');
	const userCells = cellsRaw
		? cellsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: null;
	if (userCells !== null && userCells.length === 0) {
		return errorResponse(400, '`cells` param given but empty', cors);
	}
	const cellsExcludeRaw = url.searchParams.get('cells.exclude');
	const userCellsExclude = cellsExcludeRaw
		? cellsExcludeRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: [];

	const bbox = userCells === null ? parseBBox(url.searchParams.get('bbox')) : null;
	if (userCells === null && bbox === null) {
		return errorResponse(400, 'either `bbox` or `cells` is required', cors);
	}

	const reducerRaw = url.searchParams.get('reducer') ?? DEFAULT_REDUCER;
	if (!REDUCERS.includes(reducerRaw as Reducer)) {
		return errorResponse(400, `bad reducer '${reducerRaw}'; one of ${REDUCERS.join('|')}`, cors);
	}
	const reducer = reducerRaw as Reducer;

	const index = s2Index;
	// `userOutputRes` mirrors the rides handler: single-level cover →
	// that level; mixed-resolution cover (or includes+excludes) → `-1`
	// sentinel ("don't filter rows by exact level"). Avail's exact-match
	// filter below doesn't actually use `outputRes` but the plan response
	// carries it so the FE knows what was used.
	const userCoverLevels = userCells !== null
		? Array.from(new Set(userCells.map((c) => index.cellLevel(c))))
		: [];
	const userOutputRes = userCells !== null
		? (userCoverLevels.length > 1 || userCellsExclude.length > 0 ? -1 : userCoverLevels[0]!)
		: null;

	// `outputCells: {res, cells}` path bypasses `pickResolution`. See
	// `pyrmts/specs/done/plan-geo-query-precomputed-cover.md`.
	const plan = userCells !== null
		? planGeoQuery(pyramid, { range: { from, to }, binBudget, outputCells: { res: userOutputRes!, cells: userCells } })
		: planGeoQuery(pyramid, { range: { from, to }, binBudget, bbox: bbox!, cellBudget });

	// Push the cell list down as an RG-prune filter on the cellCol. For
	// `(cell, dt)`-sorted shards this lets hyparquet skip whole row groups
	// whose `cellCol` range doesn't overlap the cover.
	const allCoverCells = userCells !== null ? [...userCells, ...userCellsExclude] : null;
	const cellCol = pyramid.geo!.cellCol;
	const allFilters = allCoverCells
		? [{ col: cellCol, values: allCoverCells }]
		: [];

	// Thread `binCol` + per-segment range so hyparquet prunes row groups by
	// `dt` column stats — shards are `(dt, s2_cell)`-sorted with small
	// row groups, so a sub-shard time window reads only the matching RGs.
	const shardRows = await Promise.all(
		plan.segments.map((seg) => pyramid.storage.fetchSegment(seg, {
			binCol: pyramid.binCol,
			range: { from: seg.from, to: seg.to },
			filters: allFilters.length ? allFilters : undefined,
		})),
	);

	// Filter to keep only rows the cover claims. Three paths:
	//   - User cover (include∪exclude — multi-level or single, no sign-flip
	//     arithmetic since avail is the histogram monoid). Exact-match by
	//     cell ID against the include set. Note: this works correctly for
	//     covers `minimalCover` emits whose include cells live at the same
	//     resolutions the data was materialized at. A mixed-resolution
	//     cover with a parent include + child exclude would NOT give
	//     "parent minus child" — for that we'd need cover-aware filtering
	//     at the build/sum level, deferred until a real consumer demands it.
	//   - No user cover: bbox-derived `plan.outputCells` membership at
	//     `plan.outputRes`.
	const filtered = userCells !== null
		? (() => {
			const includeSet = new Set(userCells);
			return shardRows.map((rows) => rows.filter((r) => includeSet.has(r[cellCol] as string)));
		})()
		: shardRows.map((rows) => filterCellsAndRes(rows, cellCol, plan.outputRes, plan.outputCells, index));
	const stitched = stitch({ pyramid, plan, shardRows: filtered });
	const reduced = reduceRows(stitched, reducer);

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	return new Response(JSON.stringify({
		records: reduced,
		reducer,
		plan: {
			outputTier: plan.outputTier.name,
			outputBin: plan.outputBin,
			outputRes: plan.outputRes,
			outputCells: plan.outputCells,
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

/** HTTP handler for `/api/avail-v3` — v3 rollup over bbox (S2-keyed). */
export async function serveAvailV3(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availV3Pyramid(bucket), request, corsOrigin || null);
}

/** HTTP handler for `/api/avail-v3/cells` — v3 per-cell rows preserved. */
export async function serveAvailV3Cells(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availV3CellsPyramid(bucket), request, corsOrigin || null);
}
