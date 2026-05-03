import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
import {
	bucketJustClosed,
	consKey,
	CONS_LEVELS_AT_1M,
	inputKeysForBucket,
	rowsToCols,
} from '../../lib/cascade';
import { buildMinuteShard } from '../../lib/avail-monoid';
import worker from './index';

const FIVE_M  = CONS_LEVELS_AT_1M.find((l) => l.cons === '5m')!;
const FIFTEEN = CONS_LEVELS_AT_1M.find((l) => l.cons === '15m')!;
const ONE_H   = CONS_LEVELS_AT_1M.find((l) => l.cons === '1h')!;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('consKey + period encoding', () => {
	const T_2026_05_03_13_30 = Math.floor(Date.parse('2026-05-03T13:30:00Z') / 60000);
	test('1m → date/HHMM', () => {
		expect(consKey('1m', '1m', T_2026_05_03_13_30)).toBe('avail/agg=1m/cons=1m/2026-05-03/1330.parquet');
	});
	test('5m → date/HHMM', () => {
		expect(consKey('1m', '5m', T_2026_05_03_13_30)).toBe('avail/agg=1m/cons=5m/2026-05-03/1330.parquet');
	});
	test('15m → date/HHMM', () => {
		expect(consKey('1m', '15m', T_2026_05_03_13_30)).toBe('avail/agg=1m/cons=15m/2026-05-03/1330.parquet');
	});
	test('1h → date/HH (drops MM)', () => {
		const T_2026_05_03_13_00 = Math.floor(Date.parse('2026-05-03T13:00:00Z') / 60000);
		expect(consKey('1m', '1h', T_2026_05_03_13_00)).toBe('avail/agg=1m/cons=1h/2026-05-03/13.parquet');
	});
});

describe('bucketJustClosed (1-minute slack for loader)', () => {
	const T13_30 = Math.floor(Date.parse('2026-05-03T13:30:00Z') / 60000);
	const T13_31 = T13_30 + 1;
	const T13_46 = T13_30 + 16;
	const T14_01 = T13_30 + 31;
	const T15_01 = T13_30 + 91;

	test('5m fires at :01-past-boundary: T=13:31 → [13:25, 13:30)', () => {
		expect(bucketJustClosed(FIVE_M, T13_31)).toBe(T13_30 - 5);
	});
	test('5m: T=13:30 (exact boundary) → null (1m@1m at 13:30 race)', () => {
		expect(bucketJustClosed(FIVE_M, T13_30)).toBeNull();
	});
	test('15m fires at :01-past-boundary: T=13:46 → [13:30, 13:45)', () => {
		expect(bucketJustClosed(FIFTEEN, T13_46)).toBe(T13_30);
	});
	test('15m: T=13:30 (exact 15m boundary) → null', () => {
		expect(bucketJustClosed(FIFTEEN, T13_30)).toBeNull();
	});
	test('1h fires at :01-past-hour: T=14:01 → [13:00, 14:00)', () => {
		expect(bucketJustClosed(ONE_H, T14_01)).toBe(T13_30 - 30);
	});
	test('1h fires at :01-past-hour: T=15:01 → [14:00, 15:00)', () => {
		expect(bucketJustClosed(ONE_H, T15_01)).toBe(T13_30 + 30);
	});
	test('1h: T=14:00 (exact hour) → null (1m@1m at 14:00 race)', () => {
		const T14_00 = T13_30 + 30;
		expect(bucketJustClosed(ONE_H, T14_00)).toBeNull();
	});
});

describe('inputKeysForBucket', () => {
	const T13_25 = Math.floor(Date.parse('2026-05-03T13:25:00Z') / 60000);
	test('5m@1m bucket 13:25 → 5 1m@1m inputs at minutes 25..29', () => {
		expect(inputKeysForBucket('1m', FIVE_M, T13_25)).toEqual([
			'avail/agg=1m/cons=1m/2026-05-03/1325.parquet',
			'avail/agg=1m/cons=1m/2026-05-03/1326.parquet',
			'avail/agg=1m/cons=1m/2026-05-03/1327.parquet',
			'avail/agg=1m/cons=1m/2026-05-03/1328.parquet',
			'avail/agg=1m/cons=1m/2026-05-03/1329.parquet',
		]);
	});
	test('15m@1m bucket → 3 5m@1m inputs at 5-min stride', () => {
		const T13_15 = T13_25 - 10;
		expect(inputKeysForBucket('1m', FIFTEEN, T13_15)).toEqual([
			'avail/agg=1m/cons=5m/2026-05-03/1315.parquet',
			'avail/agg=1m/cons=5m/2026-05-03/1320.parquet',
			'avail/agg=1m/cons=5m/2026-05-03/1325.parquet',
		]);
	});
	test('1h@1m bucket → 4 15m@1m inputs at 15-min stride', () => {
		const T13_00 = T13_25 - 25;
		expect(inputKeysForBucket('1m', ONE_H, T13_00)).toEqual([
			'avail/agg=1m/cons=15m/2026-05-03/1300.parquet',
			'avail/agg=1m/cons=15m/2026-05-03/1315.parquet',
			'avail/agg=1m/cons=15m/2026-05-03/1330.parquet',
			'avail/agg=1m/cons=15m/2026-05-03/1345.parquet',
		]);
	});
});

const station = (id: string, vals: Record<string, number> = {}) => ({
	station_id: id,
	num_bikes_available: 0,
	num_ebikes_available: 0,
	num_docks_available: 0,
	num_bikes_disabled: 0,
	num_docks_disabled: 0,
	is_installed: 1,
	is_renting: 1,
	is_returning: 1,
	last_reported: 1700000000,
	...vals,
});

/** Build a 1m@1m parquet buffer for a given minute + station list. */
function build1mShard(polled_at: number, stations: ReturnType<typeof station>[]): ArrayBuffer {
	const cols = buildMinuteShard({ ts: polled_at, polled_at, stations });
	return parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
}

interface Put {
	key: string;
	body: ArrayBuffer | string;
}

/** R2 mock: in-memory map of key → ArrayBuffer. Records all puts in `puts`. */
function makeR2(initial: Record<string, ArrayBuffer> = {}) {
	const store: Record<string, ArrayBuffer> = { ...initial };
	const puts: Put[] = [];
	const r2 = {
		head: vi.fn(async (key: string) => (key in store ? { key, size: store[key].byteLength } : null)),
		get: vi.fn(async (key: string) => {
			if (!(key in store)) return null;
			const buf = store[key];
			return {
				arrayBuffer: async () => buf,
				json: async () => JSON.parse(new TextDecoder().decode(buf)),
				text: async () => new TextDecoder().decode(buf),
			};
		}),
		put: vi.fn(async (key: string, body: ArrayBuffer | string) => {
			puts.push({ key, body });
			store[key] = body instanceof ArrayBuffer ? body : new TextEncoder().encode(body).buffer;
		}),
	};
	return { r2, store, puts };
}

describe('rowsToCols (concat + sort)', () => {
	test('produces identical ColumnSource[] when round-tripped', async () => {
		// Build a 1m@1m shard, decode to rows, reassemble via rowsToCols, write again,
		// decode again — final rows should match original (same sort, same values).
		const buf = build1mShard(Math.floor(Date.parse('2026-05-03T13:25:00Z') / 1000), [
			station('Z', { num_bikes_available: 5 }),
			station('A', { num_bikes_available: 3 }),
			station('M', { num_bikes_available: 7 }),
		]);
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		const cols = rowsToCols(rows);
		expect(cols.find((c) => c.name === 'station_id')!.data).toEqual(['A', 'M', 'Z']);
		expect(cols.find((c) => c.name === 'bikes_sum')!.data).toEqual([3, 7, 5]);
	});

	test('concat across input shards: rows interleave by sort, not by input', async () => {
		// 2 inputs at distinct minutes, each with 2 stations. Output should be
		// sorted by (station_id, dt) — not by input order.
		const t1 = Math.floor(Date.parse('2026-05-03T13:25:00Z') / 1000);
		const t2 = t1 + 60;
		const buf1 = build1mShard(t1, [station('B', { num_bikes_available: 1 }), station('A', { num_bikes_available: 2 })]);
		const buf2 = build1mShard(t2, [station('B', { num_bikes_available: 3 }), station('A', { num_bikes_available: 4 })]);
		const f1 = { byteLength: buf1.byteLength, slice: (s: number, e?: number) => buf1.slice(s, e) };
		const f2 = { byteLength: buf2.byteLength, slice: (s: number, e?: number) => buf2.slice(s, e) };
		const r1 = (await parquetReadObjects({ file: f1 })) as Record<string, unknown>[];
		const r2 = (await parquetReadObjects({ file: f2 })) as Record<string, unknown>[];
		const cols = rowsToCols([...r1, ...r2]);
		expect(cols.find((c) => c.name === 'station_id')!.data).toEqual(['A', 'A', 'B', 'B']);
		expect((cols.find((c) => c.name === 'dt')!.data as bigint[]).map((d) => Number(d))).toEqual(
			[t1 - (t1 % 60), t2 - (t2 % 60), t1 - (t1 % 60), t2 - (t2 % 60)],
		);
		expect(cols.find((c) => c.name === 'bikes_sum')!.data).toEqual([2, 4, 1, 3]);
	});
});

/** Drive worker.scheduled and properly await all the promises queued via
 *  ctx.waitUntil (which the real CFW runtime awaits before exiting the
 *  invocation, but a sync callback would not). */
async function runScheduled(w: typeof worker, tickMin: number, r2: ReturnType<typeof makeR2>['r2']): Promise<void> {
	const tasks: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => { tasks.push(p); } };
	await w.scheduled!({ scheduledTime: tickMin * 60_000 } as never, { R2: r2 } as never, ctx as never);
	await Promise.all(tasks);
}

describe('worker.scheduled (cron tick)', () => {
	const T13_25 = Math.floor(Date.parse('2026-05-03T13:25:00Z') / 60000);
	const T13_30 = T13_25 + 5;
	// Cron shifts by 1 minute for loader-write slack: bucket [13:25, 13:30)
	// fires at tick T13_31 (not T13_30). See bucketJustClosed docstring.
	const T13_31 = T13_30 + 1;

	test('5m boundary tick (T+1) + barrier present + all 5 inputs → writes 5m@1m', async () => {
		const initial: Record<string, ArrayBuffer> = {};
		for (let i = 0; i < 5; i++) {
			const minute = T13_25 + i;
			const polled_at = minute * 60;
			initial[consKey('1m', '1m', minute)] = build1mShard(polled_at, [
				station('A', { num_bikes_available: i + 1 }),
				station('B', { num_bikes_available: i + 2 }),
			]);
		}
		initial[consKey('1m', '1m', T13_30)] = build1mShard(T13_30 * 60, [station('A')]);

		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T13_31, r2);

		const writes = puts.filter((p) => p.key.includes('cons=5m'));
		expect(writes).toHaveLength(1);
		expect(writes[0].key).toBe(consKey('1m', '5m', T13_25));

		const buf = writes[0].body as ArrayBuffer;
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		expect(rows).toHaveLength(10);
		expect(rows.slice(0, 5).every((r) => r.station_id === 'A')).toBe(true);
		expect(rows.slice(5).every((r) => r.station_id === 'B')).toBe(true);
		expect(rows.slice(0, 5).map((r) => r.bikes_sum)).toEqual([1, 2, 3, 4, 5]);
		expect(rows.slice(5).map((r) => r.bikes_sum)).toEqual([2, 3, 4, 5, 6]);
	});

	test('barrier missing → no write', async () => {
		const initial: Record<string, ArrayBuffer> = {};
		for (let i = 0; i < 5; i++) {
			initial[consKey('1m', '1m', T13_25 + i)] = build1mShard((T13_25 + i) * 60, [station('A')]);
		}
		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T13_31, r2);
		expect(puts.filter((p) => p.key.includes('cons=5m'))).toEqual([]);
	});

	test('output already exists → skip (idempotent)', async () => {
		const initial: Record<string, ArrayBuffer> = {};
		for (let i = 0; i < 5; i++) {
			initial[consKey('1m', '1m', T13_25 + i)] = build1mShard((T13_25 + i) * 60, [station('A')]);
		}
		initial[consKey('1m', '1m', T13_30)] = build1mShard(T13_30 * 60, [station('A')]);
		initial[consKey('1m', '5m', T13_25)] = new ArrayBuffer(0);

		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T13_31, r2);
		expect(puts.filter((p) => p.key.includes('cons=5m'))).toEqual([]);
	});

	test('exact boundary tick (T) → no work (1m@1m race avoided)', async () => {
		const { r2, puts } = makeR2({});
		await runScheduled(worker, T13_30, r2);
		expect(puts).toEqual([]);
	});

	test('off-boundary tick (T+2) → no work', async () => {
		const T13_32 = T13_30 + 2;
		const { r2, puts } = makeR2({});
		await runScheduled(worker, T13_32, r2);
		expect(puts).toEqual([]);
		expect(r2.head).not.toHaveBeenCalled();
	});

	test('hour-boundary tick (T+1) cascades 5m → 15m → 1h via existing finer cons', async () => {
		// At T=14:00 (UTC) all three cons boundaries align; tick fires at T=14:01.
		// 5m for [13:55, 14:00) writes first, then 15m reads it as a fresh input
		// for [13:45, 14:00), and 1h reads the just-written 15m as input for
		// [13:00, 14:00). Tests the same-tick fan-out chain.
		const T13_00 = Math.floor(Date.parse('2026-05-03T13:00:00Z') / 60000);
		const T14_00 = T13_00 + 60;
		const T14_01 = T14_00 + 1;
		const initial: Record<string, ArrayBuffer> = {};

		// 1m@1m for the 5m bucket [13:55, 14:00) + barrier at T14_00.
		for (let i = 0; i < 5; i++) {
			initial[consKey('1m', '1m', T14_00 - 5 + i)] = build1mShard((T14_00 - 5 + i) * 60, [station('A')]);
		}
		initial[consKey('1m', '1m', T14_00)] = build1mShard(T14_00 * 60, [station('A')]);

		// 5m@1m for [13:45, 13:50) and [13:50, 13:55) — inputs for 15m bucket [13:45, 14:00).
		for (const bs of [T14_00 - 15, T14_00 - 10]) {
			const cols = buildMinuteShard({ ts: bs * 60, polled_at: bs * 60, stations: [station('A')] });
			initial[consKey('1m', '5m', bs)] = parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
		}
		// 15m@1m for [13:00, 13:15), [13:15, 13:30), [13:30, 13:45) — inputs for 1h bucket [13:00, 14:00).
		for (const bs of [T13_00, T13_00 + 15, T13_00 + 30]) {
			const cols = buildMinuteShard({ ts: bs * 60, polled_at: bs * 60, stations: [station('A')] });
			initial[consKey('1m', '15m', bs)] = parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
		}

		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T14_01, r2);

		const writes = puts.map((p) => p.key).sort();
		expect(writes).toContain(consKey('1m', '5m', T14_00 - 5));
		expect(writes).toContain(consKey('1m', '15m', T14_00 - 15));
		expect(writes).toContain(consKey('1m', '1h', T13_00));
	});
});

describe('worker.fetch /backfill auth gate', () => {
	test('no secret configured → 503', async () => {
		const { r2 } = makeR2();
		const res = await worker.fetch(
			new Request('http://test/backfill?date=2026-05-03&cons=5m'),
			{ R2: r2 } as never,
			{} as never,
		);
		expect(res.status).toBe(503);
	});
	test('wrong secret → 401', async () => {
		const { r2 } = makeR2();
		const res = await worker.fetch(
			new Request('http://test/backfill?date=2026-05-03&cons=5m'),
			{ R2: r2, COMPACTOR_SECRET: 'right' } as never,
			{} as never,
		);
		expect(res.status).toBe(401);
	});
	test('missing params → 400', async () => {
		const { r2 } = makeR2();
		const res = await worker.fetch(
			new Request('http://test/backfill', { headers: { 'x-compactor-secret': 'x' } }),
			{ R2: r2, COMPACTOR_SECRET: 'x' } as never,
			{} as never,
		);
		expect(res.status).toBe(400);
	});
});
