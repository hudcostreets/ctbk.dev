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
export type TotalsMetric = 'count' | 'duration_s';

/** Storage tier picked by `pickTripsAggTier`. */
export type TripsAggTier = 'mo1' | 'd1' | 'h1';

const SECOND_MS = 1000;
const DAY_S = 86400;
const MONTH_S = 30 * DAY_S;
const YEAR_S = 365 * DAY_S;

/** Sum-monoid metric columns for trips. */
export const TRIPS_TOTAL_METRICS: readonly TotalsMetric[] = ['count', 'duration_s'];

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
	filterShortName?: string[];              // optional restrict
	filterRegion?: Region[];                 // optional restrict
	filterSide?: Side;                       // optional restrict (trips only)
}

/** `/api/totals` JSON response shape. */
export interface TotalsResponse {
	kind: TotalsKind;
	metric: TotalsMetric;
	scope: TotalsScope;
	tier: TripsAggTier | 'fallback-stations' | 'fallback-regions';
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

	const metricRaw = params.get('metric') ?? 'count';
	if (metricRaw !== 'count' && metricRaw !== 'duration_s') {
		throw new Error(`metric must be 'count' or 'duration_s' (got ${metricRaw})`);
	}
	const metric = metricRaw;

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

	return { kind, metric, fromS, toS, scope, dims, filterShortName, filterRegion, filterSide };
}

/**
 * Pick the coarsest agg tier whose calendar bucket the requested window
 * comfortably spans:
 *   ≥ 1 year   → mo1   (yearly shards)
 *   ≥ 1 month  → d1    (monthly shards)
 *   ≥ 1 day    → h1    (daily shards)
 *   else       → null  → caller should fall back to per-station scans
 */
export function pickTripsAggTier(fromS: number, toS: number): TripsAggTier | null {
	const span = toS - fromS;
	if (span >= YEAR_S) return 'mo1';
	if (span >= MONTH_S) return 'd1';
	if (span >= DAY_S) return 'h1';
	return null;
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

/**
 * R2 keys for the eventual `trips/agg/<tier>/<window>.parquet` shards
 * covering the requested window. Once `ctbk trips-agg` lands, these are the
 * primary source. Until then we expect 404s and fall back per
 * `tripsTotalsFallbackPaths` below.
 */
export function tripsAggKeys(tier: TripsAggTier, fromS: number, toS: number): string[] {
	switch (tier) {
		case 'mo1': return yearsIn(fromS, toS).map((y) => `trips/agg/mo1/${y}.parquet`);
		case 'd1':  return monthsInDashed(fromS, toS).map((ym) => `trips/agg/d1/${ym}.parquet`);
		case 'h1':  return daysIn(fromS, toS).map((d) => `trips/agg/h1/${d}.parquet`);
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
			buckets.set(key, acc);
		}
		if (synthesizeCount) {
			acc.count = (acc.count as number) + 1;
		} else {
			const c = r.count;
			if (typeof c === 'number') acc.count = (acc.count as number) + c;
		}
		const d = r.duration_s;
		if (typeof d === 'number') acc.duration_s = (acc.duration_s as number) + d;
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
