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
	CONS_LEVELS_BY_AGG,
	type CascadeLevel,
	consKey,
	inputKeysForBucket,
	rowsToCols,
} from '../../lib/cascade';
import { AVAIL_1M_ROW_GROUP_SIZE } from '../../lib/avail-monoid';
import { avail3Tick } from './avail3/cascade';

interface Env {
	R2: R2Bucket;
	DB: D1Database;
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

/** Attempt a cons-only cascade for one bucket at the given agg level.
 *  Reads `level.fromCount` inputs from `agg`@`level.fromCons`, concatenates
 *  rows, sorts by (station_id, dt), writes to `agg`@`level.cons`. */
async function attemptCons(
	r2: R2Bucket,
	agg: string,
	level: CascadeLevel,
	bucketStartMin: number,
): Promise<AttemptResult> {
	const outKey = consKey(agg, level.cons, bucketStartMin);
	if (await r2.head(outKey)) return { status: 'exists' };

	const inputKeys = inputKeysForBucket(agg, level, bucketStartMin);
	// Barrier: the LAST input shard must exist. For agg=1m cons-only this
	// is the 1m@1m at minute `bucketEnd-1`, written by the loader within
	// ~1s of the cron tick at minute `bucketEnd-1`. By the cascade tick at
	// `bucketEnd+1` (per `bucketJustClosed`'s 1-minute slack), the loader
	// has finished. For higher-agg cons the last input is the previous
	// finer-cons shard, written either in this tick (cascade-of-cascades,
	// finer-runs-first ordering) or an earlier one.
	if (!(await r2.head(inputKeys[inputKeys.length - 1]))) return { status: 'barrier_missing' };

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

/** Per-tick cron handler. Order matters because each level may read
 *  shards just written by an earlier level in the same tick:
 *
 *   1. Cons-only at agg=1m, finest-to-coarsest (5m@1m → 15m@1m → ... → 1d@1m)
 *      Each level reads the previous's just-written 1m@... shards.
 *
 *   2. Agg-self, finest-to-coarsest (5m@5m → 15m@15m → 1h@1h → 1d@1d)
 *      Each reads the previous agg-self's just-written shards.
 *
 *   3. Cons at higher aggs (5m, 15m, 1h), finest-to-coarsest within each.
 *      Each reads the just-written agg-self at the same agg level
 *      (e.g., 1h@5m reads 4 × 15m@5m which was written in step 3 itself,
 *      and the chain bottoms out at agg-self from step 2).
 *
 *  R2 strong read-after-write makes the same-tick cascade safe. */
async function cronTick(r2: R2Bucket, tickMin: number): Promise<void> {
	const summary: string[] = [];
	const note = (key: string, r: AttemptResult) => {
		if (r.status === 'wrote') summary.push(`${key}: wrote ${r.bytes}B from ${r.inputs}`);
		else if (r.status !== 'exists' && r.status !== 'barrier_missing') summary.push(`${key}: ${r.status}`);
	};

	// Step 1: cons-only at agg=1m
	for (const level of CONS_LEVELS_BY_AGG['1m']) {
		const bs = bucketJustClosed(level, tickMin);
		if (bs === null) continue;
		try {
			note(consKey('1m', level.cons, bs), await attemptCons(r2, '1m', level, bs));
		} catch (err) {
			summary.push(`${consKey('1m', level.cons, bs)}: error ${err}`);
		}
	}

	// Step 2: agg-self
	for (const level of AGG_LEVELS) {
		const bs = aggBucketJustClosed(level, tickMin);
		if (bs === null) continue;
		try {
			note(consKey(level.agg, level.agg, bs), await attemptAgg(r2, level, bs));
		} catch (err) {
			summary.push(`${consKey(level.agg, level.agg, bs)}: error ${err}`);
		}
	}

	// Step 3: cons at higher aggs (skip agg=1m, already done)
	for (const agg of Object.keys(CONS_LEVELS_BY_AGG)) {
		if (agg === '1m') continue;
		for (const level of CONS_LEVELS_BY_AGG[agg]) {
			const bs = bucketJustClosed(level, tickMin);
			if (bs === null) continue;
			try {
				note(consKey(agg, level.cons, bs), await attemptCons(r2, agg, level, bs));
			} catch (err) {
				summary.push(`${consKey(agg, level.cons, bs)}: error ${err}`);
			}
		}
	}

	if (summary.length) console.log(`cascade tick min=${tickMin}: ${summary.join(' | ')}`);
}

/** Backfill one (date, agg, cons) cell for the cons-only cascade. */
async function backfillCons(
	r2: R2Bucket,
	date: string,
	agg: string,
	consName: string,
): Promise<{ wrote: number; exists: number; barrier_missing: number; no_inputs: number; empty: number; bytes: number }> {
	const levels = CONS_LEVELS_BY_AGG[agg];
	if (!levels) throw new Error(`unknown agg level: ${agg}`);
	const level = levels.find((l) => l.cons === consName);
	if (!level) throw new Error(`unknown cons level for agg=${agg}: ${consName}`);
	const dayStartMin = Math.floor(Date.parse(`${date}T00:00:00Z`) / 60000);
	const dayEndMin = dayStartMin + 1440;
	const tally = { wrote: 0, exists: 0, barrier_missing: 0, no_inputs: 0, empty: 0, bytes: 0 };
	for (let bs = dayStartMin; bs + level.bucketMin <= dayEndMin; bs += level.bucketMin) {
		const r = await attemptCons(r2, agg, level, bs);
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
		// avail-v3 sub-shard cascade (task #130). Self-gates to /5m ticks.
		const tickTime = new Date(event.scheduledTime);
		ctx.waitUntil(avail3Tick(env.R2, env.DB, tickTime).then((results) => {
			const summary = results
				.filter((r) => r.status === 'wrote' || (r.status !== 'exists' && r.status !== 'no_inputs'))
				.map((r) => r.status === 'wrote'
					? `${r.key}: wrote ${r.bytes}B (${r.rows} rows)`
					: `${r.key}: ${r.status}`);
			if (summary.length) console.log(`avail3 tick ${tickTime.toISOString()}: ${summary.join(' | ')}`);
		}).catch((err) => console.error('avail3 tick error:', err)));
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
			// cons → backfillCons (defaults agg=1m if not specified, or agg+cons together)
			// agg alone → backfillAgg (agg-self)
			if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (!cons && !agg)) {
				return new Response(
					'usage: /backfill?date=YYYY-MM-DD&{cons=<C>[&agg=<A>] | agg=<A>}\n' +
					'  cons alone:   backfill cons=<C> at agg=1m\n' +
					'  cons + agg:   backfill cons=<C> at agg=<A> (e.g., 1h@5m)\n' +
					'  agg alone:    backfill agg-self <A>@<A>\n',
					{ status: 400 },
				);
			}
			const result = cons
				? await backfillCons(env.R2, date, agg ?? '1m', cons)
				: await backfillAgg(env.R2, date, agg!);
			const params = cons ? { agg: agg ?? '1m', cons } : { agg };
			return new Response(JSON.stringify({ date, ...params, ...result }, null, 2) + '\n', {
				headers: { 'content-type': 'application/json' },
			});
		}
		// Manual avail-v3 tick trigger (dev / debugging). `?t=` is the
		// UTC ISO timestamp of the tick to process; must be /5m-aligned.
		// Secret-gated, same as /backfill.
		if (url.pathname === '/avail3') {
			if (!env.COMPACTOR_SECRET) {
				return new Response('cascade secret not configured\n', { status: 503 });
			}
			if (request.headers.get('x-compactor-secret') !== env.COMPACTOR_SECRET) {
				return new Response('unauthorized\n', { status: 401 });
			}
			const tParam = url.searchParams.get('t');
			if (!tParam) {
				return new Response('usage: /avail3?t=YYYY-MM-DDTHH:MM:SSZ (must be /5m-aligned)\n', { status: 400 });
			}
			const tickTime = new Date(tParam);
			if (Number.isNaN(tickTime.getTime())) {
				return new Response(`invalid t: ${tParam}\n`, { status: 400 });
			}
			const results = await avail3Tick(env.R2, env.DB, tickTime);
			return new Response(JSON.stringify({ tickTime: tickTime.toISOString(), results }, null, 2) + '\n', {
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response(
			'GBFS cascade compactor.\n' +
			'  GET /backfill?date=YYYY-MM-DD&{cons|agg}=<level> (secret-gated)\n' +
			'  GET /avail3?t=<iso-ts>                            (secret-gated)\n',
		);
	},
} satisfies ExportedHandler<Env>;
