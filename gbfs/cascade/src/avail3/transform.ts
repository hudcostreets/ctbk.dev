/**
 * Raw 1m parquet → LUC-expanded histogram rows.
 *
 * Input shape (from `gbfs/loader`'s per-minute output at
 * `gbfs/avail/agg=1m/cons=1m/<date>/<HHMM>.parquet`):
 *   station_id UTF8, dt INT64 (ms epoch),
 *   bikes_n INT32, bikes_sum DOUBLE, bikes_sum_sq DOUBLE,
 *   ebikes_n …, docks_n …, disabled_n …, pending_n …
 *
 * Output shape (avail-v3 sub-shard schema, per `configs/pyramids/avail.yaml`):
 *   s2_cell UTF8, dt INT64,
 *   bikes UTF8 (`{value:count}` JSON), ebikes …, docks …, disabled …, pending …
 *
 * Transform:
 *   1. Per row: `value = sum / n` (n is always 1 from the loader, so `value = sum`).
 *   2. LUC expansion: emit a row at each S2 ancestor cell L10..L(luc_level)
 *      using `LucIndex.chains[station_id]`.
 *   3. Group by `(s2_cell, dt)`. Per `(s2_cell, dt, metric)`, increment
 *      `hist[value]` by 1 for each station observation reaching that cell.
 *   4. Serialize each per-metric histogram to a JSON string.
 *
 * Skips rows where:
 *   - `station_id` isn't in the LUC denorm (new station since last refresh).
 *   - A metric's `_n` is 0 or its `_sum` is null (station didn't report).
 */
import type { LucIndex } from './luc';

export const AVAIL_METRICS = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;
export type AvailMetric = typeof AVAIL_METRICS[number];

export interface AvailV3Row {
	s2_cell: string;
	dt: bigint;
	bikes: string;     // JSON: {value: count}
	ebikes: string;
	docks: string;
	disabled: string;
	pending: string;
}

type Histogram = Map<number, number>;

interface CellBucket {
	// One histogram per metric. Lazy: only populated when a row contributes.
	bikes: Histogram;
	ebikes: Histogram;
	docks: Histogram;
	disabled: Histogram;
	pending: Histogram;
}

function newBucket(): CellBucket {
	return {
		bikes: new Map(),
		ebikes: new Map(),
		docks: new Map(),
		disabled: new Map(),
		pending: new Map(),
	};
}

function bumpHist(h: Histogram, value: number): void {
	h.set(value, (h.get(value) ?? 0) + 1);
}

function histToJson(h: Histogram): string {
	if (h.size === 0) return '{}';
	// Stable key order (smallest first) for byte-stable output across
	// re-runs at the same content.
	const sorted = Array.from(h.entries()).sort((a, b) => a[0] - b[0]);
	const obj: Record<string, number> = {};
	for (const [k, v] of sorted) obj[String(k)] = v;
	return JSON.stringify(obj);
}

/** Pivot one raw row of input parquet to `(metric → value)`. Returns
 *  null if all metrics are null/zero-n (station didn't report this minute). */
function rowMetrics(row: Record<string, unknown>): Partial<Record<AvailMetric, number>> | null {
	const out: Partial<Record<AvailMetric, number>> = {};
	let any = false;
	for (const m of AVAIL_METRICS) {
		const n = row[`${m}_n`] as number | null | undefined;
		const sum = row[`${m}_sum`] as number | null | undefined;
		if (n === null || n === undefined || n === 0) continue;
		if (sum === null || sum === undefined) continue;
		// n is always 1 in the loader output; `value` is the integer count.
		out[m] = Math.round(sum / n);
		any = true;
	}
	return any ? out : null;
}

/** Transform raw 1m parquet rows → LUC-expanded histogram rows.
 *  Returns an array of avail-v3 wide rows ready to write to parquet. */
export function transformMinuteRows(
	rawRows: Record<string, unknown>[],
	luc: LucIndex,
): AvailV3Row[] {
	// (s2_cell, dt) → bucket of per-metric histograms.
	// Key: `${s2_cell}\x00${dt}` — `\x00` is safe since neither cell tokens
	// nor stringified dt contain a null byte.
	const buckets = new Map<string, CellBucket>();

	for (const row of rawRows) {
		const stationId = row.station_id as string | null;
		if (!stationId) continue;
		const chain = luc.chains.get(stationId);
		if (!chain) continue;
		const dtRaw = row.dt as bigint | number | null;
		if (dtRaw === null || dtRaw === undefined) continue;
		// Raw 1m@1m loader writes `dt` in SECONDS (legacy convention,
		// shared with gbfs/avail/agg=*/cons=*). avail-v3 expects MS to
		// match pyrmts's `binCol: dt` Date interpretation. Convert here.
		const dtMs = typeof dtRaw === 'bigint' ? dtRaw * 1000n : BigInt(dtRaw) * 1000n;
		const dtKey = dtMs.toString();
		const metrics = rowMetrics(row);
		if (metrics === null) continue;

		for (const cell of chain) {
			const key = `${cell}\x00${dtKey}`;
			let bucket = buckets.get(key);
			if (bucket === undefined) {
				bucket = newBucket();
				buckets.set(key, bucket);
			}
			for (const m of AVAIL_METRICS) {
				const v = metrics[m];
				if (v === undefined) continue;
				bumpHist(bucket[m], v);
			}
		}
	}

	const out: AvailV3Row[] = [];
	for (const [key, bucket] of buckets) {
		const sepIdx = key.indexOf('\x00');
		const s2_cell = key.slice(0, sepIdx);
		const dt = BigInt(key.slice(sepIdx + 1));
		out.push({
			s2_cell,
			dt,
			bikes: histToJson(bucket.bikes),
			ebikes: histToJson(bucket.ebikes),
			docks: histToJson(bucket.docks),
			disabled: histToJson(bucket.disabled),
			pending: histToJson(bucket.pending),
		});
	}
	return out;
}

/** Merge multiple avail-v3 row sets (typically one per minute) into a
 *  single set, summing histograms per `(s2_cell, dt)`. Handles the
 *  "concat N partials of finer cadence" cascade step.
 *
 *  Optionally rebin dt: if `binMs` is provided, dt values get floored to
 *  the bin boundary before grouping.
 *
 *  Performance: in cadence cascades (e.g. /p3h reading 3× /p1h covering
 *  disjoint hours), every `(cell, dt)` bucket has exactly one
 *  contributor. The fast path returns those rows verbatim — no
 *  JSON.parse / Map accumulate / JSON.stringify round-trip. /p3h
 *  merging ~700k rows had been CPU-bound at ~10s on the slow path,
 *  silently timing out the CF Worker (only 1 of 11 expected /p3h
 *  shards landed since CFW deploy 2026-06-27 until this fix). The slow
 *  path remains exact for re-binning and any genuine multi-contributor
 *  buckets (Phase 3+ derived-tier partials). */
export function mergeRows(
	rowSets: AvailV3Row[][],
	binMs?: bigint,
): AvailV3Row[] {
	// (cell, dt) → row, kept verbatim while each bucket has one contributor.
	const single = new Map<string, AvailV3Row>();
	// (cell, dt) → accumulating bucket. Populated only on the 2nd
	// contribution to a bucket; mutually exclusive with `single`.
	const merged = new Map<string, CellBucket>();

	const parseHist = (s: string): Histogram => {
		const h: Histogram = new Map();
		const obj = JSON.parse(s) as Record<string, number>;
		for (const [k, v] of Object.entries(obj)) h.set(Number(k), v);
		return h;
	};
	const rowToBucket = (row: AvailV3Row): CellBucket => ({
		bikes:    parseHist(row.bikes),
		ebikes:   parseHist(row.ebikes),
		docks:    parseHist(row.docks),
		disabled: parseHist(row.disabled),
		pending:  parseHist(row.pending),
	});
	const addRowToBucket = (b: CellBucket, row: AvailV3Row): void => {
		for (const m of AVAIL_METRICS) {
			const incoming = parseHist(row[m]);
			for (const [k, v] of incoming) b[m].set(k, (b[m].get(k) ?? 0) + v);
		}
	};

	for (const rows of rowSets) {
		for (const row of rows) {
			const dt = binMs ? row.dt - (row.dt % binMs) : row.dt;
			const key = `${row.s2_cell}\x00${dt.toString()}`;

			const slow = merged.get(key);
			if (slow !== undefined) {
				addRowToBucket(slow, row);
				continue;
			}
			const fast = single.get(key);
			if (fast === undefined) {
				// First contributor. If binMs floored `dt`, store a
				// new row carrying the bin-aligned dt; else keep the
				// original reference for true zero-copy.
				single.set(key, binMs && dt !== row.dt ? { ...row, dt } : row);
			} else {
				// Second contributor — promote this bucket to slow path.
				single.delete(key);
				const bucket = rowToBucket(fast);
				addRowToBucket(bucket, row);
				merged.set(key, bucket);
			}
		}
	}

	const out: AvailV3Row[] = [];
	for (const row of single.values()) out.push(row);
	for (const [key, bucket] of merged) {
		const sepIdx = key.indexOf('\x00');
		const s2_cell = key.slice(0, sepIdx);
		const dt = BigInt(key.slice(sepIdx + 1));
		out.push({
			s2_cell,
			dt,
			bikes:    histToJson(bucket.bikes),
			ebikes:   histToJson(bucket.ebikes),
			docks:    histToJson(bucket.docks),
			disabled: histToJson(bucket.disabled),
			pending:  histToJson(bucket.pending),
		});
	}
	return out;
}

/** Sort wide rows by `(s2_cell, dt)` for stable, predicate-friendly
 *  parquet output (matches the existing avail-v3 sort order, per
 *  `specs/done/per-station-luc-v3.md` and ctbk #114). */
export function sortRows(rows: AvailV3Row[]): AvailV3Row[] {
	return rows.slice().sort((a, b) => {
		if (a.s2_cell !== b.s2_cell) return a.s2_cell < b.s2_cell ? -1 : 1;
		return a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0;
	});
}

/** Pivot wide rows to columnar form for `parquetWriteBuffer`. */
export function rowsToColumns(rows: AvailV3Row[]) {
	const s2_cell: string[] = [];
	const dt: bigint[] = [];
	const bikes: string[] = [];
	const ebikes: string[] = [];
	const docks: string[] = [];
	const disabled: string[] = [];
	const pending: string[] = [];
	for (const r of rows) {
		s2_cell.push(r.s2_cell);
		dt.push(r.dt);
		bikes.push(r.bikes);
		ebikes.push(r.ebikes);
		docks.push(r.docks);
		disabled.push(r.disabled);
		pending.push(r.pending);
	}
	return [
		{ name: 's2_cell', data: s2_cell, type: 'STRING' as const },
		{ name: 'dt', data: dt, type: 'INT64' as const },
		{ name: 'bikes', data: bikes, type: 'STRING' as const },
		{ name: 'ebikes', data: ebikes, type: 'STRING' as const },
		{ name: 'docks', data: docks, type: 'STRING' as const },
		{ name: 'disabled', data: disabled, type: 'STRING' as const },
		{ name: 'pending', data: pending, type: 'STRING' as const },
	];
}
