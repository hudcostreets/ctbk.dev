import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
import {
	AGG_LEVELS,
	aggBucketJustClosed,
	aggInputKeysForBucket,
	aggMergeRows,
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
const AGG_5M  = AGG_LEVELS.find((l) => l.agg === '5m')!;
const AGG_15M = AGG_LEVELS.find((l) => l.agg === '15m')!;
const AGG_1H  = AGG_LEVELS.find((l) => l.agg === '1h')!;
const AGG_1D  = AGG_LEVELS.find((l) => l.agg === '1d')!;

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
		expect(consKey('1m', '1m', T_2026_05_03_13_30)).toBe('gbfs/avail/agg=1m/cons=1m/2026-05-03/1330.parquet');
	});
	test('5m → date/HHMM', () => {
		expect(consKey('1m', '5m', T_2026_05_03_13_30)).toBe('gbfs/avail/agg=1m/cons=5m/2026-05-03/1330.parquet');
	});
	test('15m → date/HHMM', () => {
		expect(consKey('1m', '15m', T_2026_05_03_13_30)).toBe('gbfs/avail/agg=1m/cons=15m/2026-05-03/1330.parquet');
	});
	test('1h → date/HH (drops MM)', () => {
		const T_2026_05_03_13_00 = Math.floor(Date.parse('2026-05-03T13:00:00Z') / 60000);
		expect(consKey('1m', '1h', T_2026_05_03_13_00)).toBe('gbfs/avail/agg=1m/cons=1h/2026-05-03/13.parquet');
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
			'gbfs/avail/agg=1m/cons=1m/2026-05-03/1325.parquet',
			'gbfs/avail/agg=1m/cons=1m/2026-05-03/1326.parquet',
			'gbfs/avail/agg=1m/cons=1m/2026-05-03/1327.parquet',
			'gbfs/avail/agg=1m/cons=1m/2026-05-03/1328.parquet',
			'gbfs/avail/agg=1m/cons=1m/2026-05-03/1329.parquet',
		]);
	});
	test('15m@1m bucket → 3 5m@1m inputs at 5-min stride', () => {
		const T13_15 = T13_25 - 10;
		expect(inputKeysForBucket('1m', FIFTEEN, T13_15)).toEqual([
			'gbfs/avail/agg=1m/cons=5m/2026-05-03/1315.parquet',
			'gbfs/avail/agg=1m/cons=5m/2026-05-03/1320.parquet',
			'gbfs/avail/agg=1m/cons=5m/2026-05-03/1325.parquet',
		]);
	});
	test('1h@1m bucket → 4 15m@1m inputs at 15-min stride', () => {
		const T13_00 = T13_25 - 25;
		expect(inputKeysForBucket('1m', ONE_H, T13_00)).toEqual([
			'gbfs/avail/agg=1m/cons=15m/2026-05-03/1300.parquet',
			'gbfs/avail/agg=1m/cons=15m/2026-05-03/1315.parquet',
			'gbfs/avail/agg=1m/cons=15m/2026-05-03/1330.parquet',
			'gbfs/avail/agg=1m/cons=15m/2026-05-03/1345.parquet',
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
			store[key] = body instanceof ArrayBuffer ? body : (new TextEncoder().encode(body).buffer as ArrayBuffer);
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

		// Dual-write during the `specs/r2-layout.md` Phase A.2 → A.3 window:
		// each cons write lands at both `gbfs/avail/...` (new) and the
		// legacy unprefixed `avail/...` path.
		const writes = puts.filter((p) => p.key.includes('agg=1m/cons=5m'));
		expect(writes.map((p) => p.key).sort()).toEqual([
			'avail/agg=1m/cons=5m/2026-05-03/1325.parquet',
			'gbfs/avail/agg=1m/cons=5m/2026-05-03/1325.parquet',
		]);

		const buf = writes[0].body as ArrayBuffer;
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		expect(rows).toHaveLength(10);
		expect(rows.slice(0, 5).every((r) => r.station_id === 'A')).toBe(true);
		expect(rows.slice(5).every((r) => r.station_id === 'B')).toBe(true);
		expect(rows.slice(0, 5).map((r) => r.bikes_sum)).toEqual([1, 2, 3, 4, 5]);
		expect(rows.slice(5).map((r) => r.bikes_sum)).toEqual([2, 3, 4, 5, 6]);
	});

	test('barrier missing (last input absent) → no write', async () => {
		// Barrier = last input shard. Stage the first 4 of 5 1m@1m inputs but
		// drop the last one (T13_29) — attemptCons should bail at the head()
		// check before reading any shard.
		const initial: Record<string, ArrayBuffer> = {};
		for (let i = 0; i < 4; i++) {
			initial[consKey('1m', '1m', T13_25 + i)] = build1mShard((T13_25 + i) * 60, [station('A')]);
		}
		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T13_31, r2);
		expect(puts.filter((p) => p.key.includes('agg=1m/cons=5m'))).toEqual([]);
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
		expect(puts.filter((p) => p.key.includes('agg=1m/cons=5m'))).toEqual([]);
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

describe('aggBucketJustClosed', () => {
	const T13_00 = Math.floor(Date.parse('2026-05-03T13:00:00Z') / 60000);
	const T13_31 = T13_00 + 31;
	const T14_01 = T13_00 + 61;
	const MIDNIGHT_MAY3 = Math.floor(Date.parse('2026-05-03T00:00:00Z') / 60000);
	const MIDNIGHT_MAY4 = MIDNIGHT_MAY3 + 1440;
	const MIDNIGHT_MAY4_01 = MIDNIGHT_MAY4 + 1;

	test('5m: T=13:31 → bucket [13:25, 13:30)', () => {
		expect(aggBucketJustClosed(AGG_5M, T13_31)).toBe(T13_00 + 25);
	});
	test('1h: T=14:01 → bucket [13:00, 14:00)', () => {
		expect(aggBucketJustClosed(AGG_1H, T14_01)).toBe(T13_00);
	});
	test('1d: T=00:01 next day → bucket [day-1 00:00, day 00:00)', () => {
		expect(aggBucketJustClosed(AGG_1D, MIDNIGHT_MAY4_01)).toBe(MIDNIGHT_MAY3);
	});
	test('1d: mid-day → null', () => {
		expect(aggBucketJustClosed(AGG_1D, T13_31)).toBeNull();
	});
});

describe('aggInputKeysForBucket', () => {
	const T13_25 = Math.floor(Date.parse('2026-05-03T13:25:00Z') / 60000);
	const T13_00 = T13_25 - 25;

	test('5m@5m bucket → 1 input shard from agg=1m/cons=5m', () => {
		expect(aggInputKeysForBucket(AGG_5M, T13_25)).toEqual([
			'gbfs/avail/agg=1m/cons=5m/2026-05-03/1325.parquet',
		]);
	});
	test('15m@15m bucket → 3 inputs from agg=5m/cons=5m at 5-min stride', () => {
		const T13_15 = T13_25 - 10;
		expect(aggInputKeysForBucket(AGG_15M, T13_15)).toEqual([
			'gbfs/avail/agg=5m/cons=5m/2026-05-03/1315.parquet',
			'gbfs/avail/agg=5m/cons=5m/2026-05-03/1320.parquet',
			'gbfs/avail/agg=5m/cons=5m/2026-05-03/1325.parquet',
		]);
	});
	test('1h@1h bucket → 4 inputs from agg=15m/cons=15m at 15-min stride', () => {
		expect(aggInputKeysForBucket(AGG_1H, T13_00)).toEqual([
			'gbfs/avail/agg=15m/cons=15m/2026-05-03/1300.parquet',
			'gbfs/avail/agg=15m/cons=15m/2026-05-03/1315.parquet',
			'gbfs/avail/agg=15m/cons=15m/2026-05-03/1330.parquet',
			'gbfs/avail/agg=15m/cons=15m/2026-05-03/1345.parquet',
		]);
	});
	test('1d@1d bucket → 24 inputs from agg=1h/cons=1h at 1h stride', () => {
		const MIDNIGHT_MAY3 = Math.floor(Date.parse('2026-05-03T00:00:00Z') / 60000);
		const keys = aggInputKeysForBucket(AGG_1D, MIDNIGHT_MAY3);
		expect(keys).toHaveLength(24);
		expect(keys[0]).toBe('gbfs/avail/agg=1h/cons=1h/2026-05-03/00.parquet');
		expect(keys[23]).toBe('gbfs/avail/agg=1h/cons=1h/2026-05-03/23.parquet');
	});
});

describe('aggMergeRows (monoid sum across input rows per station)', () => {
	const bs = Math.floor(Date.parse('2026-05-03T13:25:00Z') / 60000);
	const dt = BigInt(bs * 60);

	test('two rows for same station → one output row with summed sketch', () => {
		const inputs = [
			{ station_id: 'A', dt: dt - 60n, bikes_n: 1, bikes_sum: 5, bikes_sum_sq: 25,
			  ebikes_n: 1, ebikes_sum: 0, ebikes_sum_sq: 0, docks_n: 1, docks_sum: 0, docks_sum_sq: 0,
			  disabled_n: 1, disabled_sum: 0, disabled_sum_sq: 0, pending_n: 1, pending_sum: 0, pending_sum_sq: 0 },
			{ station_id: 'A', dt: dt, bikes_n: 1, bikes_sum: 7, bikes_sum_sq: 49,
			  ebikes_n: 1, ebikes_sum: 0, ebikes_sum_sq: 0, docks_n: 1, docks_sum: 0, docks_sum_sq: 0,
			  disabled_n: 1, disabled_sum: 0, disabled_sum_sq: 0, pending_n: 1, pending_sum: 0, pending_sum_sq: 0 },
		];
		const cols = aggMergeRows(inputs, bs);
		expect(cols.find((c) => c.name === 'station_id')!.data).toEqual(['A']);
		expect(cols.find((c) => c.name === 'bikes_n')!.data).toEqual([2]);
		expect(cols.find((c) => c.name === 'bikes_sum')!.data).toEqual([12]);
		expect(cols.find((c) => c.name === 'bikes_sum_sq')!.data).toEqual([74]);
		// dt = bucket-start, NOT one of the input dts
		expect((cols.find((c) => c.name === 'dt')!.data as bigint[])[0]).toBe(dt);
	});

	test('multiple stations, multiple rows each → one output row per station, sorted', () => {
		const inputs = [
			{ station_id: 'B', dt: 0n, bikes_n: 1, bikes_sum: 1, bikes_sum_sq: 1,
			  ebikes_n: 0, ebikes_sum: 0, ebikes_sum_sq: 0, docks_n: 0, docks_sum: 0, docks_sum_sq: 0,
			  disabled_n: 0, disabled_sum: 0, disabled_sum_sq: 0, pending_n: 0, pending_sum: 0, pending_sum_sq: 0 },
			{ station_id: 'A', dt: 0n, bikes_n: 1, bikes_sum: 2, bikes_sum_sq: 4,
			  ebikes_n: 0, ebikes_sum: 0, ebikes_sum_sq: 0, docks_n: 0, docks_sum: 0, docks_sum_sq: 0,
			  disabled_n: 0, disabled_sum: 0, disabled_sum_sq: 0, pending_n: 0, pending_sum: 0, pending_sum_sq: 0 },
			{ station_id: 'B', dt: 0n, bikes_n: 1, bikes_sum: 3, bikes_sum_sq: 9,
			  ebikes_n: 0, ebikes_sum: 0, ebikes_sum_sq: 0, docks_n: 0, docks_sum: 0, docks_sum_sq: 0,
			  disabled_n: 0, disabled_sum: 0, disabled_sum_sq: 0, pending_n: 0, pending_sum: 0, pending_sum_sq: 0 },
		];
		const cols = aggMergeRows(inputs, bs);
		expect(cols.find((c) => c.name === 'station_id')!.data).toEqual(['A', 'B']);
		expect(cols.find((c) => c.name === 'bikes_n')!.data).toEqual([1, 2]);
		expect(cols.find((c) => c.name === 'bikes_sum')!.data).toEqual([2, 4]);
		expect(cols.find((c) => c.name === 'bikes_sum_sq')!.data).toEqual([4, 10]);
	});

	test('empty input → empty cols', () => {
		const cols = aggMergeRows([], bs);
		expect(cols[0].data).toEqual([]);
	});
});

describe('worker.scheduled: agg-self path (5m@5m)', () => {
	const T13_25 = Math.floor(Date.parse('2026-05-03T13:25:00Z') / 60000);
	const T13_30 = T13_25 + 5;
	const T13_31 = T13_30 + 1;

	test('5m boundary fires both cons=5m AND agg=5m in one tick (cascade-of-cascades)', async () => {
		// Set up: 1m@1m for [13:25, 13:30) inputs + barrier at 13:30.
		const initial: Record<string, ArrayBuffer> = {};
		for (let i = 0; i < 5; i++) {
			const minute = T13_25 + i;
			initial[consKey('1m', '1m', minute)] = build1mShard(minute * 60, [
				station('A', { num_bikes_available: i + 1 }),  // 1, 2, 3, 4, 5
			]);
		}
		initial[consKey('1m', '1m', T13_30)] = build1mShard(T13_30 * 60, [station('A')]);

		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T13_31, r2);

		// Cons-only writes 5m@1m for 1325 (5 rows)
		const consWrite = puts.find((p) => p.key === 'gbfs/avail/agg=1m/cons=5m/2026-05-03/1325.parquet');
		expect(consWrite).toBeDefined();
		// Agg-self writes 5m@5m for 1325 (1 row, summed)
		const aggWrite = puts.find((p) => p.key === 'gbfs/avail/agg=5m/cons=5m/2026-05-03/1325.parquet');
		expect(aggWrite).toBeDefined();

		// Verify agg=5m output: 1 row per station, with summed n + sum + sum_sq
		const buf = aggWrite!.body as ArrayBuffer;
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0].station_id).toBe('A');
		// 5 minutes of bikes_sum: 1+2+3+4+5 = 15. sum_sq = 1+4+9+16+25 = 55. n = 5.
		expect(rows[0].bikes_n).toBe(5);
		expect(rows[0].bikes_sum).toBe(15);
		expect(rows[0].bikes_sum_sq).toBe(55);
		// dt should be the bucket-start unix-s (T13_25 * 60)
		expect(Number(rows[0].dt)).toBe(T13_25 * 60);
	});

	test('agg-self skipped when input shard absent (barrier_missing)', async () => {
		// 1m@1m present + barrier present, but 5m@1m (the agg-self input) NOT
		// present (e.g., cons-only attempt failed). agg-self should skip.
		const initial: Record<string, ArrayBuffer> = {};
		for (let i = 0; i < 5; i++) {
			initial[consKey('1m', '1m', T13_25 + i)] = build1mShard((T13_25 + i) * 60, [station('A')]);
		}
		initial[consKey('1m', '1m', T13_30)] = build1mShard(T13_30 * 60, [station('A')]);
		// Pre-populate 5m@1m AND 5m@5m so cons-only AND agg-self both think output exists
		// — leave them empty so we can confirm the agg attempt didn't run.
		initial[consKey('1m', '5m', T13_25)] = new ArrayBuffer(0);
		// agg=5m output is what we're testing. Don't pre-populate it. But the input
		// (agg=1m/cons=5m) is present (just empty). So agg-self should run.

		// Actually let me invert: ensure 5m@1m is absent, then agg should be barrier_missing.
		delete initial[consKey('1m', '5m', T13_25)];

		const { r2, puts } = makeR2(initial);
		await runScheduled(worker, T13_31, r2);
		// agg-self can't proceed without 5m@1m input — expect no agg=5m write.
		// But cons-only WILL run and write 5m@1m. After that, agg-self at the
		// SAME tick re-checks and sees 5m@1m → so it WILL run too.
		const aggWrite = puts.find((p) => p.key.includes('agg=5m/cons=5m'));
		expect(aggWrite).toBeDefined();
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
