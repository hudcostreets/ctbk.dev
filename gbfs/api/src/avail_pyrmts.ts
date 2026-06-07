/**
 * Pyrmts-backed availability totals (shadow path for `/api/totals?kind=availability`).
 *
 * Reads the same `avail/agg/{h1,d1,mo1}/<period>.parquet` shards the legacy
 * `executeAvailTotalsQuery` reads, but routes through `pyrmts`'s histogram
 * monoid and reducer dispatch. Output should match the legacy path within
 * float-epsilon for `mean` and exactly for `min`/`max`/percentiles/`hist`.
 *
 * Migration plan: `specs/pyrmts-avail-port.md`.
 *
 * Schema bridge: ctbk's shards are tall (`dt, station_id, metric, state,
 * minutes`); pyrmts wants wide-JSON (one row per `(dt, station_id)`, each
 * metric column a `{state: count}` Map). The `pivotPerMetric` helper does
 * that pivot via `pyrmts.pivotTallToHistogram` once per metric, then merges
 * the per-metric outputs by dim key.
 *
 * `dt` unit: ctbk shards store INT64 unix-seconds; pyrmts time-axis expects
 * ms. Pivot multiplies by 1000.
 */
import {
	fetchShardData,
	parquetBackend,
	pivotTallToHistogram,
	planQuery,
	stitch,
	type Pyramid,
	type Row,
} from 'pyrmts';
import { r2Storage } from 'pyrmts-cfw';
import type { AvailAgg, AvailMetric, TotalsParams, TotalsResponse } from './totals';

// ─────────────────────────────────────────────────────────────────────
// Pyramid definition

/** Avail metrics that get a histogram-monoid column. Matches ctbk's
 *  `AVAIL_METRICS` (`gbfs/api/src/totals.ts:57`). */
const METRICS: readonly AvailMetric[] = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;

export function availPyramid(bucket: R2Bucket): Pyramid {
	return {
		storage: parquetBackend(r2Storage(bucket)),
		keyTemplate: 'avail/agg/{tier}/{period}.parquet',
		axis: 'time',
		// Pivot adapter converts ctbk's unix-seconds `dt` to a ms-valued `dt_ms`
		// column (pyrmts time-axis convention). Stitch reads from `dt_ms`.
		binCol: 'dt_ms',
		dims: [{ name: 'station_id', type: 'string' }],
		metrics: METRICS.map((name) => ({ name, monoid: 'histogram' as const })),
		// Finest → coarsest per pyrmts convention (`types.ts:70`); planner
		// iterates in declared order and returns the *finest* tier whose
		// bin-count fits the budget.
		tiers: [
			{ name: 'h1', bin: '1h', shard: '1d' },
			{ name: 'd1', bin: '1d', shard: '1mo' },
			{ name: 'mo1', bin: '1mo', shard: '1y' },
		],
	};
}

// ─────────────────────────────────────────────────────────────────────
// Pivot adapter — tall ctbk rows → wide-JSON per-(dt, station_id)

/** Convert a tall-format shard (one row per `(dt, station_id, metric, state)`)
 *  into wide-JSON form (one row per `(dt, station_id)` with all 5 histogram
 *  columns inlined). `dt` unit converts seconds → milliseconds along the way. */
export function pivotPerMetric(tallRows: Row[]): Row[] {
	// One pyrmts pivot per metric; then merge by dim key. We could do a
	// single-pass fused version if profiling shows the 5x scan matters.
	const byDimKey = new Map<string, Row>();
	const dimCols = ['dt_ms', 'station_id'];

	for (const metricName of METRICS) {
		// Filter + project to the columns pyrmts needs, normalizing dt → ms.
		const metricRows: Row[] = [];
		for (const r of tallRows) {
			if (r.metric !== metricName) continue;
			metricRows.push({
				dt_ms: (r.dt as number) * 1000,
				station_id: r.station_id,
				state: r.state,
				minutes: r.minutes,
			});
		}
		const widened = pivotTallToHistogram(metricRows, {
			histogramCol: metricName,
			categoryCol: 'state',
			countCol: 'minutes',
			groupBy: dimCols,
		});
		for (const row of widened) {
			const key = `${row.dt_ms}\x00${row.station_id}`;
			const existing = byDimKey.get(key);
			if (existing) existing[metricName] = row[metricName];
			else byDimKey.set(key, { ...row });
		}
	}

	return [...byDimKey.values()];
}

// ─────────────────────────────────────────────────────────────────────
// Reducer dispatch — read histograms, apply requested reducer

/** Mean of a histogram `{state: minutes}`: Σ(state * minutes) / Σ(minutes).
 *  Returns `null` for empty histograms. */
function histogramMean(hist: Record<string, number>): number | null {
	let totalWeight = 0;
	let weighted = 0;
	for (const k in hist) {
		const w = hist[k]!;
		weighted += Number(k) * w;
		totalWeight += w;
	}
	return totalWeight > 0 ? weighted / totalWeight : null;
}

function histogramMin(hist: Record<string, number>): number | null {
	let min: number | null = null;
	for (const k in hist) {
		if (hist[k]! <= 0) continue;
		const v = Number(k);
		if (min === null || v < min) min = v;
	}
	return min;
}

function histogramMax(hist: Record<string, number>): number | null {
	let max: number | null = null;
	for (const k in hist) {
		if (hist[k]! <= 0) continue;
		const v = Number(k);
		if (max === null || v > max) max = v;
	}
	return max;
}

/** R-7 linear-interpolation quantile (matches `availHistQuantile` in totals.ts:476). */
function histogramQuantile(hist: Record<string, number>, p: number): number | null {
	const entries = Object.entries(hist)
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
			// Straddles boundary — interpolate to next state.
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

export interface ReducedRow {
	dt: number;       // unix seconds (back to ctbk convention for the response)
	station_id: string;
	value: number | null | Record<string, number>;
}

/** Apply the requested `availAgg` reducer to one metric's histograms across
 *  pyrmts' stitched rows. Returns one `ReducedRow` per input row. */
export function applyReducer(
	stitched: Row[],
	metric: AvailMetric,
	reducer: AvailAgg,
): ReducedRow[] {
	return stitched.map((row) => {
		const hist = (row[metric] ?? {}) as Record<string, number>;
		let value: number | null | Record<string, number>;
		if (reducer === 'mean') value = histogramMean(hist);
		else if (reducer === 'min') value = histogramMin(hist);
		else if (reducer === 'max') value = histogramMax(hist);
		else if (reducer === 'hist') value = hist;
		else {
			const pct = PCT_FOR_REDUCER[reducer];
			if (pct === undefined) throw new Error(`unknown availAgg: ${reducer}`);
			value = histogramQuantile(hist, pct);
		}
		return {
			dt: Math.floor((row.dt_ms as number) / 1000),
			station_id: row.station_id as string,
			value,
		};
	});
}

// ─────────────────────────────────────────────────────────────────────
// Watermarks

/** Latest-complete-bin instant per tier, conservatively. h1 = end of
 *  yesterday UTC; d1 = end of previous month; mo1 = end of previous year.
 *  Past these watermarks pyrmts won't fetch shards (they may be in-progress
 *  or missing); the legacy `stitchInProgressDay` covers today's data. */
export function availWatermarks(now: Date = new Date()): Record<string, Date> {
	const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
	return { h1: utcMidnight, d1: monthStart, mo1: yearStart };
}

// ─────────────────────────────────────────────────────────────────────
// End-to-end: plan → fetch → pivot → stitch → reduce

export interface PyrmtsAvailResult {
	tier: string;
	rows: ReducedRow[];
	authoritativeEnd: string | null;   // ISO timestamp where the pyramid stops covering
}

/** Execute an availability totals query via pyrmts. Caller decides whether
 *  to use this output or fall back to the legacy path. */
export async function executeAvailViaPyrmts(
	bucket: R2Bucket,
	p: TotalsParams,
): Promise<PyrmtsAvailResult> {
	const pyramid = availPyramid(bucket);
	const range = {
		from: new Date(p.fromS * 1000),
		to: new Date(p.toS * 1000),
	};
	// `binBudget` is interpreted by pyrmts as max output bins. Mirror ctbk's
	// `binS`-driven tier selection by computing the equivalent bin count.
	// `ceil` (not `floor`) so a window like 86398s @ 3600s-bins still gets
	// budget=24 (the user wants 24 hourly bins, possibly the last one partial).
	const windowMs = (p.toS - p.fromS) * 1000;
	const binBudget = p.binS
		? Math.max(1, Math.ceil(windowMs / (p.binS * 1000)))
		: 8760;  // hours/year — generous default lets planner walk down to finest
	const watermarks = availWatermarks();
	const filter: Record<string, string> = {};
	// Pyrmts' planner only supports `{dim}` placeholders in the keyTemplate.
	// Our template uses `{tier}/{period}` only — no per-dim sharding — so
	// no filter is needed for shard-key construction. Per-station RG pruning
	// happens via hyparquet's column-stats check below (pyrmts §2 added
	// `FetchOptions.filters`); see `~/c/pyrmts/specs/done/writer-helper-and-arbitrary-col-rg-prune.md`.
	const plan = planQuery(pyramid, { range, binBudget, watermarks, filter });

	const stationFilter = p.filterStationId?.length ? new Set(p.filterStationId) : null;
	const rgFilters = p.filterStationId?.length
		? [{ col: 'station_id', values: p.filterStationId }]
		: undefined;

	const shardRows = await Promise.all(
		plan.segments.map((seg) =>
			Promise.all(seg.keys.map((k) => fetchShardData(pyramid.storage, k, {
				binCol: pyramid.binCol,
				range: { from: seg.from, to: seg.to },
				filters: rgFilters,
			}).catch(() => [] as Row[]))).then((arrs) =>
				arrs.flat(),
			),
		),
	);
	const widened = shardRows.map(pivotPerMetric);

	const stitched = stitch({ pyramid, plan, shardRows: widened });

	// Post-fetch station filter — RG pruning above narrows reads to RGs whose
	// `station_id` stats overlap the request, but row groups can still contain
	// non-matching stations; final filter is exact.
	const filtered = stationFilter
		? stitched.filter((r) => stationFilter.has(r.station_id as string))
		: stitched;

	const reducer = (p.availAgg ?? 'mean') as AvailAgg;
	const reducedRows = applyReducer(filtered, p.metric as AvailMetric, reducer);

	return {
		tier: plan.outputTier.name,
		rows: reducedRows,
		authoritativeEnd: plan.authoritativeEnd?.toISOString() ?? null,
	};
}

// ─────────────────────────────────────────────────────────────────────
// Shadow-mode delta logging — caller invokes after legacy path returns.

export interface ShadowDelta {
	tier: string;
	rowsLegacy: number;
	rowsPyrmts: number;
	exactMatchPct: number;       // fraction of (dt, station_id) keys whose value matches
	maxAbsDiff: number;          // for numeric reducers
	authoritativeEnd: string | null;
}

/** Compare a legacy result vs a pyrmts result. Logs are designed to be
 *  scraped from `wrangler tail` to validate parity before cutting over. */
export function shadowDelta(
	legacy: TotalsResponse,
	pyrmts: PyrmtsAvailResult,
	reducer: AvailAgg,
): ShadowDelta {
	const legacyByKey = new Map<string, unknown>();
	for (const r of legacy.rows) {
		const key = `${(r as Record<string, unknown>).dt}\x00${(r as Record<string, unknown>).station_id ?? ''}`;
		legacyByKey.set(key, (r as Record<string, unknown>)[reducer]);
	}
	let matched = 0;
	let maxAbsDiff = 0;
	for (const r of pyrmts.rows) {
		const key = `${r.dt}\x00${r.station_id}`;
		const legacyVal = legacyByKey.get(key);
		if (legacyVal === undefined) continue;
		if (typeof r.value === 'number' && typeof legacyVal === 'number') {
			const diff = Math.abs(r.value - legacyVal);
			if (diff > maxAbsDiff) maxAbsDiff = diff;
			if (diff < 1e-6) matched++;
		} else if (r.value === legacyVal) {
			matched++;
		}
	}
	const total = pyrmts.rows.length;
	return {
		tier: pyrmts.tier,
		rowsLegacy: legacy.rows.length,
		rowsPyrmts: total,
		exactMatchPct: total > 0 ? matched / total : 1,
		maxAbsDiff,
		authoritativeEnd: pyrmts.authoritativeEnd,
	};
}
