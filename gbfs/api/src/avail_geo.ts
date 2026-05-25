/**
 * pyrmts-geo CFW glue for ctbk's v2 avail pyramid.
 *
 * Reads h3-cell-keyed `avail-v2/<tier>/<period>.parquet` shards (built by
 * `ctbk avail-v2-build`, see `ctbk/avail_v2.py` + `specs/avail-pyramid-v2.md`).
 * Each shard contains rows at every materialized h3 resolution (9, 7, 5),
 * sorted by `(h3_cell, dt)`. Histograms per metric stored as JSON-string
 * columns (decoded by pyrmts's `histogram` monoid on-the-fly).
 *
 * Tier coverage in this serving config: 1h, 1d, 1mo, 1y — the four
 * non-sub-hour tiers whose `{period}` formatting already matches pyrmts's
 * `formatPeriod` convention (sub-hour tiers in R2 use `<date>/<hh>` paths
 * that won't match pyrmts's `<date>T<hh>` until reformatted; see TODO).
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
 *
 * Server-side reducer dispatch: when `?reducer=mean|p50|min|max|...` (default
 * `mean`), each metric's histogram column collapses to a scalar before the
 * response is serialized. ~10–20× smaller payloads than `?reducer=hist`.
 */
import {
	fetchSegmentRows,
	stitch,
	type Pyramid,
	type Row,
} from 'pyrmts';
import { r2Storage } from 'pyrmts-cfw';
import { filterCellsAndRes, planGeoQuery, type BBox } from 'pyrmts-geo';

const METRICS = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;
type Metric = typeof METRICS[number];

export const REDUCERS = ['mean', 'min', 'max', 'p05', 'p25', 'p50', 'p75', 'p95', 'hist'] as const;
export type Reducer = typeof REDUCERS[number];
const DEFAULT_REDUCER: Reducer = 'mean';

/** Common pyramid params; only `dims` differs between rollup + per-cell variants. */
function basePyramidProps(bucket: R2Bucket): Omit<Pyramid, 'dims'> {
	return {
		storage: r2Storage(bucket),
		keyTemplate: 'avail-v2/{tier}/{period}.parquet',
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'histogram' as const })),
		// v2 ladder. Sub-hour tiers (1m, 2m, 3m, 5m, 10m, 15m, 30m) and `3mo`
		// are also built on R2 but omitted here:
		//   - sub-hour: path-format mismatch with pyrmts's `formatPeriod('1h')`
		//     (R2 uses `<date>/<hh>.parquet`; pyrmts wants `<date>T<hh>.parquet`)
		//   - 3mo: pyrmts `floorToSpan` doesn't support multi-unit calendar bins
		tiers: [
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
		],
		geo: {
			cellCol: 'h3_cell',
			resolutions: [9, 7, 5],
		},
	};
}

/** Rollup pyramid — `dims: []` so `stitch` collapses all cells in the bbox
 *  into ONE row per time bucket (system-over-viewport trend). */
export function availGeoPyramid(bucket: R2Bucket): Pyramid {
	return { ...basePyramidProps(bucket), dims: [] };
}

/** Per-cell pyramid — `dims: ['h3_cell']` so `stitch` preserves one row per
 *  `(binStart, h3_cell)` (heatmap-on-map shape). Same underlying shards. */
export function availGeoCellsPyramid(bucket: R2Bucket): Pyramid {
	return { ...basePyramidProps(bucket), dims: [{ name: 'h3_cell', type: 'string' }] };
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

/** Core handler — runs plan/fetch/filter/stitch and applies reducer. */
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
	const bbox = parseBBox(url.searchParams.get('bbox'));
	if (bbox === null) return errorResponse(400, 'bbox required (minLat,minLng,maxLat,maxLng)', cors);

	const reducerRaw = url.searchParams.get('reducer') ?? DEFAULT_REDUCER;
	if (!REDUCERS.includes(reducerRaw as Reducer)) {
		return errorResponse(400, `bad reducer '${reducerRaw}'; one of ${REDUCERS.join('|')}`, cors);
	}
	const reducer = reducerRaw as Reducer;

	const plan = planGeoQuery(pyramid, { range: { from, to }, binBudget, bbox, cellBudget });
	const shardRows = await Promise.all(
		plan.segments.map((seg) => fetchSegmentRows(pyramid.storage, seg.keys)),
	);
	// Filter to chosen output resolution + bbox-covering cells.
	const filtered = shardRows.map((rows) =>
		filterCellsAndRes(rows, pyramid.geo!.cellCol, plan.outputRes, plan.outputCells),
	);
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

/** HTTP handler for `/api/avail-geo` — rollup over bbox. */
export async function serveAvailGeo(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availGeoPyramid(bucket), request, corsOrigin || null);
}

/** HTTP handler for `/api/avail-geo/cells` — per-cell rows preserved. */
export async function serveAvailGeoCells(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoReduced(availGeoCellsPyramid(bucket), request, corsOrigin || null);
}
