/**
 * pyrmts-geo CFW glue for ctbk's rides pyramids.
 *
 * rides-v3 (S2-keyed, `ctbk/rides_v1.py`) is the rollback path behind
 * prod's rides-v5 (engine-built, station-identity-keyed — see the v5
 * section below). Two anchors = two sibling pyramids:
 *   rides-v3/start/<tier>/<period>.parquet — `start_s2_cell`-anchored
 *   rides-v3/end/<tier>/<period>.parquet   — `end_s2_cell`-anchored
 *
 * (The h3-keyed rides-v1/v2 forebears were GC'd 2026-08-15 — child hexes
 * are neither necessary nor sufficient to cover their parent, so exact
 * multi-resolution aggregation is unachievable on h3.)
 *
 * 11-tier ladder: 1h / 3h / 6h / 12h / 1d / 3d / 7d / 14d / 1mo / 3mo / 1y.
 * S2 levels: 10..15.
 *
 *  Schema (per row, sum-monoid):
 *    {anchor}_s2_cell : STRING       S2 token (level encoded in trailing bits)
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
 *   GET /api/rides-v3?anchor=start|end&from=&to=&bbox=&bin_budget=&cell_budget=&reducer=
 *   GET /api/rides-v3/cells?anchor=start|end&… (per-cell breakdown)
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
	parseDuration,
	PlanLimitError,
	stitch,
	type Duration,
	type PlanLimits,
	type Row,
	type Tier,
} from 'pyrmts';
import { parquetBackend, CachedShardIndex, type ShardIndex } from 'pyrmts';
import { r2Storage, D1ShardIndex } from 'pyrmts-cfw';
import { retryingStorage } from './r2_retry';
import { acquireFooterSlot, busyResponse, FetchBusyError } from './fetch_guard';
import { fetchShardRows } from './rg_manifest';
import {
	planGeoQueryFromInventory,
	s2Index,
	vocabCover,
	type BBox,
	type GeoPyramid,
	type GeoQueryPlan,
	type SpatialSet,
} from 'pyrmts-geo';
import { loadV5Vocab, v5BBoxCover } from './avail_geo';
import { loadCanonMap, selectLeaves } from './canon';

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
 *  rollup handler to scrub the `{anchor}_s2_cell` value that pyrmts leaves
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

// ─── Rides fetch memory guard ────────────────────────────────────────────
//
// `fetchSegment` parses each shard's full parquet footer via hyparquet —
// the big rides shards' 7-8MB footers become large JS object graphs, and
// a few concurrent parses blow the isolate's 128MB limit (`outcome:
// exceededMemory`). See `fetch_guard.ts` for the load-shed rationale.
// Footer-parsing paths run segments sequentially within a request (one
// metadata graph alive at a time) under the guard's in-flight cap; the
// RG-manifest path (`rg_manifest.ts`, `specs/rg-manifest.md`) never
// parses footers and bypasses both bounds.
async function fetchSegmentsSequential<S, R>(segments: S[], fn: (seg: S) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (const seg of segments) out.push(await fn(seg));
	return out;
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

function parseAnchor(url: URL, cors: string | null): Anchor | Response {
	const raw = url.searchParams.get('anchor') ?? DEFAULT_ANCHOR;
	if (!ANCHORS.includes(raw as Anchor)) {
		return errorResponse(400, `bad anchor '${raw}'; one of ${ANCHORS.join('|')}`, cors);
	}
	return raw as Anchor;
}

// ─────────────────────────────────────────────────────────────────────
// rides-v5: engine-built, station-identity-keyed, inventory-driven
// (`specs/rides-v5.md`). Differences vs v3:
//   - keys: frozen vocab cells + `s:<short_name>` identity rows (drop-LUC)
//     — user covers/bboxes translate to positive-only vocab covers via
//     the station registry (raw S2 cover cells match no stored rows)
//   - shards: multi-rung fixed-duration min-cover, resolved from the D1
//     `pyramid_shards` inventory (same machinery as avail-v5/v6)
//   - bins: `bin=<any pyrmts Duration>` (`4h`, `5d`, `1mo`, `4mo`, `2y`, …)
//     plans via `targetBin`. Widths the ladder materializes serve directly;
//     others decompose — fixed widths by DP over finer fixed tiers,
//     calendar widths by greedy containment over finer *calendar* tiers
//     first and whole-day fixed tiers for the residue (and always for the
//     un-closed tip), reaggregated at stitch. Exact for sum monoids: month
//     boundaries are whole days. Omit `bin=` and pass `bin_budget=N` to let
//     the planner pick a materialized tier instead.
//   - cost: every plan is bounded by `V5_LIMITS` (bins/atoms/keys); an
//     over-budget request 413s rather than OOM-ing the isolate.

export const RIDES_GENESIS = new Date('2013-06-01T00:00:00Z');

// Mirrors `configs/pyramids/rides-v5-{start,end}.yaml` (fixed pow-2 day
// ladder + materialized calendar family).
export const V5_TIERS: Tier[] = [
	{ name: '1h',  bin: '1h',  shards: ['1d', '2d', '4d', '8d', '16d', '32d'] },
	{ name: '3h',  bin: '3h',  shards: ['4d', '8d', '16d', '32d', '64d', '128d'] },
	{ name: '6h',  bin: '6h',  shards: ['8d', '16d', '32d', '64d', '128d', '256d'] },
	{ name: '12h', bin: '12h', shards: ['16d', '32d', '64d', '128d', '256d', '512d'] },
	{ name: '1d',  bin: '1d',  shards: ['32d', '64d', '128d', '256d', '512d', '1024d'] },
	{ name: '3d',  bin: '3d',  shards: ['96d', '192d', '384d', '768d', '1536d', '3072d'] },
	{ name: '7d',  bin: '7d',  shards: ['224d', '448d', '896d', '1792d', '3584d', '7168d'] },
	{ name: '14d', bin: '14d', shards: ['448d', '896d', '1792d', '3584d', '7168d'] },
	// `1mo` leads the rungs so closed months of the still-open year get
	// their own shard the moment they close (`specs/rides-v5-calendar-tip-
	// rung.md`). With `1y` as the finest rung, the min-cover expected
	// NOTHING from this tier for the open year — not an unsealed shard, no
	// shard — so every closed month of 2026 was invisible to the calendar
	// family and fell through to `1d`/`3d`/`7d`. `1y` still covers closed
	// years, so no historical rebuild; `1mo/1y/<Y>` becomes buildable from
	// the twelve monthly shards at year close (pure concat, same tier).
	{ name: '1mo', bin: '1mo', shards: ['1mo', '1y', '2y', '4y', '8y', '16y'] },
	{ name: '2mo', bin: '2mo', shards: ['1y', '2y', '4y', '16y', '32y'] },
	{ name: '3mo', bin: '3mo', shards: ['1y', '4y', '16y', '64y'] },
	{ name: '6mo', bin: '6mo', shards: ['2y', '8y', '32y', '128y'] },
	{ name: '1y',  bin: '1y',  shards: ['4y', '16y', '128y'] },
];

// Cost ceiling for v5 plans (pyrmts `PlanLimits`). Three independent axes —
// they don't correlate, so capping only one leaves the others open:
//   - bins:  response size + client render. 1h over 13y is ~115k bins but
//            only ~150 keys.
//   - atoms: pre-coalesce ragged packing atoms = source rows fetched and
//            stitched. A badly-packed calendar target is few bins, many
//            atoms (the axis calendar-tier composition improves).
//   - keys:  distinct shards = R2 GETs + manifest lookups. The axis that
//            costs money and drives tail latency.
// Sized off observed good plans with headroom: the full-history Home query
// is ~160 bins / 1 key; a het-tiled current-year month view is ~21 keys.
// `maxAtoms` is a blowup backstop, NOT a cost model. Atom count alone does
// not predict servability: over 2024 the widths that die (`5mo` 39, `7mo`
// 60, `18mo` 64, `10d` 154, `5d` 222) all out-atom the ones that work
// (`1mo` 12, `4mo` 6, `2y` 4) — but the production Home query (full
// history, `bin=1mo`) plans **223** atoms and serves in ~6s. What actually
// differs is which tiers the atoms come from: calendar-tier atoms are
// cheap, `1d`/`3d`/`7d` atoms hold orders of magnitude more rows per key.
// So this is set above real traffic (223) with headroom, and the tighter
// `keys × cover-terms` guard below does the real work.
const V5_LIMITS: PlanLimits = { maxOutputBins: 2048, maxAtoms: 512, maxKeys: 128 };

// pyrmts' three axes don't capture what actually kills this worker: CF caps
// subrequests per invocation, and the manifest path issues byte-range reads
// per matched row-group per key, so cost scales as keys × cover-tokens —
// neither factor alone. Measured against the deployed worker:
//     1 key × 386 tokens → 0.6s ok        5 keys ×  12 tokens → ok
//    11 keys ×   2 tokens → ok           21 keys ×  50 tokens → 8-11s ok
//    21 keys × 100 tokens → CF 1102      99 keys ×  12 tokens → subrequest cap
// so the cliff sits just above ~1050. Cap at 1000 and 413 — an actionable
// error beats a 500 the caller can't interpret.
//
// KNOWN GAP: `5mo`/`7mo`/`18mo` over a region cover (11 keys × 60 terms =
// 660) slip under this and still 503 with CF's CPU limit, because their
// keys are fine-tier (`1d`/`3d`) shards that cost far more per key than the
// calendar-tier shards this product implicitly assumes. Tightening the cap
// enough to catch them also rejects the production Home query, so it's left
// permissive on purpose. The real fix is upstream: those widths only touch
// fine tiers because the current-year calendar shards aren't sealed — see
// the un-sealed-tip note in `specs/rides-v5.md`.
const V5_MAX_KEY_CELL_PRODUCT = 1000;

/** Parse a caller-supplied `bin=`. Any pyrmts `Duration` is legal — fixed
 *  widths decompose by DP over finer tiers, calendar widths het-tile from
 *  the materialized calendar family (and, past `pyrmts@69de58b`, from
 *  finer *calendar* tiers), so there's no closed list to validate against.
 *  `Nmo` is unrestricted since pyrmts moved to year-0 month anchoring. */
function parseBin(raw: string | null): Duration | null | undefined {
	if (raw === null) return null;
	try {
		parseDuration(raw as Duration);
		return raw as Duration;
	} catch {
		return undefined;
	}
}

const V5_SHARD_TTL_MS = 60_000;
const _v5ShardIndex: Record<string, ShardIndex> = {};
function v5ShardIndex(db: D1Database, name: string): ShardIndex {
	return _v5ShardIndex[name] ??= new CachedShardIndex(new D1ShardIndex(db), { ttlMs: V5_SHARD_TTL_MS });
}

/** Which stored rides pyramid a route serves. `rides-v5` (`/api/rides-v5`)
 *  keys station leaves by canonical id at ingest; `rides` (`/api/rides`,
 *  `specs/rides-rekey.md`) stores raw-id leaves + materialized `c:` rollups,
 *  selected per request by `canon.ts` (canonical default, `?raw=1` audit). */
export interface RidesVariant {
	/** R2 key prefix; the D1 pyramid name is `${prefix}-${anchor}`. */
	prefix: string;
	canonicalized: boolean;
}
export const RIDES_V5: RidesVariant = { prefix: 'rides-v5', canonicalized: false };
export const RIDES: RidesVariant = { prefix: 'rides', canonicalized: true };

function ridesV5Pyramid(bucket: R2Bucket, variant: RidesVariant, anchor: Anchor, cells: boolean): GeoPyramid {
	return {
		storage: parquetBackend(retryingStorage(r2Storage(bucket))),
		keyTemplate: `${variant.prefix}/${anchor}/{tier}/{shard}/{period}.parquet`,
		axis: 'time',
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'sum' as const })),
		tiers: V5_TIERS,
		dims: [
			...(cells ? [{ name: 'cell', type: 'string' as const }] : []),
			...DIMS.map((d) => ({ name: d, type: 'string' as const })),
		],
		geo: { cellCol: 'cell', resolutions: [15, 14, 13, 12, 11, 10], index: s2Index },
	};
}

/** Translate a raw-S2 user cover (include/exclude, `minimalCover`
 *  output) to the positive-only vocab cover of the stations it selects. */
async function v5UserCover(bucket: R2Bucket, include: string[], exclude: string[]): Promise<string[]> {
	const { graph, stations } = await loadV5Vocab(bucket);
	const set: SpatialSet = { include, exclude };
	const wanted = stations
		.filter((s) => {
			const leaf = s2Index.latLngToCell(s.lat, s.lng, s2Index.maxLevel);
			return s2Index.cellInSet(leaf, s2Index.maxLevel, set);
		})
		.map((s) => s.key);
	if (wanted.length === 0) return [];
	return vocabCover(graph, wanted, { positiveOnly: true }).include;
}

export async function serveRides(
	variant: RidesVariant,
	bucket: R2Bucket,
	db: D1Database,
	request: Request,
	corsOrigin: string,
	cellsRoute: boolean,
	// ctx.waitUntil passthrough — carries deferred RG-manifest fills past
	// the response (`rg_manifest.ts`).
	defer: (p: Promise<unknown>) => void = () => {},
): Promise<Response> {
	const cors = corsOrigin || null;
	const url = new URL(request.url);
	const anchor = parseAnchor(url, cors);
	if (anchor instanceof Response) return anchor;
	const from = parseInstant(url.searchParams.get('from'));
	const to = parseInstant(url.searchParams.get('to'));
	if (from === null || to === null) {
		return errorResponse(400, 'from and to query params required (ISO-8601)', cors);
	}
	const reducerRaw = url.searchParams.get('reducer') ?? DEFAULT_REDUCER;
	if (!REDUCERS.includes(reducerRaw as Reducer)) {
		return errorResponse(400, `bad reducer '${reducerRaw}'; one of ${REDUCERS.join('|')}`, cors);
	}
	const reducer = reducerRaw as Reducer;
	const binRaw = url.searchParams.get('bin');
	const targetBin = parseBin(binRaw);
	if (targetBin === undefined) {
		return errorResponse(400, `bad bin '${binRaw}'; expected <count><min|h|d|mo|y> (or omit for bin_budget)`, cors);
	}
	const binBudget = parsePositiveInt(url.searchParams.get('bin_budget'), 1024);
	if (binBudget === null) return errorResponse(400, 'invalid bin_budget', cors);
	// `binBudget` picks the tier when no `bin=` is given. With an explicit
	// `bin=`, pyrmts ≥69de58b treats it as `maxOutputBins` if limits don't
	// set one — we always set one, so an explicit `bin=` never inherits a
	// caller's budget as a cost ceiling (the pre-re-pin contract was that
	// `binBudget` is simply ignored under `targetBin`; silently turning a
	// small budget into a hard error would be a BIC surprise).
	const limits: PlanLimits = V5_LIMITS;

	const cellsRaw = url.searchParams.get('cells');
	const userCells = cellsRaw
		? cellsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: null;
	const exclude = (url.searchParams.get('cells.exclude') ?? '')
		.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
	const bbox = parseBBox(url.searchParams.get('bbox'));
	const rawParam = url.searchParams.get('raw');
	if (rawParam !== null && rawParam !== '0' && rawParam !== '1') {
		return errorResponse(400, `bad raw '${rawParam}'; expected 0|1`, cors);
	}
	const raw = rawParam === '1';
	if (raw && !variant.canonicalized) {
		return errorResponse(400, `raw=1 needs a canonicalized pyramid (/api/rides), not ${variant.prefix}`, cors);
	}
	let include: string[];
	if (userCells !== null) {
		// Station-key covers (`s:` / `c:`) pass through (station-detail path);
		// raw S2 covers translate via the registry.
		const explicit = userCells.every((c) => c.startsWith('s:') || c.startsWith('c:'));
		include = explicit ? userCells : await v5UserCover(bucket, userCells, exclude);
		// Explicit ids under `raw=1` are raw reported ids, taken verbatim (the
		// audit view); everything else resolves station leaves per `canon.ts`.
		if (variant.canonicalized && !(explicit && raw)) {
			include = selectLeaves(include, await loadCanonMap(bucket), raw ? 'raw' : 'canonical');
		}
	} else if (bbox !== null) {
		include = await v5BBoxCover(bucket, bbox);
		if (variant.canonicalized) {
			include = selectLeaves(include, await loadCanonMap(bucket), raw ? 'raw' : 'canonical');
		}
	} else {
		return errorResponse(400, 'either `bbox` or `cells` is required', cors);
	}
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	if (include.length === 0) {
		return new Response(JSON.stringify({ records: [], reducer, anchor, plan: null }), { headers });
	}

	const pyramid = ridesV5Pyramid(bucket, variant, anchor, cellsRoute);
	const pyramidName = `${variant.prefix}-${anchor}`;
	const registered = await v5ShardIndex(db, pyramidName).listShards(pyramidName, { range: { from, to } });
	// One planner for both modes: pyrmts-geo forwards `targetBin` as of
	// `69de58b`, so explicit-width queries no longer need the time-only
	// planner detour (which cost `outputRes` and per-segment cells).
	let plan: GeoQueryPlan;
	try {
		plan = planGeoQueryFromInventory(
			pyramid,
			{
				range: { from, to },
				binBudget,
				outputCells: { res: -1, cells: include },
				...(targetBin !== null ? { targetBin } : {}),
				limits,
			},
			registered,
		);
	} catch (err) {
		// Cost ceiling — the caller asked for a plan we won't serve. 413
		// rather than 500: the request is well-formed, just too expensive.
		if (err instanceof PlanLimitError) {
			return errorResponse(413, `plan too large: ${err.limit} ${err.requested} > ${err.allowed}`, cors);
		}
		throw err;
	}
	const keyCount = plan.segments.reduce((n, s) => n + s.keys.length, 0);
	const keyCellProduct = keyCount * include.length;
	if (keyCellProduct > V5_MAX_KEY_CELL_PRODUCT) {
		return errorResponse(413, `plan too large: keys×cells ${keyCellProduct} > ${V5_MAX_KEY_CELL_PRODUCT} `
			+ `(${keyCount} shards × ${include.length} cover terms) — narrow the range, the area, or use a coarser bin`, cors);
	}
	const rgFilters = parseDimFilters(url) ?? [];
	// RG-manifest path (`specs/rg-manifest.md` P1+P3): serve from the D1
	// row-group index — no footer parse, so segments fan out in parallel
	// and the footer guard doesn't apply (misses fall back to the guarded
	// footer path per key, and fill the manifest via `defer`). `include`
	// is always a vocab term list here (`s:` passthrough, or raw
	// covers/bboxes translated positive-only via `vocabCover`), so
	// per-token exact-match predicates are valid for every shape;
	// region-scale covers measure ≤16 tokens (NYC), inside the predicate
	// builder's 45-token cap. Dim-filtered queries keep the legacy
	// guarded sequential path (dim RG-prune semantics are out of scope).
	const manifestEligible = rgFilters.length === 0;
	let shardRows: Row[][];
	try {
		if (manifestEligible) {
			const writtenAtByKey = new Map(registered.map((s) => [s.key, s.writtenAt?.getTime() ?? 0]));
			const storage = retryingStorage(r2Storage(bucket));
			shardRows = await Promise.all(plan.segments.map(async (seg) => {
				const perKey = await Promise.all(seg.keys.map((key) => fetchShardRows({
					db,
					storage,
					pyramid: pyramidName,
					key,
					writtenAt: writtenAtByKey.get(key) ?? 0,
					from: seg.from,
					to: seg.to,
					cells: include,
					cellCol: 'cell',
					defer,
				})));
				return perKey.flat();
			}));
		} else {
			const releaseSlot = await acquireFooterSlot();
			try {
				shardRows = await fetchSegmentsSequential(plan.segments, (seg) => pyramid.storage.fetchSegment(seg, {
					binCol: pyramid.binCol,
					range: { from: seg.from, to: seg.to },
					filters: [{ col: 'cell', values: include }, ...rgFilters],
				}));
			} finally {
				releaseSlot();
			}
		}
	} catch (err) {
		if (err instanceof FetchBusyError) return busyResponse(cors);
		throw err;
	}
	const includeSet = new Set(include);
	const filtered = shardRows.map((rows) => rows.filter((r) => includeSet.has(r.cell as string)));
	const stitched = stitch({ pyramid, plan, shardRows: filtered });
	const reduced = reduceRows(stitched, reducer, cellsRoute ? [] : ['cell']);
	return new Response(JSON.stringify({
		records: reduced,
		reducer,
		anchor,
		plan: {
			outputTier: plan.outputTier?.name ?? null,
			outputBin: plan.outputBin,
			outputRes: plan.outputRes,
			outputCells: include,
			atomCount: plan.atomCount,
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
