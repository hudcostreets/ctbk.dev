/**
 * Bin + aggregate rows for `/api/query`. Two flavors:
 *
 *   - `binAndAggregateTrips`: trips path. Sums `count` and `duration_s` per
 *     (bin × dims) bucket. Optionally synthesizes `count: 1` per source row
 *     (for raw per-station files that have no explicit count column).
 *
 *   - `binAndAggregateAvailability`: state path. Per metric column emits
 *     `<f>_mean`, `<f>_min`, `<f>_max`, `<f>_p05/p25/p50/p75/p95`. Plus a
 *     single `sample_count` per bucket. Sum-aggregation isn't meaningful
 *     for availability state (one row per minute poll).
 *
 * `binAndAggregate` is a thin dispatcher kept around for executeQuery.
 */
const SECOND_MS = 1000;

/** Trips: numeric metric columns to sum per bucket. Other numeric cols (e.g. `gender`,
 * a 0/1/2 enum) are categorical — kept as a group-key via `dims` or dropped. */
export const TRIPS_METRIC_COLUMNS = new Set(['count', 'duration_s']);

/** Availability: numeric state columns we aggregate per bucket. Allowlist guards
 * against quietly summing/percentile-ing fields that are categorical or boolean
 * (`is_installed`, `is_renting`, `is_returning`, `last_reported`). */
export const AVAILABILITY_METRIC_COLUMNS = [
	'num_bikes_available',
	'num_ebikes_available',
	'num_docks_available',
	'num_bikes_disabled',
	'num_docks_disabled',
] as const;

/** Quantile probabilities emitted per availability metric. */
export const AVAILABILITY_QUANTILES: { suffix: string; p: number }[] = [
	{ suffix: 'p05', p: 0.05 },
	{ suffix: 'p25', p: 0.25 },
	{ suffix: 'p50', p: 0.50 },
	{ suffix: 'p75', p: 0.75 },
	{ suffix: 'p95', p: 0.95 },
];

/**
 * Linear-interpolation quantile (R type-7, NumPy default) on a *sorted*
 * non-empty array.
 */
export function quantileSorted(sorted: number[], p: number): number {
	const n = sorted.length;
	if (n === 0) throw new Error('quantileSorted: empty input');
	if (n === 1) return sorted[0];
	const idx = (n - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	const frac = idx - lo;
	return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Build the bin (and optional dim) group key for a row. */
function bucketKey(bin: number, dims: string[], r: Record<string, unknown>): string {
	if (dims.length === 0) return String(bin);
	return `${bin}|${dims.map((d) => String(r[d] ?? '')).join('|')}`;
}

/** Stable secondary sort by dim values (after primary `dt` sort). */
function compareByDims(a: Record<string, unknown>, b: Record<string, unknown>, dims: string[]): number {
	for (const d of dims) {
		const av = String(a[d] ?? '');
		const bv = String(b[d] ?? '');
		if (av !== bv) return av < bv ? -1 : 1;
	}
	return 0;
}

/**
 * Trips bin/aggregate. Groups by `(bin, ...dims)`, sums recognized metric
 * columns. With `synthesizeCount=true`, injects `count: 1` per source row
 * (used for raw per-station trip files which have no explicit count column).
 */
export function binAndAggregateTrips(
	rows: Record<string, unknown>[],
	binMs: number,
	fromS: number,
	toS: number,
	dims: string[] = [],
	synthesizeCount = false,
): Record<string, unknown>[] {
	const binS = Math.max(1, Math.floor(binMs / SECOND_MS));
	const buckets = new Map<string, Record<string, unknown>>();
	for (const r of rows) {
		const dt = r.dt as number | undefined;
		if (dt === undefined || dt < fromS || dt > toS) continue;
		const bin = Math.floor(dt / binS) * binS;
		const key = bucketKey(bin, dims, r);
		let acc = buckets.get(key);
		if (!acc) {
			acc = { dt: bin };
			for (const d of dims) acc[d] = r[d];
			buckets.set(key, acc);
		}
		if (synthesizeCount) {
			acc.count = ((acc.count as number) ?? 0) + 1;
		}
		for (const k of TRIPS_METRIC_COLUMNS) {
			if (synthesizeCount && k === 'count') continue;  // already incremented
			const v = r[k];
			if (typeof v === 'number') {
				acc[k] = ((acc[k] as number) ?? 0) + v;
			}
		}
	}
	return [...buckets.values()].sort((a, b) => {
		const aDt = a.dt as number;
		const bDt = b.dt as number;
		if (aDt !== bDt) return aDt - bDt;
		return compareByDims(a, b, dims);
	});
}

/** Per-bucket accumulator for availability stats. */
interface AvailAcc {
	dt: number;
	dimVals: Record<string, unknown>;
	count: number;
	fields: Map<string, { min: number; max: number; sum: number; samples: number[] }>;
}

/**
 * Availability bin/aggregate. Groups by `(bin, ...dims)`. Per metric column,
 * emits `<f>_mean`, `<f>_min`, `<f>_max`, and quantiles. Plus `sample_count`
 * (rows in bucket) emitted once per bucket.
 *
 * Memory: one `samples: number[]` per (bucket × field). Bounded by the raw
 * row count; acceptable at availability volumes (~10k samples per bucket
 * worst case for system-wide minute polls binned to a day).
 */
export function binAndAggregateAvailability(
	rows: Record<string, unknown>[],
	binMs: number,
	fromS: number,
	toS: number,
	dims: string[] = [],
	metricColumns: readonly string[] = AVAILABILITY_METRIC_COLUMNS,
): Record<string, unknown>[] {
	const binS = Math.max(1, Math.floor(binMs / SECOND_MS));
	const buckets = new Map<string, AvailAcc>();
	for (const r of rows) {
		const dt = r.dt as number | undefined;
		if (dt === undefined || dt < fromS || dt > toS) continue;
		const bin = Math.floor(dt / binS) * binS;
		const key = bucketKey(bin, dims, r);
		let acc = buckets.get(key);
		if (!acc) {
			const dimVals: Record<string, unknown> = {};
			for (const d of dims) dimVals[d] = r[d];
			acc = { dt: bin, dimVals, count: 0, fields: new Map() };
			buckets.set(key, acc);
		}
		acc.count += 1;
		for (const f of metricColumns) {
			const v = r[f];
			if (typeof v !== 'number') continue;
			let stats = acc.fields.get(f);
			if (!stats) {
				stats = { min: v, max: v, sum: 0, samples: [] };
				acc.fields.set(f, stats);
			}
			if (v < stats.min) stats.min = v;
			if (v > stats.max) stats.max = v;
			stats.sum += v;
			stats.samples.push(v);
		}
	}

	const out: Record<string, unknown>[] = [];
	for (const acc of buckets.values()) {
		const row: Record<string, unknown> = { dt: acc.dt, ...acc.dimVals, sample_count: acc.count };
		for (const f of metricColumns) {
			const stats = acc.fields.get(f);
			if (!stats || stats.samples.length === 0) continue;
			const sorted = stats.samples.slice().sort((a, b) => a - b);
			row[`${f}_mean`] = stats.sum / sorted.length;
			row[`${f}_min`] = stats.min;
			row[`${f}_max`] = stats.max;
			for (const { suffix, p } of AVAILABILITY_QUANTILES) {
				row[`${f}_${suffix}`] = quantileSorted(sorted, p);
			}
		}
		out.push(row);
	}
	return out.sort((a, b) => {
		const aDt = a.dt as number;
		const bDt = b.dt as number;
		if (aDt !== bDt) return aDt - bDt;
		return compareByDims(a, b, dims);
	});
}

export interface BinOptions {
	kind: 'trips' | 'availability';
	binMs: number;
	fromS: number;
	toS: number;
	dims?: string[];
	/** Trips-only: synthesize `count: 1` per source row (raw per-station files). */
	synthesizeCount?: boolean;
}

/** Dispatcher used by the Worker — branches to the right aggregator on `kind`. */
export function binAndAggregate(
	rows: Record<string, unknown>[],
	opts: BinOptions,
): Record<string, unknown>[] {
	const { kind, binMs, fromS, toS, dims = [], synthesizeCount = false } = opts;
	if (kind === 'availability') {
		return binAndAggregateAvailability(rows, binMs, fromS, toS, dims);
	}
	return binAndAggregateTrips(rows, binMs, fromS, toS, dims, synthesizeCount);
}
