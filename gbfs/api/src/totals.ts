/**
 * Pure helpers for `/api/totals` — the new "monoid totals over a window"
 * endpoint described in `specs/multiscale-timeseries-backend.md` § "Worker
 * query API".
 *
 * Trips path (this file):
 *   - Parse + validate query params.
 *   - Pick a storage tier from the requested window:
 *       window ≥ 1y  → mo1
 *       window ≥ 1mo → d1
 *       window ≥ 1d  → h1
 *       else         → fall back to per-station scan
 *     The agg-tier files (`trips/agg/<tier>/<window>.parquet`) don't exist
 *     yet — they'll be produced by a separate Python `trips-agg` stage. Until
 *     then we attempt the agg shards and on 404 fall back to the existing
 *     per-region or per-station shards already on R2 (see
 *     `tripsTotalsFallbackPaths`).
 *   - Aggregate sum-monoid metrics (`count`, `duration_s`) into one row
 *     per `(scope × dims)` group via `aggregateTotals`.
 *
 * Availability path: not yet implemented (see `specs/...` § "Open EDA";
 * needs joint-vs-marginal-histogram decision before we can wire it).
 *
 * Kept free of any Cloudflare runtime imports so it's directly unit-testable.
 */

import {
	ALL_REGIONS,
	monthsIn,
	monthsInDashed,
	yearsIn,
	type Region,
	type Side,
} from './planQuery';

export type TotalsKind = 'trips' | 'availability';
export type TotalsScope = 'stations' | 'regions' | 'all';
export type TripsMetric = 'count' | 'duration_s' | 'duration_s_sq';
export type AvailMetric = 'bikes' | 'ebikes' | 'docks' | 'disabled' | 'pending';
/** `'all'` is a meta-metric that, for availability totals, returns one row
 *  per (bin?, scope-key, ...dims, metric) — all 5 availability metrics in
 *  a single response. Avoids 5x round-trips for stacked-area chart fetches. */
export type AvailMetricParam = AvailMetric | 'all';
export type TotalsMetric = TripsMetric | AvailMetricParam;

/** Storage tier picked by `pickAggTier` (shared trips/availability). */
export type AggTier = 'mo1' | 'd1' | 'h1';
/** Back-compat alias. */
export type TripsAggTier = AggTier;

/** Histogram reducers for availability (`agg=` parameter). `hist` returns
 *  the raw merged histogram as an array of `{state, minutes}` rows. */
export type AvailAgg = 'mean' | 'min' | 'max' | 'p05' | 'p25' | 'p50' | 'p75' | 'p95' | 'hist';
export const AVAIL_METRICS: readonly AvailMetric[] = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'];
export const AVAIL_AGGS: readonly AvailAgg[] = ['mean', 'min', 'max', 'p05', 'p25', 'p50', 'p75', 'p95', 'hist'];

const SECOND_MS = 1000;
const HOUR_S = 3600;
const DAY_S = 86400;
const MONTH_S = 30 * DAY_S;
const YEAR_S = 365 * DAY_S;

/** Sum-monoid metric columns for trips. `duration_s_sq` is the per-trip
 *  duration² sum — pairs with `count` and `duration_s` to derive mean/stddev
 *  on any subgroup (see v2 §"Variance/percentile reducers"). */
export const TRIPS_TOTAL_METRICS: readonly TripsMetric[] = ['count', 'duration_s', 'duration_s_sq'];

/** Allowlist of dim columns clients may break out by (trips). Keep in sync
 *  with the `trips/agg/<tier>` schema in the spec. */
export const TRIPS_DIM_COLUMNS = [
	'side',
	'gender',
	'user_type',
	'rideable_type',
	'region',
	'short_name',
] as const;
export type TripsDim = (typeof TRIPS_DIM_COLUMNS)[number];

/** Parsed `/api/totals` request, validated. Pure; throws on invalid input. */
export interface TotalsParams {
	kind: TotalsKind;
	metric: TotalsMetric;
	fromS: number;
	toS: number;
	scope: TotalsScope;
	dims: string[];                          // never `undefined`; `[]` means "no breakouts"
	filterShortName?: string[];              // optional restrict (trips only — short_name)
	filterStationId?: string[];              // optional restrict (availability — UUID)
	filterRegion?: Region[];                 // optional restrict
	filterSide?: Side;                       // optional restrict (trips only)
	availAgg?: AvailAgg;                     // availability only; default 'mean'
	binS?: number;                           // availability only; time-bin aggregation in seconds
}

/** `/api/totals` JSON response shape. */
export interface TotalsResponse {
	kind: TotalsKind;
	metric: TotalsMetric;
	scope: TotalsScope;
	tier: AggTier | 'fallback-stations' | 'fallback-regions';
	/** Rows shaped per the requested reducer. For trips: one row per
	 *  `(scope × dims)` with `count` + `duration_s`. For availability:
	 *  one row per `(scope × dims)` with the requested `agg` field
	 *  (`mean` / `p50` / etc), or `hist` as `[{state, minutes}, ...]`. */
	rows: Record<string, unknown>[];
}

/**
 * Parse + validate `/api/totals` query parameters. Pure; throws on invalid
 * input. See top-of-file for the parameter shape.
 */
export function parseTotalsParams(params: URLSearchParams): TotalsParams {
	const kindRaw = params.get('kind');
	if (kindRaw !== 'trips' && kindRaw !== 'availability') {
		throw new Error(`kind must be 'trips' or 'availability' (got ${kindRaw})`);
	}
	const kind = kindRaw;

	const metricRaw = params.get('metric') ?? (kind === 'trips' ? 'count' : 'bikes');
	let metric: TotalsMetric;
	if (kind === 'trips') {
		if (metricRaw !== 'count' && metricRaw !== 'duration_s' && metricRaw !== 'duration_s_sq') {
			throw new Error(`metric must be one of count|duration_s|duration_s_sq for kind=trips (got ${metricRaw})`);
		}
		metric = metricRaw;
	} else {
		const allowed = [...AVAIL_METRICS, 'all'];
		if (!(allowed as readonly string[]).includes(metricRaw)) {
			throw new Error(`metric must be one of ${allowed.join('|')} for kind=availability (got ${metricRaw})`);
		}
		metric = metricRaw as AvailMetricParam;
	}

	const fromS = parseInt(params.get('from') ?? '', 10);
	const toS = parseInt(params.get('to') ?? '', 10);
	if (!Number.isFinite(fromS) || !Number.isFinite(toS) || fromS > toS) {
		throw new Error('invalid from/to');
	}

	const scopeRaw = params.get('scope') ?? 'stations';
	if (scopeRaw !== 'stations' && scopeRaw !== 'regions' && scopeRaw !== 'all') {
		throw new Error(`scope must be 'stations' | 'regions' | 'all' (got ${scopeRaw})`);
	}
	const scope = scopeRaw;

	const dimsRaw = params.get('dims');
	const dims: string[] = dimsRaw
		? dimsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: [];
	if (kind === 'trips') {
		for (const d of dims) {
			if (!(TRIPS_DIM_COLUMNS as readonly string[]).includes(d)) {
				throw new Error(`invalid dim for trips: ${d}`);
			}
		}
	}

	const shortNameRaw = params.get('filter.short_name');
	const filterShortName = shortNameRaw
		? shortNameRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: undefined;

	const regionRaw = params.get('filter.region');
	let filterRegion: Region[] | undefined;
	if (regionRaw !== null) {
		filterRegion = regionRaw.split(',').map((s) => s.trim()) as Region[];
		for (const r of filterRegion) {
			if (!ALL_REGIONS.includes(r)) throw new Error(`invalid filter.region: ${r}`);
		}
	}

	const sideRaw = params.get('filter.side');
	if (sideRaw !== null && sideRaw !== 'start' && sideRaw !== 'end') {
		throw new Error(`filter.side must be 'start' or 'end'`);
	}
	const filterSide = (sideRaw as Side | null) ?? undefined;

	const stationIdRaw = params.get('filter.station_id');
	const filterStationId = stationIdRaw
		? stationIdRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
		: undefined;

	let availAgg: AvailAgg | undefined;
	const aggRaw = params.get('agg');
	if (kind === 'availability') {
		const a = aggRaw ?? 'mean';
		if (!(AVAIL_AGGS as readonly string[]).includes(a)) {
			throw new Error(`agg must be one of ${AVAIL_AGGS.join('|')} (got ${a})`);
		}
		availAgg = a as AvailAgg;
	} else if (aggRaw !== null) {
		throw new Error(`agg= is only valid for kind=availability`);
	}

	// `bin=<seconds>` (availability only): when set, output one row per
	// (floor(dt/binS)*binS, scope-key, ...dims) instead of one row per
	// (scope-key, ...dims) for the whole window. Enables time-binned charts.
	let binS: number | undefined;
	const binRaw = params.get('bin');
	if (binRaw !== null) {
		if (kind !== 'availability') {
			throw new Error(`bin= is only valid for kind=availability`);
		}
		const b = parseInt(binRaw, 10);
		if (!Number.isFinite(b) || b <= 0) {
			throw new Error(`bin must be a positive integer of seconds (got ${binRaw})`);
		}
		// Lower-bound: h1 tier's natural bucket is 1h (3600s). Asking for a
		// finer bin would require raw n0 data which the agg pipeline doesn't
		// preserve. Reject up-front.
		if (b < HOUR_S) {
			throw new Error(`bin must be ≥ ${HOUR_S}s (avail-agg tier minimum); got ${b}`);
		}
		binS = b;
	}

	return {
		kind, metric, fromS, toS, scope, dims,
		filterShortName, filterStationId, filterRegion, filterSide, availAgg, binS,
	};
}

/**
 * Pick the coarsest agg tier whose natural bin is finer than the window —
 * minimizes file reads since coarser tiers pack more bins per file.
 *   ≥ 1 year   → mo1   (decade-period file, 1mo bins)
 *   ≥ 1 month  → d1    (year-period file, 1d bins)
 *   ≥ 1 day    → h1    (month-period file, 1h bins)
 *   else       → null  → caller falls back to per-station rides files
 *
 * Optional `binS` lets binned planQuery callers pick by requested bin
 * granularity (mirrors `pickAvailAggTier`).
 */
export function pickTripsAggTier(fromS: number, toS: number, binS?: number): AggTier | null {
	if (binS !== undefined) {
		if (binS >= MONTH_S) return 'mo1';
		if (binS >= DAY_S) return 'd1';
		if (binS >= 3600) return 'h1';
		return null;
	}
	const span = toS - fromS;
	if (span >= YEAR_S) return 'mo1';
	if (span >= MONTH_S) return 'd1';
	if (span >= DAY_S) return 'h1';
	return null;
}

/**
 * Availability shares the same tier ladder. Default to `h1` for short
 * windows since `n0` (raw 1-min polls) isn't a totals-friendly shape — the
 * histogram aggregator only collapses pre-bucketed minute counts.
 */
export function pickAvailAggTier(fromS: number, toS: number, binS?: number): AggTier {
	// When `binS` is set, pick the COARSEST tier whose natural bin is ≤ binS.
	// (Coarser = fewer files; bin-≤-natural is required to actually produce
	// the requested bin granularity.)
	if (binS !== undefined) {
		if (binS >= MONTH_S) return 'mo1';
		if (binS >= DAY_S) return 'd1';
		return 'h1';
	}
	const span = toS - fromS;
	if (span >= YEAR_S) return 'mo1';
	if (span >= MONTH_S) return 'd1';
	return 'h1';
}

/** Enumerate YYYY-MM-DD days touching [fromS, toS] (UTC). */
export function daysIn(fromS: number, toS: number): string[] {
	const MS_PER_DAY = 86400 * SECOND_MS;
	const startMs = fromS * SECOND_MS;
	const endMs = toS * SECOND_MS;
	const day0 = new Date(startMs);
	day0.setUTCHours(0, 0, 0, 0);
	const out: string[] = [];
	for (let t = day0.getTime(); t <= endMs; t += MS_PER_DAY) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}

/** Enumerate decade-start years (multiples of 10) touching [fromS, toS] (UTC).
 *  e.g. a 2018-2024 window → ['2010', '2020']. */
export function decadesIn(fromS: number, toS: number): string[] {
	const y0 = new Date(fromS * SECOND_MS).getUTCFullYear();
	const y1 = new Date(toS * SECOND_MS).getUTCFullYear();
	const d0 = Math.floor(y0 / 10) * 10;
	const d1 = Math.floor(y1 / 10) * 10;
	const out: string[] = [];
	for (let d = d0; d <= d1; d += 10) out.push(String(d));
	return out;
}

/**
 * R2 keys for `trips/agg/<tier>/<window>.parquet` shards covering the
 * requested window (v2 layout: monthly h1, yearly d1, decade mo1).
 * Built by `ctbk trips-agg-{h1,d1,mo1}` (see `ctbk/trips_agg.py`).
 */
export function tripsAggKeys(tier: AggTier, fromS: number, toS: number): string[] {
	switch (tier) {
		case 'mo1': return decadesIn(fromS, toS).map((d) => `trips/agg/mo1/${d}.parquet`);
		case 'd1':  return yearsIn(fromS, toS).map((y) => `trips/agg/d1/${y}.parquet`);
		case 'h1':  return monthsInDashed(fromS, toS).map((ym) => `trips/agg/h1/${ym}.parquet`);
	}
}

/**
 * R2 keys for `avail/agg/<tier>/<window>.parquet` shards. Mirrors
 * `tripsAggKeys` — mo1 yearly, d1 monthly, h1 daily. Built by the new
 * `ctbk avail-agg-{h1,d1,mo1}` Python stages (see `ctbk/avail_agg.py`).
 */
export function availAggKeys(tier: AggTier, fromS: number, toS: number): string[] {
	switch (tier) {
		case 'mo1': return yearsIn(fromS, toS).map((y) => `avail/agg/mo1/${y}.parquet`);
		case 'd1':  return monthsInDashed(fromS, toS).map((ym) => `avail/agg/d1/${ym}.parquet`);
		case 'h1':  return daysIn(fromS, toS).map((d) => `avail/agg/h1/${d}.parquet`);
	}
}

/**
 * Fallback chain for when the `trips/agg/<tier>` shards don't exist yet.
 * Documented here so it's clear when this branch can be retired (once
 * `ctbk trips-agg` is producing all tiers, `tripsAggKeys` is enough and this
 * fallback can be deleted).
 *
 *   scope=stations + filter.short_name set → read per-station rides parquets
 *     (`trips/stations/<short_name>.parquet`). One row per ride; we sum.
 *   scope=regions or scope=all → read existing per-region rolled tier files
 *     (`trips/region/<r>/{h1,n1}/<window>.parquet`), which are already on R2.
 *     The picked tier is whatever the planQuery h1/n1 logic would pick — h1
 *     for trips/agg's mo1+d1+h1 selectors, n1 for the per-station-fallback
 *     window.
 */
export function tripsTotalsFallbackPaths(p: TotalsParams): { paths: string[]; tier: 'fallback-stations' | 'fallback-regions' } {
	if (p.scope === 'stations' && p.filterShortName?.length) {
		return {
			paths: p.filterShortName.map((s) => `trips/stations/${s}.parquet`),
			tier: 'fallback-stations',
		};
	}
	// Region fallback: union per-region h1 yearly shards (sufficient for any
	// window the totals endpoint cares about, since totals is windowed not
	// binned).
	const regions: Region[] = p.filterRegion?.length ? p.filterRegion : ALL_REGIONS;
	const years = yearsIn(p.fromS, p.toS);
	return {
		paths: regions.flatMap((r) => years.map((y) => `trips/region/${r}/h1/${y}.parquet`)),
		tier: 'fallback-regions',
	};
}

/** Build the group key for a row from `(scope, ...dims)`. */
function groupKey(scope: TotalsScope, dims: string[], r: Record<string, unknown>): string {
	const parts: string[] = [];
	if (scope === 'stations') parts.push(String(r.short_name ?? ''));
	else if (scope === 'regions') parts.push(String(r.region ?? ''));
	// scope=all → no scope-key part; everything collapses into one bucket.
	for (const d of dims) parts.push(String(r[d] ?? ''));
	return parts.join('|');
}

/**
 * Aggregate trip rows into one totals-row per `(scope × dims)` group, summing
 * the monoid metric columns (`count`, `duration_s`). Rows outside `[fromS, toS]`
 * are dropped; rows missing the scope key (e.g. a row with no `short_name`
 * under `scope=stations`) are also dropped — they can't belong to any group.
 *
 * `synthesizeCount=true` is for raw per-station rides files which have no
 * explicit `count` column (one row per ride). Pre-agg shards already carry
 * an explicit `count` and should pass `synthesizeCount=false`.
 *
 * Filters (`filterShortName`, `filterRegion`, `filterSide`) are applied
 * pre-grouping for symmetry with `executeQuery` semantics.
 */
export function aggregateTotals(
	rows: Record<string, unknown>[],
	p: TotalsParams,
	synthesizeCount: boolean,
): Record<string, unknown>[] {
	const buckets = new Map<string, Record<string, unknown>>();
	const shortNameSet = p.filterShortName?.length ? new Set(p.filterShortName) : null;
	const regionSet = p.filterRegion?.length ? new Set<string>(p.filterRegion) : null;

	for (const r of rows) {
		const dt = r.dt as number | undefined;
		if (typeof dt !== 'number' || dt < p.fromS || dt > p.toS) continue;
		if (p.filterSide !== undefined && r.side !== undefined && r.side !== p.filterSide) continue;
		if (shortNameSet && !shortNameSet.has(String(r.short_name ?? ''))) continue;
		if (regionSet && !regionSet.has(String(r.region ?? ''))) continue;
		// Drop rows missing the scope key — they'd land in a bogus '' bucket.
		if (p.scope === 'stations' && (r.short_name === undefined || r.short_name === null)) continue;
		if (p.scope === 'regions' && (r.region === undefined || r.region === null)) continue;

		const key = groupKey(p.scope, p.dims, r);
		let acc = buckets.get(key);
		if (!acc) {
			acc = {};
			if (p.scope === 'stations') acc.short_name = r.short_name;
			else if (p.scope === 'regions') acc.region = r.region;
			for (const d of p.dims) acc[d] = r[d];
			acc.count = 0;
			acc.duration_s = 0;
			acc.duration_s_sq = 0;
			buckets.set(key, acc);
		}
		if (synthesizeCount) {
			acc.count = (acc.count as number) + 1;
			// For per-ride raw rows synthesizing count, derive `duration_s_sq`
			// from the row's `duration_s` (which is the per-ride duration here,
			// not a sum). For pre-agg rows, sum the column directly below.
			const d = r.duration_s;
			if (typeof d === 'number') {
				acc.duration_s = (acc.duration_s as number) + d;
				acc.duration_s_sq = (acc.duration_s_sq as number) + d * d;
			}
		} else {
			const c = r.count;
			if (typeof c === 'number') acc.count = (acc.count as number) + c;
			const d = r.duration_s;
			if (typeof d === 'number') acc.duration_s = (acc.duration_s as number) + d;
			const dsq = r.duration_s_sq;
			if (typeof dsq === 'number') acc.duration_s_sq = (acc.duration_s_sq as number) + dsq;
		}
	}

	// Stable sort: by scope-key (if any), then dims, for deterministic output.
	const out = [...buckets.values()];
	out.sort((a, b) => {
		const ka = groupKey(p.scope, p.dims, a);
		const kb = groupKey(p.scope, p.dims, b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	return out;
}

// Re-export `monthsIn` so the eventual d1 path has a place to lean if the
// caller needs YYYYMM windows; not currently used here but keeps the import
// surface minimal at the index.ts edge.
export { monthsIn };

// ---------------------------------------------------------------------------
// Availability totals: histogram merge + reducers
// ---------------------------------------------------------------------------

/** One row of the marginal-histogram parquet schema (see
 *  `ctbk/avail_agg.py`). Long-format: one row per `(dt, station_id, metric,
 *  state)` cell, sparse (0-minute states omitted). */
export interface AvailHistRow {
	dt: number;
	station_id: string;
	metric: AvailMetric | string;
	state: number;
	minutes: number;
	[k: string]: unknown;
}

/** Linear-interpolation quantile (R-7 / NumPy default) on a sorted histogram
 *  expressed as parallel arrays of `(state, minutes)`. Treats minutes as
 *  sample weights. Throws on empty input. */
export function availHistQuantile(states: number[], weights: number[], p: number): number {
	if (states.length !== weights.length) throw new Error('states/weights length mismatch');
	if (states.length === 0) throw new Error('availHistQuantile: empty input');
	// Build cumulative-weight curve. Already sorted by `state` (caller guarantee).
	let total = 0;
	for (const w of weights) total += w;
	if (total <= 0) throw new Error('availHistQuantile: zero-weight histogram');
	const target = p * (total - 1);  // 0-indexed sample number
	let cum = 0;
	let prev = states[0];
	for (let i = 0; i < states.length; i++) {
		const next = cum + weights[i];
		// Sample numbers `cum .. next-1` all sit at `states[i]`.
		if (target <= next - 1) {
			// `target` is between `cum` and `next-1` → answer is `states[i]`,
			// linear-interpolate to `states[i+1]` only if `target` straddles
			// the boundary (target == next-1 + frac, frac >= 0 from neighbor).
			const frac = target - Math.floor(target);
			if (frac === 0 || target < next - 1) return states[i];
			// target sits exactly on the last sample of bucket i AND has a
			// fractional component → interpolate to next bucket if there is one.
			if (i + 1 < states.length) return states[i] + frac * (states[i + 1] - states[i]);
			return states[i];
		}
		cum = next;
		prev = states[i];
	}
	// Fall-through (shouldn't happen): return the max state.
	return prev;
}

const QUANTILE_REDUCERS: Record<string, number> = {
	p05: 0.05, p25: 0.25, p50: 0.50, p75: 0.75, p95: 0.95,
};

/** Build the group key for an availability histogram row.
 *  scope=stations → `station_id`. scope=all → `''` (collapse). dims appended.
 *  When `binS` is set, the bin start (`floor(dt/binS)*binS`) is prepended so
 *  rows with the same scope-key but different bins are kept separate. When
 *  `metric === 'all'`, the row's `metric` is appended so each metric gets its
 *  own group. */
function availGroupKey(
	scope: TotalsScope,
	dims: string[],
	binS: number | undefined,
	allMetrics: boolean,
	r: AvailHistRow,
): string {
	const parts: string[] = [];
	if (binS !== undefined) parts.push(String(Math.floor(r.dt / binS) * binS));
	if (scope === 'stations') parts.push(r.station_id ?? '');
	for (const d of dims) parts.push(String((r as Record<string, unknown>)[d] ?? ''));
	if (allMetrics) parts.push(r.metric);
	return parts.join('|');
}

/** Per-group accumulator used by both `aggregateAvailTotals` and the
 *  streaming variant `availFold` / `availFinalize`. */
interface AvailAcc {
	key: string;
	dimVals: Record<string, unknown>;
	hist: Map<number, number>;
}

/**
 * Streaming-friendly fold: ingest one batch of histogram rows (e.g. one
 * parquet file's worth) into a `groups` map. Lets the caller drop the source
 * batch from memory before processing the next file. Pairs with
 * `availFinalize` once all files are folded.
 *
 * Memory bound = sum of per-group sparse histogram sizes — typically tiny
 * even for million-row inputs since each (station × metric) collapses to
 * ≤ ~50 distinct states.
 */
export function availFold(
	rows: Iterable<AvailHistRow>,
	p: TotalsParams,
	groups: Map<string, AvailAcc>,
): void {
	const stationIdSet = p.filterStationId?.length ? new Set(p.filterStationId) : null;
	const allMetrics = p.metric === 'all';
	for (const r of rows) {
		if (typeof r.dt !== 'number' || r.dt < p.fromS || r.dt > p.toS) continue;
		if (!allMetrics && r.metric !== p.metric) continue;
		if (stationIdSet && !stationIdSet.has(r.station_id)) continue;
		if (p.scope === 'stations' && !r.station_id) continue;
		const key = availGroupKey(p.scope, p.dims, p.binS, allMetrics, r);
		let acc = groups.get(key);
		if (!acc) {
			const dimVals: Record<string, unknown> = {};
			if (p.binS !== undefined) dimVals.dt = Math.floor(r.dt / p.binS) * p.binS;
			if (p.scope === 'stations') dimVals.station_id = r.station_id;
			for (const d of p.dims) dimVals[d] = (r as Record<string, unknown>)[d];
			if (allMetrics) dimVals.metric = r.metric;
			acc = { key, dimVals, hist: new Map() };
			groups.set(key, acc);
		}
		acc.hist.set(r.state, (acc.hist.get(r.state) ?? 0) + r.minutes);
	}
}

/** Finalize a folded `groups` map into output rows by applying the reducer. */
export function availFinalize(
	groups: Map<string, AvailAcc>,
	p: TotalsParams,
): Record<string, unknown>[] {
	const reducer = p.availAgg ?? 'mean';
	const out: Record<string, unknown>[] = [];
	for (const acc of groups.values()) {
		const states = [...acc.hist.keys()].sort((a, b) => a - b);
		const weights = states.map((s) => acc.hist.get(s)!);
		let total = 0;
		for (const w of weights) total += w;
		if (total === 0) continue;
		const row: Record<string, unknown> = { ...acc.dimVals, sample_count: total };
		switch (reducer) {
			case 'mean': {
				let s = 0;
				for (let i = 0; i < states.length; i++) s += states[i] * weights[i];
				row.mean = s / total;
				break;
			}
			case 'min': row.min = states[0]; break;
			case 'max': row.max = states[states.length - 1]; break;
			case 'hist':
				row.hist = states.map((s, i) => ({ state: s, minutes: weights[i] }));
				break;
			default: {
				const q = QUANTILE_REDUCERS[reducer];
				if (q === undefined) throw new Error(`unknown availAgg: ${reducer}`);
				row[reducer] = availHistQuantile(states, weights, q);
			}
		}
		out.push(row);
	}
	out.sort((a, b) => {
		// (dt, station_id, metric) — components only present when applicable.
		const da = (a.dt as number | undefined) ?? 0;
		const db = (b.dt as number | undefined) ?? 0;
		if (da !== db) return da - db;
		const ka = String(a.station_id ?? '');
		const kb = String(b.station_id ?? '');
		if (ka !== kb) return ka < kb ? -1 : 1;
		const ma = String(a.metric ?? '');
		const mb = String(b.metric ?? '');
		return ma < mb ? -1 : ma > mb ? 1 : 0;
	});
	return out;
}

/**
 * Aggregate availability histogram rows into one totals-row per
 * `(scope × dims)` group, applying the requested reducer.
 *
 *   - Filter to `metric` + window + optional station/region.
 *   - Group by `(scope × dims)`.
 *   - Within a group, merge histograms across `(dt, ...)` → sum `minutes`
 *     by `state` (the histogram CRDT combiner; see spec §Metrics as monoids).
 *   - Apply `availAgg` (default `mean`) on the merged histogram.
 *
 * `region` filtering / scope=regions requires a `station_id → region` map
 * (not in the parquet); not yet supported here. Caller can resolve client-side.
 *
 * Convenience wrapper around `availFold` + `availFinalize` — fine for tests
 * and small inputs. Workers should prefer the streaming variant to avoid
 * holding all source rows in memory at once.
 */
export function aggregateAvailTotals(
	rows: AvailHistRow[],
	p: TotalsParams,
): Record<string, unknown>[] {
	const groups = new Map<string, AvailAcc>();
	availFold(rows, p, groups);
	return availFinalize(groups, p);
}

/** Columns to project from the avail/agg parquets. */
export function projectionForAvailTotals(_p: TotalsParams): string[] {
	return ['dt', 'station_id', 'metric', 'state', 'minutes'];
}
