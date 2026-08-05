/**
 * pyrmts-geo CFW glue for ctbk's avail-v3 pyramid (S2-keyed).
 *
 *   Storage: `avail-v3/<tier>/<period>.parquet`
 *            (built by `ctbk pyramid-cascade -c configs/pyramids/avail.yaml`,
 *            see `ctbk/pyramid_cascade/*.py` + `specs/pyramid-cascade.md`)
 *   Tiers:   15 — 1m, 2m, 3m, 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h,
 *                 1d, 3d, 7d (capped at /7d; the prior 1mo/3mo/1y tiers
 *                 dropped because the avail dataset is only ~2 months
 *                 old — re-add to YAML + here when data outgrows the cap)
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
import { parquetBackend, CachedShardIndex, type ShardIndex } from 'pyrmts';
import { r2Storage, D1ShardIndex } from 'pyrmts-cfw';
import { retryingStorage } from './r2_retry';
import {
	buildVocabGraph,
	filterCellsAndRes,
	planGeoQueryFromInventory,
	s2Index,
	vocabCover,
	type BBox,
	type GeoPyramid,
} from 'pyrmts-geo';
import stationVocab from '../../../configs/pyramids/station-vocab.json';

const METRICS = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;
type Metric = typeof METRICS[number];

export const REDUCERS = ['mean', 'min', 'max', 'p05', 'p25', 'p50', 'p75', 'p95', 'hist'] as const;
export type Reducer = typeof REDUCERS[number];
const DEFAULT_REDUCER: Reducer = 'mean';

/** 14-tier ladder for the new pyramid-cascade layout (per
 *  `configs/pyramids/avail.yaml`). Shard sizes here MUST track the
 *  YAML's `shard` per tier — the worker constructs R2 keys from
 *  `(tier, period)` via `KEY_TEMPLATE`, so a mismatch silently 404s.
 *
 *  R2 path `name`s use `<N>m` for minutes (matching the builder's
 *  tier keys); pyrmts `bin`/`shard` Duration strings use the typed
 *  `<N>min` form (`m` collides with `mo` in pyrmts's TimeUnit).
 *
 *  Tiers `1mo`/`3mo`/`1y` (in the prior `TIER_SPECS` ladder) are not
 *  materialized in the current pyramid-cascade build because the avail
 *  data is only ~2 months old — those tiers would have 0-2 bins each.
 *  Add them back here when the YAML grows them.
 *
 *  Base tier `/1m` (bin=1min, shard=1d) is fed by the cascading CFW's
 *  partial sub-shards (#130). pyrmts now supports per-(tier, cadence)
 *  earliest-watermark gating without cross-tier propagation (pyrmts
 *  #135 / `specs/per-cadence-earliest.md`), so /1m partials are trusted
 *  only for windows after cascade-start; coarser tiers' canonical
 *  coverage is preserved for older windows. */
export const TIERS: Tier[] = [
	// Each tier's tail rungs past the CFW's N ≤ 960 budget are the
	// `lambda_shards` extensions (avail.yaml + specs/avail-v3-lambda-
	// cascade.md), built + maintained by the `ctbk-avail-cascade`
	// Lambda. Health's expected min-covers include them; the read
	// planner picks whatever's registered either way.
	{ name: '1m',  bin: '1min',  shards: ['5min', '10min', '30min', '1h', '3h', '6h', '12h', '1d', '2d'] },
	{ name: '2m',  bin: '2min',  shards: ['10min', '30min', '1h', '3h', '6h', '12h', '1d', '2d', '4d'] },
	{ name: '3m',  bin: '3min',  shards: ['15min', '30min', '1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d'] },
	{ name: '5m',  bin: '5min',  shards: ['15min', '30min', '1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d'] },
	{ name: '10m', bin: '10min', shards: ['30min', '1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d', '16d'] },
	{ name: '15m', bin: '15min', shards: ['1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d'] },
	{ name: '30m', bin: '30min', shards: ['2h', '6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d'] },
	{ name: '1h',  bin: '1h',    shards: ['3h', '6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d', '128d'] },
	{ name: '2h',  bin: '2h',    shards: ['6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d', '128d', '256d'] },
	{ name: '3h',  bin: '3h',    shards: ['12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d', '128d', '256d', '512d'] },
	{ name: '6h',  bin: '6h',    shards: ['1d', '2d', '4d', '8d', '16d', '32d', '64d', '128d', '256d', '512d', '1024d'] },
	{ name: '12h', bin: '12h',   shards: ['2d', '4d', '8d', '16d', '32d', '64d', '128d', '256d', '512d', '1024d', '2048d'] },
	{ name: '1d',  bin: '1d',    shards: ['4d', '8d', '16d', '32d', '64d', '128d', '256d', '512d', '1024d', '2048d'] },
	{ name: '3d',  bin: '3d',    shards: ['12d', '24d', '48d', '96d', '192d', '384d', '768d', '1536d', '3072d'] },
	{ name: '7d',  bin: '7d',    shards: ['28d', '56d', '112d', '224d', '448d', '896d', '1792d', '3584d', '7168d'] },
];

const KEY_TEMPLATE = 'avail-v3/{tier}/{shard}/{period}.parquet';

/** Serveable pyramids: `?pyramid=` values → (D1 registry name, key
 *  template, key style). Same ladder/genesis; v5 is the
 *  engine-backfilled, vocab-keyed successor (`specs/avail-v5-stack.md`)
 *  and the default since the 2026-07-29 cutover; v3 (`avail`) stays
 *  addressable behind the explicit param until retirement. */
const PYRAMIDS: Record<string, { name: string; keyTemplate: string; vocab?: boolean }> = {
	'avail': { name: 'avail', keyTemplate: KEY_TEMPLATE },
	'avail-v5': { name: 'avail-v5', keyTemplate: 'avail-v5/{tier}/{shard}/{period}.parquet', vocab: true },
};

/** The pyramid served when `?pyramid=` is absent. Also folded into the
 *  edge-cache key (`index.ts`) so flipping this constant rotates cache
 *  entries instead of serving the old default's cached payloads. */
export const DEFAULT_PYRAMID = 'avail-v5';

/** Repair-generation edge-cache versioning
 *  (`specs/shard-invalidation-adoption.md`): past-window responses stay
 *  long-TTL/immutable, but their cache key folds in the mtime of the
 *  pyramid's R2 invalidation journal (`<prefix>/_invalidations.json`),
 *  so every journal write — the append on `ctbk gbfs invalidate`, and
 *  the fill driver's prune once repairs land — rotates every affected
 *  key. mtime, not etag: the journal is emptied in place after repairs,
 *  and an emptied journal's CONTENT (hence etag) is identical across
 *  repair cycles — etag-keying would resurrect pre-repair cache entries
 *  on the second cycle. Unrepaired pyramids (no journal) pin gen '0'.
 *  The in-isolate TTL cache bounds the R2 HEAD to ~1/min/isolate. */
const repairGenCache = new Map<string, { gen: string; at: number }>();
const REPAIR_GEN_TTL_MS = 60_000;
export async function repairGeneration(bucket: R2Bucket, pyramid: string): Promise<string> {
	const now = Date.now();
	const hit = repairGenCache.get(pyramid);
	if (hit && now - hit.at < REPAIR_GEN_TTL_MS) return hit.gen;
	const head = await bucket.head(`${pyramid}/_invalidations.json`);
	const gen = head ? String(head.uploaded.getTime()) : '0';
	repairGenCache.set(pyramid, { gen, at: now });
	return gen;
}
const RESOLUTIONS = [15, 14, 13, 12, 11, 10];

/** avail-v3 genesis: earliest 5-min-aligned UTC timestamp intersecting any
 *  materialized shard. Used by the /health min-cover computation. Keep in
 *  sync with `gbfs/cascade/src/avail3/cascade.ts` — same value must hold on
 *  both workers so cover math agrees on the closed-history region. */
export const AVAIL_GENESIS = new Date('2026-04-07T01:15:00Z');

function makeBaseProps(bucket: R2Bucket, keyTemplate: string = KEY_TEMPLATE): Omit<GeoPyramid, 'dims'> {
	return {
		storage: parquetBackend(retryingStorage(r2Storage(bucket))),
		// Unified `{tier}/{shard}/{period}` template per unified-shard-ladder
		// (pyrmts spec). Per-tier `shards: [...]` arrays above declare each
		// tier's full duration ladder; the planner picks largest-shard-first
		// per cursor position via the cursor-aware walk.
		keyTemplate,
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'histogram' as const })),
		tiers: TIERS,
		geo: { cellCol: 's2_cell', resolutions: RESOLUTIONS, index: s2Index },
	};
}

/** Rollup pyramid — empty `dims` so `stitch` collapses cells, leaving
 *  one row per (dt) summed across the bbox/cells covering set. */
export function availV3Pyramid(bucket: R2Bucket, keyTemplate?: string): GeoPyramid {
	return { ...makeBaseProps(bucket, keyTemplate), dims: [] };
}

/** Per-cell pyramid — adds `s2_cell` to dims so stitch preserves
 *  cell-level breakdown. */
export function availV3CellsPyramid(bucket: R2Bucket, keyTemplate?: string): GeoPyramid {
	return { ...makeBaseProps(bucket, keyTemplate), dims: [{ name: 's2_cell', type: 'string' }] };
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

// ─── ShardIndex-driven per-(tier, cadence) watermarks ─────────────────
//
// Watermarks live in D1 (`pyramid_watermarks` table). Backfilled from the
// legacy `avail-v3/_manifest.json` once at adoption; subsequent updates
// come from `pyramid-cascade` (canonical shards) and the /5m sub-shard
// CFW (partials, ctbk task #130) via `D1ShardIndex.recordShard`.
//
// `CachedShardIndex` wraps the D1 read with a 60s TTL + in-flight dedupe
// so concurrent requests share one D1 round-trip. See pyrmts
// `specs/done/partial-shards.md` §Watermark index.
//
// Per-isolate singleton — Workers reuse isolates across requests, so the
// CachedShardIndex's in-memory TTL applies across them.

const PYRAMID_NAME = 'avail';
const WATERMARK_CACHE_TTL_MS = 60_000;

let _shardIndex: ShardIndex | null = null;
function getShardIndex(db: D1Database): ShardIndex {
	if (_shardIndex === null) {
		_shardIndex = new CachedShardIndex(new D1ShardIndex(db), { ttlMs: WATERMARK_CACHE_TTL_MS });
	}
	return _shardIndex;
}

async function loadWatermarks(db: D1Database, pyramidName: string = PYRAMID_NAME): Promise<Record<string, Date>> {
	try {
		const map = await getShardIndex(db).getWatermarks(pyramidName);
		return Object.fromEntries(map);
	} catch {
		// On any D1 fetch failure, return empty (no watermark gating).
		// Better to over-trust shards than to crash queries on a transient D1 error.
		return {};
	}
}

// ─── Per-(tier, cadence) earliest watermarks ─────────────────────────
//
// Forward-rolling partials (#130 cascade) need per-cadence "available
// since" gating so the planner doesn't emit partial keys for periods
// before the cascade started writing. See pyrmts
// `specs/per-cadence-earliest.md`. Source: `MIN(period_start)` from
// the D1 `pyramid_shards` inventory grouped by (tier, cadence).
// Cached per-isolate alongside the watermark cache.

interface EarliestCache {
	map: Record<string, Date>;
	ts: number;
}
const _earliestCaches = new Map<string, EarliestCache>();

async function loadEarliestPerShard(db: D1Database, pyramidName: string = PYRAMID_NAME): Promise<Record<string, Date>> {
	const now = Date.now();
	const cached = _earliestCaches.get(pyramidName);
	if (cached && (now - cached.ts) < WATERMARK_CACHE_TTL_MS) {
		return cached.map;
	}
	try {
		// D1 column is still `cadence` pre-P3 rename. Legacy canonical
		// rows have `cadence = ''`; pyrmts's new unified-ladder API expects
		// every entry keyed `${tier}@${shardDur}` (no bare-tier sentinel),
		// so canonical rows translate to the tier's largest configured shard.
		const rs = await db.prepare(
			`SELECT tier, cadence, MIN(period_start) AS earliest_ms
			 FROM pyramid_shards
			 WHERE pyramid = ?
			 GROUP BY tier, cadence`
		).bind(pyramidName).all<{ tier: string; cadence: string; earliest_ms: number }>();
		const largestPerTier: Record<string, string> = Object.fromEntries(
			TIERS.map((t) => [t.name, t.shards[t.shards.length - 1]!])
		);
		const map: Record<string, Date> = {};
		for (const row of rs.results ?? []) {
			const shardDur = row.cadence === '' ? largestPerTier[row.tier] : row.cadence;
			if (!shardDur) continue;  // unknown tier; skip
			map[`${row.tier}@${shardDur}`] = new Date(row.earliest_ms);
		}
		_earliestCaches.set(pyramidName, { map, ts: now });
		return map;
	} catch {
		_earliestCaches.set(pyramidName, { map: {}, ts: now });
		return {};
	}
}

// ─── avail-v5 vocab covers (bbox → frozen-vocabulary terms) ───────────
//
// v5 rows live only at the frozen station-cell vocabulary + `s:<name>`
// identity keys (drop-LUC). `v5BBoxCover` maps a bbox to the exact
// positive-only cover: registry stations inside the bbox → `vocabCover`
// (pyrmts-geo ± DP, complement branch disabled — avail's histogram path
// does no sign-flip arithmetic). Graph + registry cached per isolate
// with a TTL (registry churns rarely); failures aren't cached.

interface V5Vocab {
	graph: ReturnType<typeof buildVocabGraph>;
	stations: { key: string; lat: number; lng: number }[];
}
let _v5Vocab: { value: Promise<V5Vocab>; ts: number } | null = null;
const V5_VOCAB_TTL_MS = 10 * 60_000;

function loadV5Vocab(bucket: R2Bucket): Promise<V5Vocab> {
	const now = Date.now();
	if (_v5Vocab && now - _v5Vocab.ts < V5_VOCAB_TTL_MS) return _v5Vocab.value;
	const value = (async (): Promise<V5Vocab> => {
		const obj = await bucket.get('station-luc.json');
		if (!obj) throw new Error('station-luc.json not found on R2');
		const luc = await obj.json<{ by_short_name: Record<string, { cell: string; lat: number; lng: number }> }>();
		const leaves: { key: string; cell: string }[] = [];
		const stations: V5Vocab['stations'] = [];
		for (const [sn, e] of Object.entries(luc.by_short_name)) {
			leaves.push({ key: `s:${sn}`, cell: e.cell });
			stations.push({ key: `s:${sn}`, lat: e.lat, lng: e.lng });
		}
		const graph = buildVocabGraph(s2Index, (stationVocab as { cells: string[] }).cells, leaves);
		return { graph, stations };
	})();
	_v5Vocab = { value, ts: now };
	value.catch(() => { _v5Vocab = null; });
	return value;
}

async function v5BBoxCover(bucket: R2Bucket, bbox: BBox): Promise<string[]> {
	const { graph, stations } = await loadV5Vocab(bucket);
	const wanted = stations
		.filter((s) => s.lat >= bbox.minLat && s.lat <= bbox.maxLat && s.lng >= bbox.minLng && s.lng <= bbox.maxLng)
		.map((s) => s.key);
	if (wanted.length === 0) return [];
	return vocabCover(graph, wanted, { positiveOnly: true }).include;
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
	bucket: R2Bucket,
	db: D1Database,
	request: Request,
	cors: string | null,
	pyramidName: string = PYRAMID_NAME,
): Promise<Response> {
	const url = new URL(request.url);
	const from = parseInstant(url.searchParams.get('from'));
	const to = parseInstant(url.searchParams.get('to'));
	if (from === null || to === null) {
		return errorResponse(400, 'from and to query params required (ISO-8601)', cors);
	}
	const userBinBudget = parsePositiveInt(url.searchParams.get('bin_budget'), 1024);
	if (userBinBudget === null) return errorResponse(400, 'invalid bin_budget', cors);
	const cellBudget = parsePositiveInt(url.searchParams.get('cell_budget'), 1024);
	if (cellBudget === null) return errorResponse(400, 'invalid cell_budget', cors);

	// Optional caller-supplied cover. When present, `bbox` is unused.
	const cellsRaw = url.searchParams.get('cells');
	let userCells = cellsRaw
		? cellsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: null;
	if (userCells !== null && userCells.length === 0) {
		return errorResponse(400, '`cells` param given but empty', cors);
	}
	const cellsExcludeRaw = url.searchParams.get('cells.exclude');
	const userCellsExclude = cellsExcludeRaw
		? cellsExcludeRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: [];

	let bbox = userCells === null ? parseBBox(url.searchParams.get('bbox')) : null;
	if (userCells === null && bbox === null) {
		return errorResponse(400, 'either `bbox` or `cells` is required', cors);
	}

	// Vocab-keyed pyramids (v5) store rows only at their frozen
	// vocabulary (S2 cells + `s:<short_name>` identity keys), so a raw
	// `minimalCover` bbox cover emits cells that match no rows — a
	// silent undercount. Convert the bbox to a vocab cover
	// (positive-only: exact union, no histogram sign-flips —
	// `specs/drop-luc-station-keys.md`) and continue down the
	// explicit-cells path, whose include-set filter + RG prune both
	// match stored keys exactly. Keyed on the registry's `vocab` flag,
	// NOT on default-ness — the default has flipped before.
	if (bbox !== null && PYRAMIDS[pyramidName]?.vocab) {
		const include = await v5BBoxCover(bucket, bbox);
		if (include.length === 0) {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (cors) headers['Access-Control-Allow-Origin'] = cors;
			return new Response(JSON.stringify({ records: [], reducer: url.searchParams.get('reducer') ?? DEFAULT_REDUCER, plan: null }), { headers });
		}
		userCells = include;
		bbox = null;
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
	// Identity keys (`s:<name>`) aren't S2 tokens — exclude them from
	// level derivation and force the mixed-cover sentinel when present.
	const nonIdCells = userCells !== null ? userCells.filter((c) => !c.startsWith('s:')) : [];
	const hasIdKeys = userCells !== null && nonIdCells.length !== userCells.length;
	const userCoverLevels = userCells !== null
		? Array.from(new Set(nonIdCells.map((c) => index.cellLevel(c))))
		: [];
	const userOutputRes = userCells !== null
		? (hasIdKeys || userCoverLevels.length > 1 || userCellsExclude.length > 0 ? -1 : userCoverLevels[0]!)
		: null;

	// Watermark fall-through: the planner clips each tier to its
	// `pyramid-cascade`-emitted manifest watermark (latest complete shard
	// end), then walks finer tiers to fill the post-watermark tail.
	// Empty `watermarks` = trust all shards (legacy behavior pre-manifest).
	const watermarks = await loadWatermarks(db, pyramidName);

	// Per-(tier, cadence) earliest gating: forward-rolling /1m partials
	// (#130) only have coverage from the cascade's first write onward.
	// pyrmts #135 (`earliestPerShard`) gates per-entry without cross-
	// tier propagation, so old queries fall through cleanly to /2m+
	// canonical. Source from D1 `MIN(period_start) GROUP BY tier, cadence`.
	const earliestPerShard = await loadEarliestPerShard(db, pyramidName);

	// pickTier doesn't know about `earliestPerShard` — it picks the
	// finest tier that fits the bin budget without considering whether
	// that tier's data covers the query window. If pickTier lands on /1m
	// for a query starting before /1m's earliest, the segment loop walks
	// /1m only (outputIdx=0; no fall-through to coarser indices), all
	// entries get gated out → 0 segments. Workaround: cap binBudget below
	// /1m's bin count when the query window extends before /1m's earliest
	// available data, forcing pickTier to /2m+ where canonical coverage
	// reaches further back.
	const oneMEarliest = earliestPerShard['1m@5min']
		?? earliestPerShard['1m@10min']
		?? earliestPerShard['1m@30min']
		?? earliestPerShard['1m@1h']
		?? earliestPerShard['1m@3h']
		?? earliestPerShard['1m@12h'];
	const queryStartsBefore1mEarliest = oneMEarliest && from < oneMEarliest;
	const rangeMinutes = Math.ceil((to.getTime() - from.getTime()) / 60_000);
	const binBudget = queryStartsBefore1mEarliest
		? Math.min(userBinBudget, rangeMinutes - 1)
		: userBinBudget;

	// Inventory-driven planning (min-cover-aware): reads pick tiles from
	// the D1 `pyramid_shards` inventory rather than synthesizing keys from
	// ladder × watermarks — under min-cover maintenance a rung's watermark
	// advancing does NOT imply older tiles at that rung still exist (they
	// get consolidated into coarser rungs; "last constituents" never
	// materialize at all). Watermark-synthesized plans 404'd on phantom
	// keys like `avail-v3/15m/1h/2026-07-09T23.parquet`. See pyrmts
	// `specs/done/inventory-driven-read-walk.md`.
	//
	// The windowed listShards is a per-request D1 query (pushdown WHERE on
	// the (pyramid, tier, period_start) index); D1 errors propagate as
	// 500s — an empty inventory would silently serve empty charts.
	const registeredShards = await getShardIndex(db).listShards(pyramidName, { range: { from, to } });

	// `outputCells: {res, cells}` path bypasses `pickResolution`. See
	// `pyrmts/specs/done/plan-geo-query-precomputed-cover.md`.
	const plan = userCells !== null
		? planGeoQueryFromInventory(pyramid, { range: { from, to }, binBudget, outputCells: { res: userOutputRes!, cells: userCells }, watermarks, earliestPerShard }, registeredShards)
		: planGeoQueryFromInventory(pyramid, { range: { from, to }, binBudget, bbox: bbox!, cellBudget, watermarks, earliestPerShard }, registeredShards);

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
			outputTier: plan.outputTier?.name ?? null,
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

/** `?pyramid=` override: select a serving pyramid from `PYRAMIDS`;
 *  absent → `DEFAULT_PYRAMID`. Unknown value → null (caller 400s). */
function pyramidParam(request: Request): { name: string; keyTemplate: string } | null {
	const v = new URL(request.url).searchParams.get('pyramid');
	if (v === null) return PYRAMIDS[DEFAULT_PYRAMID]!;
	return PYRAMIDS[v] ?? null;
}

/** HTTP handler for `/api/avail-v3` — v3 rollup over bbox (S2-keyed). */
export async function serveAvailV3(bucket: R2Bucket, db: D1Database, request: Request, corsOrigin: string): Promise<Response> {
	const p = pyramidParam(request);
	if (p === null) return errorResponse(400, 'unknown pyramid', corsOrigin || null);
	return serveGeoReduced(availV3Pyramid(bucket, p.keyTemplate), bucket, db, request, corsOrigin || null, p.name);
}

/** HTTP handler for `/api/avail-v3/cells` — v3 per-cell rows preserved. */
export async function serveAvailV3Cells(bucket: R2Bucket, db: D1Database, request: Request, corsOrigin: string): Promise<Response> {
	const p = pyramidParam(request);
	if (p === null) return errorResponse(400, 'unknown pyramid', corsOrigin || null);
	return serveGeoReduced(availV3CellsPyramid(bucket, p.keyTemplate), bucket, db, request, corsOrigin || null, p.name);
}
