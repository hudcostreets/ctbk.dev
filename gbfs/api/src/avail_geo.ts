/**
 * pyrmts-geo CFW glue for ctbk's avail pyramids (PoC + v2, served side-by-side).
 *
 * Two pyramids, same row schema, same query-handler code path — only the R2
 * key template + tier ladder differ:
 *
 *   PoC (`avail-geo/<tier>/<period>.parquet`, built by `ctbk avail-geo-build`):
 *     tiers `h1 / d1 / mo1` — derived from Cascade-compactor `avail/agg/h1/`
 *     (has sample-drop gaps; mean ~37 / max 55 min per (station,hour,metric)).
 *     Served at `/api/avail-geo[/cells]` (existing FE consumers stable).
 *
 *   v2  (`avail-v2/<tier>/<period>.parquet`, built by `ctbk avail-v2-build`,
 *     see `ctbk/avail_v2.py` + `specs/avail-pyramid-v2.md`):
 *     tiers `1h / 2h / 3h / 6h / 12h / 1d / 3d / 7d / 1mo / 1y` — derived
 *     directly from loader 1m@1m shards (no drops). Served at
 *     `/api/avail-v2[/cells]` for shadow-mode dual-read against the PoC
 *     before the eventual cutover (§5 step 3 of `specs/avail-pyramid-v2.md`).
 *
 * Tiers omitted from the v2 serving config (still built on R2):
 *   - sub-hour (1m, 2m, 3m, 5m, 10m, 15m, 30m): path-format mismatch with
 *     pyrmts's `formatPeriod('1h')` — R2 uses `<date>/<hh>.parquet`; pyrmts
 *     wants `<date>T<hh>.parquet`. Reconciliation is a follow-up.
 *   - 3mo: pyrmts `floorToSpan` doesn't support multi-unit calendar bins.
 *
 *  Schema (per row):
 *    h3_cell : STRING       (resolution encoded in high bits)
 *    dt      : INT64        unix ms — bucket start
 *    bikes   : STRING       JSON {state: minutes}
 *    ebikes  : STRING       JSON
 *    docks   : STRING       JSON
 *    disabled: STRING       JSON
 *    pending : STRING       JSON
 *
 * Endpoints (mounted from `index.ts`):
 *   GET /api/avail-geo[/cells]?from=&to=&bbox=&bin_budget=&cell_budget=&reducer=
 *   GET /api/avail-v2[/cells]?from=&to=&bbox=&bin_budget=&cell_budget=&reducer=
 *
 * Server-side reducer dispatch: when `?reducer=mean|p50|min|max|...` (default
 * `mean`), each metric's histogram column collapses to a scalar before the
 * response is serialized. ~10–20× smaller payloads than `?reducer=hist`.
 */
import {
	stitch,
	type Pyramid,
	type Row,
	type Tier,
} from 'pyrmts';
import { parquetBackend } from 'pyrmts';
import { r2Storage } from 'pyrmts-cfw';
import {
	filterCellsAndRes,
	getSpatialIndex,
	planGeoQuery,
	type BBox,
	type SpatialIndex,
} from 'pyrmts-geo';

const METRICS = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;
type Metric = typeof METRICS[number];

export const REDUCERS = ['mean', 'min', 'max', 'p05', 'p25', 'p50', 'p75', 'p95', 'hist'] as const;
export type Reducer = typeof REDUCERS[number];
const DEFAULT_REDUCER: Reducer = 'mean';

const POC_TIERS: Tier[] = [
	{ name: 'h1',  bin: '1h',  shard: '1d'  },
	{ name: 'd1',  bin: '1d',  shard: '1mo' },
	{ name: 'mo1', bin: '1mo', shard: '1y'  },
];

const V2_TIERS: Tier[] = [
	{ name: '1h',  bin: '1h',  shard: '1mo' },
	{ name: '2h',  bin: '2h',  shard: '1mo' },
	{ name: '3h',  bin: '3h',  shard: '1mo' },
	{ name: '6h',  bin: '6h',  shard: '1mo' },
	{ name: '12h', bin: '12h', shard: '1mo' },
	{ name: '1d',  bin: '1d',  shard: '1y'  },
	{ name: '3d',  bin: '3d',  shard: '1y'  },
	{ name: '7d',  bin: '7d',  shard: '1y'  },
	{ name: '1mo', bin: '1mo', shard: '1y'  },
	{ name: '1y',  bin: '1y',  shard: 'all' },
];

/** Shared pyramid skeleton; only key-template + tier ladder + `dims` vary. */
function makeBaseProps(bucket: R2Bucket, keyTemplate: string, tiers: Tier[]): Omit<Pyramid, 'dims'> {
	return {
		storage: parquetBackend(r2Storage(bucket)),
		keyTemplate,
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'histogram' as const })),
		tiers,
		geo: {
			cellCol: 'h3_cell',
			resolutions: [9, 7, 5],
		},
	};
}

/** PoC pyramid — `avail-geo/<tier>/<period>.parquet`, 3-tier ladder. */
export function availGeoPyramid(bucket: R2Bucket): Pyramid {
	return { ...makeBaseProps(bucket, 'avail-geo/{tier}/{period}.parquet', POC_TIERS), dims: [] };
}
export function availGeoCellsPyramid(bucket: R2Bucket): Pyramid {
	return { ...makeBaseProps(bucket, 'avail-geo/{tier}/{period}.parquet', POC_TIERS), dims: [{ name: 'h3_cell', type: 'string' }] };
}

/** v2 pyramid — `avail-v2/<tier>/<period>.parquet`, 10-tier ladder. */
export function availV2Pyramid(bucket: R2Bucket): Pyramid {
	return { ...makeBaseProps(bucket, 'avail-v2/{tier}/{period}.parquet', V2_TIERS), dims: [] };
}
export function availV2CellsPyramid(bucket: R2Bucket): Pyramid {
	return { ...makeBaseProps(bucket, 'avail-v2/{tier}/{period}.parquet', V2_TIERS), dims: [{ name: 'h3_cell', type: 'string' }] };
}

// ─────────────────────────────────────────────────────────────────────
// Histogram reducer math (faithful port of legacy `availHistQuantile`).

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
 *  (dt / h3_cell / other dims) pass through unchanged. `hist` returns the
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
	pyramid: Pyramid,
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

	const index: SpatialIndex = getSpatialIndex(pyramid);
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
	// `dt` column stats. v2 shards: `avail_v2.py` writes single 956K-row RG
	// per shard (rows `(cell, dt)`-sorted), so a sub-day query would still
	// read the full month. See `avail-pyramid-v2.md` §7 (smaller RGs +
	// `dt`-first sort) for the build-side fix.
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

/** HTTP handler for `/api/avail-geo` — PoC rollup over bbox. */
export async function serveAvailGeo(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availGeoPyramid(bucket), request, corsOrigin || null);
}

/** HTTP handler for `/api/avail-geo/cells` — PoC per-cell rows preserved. */
export async function serveAvailGeoCells(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availGeoCellsPyramid(bucket), request, corsOrigin || null);
}

/** HTTP handler for `/api/avail-v2` — v2 rollup over bbox. */
export async function serveAvailV2(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availV2Pyramid(bucket), request, corsOrigin || null);
}

/** HTTP handler for `/api/avail-v2/cells` — v2 per-cell rows preserved. */
export async function serveAvailV2Cells(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availV2CellsPyramid(bucket), request, corsOrigin || null);
}
