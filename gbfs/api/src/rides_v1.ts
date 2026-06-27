/**
 * pyrmts-geo CFW glue for ctbk's rides pyramids (`rides-v1`, `rides-v2`).
 *
 * Two variants × two anchors = four sibling pyramids, all built by
 * `ctbk/rides_v1.py`:
 *   rides-{v1,v2}/start/<tier>/<period>.parquet — `start_h3_cell`-anchored
 *   rides-{v1,v2}/end/<tier>/<period>.parquet   — `end_h3_cell`-anchored
 *
 * v1 vs v2: same schema; v2 has coarser shard sizes (~1000 bins each) and
 * `(cell, dt)` sort — see `specs/done/rides-pyramid-v2.md`. FE selects via
 * `?pyramid=v1|v2` (mapped to endpoint `/api/rides-v{1,2}[/cells]`).
 *
 * 11-tier ladder: 1h / 3h / 6h / 12h / 1d / 3d / 7d / 14d / 1mo / 3mo / 1y.
 * h3 resolutions: 9 / 7 / 5.
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
	stitch,
	type FetchTrace,
	type Pyramid,
	type Row,
	type Tier,
} from 'pyrmts';
import { parquetBackend } from 'pyrmts';
import { d1Backend, r2Storage } from 'pyrmts-cfw';
import {
	filterCellsAndRes,
	filterCellsByCover,
	getSpatialIndex,
	planGeoQuery,
	s2Index,
	type BBox,
	type GeoPyramid,
	type SpatialIndex,
	type SpatialSet,
} from 'pyrmts-geo';

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

export const VARIANTS = ['v1', 'v2', 'v3'] as const;
export type Variant = typeof VARIANTS[number];

const V2_TIERS: Tier[] = [
	{ name: '1h',  bin: '1h',  shard: '1mo' },
	{ name: '3h',  bin: '3h',  shard: '3mo' },
	{ name: '6h',  bin: '6h',  shard: '6mo' },
	{ name: '12h', bin: '12h', shard: '1y'  },
	{ name: '1d',  bin: '1d',  shard: 'all' },
	{ name: '3d',  bin: '3d',  shard: 'all' },
	{ name: '7d',  bin: '7d',  shard: 'all' },
	{ name: '14d', bin: '14d', shard: 'all' },
	{ name: '1mo', bin: '1mo', shard: 'all' },
	{ name: '3mo', bin: '3mo', shard: 'all' },
	{ name: '1y',  bin: '1y',  shard: 'all' },
];

/** v1: every tier 1h-12h on 1mo shards, every 1d-3mo tier on 1y, 1y on `all`.
 *  v2: consolidated cascade per `specs/done/rides-pyramid-v2.md` — ~1000
 *  bins per shard so a typical viewport reads one shard.
 *  v3: S2-keyed at levels 10..15, same cascade as v2 — see
 *  `specs/done/rides-pyramid-v3.md`. */
const TIERS_BY_VARIANT: Record<Variant, Tier[]> = {
	v1: [
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
	],
	v2: V2_TIERS,
	v3: V2_TIERS,
};

/** v1/v2 use H3 (`<anchor>_h3_cell`); v3 uses S2 token (`<anchor>_s2_cell`). */
function cellCol(anchor: Anchor, variant: Variant): string {
	const idx = variant === 'v3' ? 's2' : 'h3';
	return `${anchor}_${idx}_cell`;
}

/** Materialized resolutions per variant, finest-first (planner picks
 *  finest that fits cellBudget). v1/v2: H3 (9, 7, 5). v3: S2 (15..10). */
function resolutions(variant: Variant): number[] {
	return variant === 'v3' ? [15, 14, 13, 12, 11, 10] : [9, 7, 5];
}

function keyTemplate(anchor: Anchor, variant: Variant): string {
	return `rides-${variant}/${anchor}/{tier}/{period}.parquet`;
}

/** Shared pyramid skeleton; only key-template + cellCol + `dims` + `index` vary. */
function makeBaseProps(bucket: R2Bucket, anchor: Anchor, variant: Variant): Omit<GeoPyramid, 'dims'> {
	return {
		storage: parquetBackend(r2Storage(bucket)),
		keyTemplate: keyTemplate(anchor, variant),
		axis: 'time',
		binCol: 'dt',
		// pyrmts's `sum` monoid stores state as `<name>{_n,_sum,_sumsq}` —
		// one metric per logical quantity, monoid handles the triplet.
		metrics: METRICS.map((name) => ({ name, monoid: 'sum' as const })),
		tiers: TIERS_BY_VARIANT[variant],
		geo: {
			cellCol: cellCol(anchor, variant),
			resolutions: resolutions(variant),
			// v3 wires S2 (exact lineage, perfect tiling). v1/v2 fall through
			// to h3Index via `getSpatialIndex` default.
			...(variant === 'v3' ? { index: s2Index } : {}),
		},
	};
}

/** Rollup pyramid — `dims: []` so `stitch` collapses cells, leaving
 *  one row per (dt, dim-tuple) summed across the bbox-covering cell set. */
export function ridesPyramid(bucket: R2Bucket, anchor: Anchor, variant: Variant): GeoPyramid {
	return { ...makeBaseProps(bucket, anchor, variant), dims: DIMS.map((d) => ({ name: d, type: 'string' as const })) };
}

/** Per-cell pyramid — adds the cell column to dims so stitch preserves
 *  cell-level breakdown. */
export function ridesCellsPyramid(bucket: R2Bucket, anchor: Anchor, variant: Variant): GeoPyramid {
	return {
		...makeBaseProps(bucket, anchor, variant),
		dims: [
			{ name: cellCol(anchor, variant), type: 'string' as const },
			...DIMS.map((d) => ({ name: d, type: 'string' as const })),
		],
	};
}

// ─────────────────────────────────────────────────────────────────────
// D1 backend (rides-v3 only — COARSE tiers in the RIDES_V3_COARSE DB).
//
// Tables: `rides_{start,end}_{1d,3d,7d,14d,1mo,3mo,1y}` — one row per
// (cell, dt, gender, user_type, bike_type) with sum-monoid state.
//
// Dim columns are INT-encoded in D1 (gender/user_type/bike_type are
// int 0-2, see `ctbk/rides_d1.py:GENDER_INT` etc.). On fetch, the
// backend wrapper decodes back to strings so downstream stitch/reduce
// code sees the same row shape as the parquet path. See
// `specs/pyrmts-d1-backend.md` §"Verdict" — INT-encoded coarse fits
// one D1 (~6.6 GB across 14 tables); TEXT-encoded the same data is
// 12 GB (the dt secondary index also embeds the PK).

/** Dim INT→string decode maps. Must match `ctbk/rides_d1.py:DIM_MAPS`
 *  — when that builder writes a new dim value, bump these too. */
const DIM_DECODE: { [dim: string]: { [k: number]: string } } = {
	gender:    { 0: 'unknown', 1: 'male', 2: 'female' },
	user_type: { 0: 'Customer', 1: 'Subscriber', 2: 'nan' },
	bike_type: { 0: 'unknown', 1: 'classic_bike', 2: 'electric_bike' },
};
const DIM_ENCODE: { [dim: string]: { [k: string]: number } } = {
	gender:    { unknown: 0, male: 1, female: 2 },
	user_type: { Customer: 0, Subscriber: 1, nan: 2 },
	bike_type: { unknown: 0, classic_bike: 1, electric_bike: 2 },
};

/** Wrap a StorageBackend so:
 *   - incoming `filters` on dim columns get their string values encoded
 *     to INT before hitting D1's WHERE clause
 *   - returned rows have dim INT values swapped back to strings (matches
 *     the parquet row shape so stitch/reduce work without dispatching
 *     on backend)
 *   - the parquet-style cell column name (`{anchor}_s2_cell`) is
 *     translated to D1's canonical `cell` on the way down, and back to
 *     the parquet name on the way up — see `ctbk/rides_d1.py` which
 *     renames `start_s2_cell` → `cell` at load. This keeps callers (and
 *     downstream stitch/reduce code) agnostic to the storage backend. */
// Per-request scratch for backend timing diagnostics. Populated by
// `withDimCodec` (`fetchMs` = inner backend wall-time;
// `decodeMs` = post-fetch row-iteration). Drained + cleared per request
// in `serveRidesReduced`.
const __d1Diag: { fetchMs: number; decodeMs: number; rowsIn: number; calls: number; perCallMs: number[] } = {
	fetchMs: 0,
	decodeMs: 0,
	rowsIn: 0,
	calls: 0,
	perCallMs: [],
};
function resetD1Diag() {
	__d1Diag.fetchMs = 0;
	__d1Diag.decodeMs = 0;
	__d1Diag.rowsIn = 0;
	__d1Diag.calls = 0;
	__d1Diag.perCallMs = [];
}

function withDimCodec<T extends import('pyrmts').FetchOptionsBase>(
	backend: import('pyrmts').StorageBackend<T>,
	parquetCellCol: string,
): import('pyrmts').StorageBackend<T> {
	return {
		name: `${backend.name}+dim-codec`,
		async fetchSegment(segment, opts) {
			let encOpts = opts;
			if (opts?.filters) {
				const encodedFilters = opts.filters.map((f) => {
					// Rename parquet-style cellCol to D1's `cell`.
					if (f.col === parquetCellCol) {
						return 'values' in f
							? { col: 'cell', values: f.values }
							: { col: 'cell', range: f.range };
					}
					if (!('values' in f) || !(f.col in DIM_ENCODE)) return f;
					const map = DIM_ENCODE[f.col]!;
					const encVals = (f.values as readonly string[])
						.map((v) => map[v])
						.filter((v): v is number => v !== undefined);
					return { col: f.col, values: encVals };
				});
				encOpts = { ...opts, filters: encodedFilters } as T;
			}
			const t0 = performance.now();
			const rows = await backend.fetchSegment(segment, encOpts);
			const t1 = performance.now();
			__d1Diag.fetchMs += t1 - t0;
			__d1Diag.rowsIn += rows.length;
			__d1Diag.calls += 1;
			__d1Diag.perCallMs.push(Math.round((t1 - t0) * 10) / 10);
			for (const r of rows) {
				// Rename D1 `cell` back to parquet `{anchor}_s2_cell` so
				// downstream code keys off pyramid.geo.cellCol uniformly.
				if (r.cell !== undefined && r[parquetCellCol] === undefined) {
					r[parquetCellCol] = r.cell;
					delete r.cell;
				}
				for (const dim of DIMS) {
					const v = r[dim];
					if (typeof v === 'number' && DIM_DECODE[dim]) {
						const s = DIM_DECODE[dim]![v];
						if (s !== undefined) r[dim] = s;
					}
				}
			}
			const t2 = performance.now();
			__d1Diag.decodeMs += t2 - t1;
			return rows;
		},
	};
}

/** Tier names served by the `RIDES_V3_COARSE` D1 (matches
 *  `ctbk/rides_d1.py:TIER_GROUPS['COARSE']`). All other v3 tiers
 *  (`1h`/`3h`/`6h`/`12h`) fall through to the parquet backend in the
 *  hybrid v3 pyramid. */
const V3_D1_TIER_NAMES = new Set(['1d', '3d', '7d', '14d', '1mo', '3mo', '1y']);

/** Tier-routing storage backend: dispatch each `fetchSegment` to one of
 *  two underlying backends based on the segment's tier name. Used to
 *  build the hybrid v3 pyramid where D1 owns coarse tiers and parquet
 *  owns the fine ones — planner sees a single full tier ladder and
 *  picks freely, multiplex routes per call. */
function multiplexStorage<T extends import('pyrmts').FetchOptionsBase>(
	pickD1: (tierName: string) => boolean,
	d1Backend_: import('pyrmts').StorageBackend<T>,
	parquetBackend_: import('pyrmts').StorageBackend<T>,
): import('pyrmts').StorageBackend<T> {
	return {
		name: `multiplex(${d1Backend_.name}|${parquetBackend_.name})`,
		fetchSegment(segment, opts) {
			const backend = pickD1(segment.shardTier.name) ? d1Backend_ : parquetBackend_;
			return backend.fetchSegment(segment, opts);
		},
	};
}

function makeBaseHybridProps(bucket: R2Bucket, db: D1Database, anchor: Anchor): Omit<GeoPyramid, 'dims'> {
	const parquetCellCol = cellCol(anchor, 'v3');
	const d1B = withDimCodec(d1Backend(db, { tableTemplate: `rides_${anchor}_{tier}` }), parquetCellCol);
	const parquetB = parquetBackend(r2Storage(bucket));
	return {
		storage: multiplexStorage((t) => V3_D1_TIER_NAMES.has(t), d1B, parquetB),
		// keyTemplate is parquet-flavored — used by the parquet leg.
		// The D1 leg derives its table from `segment.shardTier.name` via
		// its own `tableTemplate`, so this template only affects parquet.
		keyTemplate: keyTemplate(anchor, 'v3'),
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'sum' as const })),
		tiers: TIERS_BY_VARIANT['v3'],
		geo: {
			cellCol: cellCol(anchor, 'v3'),
			resolutions: resolutions('v3'),
			index: s2Index,
		},
	};
}

/** Hybrid v3 pyramid: D1 for coarse tiers (≥1d), parquet for fine.
 *  Planner picks the finest tier within the requested bin_budget;
 *  storage layer routes per-segment. */
export function ridesPyramidV3Hybrid(bucket: R2Bucket, db: D1Database, anchor: Anchor): GeoPyramid {
	return { ...makeBaseHybridProps(bucket, db, anchor), dims: DIMS.map((d) => ({ name: d, type: 'string' as const })) };
}

/** D1-only v3 pyramid — diagnostic helper for `/api/d1-probe`. Production
 *  v3 always uses `ridesPyramidV3Hybrid`. Restricted to D1 COARSE tiers
 *  so the planner can't pick a tier that isn't in D1. */
export function ridesPyramidV3D1(db: D1Database, anchor: Anchor): GeoPyramid {
	const parquetCellCol = cellCol(anchor, 'v3');
	const d1Only = withDimCodec(d1Backend(db, { tableTemplate: `rides_${anchor}_{tier}` }), parquetCellCol);
	const coarseTiers: Tier[] = TIERS_BY_VARIANT['v3'].filter((t) => V3_D1_TIER_NAMES.has(t.name));
	return {
		storage: d1Only,
		keyTemplate: `rides_${anchor}_{tier}`,
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'sum' as const })),
		tiers: coarseTiers,
		geo: {
			cellCol: cellCol(anchor, 'v3'),
			resolutions: resolutions('v3'),
			index: s2Index,
		},
		dims: DIMS.map((d) => ({ name: d, type: 'string' as const })),
	};
}

export function ridesCellsPyramidV3Hybrid(bucket: R2Bucket, db: D1Database, anchor: Anchor): GeoPyramid {
	return {
		...makeBaseHybridProps(bucket, db, anchor),
		dims: [
			{ name: cellCol(anchor, 'v3'), type: 'string' as const },
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

/** Core handler — runs plan/fetch/filter/stitch and applies reducer.
 *
 *  Pass `?debug=1` to swap the row payload for a phase-timing diagnostic:
 *  `{ debug: { plan, phaseMs: { plan, fetch, filter, stitch, reduce, total },
 *  rowCounts: { perShard, filtered, stitched, reduced } } }`. Used to
 *  benchmark hot-path optimizations (RG size, multi-range, pre-aggregation).
 */
async function serveRidesReduced(
	pyramid: GeoPyramid,
	request: Request,
	cors: string | null,
	dropCellCol: boolean,
): Promise<Response> {
	const tStart = performance.now();
	resetD1Diag();
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
	const debug = url.searchParams.get('debug') === '1';

	const rgFilters = parseDimFilters(url);

	// Optional caller-supplied cell list — overrides bbox-derived
	// `plan.outputCells`. Used for region stacking: caller provides the
	// minimal cover of each region. Cells may be at mixed resolutions
	// (S2 `minimalCover` output); finest-level cell drives `outputRes`.
	// `cells.exclude` (optional) declares lineage-aware subtractions —
	// the cover (`SpatialSet`) shape required by `filterCellsByCover`.
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

	const tPlan = performance.now();
	const index: SpatialIndex = getSpatialIndex(pyramid);
	// Cover semantics:
	//   - No user cover: bbox-derived single-level (planner runs `pickResolution`).
	//   - Single-level user cover (no excludes): exact-match push-down; rows
	//     at the cover's own level survive (v1/v2 H3 path).
	//   - MIXED-level cover (possibly with excludes): algebraic mode. Push
	//     down `cells IN [include ∪ exclude]` — every kept row's cell
	//     equals one of the cover's tokens at its native level. Negate the
	//     sum-monoid state for exclude rows; stitch then naturally
	//     computes Σ(include) − Σ(exclude). No `filterCellsByCover`
	//     lineage walk needed; correctness rides on the monoid arithmetic.
	const userCoverLevels = userCells !== null
		? Array.from(new Set(userCells.map((c) => index.cellLevel(c))))
		: [];
	const userCoverIsMixed = userCells !== null && (userCoverLevels.length > 1 || userCellsExclude.length > 0);
	const userOutputRes = userCells !== null
		? (userCoverIsMixed ? -1 : userCoverLevels[0]!)  // -1 sentinel: don't filter by level
		: null;
	// `outputCells` (caller-supplied cover) path bypasses `pickResolution`,
	// skipping `bboxToCells`'s `RegionCoverer` allocation — avoids the V8
	// GC tail that adds 3-5s to the next async safepoint (`stmt.all()` in
	// d1Backend). See pyrmts `specs/done/plan-geo-query-precomputed-cover.md`.
	const plan = userCells !== null
		? planGeoQuery(pyramid, { range: { from, to }, binBudget, outputCells: { res: userOutputRes!, cells: userCells } })
		: planGeoQuery(pyramid, { range: { from, to }, binBudget, bbox, cellBudget });
	const outputCells = userCells ?? plan.outputCells;
	const outputRes = userCells !== null ? userOutputRes! : plan.outputRes;
	const allCoverCells = userCells !== null ? [...userCells, ...userCellsExclude] : null;
	const excludeSet = new Set(userCellsExclude);

	const tFetch = performance.now();
	// Per-segment trace buffer (debug only). When `debug=1`, each segment's
	// shard fetches append `FetchTrace` entries here, then we expose them
	// in the debug response so callers can see the actual byte-range
	// request distribution per parquet.
	const trace: FetchTrace[] = debug ? [] : undefined as unknown as FetchTrace[];
	// Push the cell list down as an RG-prune filter on the cellCol. For
	// `(cell, dt)`-sorted shards (rides-v2), each RG covers a narrow cell
	// range and ~70% of RGs can be skipped for a region-sized cell set.
	// For `(dt, cell)`-sorted shards (rides-v1), RGs cover the full cell
	// range per dt-bucket → the filter never prunes (but doesn't hurt
	// either; the canSkipRowGroup check is cheap stats arithmetic).
	//
	// Push-down filter is exact `cellCol IN values`. Use:
	//   - Single-level cover, no excludes: include cells as-is.
	//   - Mixed cover (with excludes): include ∪ exclude — kept rows have
	//     cellCol equal to one of these (push-down + RG-prune still
	//     correct); exclude rows get sign-flipped post-fetch.
	//   - No cover: no cell filter (bbox path).
	const allFilters = [
		...(rgFilters ?? []),
		...(allCoverCells ? [{ col: pyramid.geo!.cellCol, values: allCoverCells }] : []),
	];
	const shardRows = await Promise.all(
		plan.segments.map((seg) => pyramid.storage.fetchSegment(seg, {
			binCol: pyramid.binCol,
			range: { from: seg.from, to: seg.to },
			filters: allFilters.length ? allFilters : undefined,
			...(debug ? { trace } : {}),
		})),
	);

	const tFilter = performance.now();
	// Three filter paths:
	//   - Mixed cover (excludes present or multi-level): rows are already
	//     filtered by exact push-down. Sign-flip the sum-monoid state on
	//     exclude rows so `stitch` computes Σinc − Σexc.
	//   - Single-level user cover: simple set membership at the cover's level.
	//   - No user cover: bbox-derived `outputCells` membership at outputRes.
	const cellCol = pyramid.geo!.cellCol;
	const monoidCols = METRICS.flatMap((m) => [`${m}_n`, `${m}_sum`, `${m}_sumsq`]);
	const includeSet = new Set(userCells ?? []);
	// Push-down on `cellCol IN values` is RG-PRUNE only (lex range overlap),
	// not exact row-level match. We need to also row-filter to keep only
	// rows whose cell equals an include or exclude token. Then for excludes,
	// sign-flip the sum-monoid state so `stitch` computes Σinc − Σexc.
	const filtered = userCoverIsMixed
		? shardRows.map((rows) => {
			const out: Row[] = [];
			for (const r of rows) {
				const c = r[cellCol] as string;
				if (includeSet.has(c)) { out.push(r); continue; }
				if (excludeSet.has(c)) {
					const negated: Row = { ...r };
					for (const col of monoidCols) negated[col] = -Number(r[col] ?? 0);
					out.push(negated);
				}
			}
			return out;
		})
		: userCells !== null
			? shardRows.map((rows) => filterCellsAndRes(rows, cellCol, outputRes, userCells, index))
			: shardRows.map((rows) => filterCellsAndRes(rows, cellCol, outputRes, outputCells, index));

	const tStitch = performance.now();
	const stitched = stitch({ pyramid, plan, shardRows: filtered });

	const tReduce = performance.now();
	const dropCols = dropCellCol ? [pyramid.geo!.cellCol] : [];
	const reduced = reduceRows(stitched, reducer, dropCols);
	const tEnd = performance.now();

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	// Surface the worker's colo on every response so bench scripts can
	// correlate latency with geographic placement without flipping
	// `?debug=1`. Empty value if CF didn't populate `cf` (local-dev case).
	const workerColo = (request as any).cf?.colo;
	if (workerColo) headers['X-Worker-Colo'] = workerColo;
	const planSummary = {
		outputTier: plan.outputTier?.name ?? null,
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
	};
	if (debug) {
		return new Response(JSON.stringify({
			debug: {
				plan: planSummary,
				phaseMs: {
					parse: Math.round((tPlan - tStart) * 100) / 100,
					plan: Math.round((tFetch - tPlan) * 100) / 100,
					fetch: Math.round((tFilter - tFetch) * 100) / 100,
					filter: Math.round((tStitch - tFilter) * 100) / 100,
					stitch: Math.round((tReduce - tStitch) * 100) / 100,
					reduce: Math.round((tEnd - tReduce) * 100) / 100,
					total: Math.round((tEnd - tStart) * 100) / 100,
				},
				rowCounts: {
					perShard: shardRows.map((rs) => rs.length),
					filteredPerShard: filtered.map((rs) => rs.length),
					stitched: stitched.length,
					reduced: reduced.length,
				},
				d1Diag: {
					...__d1Diag,
					fetchMs: Math.round(__d1Diag.fetchMs * 100) / 100,
					decodeMs: Math.round(__d1Diag.decodeMs * 100) / 100,
					workerColo: (request as any).cf?.colo ?? null,
				},
				cellsFilter: userCells !== null ? userCells.length : null,
				dimFilters: rgFilters ?? null,
				reducer,
				anchor: (pyramid.keyTemplate.includes('/start/') ? 'start' : 'end') as Anchor,
				fetchTrace: summarizeTrace(trace),
			},
		}), { headers });
	}
	return new Response(JSON.stringify({
		records: reduced,
		reducer,
		anchor: (pyramid.keyTemplate.includes('/start/') ? 'start' : 'end') as Anchor,
		plan: planSummary,
	}), { headers });
}

/** Group `FetchTrace[]` by parquet key, summarize counts + sizes + phase
 *  breakdown. Designed for the `?debug=1` debug response — keeps the
 *  per-slice detail available but also surfaces useful aggregates
 *  (request count, total bytes fetched, footer vs data split) without
 *  forcing the caller to walk every entry. */
function summarizeTrace(trace: FetchTrace[] | undefined) {
	if (!trace || trace.length === 0) return null;
	const perKey: Record<string, {
		count: number;
		bytesTotal: number;
		msTotal: number;
		metadataSlices: number;
		dataSlices: number;
		minLen: number;
		maxLen: number;
		ranges: { start: number; end: number; length: number; ms: number; phase: string }[];
	}> = {};
	for (const t of trace) {
		const e = perKey[t.key] ??= {
			count: 0, bytesTotal: 0, msTotal: 0,
			metadataSlices: 0, dataSlices: 0,
			minLen: Infinity, maxLen: 0, ranges: [],
		};
		e.count++;
		e.bytesTotal += t.length;
		e.msTotal += t.ms;
		e.minLen = Math.min(e.minLen, t.length);
		e.maxLen = Math.max(e.maxLen, t.length);
		if (t.phase === 'metadata') e.metadataSlices++; else e.dataSlices++;
		e.ranges.push({ start: t.start, end: t.end, length: t.length, ms: t.ms, phase: t.phase });
	}
	return Object.entries(perKey).map(([key, e]) => ({
		key,
		count: e.count,
		bytesTotal: e.bytesTotal,
		msTotal: Math.round(e.msTotal * 100) / 100,
		metadataSlices: e.metadataSlices,
		dataSlices: e.dataSlices,
		minLen: e.minLen,
		maxLen: e.maxLen,
		ranges: e.ranges,
	}));
}

function parseAnchor(url: URL, cors: string | null): Anchor | Response {
	const raw = url.searchParams.get('anchor') ?? DEFAULT_ANCHOR;
	if (!ANCHORS.includes(raw as Anchor)) {
		return errorResponse(400, `bad anchor '${raw}'; one of ${ANCHORS.join('|')}`, cors);
	}
	return raw as Anchor;
}

/** HTTP handler for `/api/rides-{v1,v2,v3}` — bbox rollup, one row per
 *  (dt, dims). Strips the `{anchor}_h3_cell` column from response rows
 *  (rollup has no meaningful cell value).
 *
 *  For v3, when `?backend=d1` and a D1 binding is provided, the rollup
 *  queries `RIDES_V3_COARSE` directly (single SELECT per segment) — see
 *  `specs/pyrmts-d1-backend.md`. Other variants ignore `?backend`. */
export async function serveRides(bucket: R2Bucket, request: Request, corsOrigin: string, variant: Variant, db?: D1Database): Promise<Response> {
	const cors = corsOrigin || null;
	const url = new URL(request.url);
	const anchor = parseAnchor(url, cors);
	if (anchor instanceof Response) return anchor;
	// v3 default: hybrid (D1 for coarse tiers, parquet for fine — D1 wins on
	// CPU at large covers since SQL aggregates server-side). `?backend=parquet`
	// forces pure parquet (diagnostic); `?backend=d1` is an alias retained for
	// back-compat with the bench tooling. v1/v2 ignore `?backend`.
	const backendOverride = url.searchParams.get('backend');
	if (variant === 'v3' && db !== undefined && backendOverride !== 'parquet') {
		return serveRidesReduced(ridesPyramidV3Hybrid(bucket, db, anchor), request, cors, true);
	}
	return serveRidesReduced(ridesPyramid(bucket, anchor, variant), request, cors, true);
}

/** HTTP handler for `/api/rides-{v1,v2,v3}/cells` — per-cell breakdown preserved. */
export async function serveRidesCells(bucket: R2Bucket, request: Request, corsOrigin: string, variant: Variant, db?: D1Database): Promise<Response> {
	const cors = corsOrigin || null;
	const url = new URL(request.url);
	const anchor = parseAnchor(url, cors);
	if (anchor instanceof Response) return anchor;
	const backendOverride = url.searchParams.get('backend');
	if (variant === 'v3' && db !== undefined && backendOverride !== 'parquet') {
		return serveRidesReduced(ridesCellsPyramidV3Hybrid(bucket, db, anchor), request, cors, false);
	}
	return serveRidesReduced(ridesCellsPyramid(bucket, anchor, variant), request, cors, false);
}

// Back-compat aliases used by `index.ts` route handlers. v1/v2 accept (and
// ignore) the trailing `db` arg so all six handlers share one signature
// — index.ts can call them uniformly without per-variant dispatch.
export const serveRidesV1 = (bucket: R2Bucket, request: Request, corsOrigin: string, _db?: D1Database) => serveRides(bucket, request, corsOrigin, 'v1');
export const serveRidesV1Cells = (bucket: R2Bucket, request: Request, corsOrigin: string, _db?: D1Database) => serveRidesCells(bucket, request, corsOrigin, 'v1');
export const serveRidesV2 = (bucket: R2Bucket, request: Request, corsOrigin: string, _db?: D1Database) => serveRides(bucket, request, corsOrigin, 'v2');
export const serveRidesV2Cells = (bucket: R2Bucket, request: Request, corsOrigin: string, _db?: D1Database) => serveRidesCells(bucket, request, corsOrigin, 'v2');
export const serveRidesV3 = (bucket: R2Bucket, request: Request, corsOrigin: string, db?: D1Database) => serveRides(bucket, request, corsOrigin, 'v3', db);
export const serveRidesV3Cells = (bucket: R2Bucket, request: Request, corsOrigin: string, db?: D1Database) => serveRidesCells(bucket, request, corsOrigin, 'v3', db);
