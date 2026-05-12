import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { availParquetKeyFromStatusKey } from '../../lib/avail-monoid';
import worker from './index';

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

interface Put {
	key: string;
	body: ArrayBuffer | string;
}

function makeBucket(initial: Record<string, unknown>) {
	const puts: Put[] = [];
	const bucket = {
		get: vi.fn(async (key: string) => {
			if (!(key in initial)) return null;
			const v = initial[key];
			return {
				json: async () => v,
				text: async () => JSON.stringify(v),
			};
		}),
		put: vi.fn(async (key: string, body: ArrayBuffer | string) => {
			puts.push({ key, body });
		}),
	};
	return { bucket, puts };
}

function makeMsg(key: string) {
	const acks = { ack: 0, retry: 0 };
	const msg = {
		body: { account: 'a', bucket: 'ctbk', object: { key, size: 0, eTag: '' }, action: 'PutObject', eventTime: '' },
		ack: vi.fn(() => { acks.ack++; }),
		retry: vi.fn(() => { acks.retry++; }),
	};
	return { msg, acks };
}

const STATUS_KEY = 'gbfs/status/2026-05-03/12-45.json';
const PQ_KEY     = 'avail/agg=1m/cons=1m/2026-05-03/1245.parquet';
// Dual-write during the `specs/r2-layout.md` Phase A migration.
const PQ_KEY_NEW = `gbfs/${PQ_KEY}`;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('availParquetKeyFromStatusKey', () => {
	test('per-minute status → parquet key', () => {
		expect(availParquetKeyFromStatusKey('gbfs/status/2026-05-03/12-45.json')).toBe(
			'avail/agg=1m/cons=1m/2026-05-03/1245.parquet',
		);
	});

	test('rejects non-per-minute status keys', () => {
		expect(() => availParquetKeyFromStatusKey('gbfs/status/2026-05-03/12-45.txt')).toThrow();
		expect(() => availParquetKeyFromStatusKey('gbfs/info/2026-05-03.json')).toThrow();
		expect(() => availParquetKeyFromStatusKey('gbfs/status/2026-05-03/123-45.json')).toThrow();
	});
});

describe('queue handler: per-minute avail key', () => {
	test('reads JSON, writes parquet to derived key, acks', async () => {
		const record = {
			ts: 1700000005,
			polled_at: 1700000007,
			stations: [
				station('A', { num_bikes_available: 5, num_docks_available: 10 }),
				station('B', { num_bikes_available: 3, num_docks_available: 12 }),
			],
		};
		const { bucket, puts } = makeBucket({ [STATUS_KEY]: record });
		const { msg, acks } = makeMsg(STATUS_KEY);

		await worker.queue({ messages: [msg] } as never, { BUCKET: bucket, DB: {} } as never, {} as never);

		expect(acks).toEqual({ ack: 1, retry: 0 });
		expect(bucket.get).toHaveBeenCalledWith(STATUS_KEY);
		expect(puts.map((p) => p.key).sort()).toEqual([PQ_KEY, PQ_KEY_NEW].sort());

		// Verify shard is decodable + has the right rows.
		const buf = puts[0].body as ArrayBuffer;
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		expect(rows).toHaveLength(2);
		expect(rows[0].station_id).toBe('A');
		expect(rows[0].bikes_sum).toBe(5);
		expect(rows[1].station_id).toBe('B');
		expect(rows[1].bikes_sum).toBe(3);
	});

	test('empty stations → warn, no parquet write, ack', async () => {
		const { bucket, puts } = makeBucket({
			[STATUS_KEY]: { ts: 0, polled_at: 0, stations: [] },
		});
		const { msg, acks } = makeMsg(STATUS_KEY);

		await worker.queue({ messages: [msg] } as never, { BUCKET: bucket, DB: {} } as never, {} as never);

		expect(acks).toEqual({ ack: 1, retry: 0 });
		expect(puts).toEqual([]);
	});

	test('missing R2 object → retry (transient)', async () => {
		const { bucket } = makeBucket({});  // no objects
		const { msg, acks } = makeMsg(STATUS_KEY);

		await worker.queue({ messages: [msg] } as never, { BUCKET: bucket, DB: {} } as never, {} as never);

		expect(acks).toEqual({ ack: 0, retry: 1 });
	});
});

describe('queue handler: routing', () => {
	test('info key → upsert path (does not call BUCKET.put for parquet)', async () => {
		const INFO_KEY = 'gbfs/info/2026-05-03.json';
		const info = { data: { stations: [{ station_id: 'A', short_name: 'HB101', name: 'A St', lat: 0, lon: 0, capacity: 10 }] } };
		const { bucket, puts } = makeBucket({ [INFO_KEY]: info });
		const { msg, acks } = makeMsg(INFO_KEY);

		// D1 stub: prepare().bind().*; batch resolves.
		const stmt = { bind: vi.fn(() => stmt) };
		const db = { prepare: vi.fn(() => stmt), batch: vi.fn(async () => []) };

		await worker.queue({ messages: [msg] } as never, { BUCKET: bucket, DB: db } as never, {} as never);

		expect(acks).toEqual({ ack: 1, retry: 0 });
		expect(puts).toEqual([]);  // no parquet write for info keys
		expect(db.batch).toHaveBeenCalledOnce();
	});

	test('unknown key → ack without action', async () => {
		const KEY = 'something/random.txt';
		const { bucket, puts } = makeBucket({});
		const { msg, acks } = makeMsg(KEY);

		await worker.queue({ messages: [msg] } as never, { BUCKET: bucket, DB: {} } as never, {} as never);

		expect(acks).toEqual({ ack: 1, retry: 0 });
		expect(puts).toEqual([]);
		expect(bucket.get).not.toHaveBeenCalled();
	});
});
