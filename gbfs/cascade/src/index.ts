/**
 * GBFS cascade compactor — Cloudflare Worker with cron trigger.
 *
 * Two cascade chains, both fired every minute:
 *
 * 1. **Cons-only at agg=1m** (5m@1m, 15m@1m, 1h@1m): the next-finer cons
 *    of the same agg, row-concatenated and re-sorted by (station_id, dt).
 *    Each row is still a 1-minute observation; the larger shard just
 *    covers more wall-clock time. Lets a query for a window decode
 *    1 file instead of N.
 *
 * 2. **Agg-self** (5m@5m, 15m@15m, 1h@1h, 1d@1d): the same window's
 *    finer-agg shards are *monoid-merged* by station — N rows per
 *    station per shard collapse to 1 row per station per bucket, with
 *    n/sum/sum_sq summed across the input rows. Output has 2407 rows
 *    per shard regardless of bucket size, so a 1d@1d shard is ~50 KB
 *    where 1d@1m would be ~250 MB. Lets a query at bin=B decode B/1m
 *    × fewer rows.
 *
 * Build relations (each level is the next-finer one's natural cascade):
 *   cons:  1m → 5m → 15m → 1h
 *   agg:   1m → 5m → 15m → 1h → 1d
 *
 * Cadence: every minute. At each tick T, for each level whose bucket
 * boundary aligns with T-1 (one-minute slack for loader writes, see
 * `bucketJustClosed`), attempt to write that level's shard. Same-tick
 * fan-out: a finer level writes first within the tick, and coarser
 * levels read its just-written output thanks to R2's strong
 * read-after-write.
 *
 * Idempotent: skip-if-output-exists; re-runs would write byte-identical
 * bytes anyway. Honest gap reporting: a missing input contributes zero
 * rows to its shard's output.
 *
 * Backfill: `GET /backfill?date=YYYY-MM-DD&{cons|agg}=<level>`,
 * auth-gated by `COMPACTOR_SECRET`. Use this on `e` to populate
 * historical shards over the existing 1m@1m archive.
 *
 * See specs/avail-perf-pass.md.
 */

import { parquetReadObjects } from 'hyparquet';
import {
	aggBucketJustClosed,
	AGG_LEVELS,
	type AggLevel,
	aggInputKeysForBucket,
	aggMergeRows,
	bucketJustClosed,
	CONS_LEVELS_AT_1M,
	type CascadeLevel,
	consKey,
	inputKeysForBucket,
	rowsToCols,
} from '../../lib/cascade';
import { AVAIL_1M_ROW_GROUP_SIZE } from '../../lib/avail-monoid';

interface Env {
	R2: R2Bucket;
	COMPACTOR_SECRET?: string;
}

interface AttemptResult {
	status: 'wrote' | 'exists' | 'barrier_missing' | 'no_inputs' | 'empty';
	bytes?: number;
	rows?: number;
	inputs?: number;
}

/** Read N parquet shards from R2 → flat row list. Missing keys are
 *  silently dropped (caller decides whether the absence is fatal). */
async function readShardRows(r2: R2Bucket, keys: string[]): Promise<{ rows: Record<string, unknown>[]; present: number }> {
	const buffers = await Promise.all(
		keys.map((k) => r2.get(k).then((o) => (o ? o.arrayBuffer() : null))),
	);
	const present = buffers.filter((b): b is ArrayBuffer => b !== null);
	const rows: Record<string, unknown>[] = [];
	for (const buf of present) {
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const fileRows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		rows.push(...fileRows);
	}
	return { rows, present: present.length };
}

/** Attempt a cons-only cascade for one bucket at agg=1m. */
async function attemptCons(
	r2: R2Bucket,
	level: CascadeLevel,
	bucketStartMin: number,
): Promise<AttemptResult> {
	const outKey = consKey('1m', level.cons, bucketStartMin);
	if (await r2.head(outKey)) return { status: 'exists' };

	// Barrier: 1m@1m at the bucket's exclusive end must exist (proves the
	// loader has attempted writes for all of this bucket's input minutes).
	const barrierKey = consKey('1m', '1m', bucketStartMin + level.bucketMin);
	if (!(await r2.head(barrierKey))) return { status: 'barrier_missing' };

	const inputKeys = inputKeysForBucket('1m', level, bucketStartMin);
	const { rows, present } = await readShardRows(r2, inputKeys);
	if (present === 0) return { status: 'no_inputs' };

	const cols = rowsToCols(rows);
	if (cols[0].data.length === 0) return { status: 'empty' };

	const { parquetWriteBuffer } = await import('hyparquet-writer');
	const out = parquetWriteBuffer({ columnData: cols, rowGroupSize: AVAIL_1M_ROW_GROUP_SIZE });
	await r2.put(outKey, out, { httpMetadata: { contentType: 'application/octet-stream' } });
	return { status: 'wrote', bytes: out.byteLength, rows: cols[0].data.length, inputs: present };
}

/** Attempt an agg-self cascade for one bucket. Reads `level.fromCount`
 *  input shards from `level.fromAgg`@`level.fromCons`, monoid-merges
 *  by station, writes one row per station to `level.agg`@`level.agg`. */
async function attemptAgg(
	r2: R2Bucket,
	level: AggLevel,
	bucketStartMin: number,
): Promise<AttemptResult> {
	const outKey = consKey(level.agg, level.agg, bucketStartMin);
	if (await r2.head(outKey)) return { status: 'exists' };

	// Barrier: the LAST input shard must exist (proves the cons cascade
	// for this level's window has completed). Cheaper than checking all
	// fromCount inputs: if the last one is there, the cascade reached the
	// end. Caller handles partial-input gaps via row count downstream.
	const inputKeys = aggInputKeysForBucket(level, bucketStartMin);
	if (!(await r2.head(inputKeys[inputKeys.length - 1]))) return { status: 'barrier_missing' };

	const { rows, present } = await readShardRows(r2, inputKeys);
	if (present === 0) return { status: 'no_inputs' };

	const cols = aggMergeRows(rows, bucketStartMin);
	if (cols[0].data.length === 0) return { status: 'empty' };

	const { parquetWriteBuffer } = await import('hyparquet-writer');
	const out = parquetWriteBuffer({ columnData: cols, rowGroupSize: AVAIL_1M_ROW_GROUP_SIZE });
	await r2.put(outKey, out, { httpMetadata: { contentType: 'application/octet-stream' } });
	return { status: 'wrote', bytes: out.byteLength, rows: cols[0].data.length, inputs: present };
}

/** Per-tick cron handler: cons-only first (so finer-cons inputs land
 *  before agg-self reads them), then agg-self in finest-to-coarsest
 *  order (so each agg-self level can read the previous level's just-
 *  written shards in the same tick). */
async function cronTick(r2: R2Bucket, tickMin: number): Promise<void> {
	const summary: string[] = [];
	const note = (key: string, r: AttemptResult) => {
		if (r.status === 'wrote') summary.push(`${key}: wrote ${r.bytes}B from ${r.inputs}`);
		else if (r.status !== 'exists' && r.status !== 'barrier_missing') summary.push(`${key}: ${r.status}`);
	};
	for (const level of CONS_LEVELS_AT_1M) {
		const bs = bucketJustClosed(level, tickMin);
		if (bs === null) continue;
		try {
			const r = await attemptCons(r2, level, bs);
			note(consKey('1m', level.cons, bs), r);
		} catch (err) {
			summary.push(`${consKey('1m', level.cons, bs)}: error ${err}`);
		}
	}
	for (const level of AGG_LEVELS) {
		const bs = aggBucketJustClosed(level, tickMin);
		if (bs === null) continue;
		try {
			const r = await attemptAgg(r2, level, bs);
			note(consKey(level.agg, level.agg, bs), r);
		} catch (err) {
			summary.push(`${consKey(level.agg, level.agg, bs)}: error ${err}`);
		}
	}
	if (summary.length) console.log(`cascade tick min=${tickMin}: ${summary.join(' | ')}`);
}

/** Backfill one (date, cons) cell for the cons-only cascade at agg=1m. */
async function backfillCons(
	r2: R2Bucket,
	date: string,
	consName: string,
): Promise<{ wrote: number; exists: number; barrier_missing: number; no_inputs: number; empty: number; bytes: number }> {
	const level = CONS_LEVELS_AT_1M.find((l) => l.cons === consName);
	if (!level) throw new Error(`unknown cons level: ${consName}`);
	const dayStartMin = Math.floor(Date.parse(`${date}T00:00:00Z`) / 60000);
	const dayEndMin = dayStartMin + 1440;
	const tally = { wrote: 0, exists: 0, barrier_missing: 0, no_inputs: 0, empty: 0, bytes: 0 };
	for (let bs = dayStartMin; bs + level.bucketMin <= dayEndMin; bs += level.bucketMin) {
		const r = await attemptCons(r2, level, bs);
		tally[r.status]++;
		if (r.bytes) tally.bytes += r.bytes;
	}
	return tally;
}

/** Backfill one (date, agg) cell for the agg-self cascade. For 1d@1d
 *  the bucket spans the whole day, so a single attempt covers it. */
async function backfillAgg(
	r2: R2Bucket,
	date: string,
	aggName: string,
): Promise<{ wrote: number; exists: number; barrier_missing: number; no_inputs: number; empty: number; bytes: number }> {
	const level = AGG_LEVELS.find((l) => l.agg === aggName);
	if (!level) throw new Error(`unknown agg level: ${aggName}`);
	const dayStartMin = Math.floor(Date.parse(`${date}T00:00:00Z`) / 60000);
	const dayEndMin = dayStartMin + 1440;
	const tally = { wrote: 0, exists: 0, barrier_missing: 0, no_inputs: 0, empty: 0, bytes: 0 };
	for (let bs = dayStartMin; bs + level.bucketMin <= dayEndMin; bs += level.bucketMin) {
		const r = await attemptAgg(r2, level, bs);
		tally[r.status]++;
		if (r.bytes) tally.bytes += r.bytes;
	}
	return tally;
}

export default {
	async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const tickMin = Math.floor(event.scheduledTime / 60000);
		ctx.waitUntil(cronTick(env.R2, tickMin));
	},

	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/backfill') {
			if (!env.COMPACTOR_SECRET) {
				return new Response('cascade secret not configured\n', { status: 503 });
			}
			if (request.headers.get('x-compactor-secret') !== env.COMPACTOR_SECRET) {
				return new Response('unauthorized\n', { status: 401 });
			}
			const date = url.searchParams.get('date');
			const cons = url.searchParams.get('cons');
			const agg  = url.searchParams.get('agg');
			if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (!cons && !agg) || (cons && agg)) {
				return new Response(
					'usage: /backfill?date=YYYY-MM-DD&{cons={5m|15m|1h} | agg={5m|15m|1h|1d}}\n',
					{ status: 400 },
				);
			}
			const result = cons
				? await backfillCons(env.R2, date, cons)
				: await backfillAgg(env.R2, date, agg!);
			return new Response(JSON.stringify({ date, ...(cons ? { cons } : { agg }), ...result }, null, 2) + '\n', {
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response(
			'GBFS cascade compactor.\n  GET /backfill?date=YYYY-MM-DD&{cons|agg}=<level> (secret-gated)\n',
		);
	},
} satisfies ExportedHandler<Env>;
