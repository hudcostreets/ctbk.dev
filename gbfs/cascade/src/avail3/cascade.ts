/**
 * avail-v3 sub-shard cascade.
 *
 * Per-/5m tick algorithm:
 *
 *   At T (UTC ms, T % 5min == 0), for each cadence c in the ladder
 *   (finest → coarsest), if T % c == 0 the c-cadence boundary just
 *   closed. Write the just-closed sub-shards in cadence order so coarser
 *   cadences can read the finer cadences' just-written output (R2
 *   strong read-after-write).
 *
 * v1 scope: /1m tier partials only. /1m is the freshness-critical tier
 * — it's what coarser-tier queries fall through to when their canonical
 * watermark is stale. Writing /1m partials at 5min..12h closes the
 * fall-through latency for ALL coarser-tier queries.
 *
 * Out of scope (v2):
 *   - Coarser-tier partials (/2m@10min, /5m@10min, etc.). The DAG +
 *     re-binning logic is sketched in `specs/avail-v3-cascade-cfw.md`.
 *
 * Canonical promotion: at midnight UTC, after the /1m@p12h write, concat
 * 2× /1m@p12h covering the prior 24h → /1m canonical at
 * `avail-v3/1m/<YYYY-MM-DD>.parquet`. Record canonical watermark.
 */
import { parquetReadObjects } from 'hyparquet';
import { D1ShardIndex } from 'pyrmts-cfw';
import type { Duration } from 'pyrmts';
import { getLucIndex } from './luc';
import {
	transformMinuteRows,
	mergeRows,
	sortRows,
	rowsToColumns,
	type AvailV3Row,
} from './transform';

export const PYRAMID_NAME = 'avail';
export const AVAIL_V3_PREFIX = 'avail-v3';

/** Source: legacy gbfs/loader per-minute parquet path. */
function rawMinuteKey(t: Date): string {
	const dateStr = t.toISOString().slice(0, 10);  // YYYY-MM-DD
	const hh = String(t.getUTCHours()).padStart(2, '0');
	const mm = String(t.getUTCMinutes()).padStart(2, '0');
	return `gbfs/avail/agg=1m/cons=1m/${dateStr}/${hh}${mm}.parquet`;
}

/** avail-v3 partial sub-shard key.
 *  Per `configs/pyramids/avail.yaml#partialKey`:
 *    `avail-v3/{tier}/p{shard}/{period}.parquet` */
export function partialKey(tier: string, cadence: Cadence, periodStart: Date): string {
	return `${AVAIL_V3_PREFIX}/${tier}/p${cadence.label}/${formatPeriod(periodStart, cadence)}.parquet`;
}

/** avail-v3 canonical shard key.
 *  Per `configs/pyramids/avail.yaml#key`:
 *    `avail-v3/{tier}/{period}.parquet` */
export function canonicalKey(tier: string, periodStart: Date, canonicalShardMs: number): string {
	const period = canonicalShardMs === 86400000  // 1 day
		? periodStart.toISOString().slice(0, 10)
		: periodStart.toISOString().slice(0, 10);  // TODO: other shard sizes
	return `${AVAIL_V3_PREFIX}/${tier}/${period}.parquet`;
}

/** Period label for a partial. Uses minute granularity for sub-day, hour
 *  for sub-1d, date for ≥1d. Matches pyrmts `formatPeriod` for the
 *  applicable durations (kept hand-written here to avoid pulling
 *  pyrmts's calendar machinery into the cron worker). */
function formatPeriod(periodStart: Date, cadence: Cadence): string {
	const iso = periodStart.toISOString();  // 2026-06-27T14:35:00.000Z
	if (cadence.minutes < 60) {
		// minute-precision: 2026-06-27T14:35
		return iso.slice(0, 16).replace(':', '-');  // 2026-06-27T14-35
	}
	if (cadence.minutes < 60 * 24) {
		// hour-precision: 2026-06-27T14
		return iso.slice(0, 13);
	}
	// day-precision: 2026-06-27
	return iso.slice(0, 10);
}

// ─── Cadence ladder ─────────────────────────────────────────────────────

export interface Cadence {
	label: string;       // for path/watermark: '5min', '10min', '1h', '12h', etc.
	minutes: number;     // duration in minutes
	durationStr: Duration; // for D1ShardIndex.recordShard: '5min', '1h', etc.
}

/** Cadence ladder per `configs/pyramids/avail.yaml#partials`. Ordered
 *  finest → coarsest. Each divides all coarser cadences in the chain. */
export const CADENCES: Cadence[] = [
	{ label: '5min',  minutes: 5,         durationStr: '5min'  },
	{ label: '10min', minutes: 10,        durationStr: '10min' },
	{ label: '30min', minutes: 30,        durationStr: '30min' },
	{ label: '1h',    minutes: 60,        durationStr: '1h'    },
	{ label: '3h',    minutes: 180,       durationStr: '3h'    },
	{ label: '12h',   minutes: 720,       durationStr: '12h'   },
];

const CANONICAL_1M_MIN = 1440;  // /1m canonical shard = 1d

// ─── Source readers ─────────────────────────────────────────────────────

async function readRawMinute(r2: R2Bucket, t: Date): Promise<Record<string, unknown>[] | null> {
	const key = rawMinuteKey(t);
	const obj = await r2.get(key);
	if (!obj) return null;
	const buf = await obj.arrayBuffer();
	const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
	return (await parquetReadObjects({ file })) as Record<string, unknown>[];
}

async function readPartial(r2: R2Bucket, key: string): Promise<AvailV3Row[] | null> {
	const obj = await r2.get(key);
	if (!obj) return null;
	const buf = await obj.arrayBuffer();
	const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
	const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
	return rows.map((r) => ({
		s2_cell: r.s2_cell as string,
		dt: r.dt as bigint,
		bikes: r.bikes as string,
		ebikes: r.ebikes as string,
		docks: r.docks as string,
		disabled: r.disabled as string,
		pending: r.pending as string,
	}));
}

async function writeParquet(r2: R2Bucket, key: string, rows: AvailV3Row[]): Promise<number> {
	if (rows.length === 0) return 0;
	const sorted = sortRows(rows);
	const cols = rowsToColumns(sorted);
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	// `rg_size: 2048` per avail.yaml defaults.
	const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize: 2048 });
	await r2.put(key, buf, { httpMetadata: { contentType: 'application/octet-stream' } });
	return buf.byteLength;
}

// ─── Per-cadence writers ────────────────────────────────────────────────

export interface WriteResult {
	status: 'wrote' | 'exists' | 'no_inputs' | 'empty';
	key: string;
	bytes?: number;
	rows?: number;
	// Input-coverage tracking for watermark integrity. A `wrote` result with
	// `inputsPresent < inputsExpected` means we shipped a parquet with HOLES
	// — the watermark MUST NOT be recorded as authoritative, else queries
	// will see those holes as zero-data (silently wrong). Caller gates
	// `recordShard` on `inputsPresent === inputsExpected`.
	inputsPresent?: number;
	inputsExpected?: number;
}

/** Write `/1m@p5min` for the period `[T-5min, T)`. Reads 5× raw 1m@1m
 *  parquets from `gbfs/avail/agg=1m/cons=1m/...`, LUC-expands, builds
 *  histograms. */
async function write1m5min(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	periodStart: Date,
): Promise<WriteResult> {
	const cadence = CADENCES[0];
	const inputsExpected = cadence.minutes;
	const key = partialKey('1m', cadence, periodStart);
	if (await r2.head(key)) return { status: 'exists', key, inputsExpected };
	const minuteRows: AvailV3Row[] = [];
	let inputsPresent = 0;
	for (let i = 0; i < cadence.minutes; i++) {
		const t = new Date(periodStart.getTime() + i * 60_000);
		const raw = await readRawMinute(r2, t);
		if (raw === null) continue;
		inputsPresent++;
		minuteRows.push(...transformMinuteRows(raw, luc));
	}
	if (minuteRows.length === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };
	const bytes = await writeParquet(r2, key, minuteRows);
	return { status: 'wrote', key, bytes, rows: minuteRows.length, inputsPresent, inputsExpected };
}

/** Write `/1m@<cadence>` for the period `[T-cadence, T)`. Reads N× finer-
 *  cadence /1m partials. */
async function write1mPartial(
	r2: R2Bucket,
	cadenceIdx: number,
	periodStart: Date,
): Promise<WriteResult> {
	const cadence = CADENCES[cadenceIdx];
	const prevCadence = CADENCES[cadenceIdx - 1];
	const key = partialKey('1m', cadence, periodStart);
	const inputsExpected = cadence.minutes / prevCadence.minutes;
	if (await r2.head(key)) return { status: 'exists', key, inputsExpected };
	const inputRowSets: AvailV3Row[][] = [];
	for (let i = 0; i < inputsExpected; i++) {
		const inputStart = new Date(periodStart.getTime() + i * prevCadence.minutes * 60_000);
		const inputKey = partialKey('1m', prevCadence, inputStart);
		const rows = await readPartial(r2, inputKey);
		if (rows === null) continue;
		inputRowSets.push(rows);
	}
	const inputsPresent = inputRowSets.length;
	if (inputsPresent === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };
	const merged = mergeRows(inputRowSets);
	if (merged.length === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	const bytes = await writeParquet(r2, key, merged);
	return { status: 'wrote', key, bytes, rows: merged.length, inputsPresent, inputsExpected };
}

/** Promote /1m partials to /1m canonical for the day ending at `dayEnd`.
 *  Concat 2× /1m@p12h covering the prior 24h. */
async function promote1mCanonical(
	r2: R2Bucket,
	dayEnd: Date,
): Promise<WriteResult> {
	const dayStart = new Date(dayEnd.getTime() - CANONICAL_1M_MIN * 60_000);
	const key = canonicalKey('1m', dayStart, CANONICAL_1M_MIN * 60_000);
	const inputsExpected = 2;
	if (await r2.head(key)) return { status: 'exists', key, inputsExpected };
	const half = CADENCES[CADENCES.length - 1];  // 12h
	const inputRowSets: AvailV3Row[][] = [];
	for (let i = 0; i < inputsExpected; i++) {
		const inputStart = new Date(dayStart.getTime() + i * half.minutes * 60_000);
		const inputKey = partialKey('1m', half, inputStart);
		const rows = await readPartial(r2, inputKey);
		if (rows === null) continue;
		inputRowSets.push(rows);
	}
	const inputsPresent = inputRowSets.length;
	if (inputsPresent === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };
	const merged = mergeRows(inputRowSets);
	if (merged.length === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	const bytes = await writeParquet(r2, key, merged);
	return { status: 'wrote', key, bytes, rows: merged.length, inputsPresent, inputsExpected };
}

// ─── Per-tick orchestration ─────────────────────────────────────────────

/** Per-/5m tick handler. Returns the list of attempted writes for
 *  logging. `tickTime` is the UTC time at the START of the tick (the
 *  tick fires AT that time, so we're processing the period that just
 *  closed, i.e. `[tickTime - cadence, tickTime)`). */
export async function avail3Tick(
	r2: R2Bucket,
	db: D1Database,
	tickTime: Date,
): Promise<WriteResult[]> {
	const tickMs = tickTime.getTime();
	if (tickMs % (5 * 60_000) !== 0) return [];

	const luc = await getLucIndex(r2);
	const shardIndex = new D1ShardIndex(db);
	const results: WriteResult[] = [];

	// Record a watermark ONLY when input coverage was complete. A wrote
	// result with partial coverage means we shipped a parquet with holes
	// (e.g. the loader missed a minute); recording its periodEnd as
	// authoritative would mislead the planner into trusting the gaps. The
	// parquet still gets written (it has whatever data DID arrive); the
	// watermark just stays at the previous successful boundary.
	const fullyCovered = (r: WriteResult) =>
		r.status === 'wrote' &&
		r.inputsPresent !== undefined &&
		r.inputsExpected !== undefined &&
		r.inputsPresent === r.inputsExpected;

	// Finest cadence: 5min. Always closes at /5m ticks. Read raw 1m@1m × 5.
	{
		const cadence = CADENCES[0];
		const periodStart = new Date(tickMs - cadence.minutes * 60_000);
		const r = await write1m5min(r2, luc, periodStart);
		results.push(r);
		if (fullyCovered(r)) {
			await shardIndex.recordShard({
				pyramidName: PYRAMID_NAME, tier: '1m', cadence: cadence.durationStr,
				periodStart, periodEnd: tickTime, key: r.key,
			});
		}
	}

	// Coarser cadences: only when their boundary closes at this tick.
	for (let i = 1; i < CADENCES.length; i++) {
		const cadence = CADENCES[i];
		if (tickMs % (cadence.minutes * 60_000) !== 0) continue;
		const periodStart = new Date(tickMs - cadence.minutes * 60_000);
		const r = await write1mPartial(r2, i, periodStart);
		results.push(r);
		if (fullyCovered(r)) {
			await shardIndex.recordShard({
				pyramidName: PYRAMID_NAME, tier: '1m', cadence: cadence.durationStr,
				periodStart, periodEnd: tickTime, key: r.key,
			});
		}
	}

	// Canonical promotion: midnight UTC (1d boundary).
	if (tickMs % (CANONICAL_1M_MIN * 60_000) === 0) {
		const r = await promote1mCanonical(r2, tickTime);
		results.push(r);
		if (fullyCovered(r)) {
			const periodStart = new Date(tickMs - CANONICAL_1M_MIN * 60_000);
			await shardIndex.recordShard({
				pyramidName: PYRAMID_NAME, tier: '1m', cadence: null,
				periodStart, periodEnd: tickTime, key: r.key,
			});
		}
	}

	return results;
}
