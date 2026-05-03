/**
 * GBFS cascade compactor — Cloudflare Worker with cron trigger.
 *
 * Builds higher cons levels (5m@1m, 15m@1m, 1h@1m) by reading shards
 * from the next-finer cons of the same agg level (`1m`) and
 * concatenating their rows, sorted by (station_id, dt). Each cons is
 * just row-concatenation since agg=1m means rows are already at
 * 1-minute granularity — the monoid for the cons axis is just union.
 *
 * Cadence: every minute. At each tick T (UTC minute), for each cons
 * level whose bucket [B, B+size) ended at minute T (i.e., T % size == 0),
 * attempt to cons it. The attempt is skipped (and retried by the next
 * boundary tick … or a future backfill) if the barrier shard
 * (1m@1m at minute B+size) is missing.
 *
 * Idempotent: re-runs read the same inputs, sort deterministically, and
 * write byte-identical output. Skip-if-output-exists short-circuits work.
 *
 * Backfill: `POST /backfill` walks a (date, cons) range and cons'es every
 * bucket. Auth-gated by `COMPACTOR_SECRET` (same env var the legacy h1
 * compactor uses). Use this on `e` to populate cons shards from existing
 * 1m@1m archive.
 *
 * See specs/avail-perf-pass.md.
 */

import { parquetReadObjects } from 'hyparquet';
import {
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

/** Attempt to cons one bucket. Returns the outcome (always resolves; never
 *  throws for normal "not ready yet" cases — barrier_missing is data, not error). */
async function attemptCons(
	r2: R2Bucket,
	level: CascadeLevel,
	bucketStartMin: number,
): Promise<AttemptResult> {
	const outKey = consKey('1m', level.cons, bucketStartMin);

	// Idempotent: skip if output already exists. Saves work + R2 ops on
	// startup / backfill / overlapping retries. (Re-running would write
	// byte-identical bytes anyway.)
	if (await r2.head(outKey)) return { status: 'exists' };

	// Barrier: 1m@1m at the bucket's exclusive end must exist. This proves
	// the loader has *attempted* to write all of the bucket's input minutes
	// (since events arrive in time order from the cron writer). Some of
	// those input shards may still be missing if the loader failed; we
	// cons what's available and flag honest gaps via row count.
	const barrierKey = consKey('1m', '1m', bucketStartMin + level.bucketMin);
	if (!(await r2.head(barrierKey))) return { status: 'barrier_missing' };

	const inputKeys = inputKeysForBucket('1m', level, bucketStartMin);
	const buffers = await Promise.all(
		inputKeys.map((k) => r2.get(k).then((o) => (o ? o.arrayBuffer() : null))),
	);
	const present = buffers.filter((b): b is ArrayBuffer => b !== null);
	if (present.length === 0) return { status: 'no_inputs' };

	const allRows: Record<string, unknown>[] = [];
	for (const buf of present) {
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		allRows.push(...rows);
	}
	const cols = rowsToCols(allRows);
	if (cols[0].data.length === 0) return { status: 'empty' };

	const { parquetWriteBuffer } = await import('hyparquet-writer');
	const out = parquetWriteBuffer({ columnData: cols, rowGroupSize: AVAIL_1M_ROW_GROUP_SIZE });
	await r2.put(outKey, out, {
		httpMetadata: { contentType: 'application/octet-stream' },
	});
	return { status: 'wrote', bytes: out.byteLength, rows: cols[0].data.length, inputs: present.length };
}

/** Per-tick cron handler: for each cons level, attempt the bucket that
 *  just closed (if any boundary aligns with this tick). */
async function cronTick(r2: R2Bucket, tickMin: number): Promise<void> {
	const summary: string[] = [];
	for (const level of CONS_LEVELS_AT_1M) {
		const bs = bucketJustClosed(level, tickMin);
		if (bs === null) continue;
		try {
			const r = await attemptCons(r2, level, bs);
			const key = consKey('1m', level.cons, bs);
			if (r.status === 'wrote') {
				summary.push(`${key}: wrote ${r.bytes}B from ${r.inputs} inputs`);
			} else {
				summary.push(`${key}: ${r.status}`);
			}
		} catch (err) {
			summary.push(`${consKey('1m', level.cons, bs)}: error ${err}`);
		}
	}
	if (summary.length) console.log(`cascade tick min=${tickMin}: ${summary.join(' | ')}`);
}

/** Backfill one (date, cons) cell: cons every bucket of this cons level
 *  that falls within the UTC date. Useful for populating cons shards over
 *  the existing 1m@1m archive. */
async function backfillDay(
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
			if (!date || !cons || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				return new Response('usage: /backfill?date=YYYY-MM-DD&cons={5m|15m|1h}\n', { status: 400 });
			}
			const result = await backfillDay(env.R2, date, cons);
			return new Response(JSON.stringify({ date, cons, ...result }, null, 2) + '\n', {
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response('GBFS cascade compactor.\n  POST /backfill?date=YYYY-MM-DD&cons={5m|15m|1h} (secret-gated)\n');
	},
} satisfies ExportedHandler<Env>;
