import { describe, expect, test } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { parquetReadObjects, parquetMetadataAsync } from 'hyparquet';
import { buildMinuteShard } from './index';

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

describe('buildMinuteShard', () => {
	test('emits station_id, dt, and 3 cols × 5 metrics', () => {
		const cols = buildMinuteShard({
			ts: 1700000005,
			polled_at: 1700000007,
			stations: [station('A')],
		});
		expect(cols.map((c) => c.name)).toEqual([
			'station_id', 'dt',
			'bikes_n', 'bikes_sum', 'bikes_sum_sq',
			'ebikes_n', 'ebikes_sum', 'ebikes_sum_sq',
			'docks_n', 'docks_sum', 'docks_sum_sq',
			'disabled_n', 'disabled_sum', 'disabled_sum_sq',
			'pending_n', 'pending_sum', 'pending_sum_sq',
		]);
	});

	test('sorts by station_id (lex)', () => {
		const cols = buildMinuteShard({
			ts: 1700000000,
			polled_at: 1700000000,
			stations: [station('Z'), station('A'), station('M')],
		});
		const ids = cols.find((c) => c.name === 'station_id')!.data;
		expect(ids).toEqual(['A', 'M', 'Z']);
	});

	test('dt = floor(polled_at / 60) * 60', () => {
		const cols = buildMinuteShard({
			ts: 1700000000,
			polled_at: 1700000125, // 2:05.125 past minute → floor to 2 min past epoch-rounded
			stations: [station('A')],
		});
		const dt = cols.find((c) => c.name === 'dt')!.data;
		expect(dt).toEqual([BigInt(1700000100)]); // 1700000125 - 25 = 1700000100
	});

	test('per-metric values mapped from GBFS source columns', () => {
		const cols = buildMinuteShard({
			ts: 1700000000,
			polled_at: 1700000000,
			stations: [station('A', {
				num_bikes_available: 5,
				num_ebikes_available: 2,
				num_docks_available: 10,
				num_bikes_disabled: 1,
				num_docks_disabled: 3,
			})],
		});
		const get = (n: string) => cols.find((c) => c.name === n)!.data[0];
		expect(get('bikes_sum')).toBe(5);
		expect(get('bikes_sum_sq')).toBe(25);
		expect(get('ebikes_sum')).toBe(2);
		expect(get('ebikes_sum_sq')).toBe(4);
		expect(get('docks_sum')).toBe(10);
		expect(get('disabled_sum')).toBe(1);
		expect(get('pending_sum')).toBe(3);
	});

	test('n=1 per row (one poll per minute, cron path)', () => {
		const cols = buildMinuteShard({
			ts: 1700000000,
			polled_at: 1700000000,
			stations: [station('A'), station('B')],
		});
		for (const m of ['bikes', 'ebikes', 'docks', 'disabled', 'pending']) {
			expect(cols.find((c) => c.name === `${m}_n`)!.data).toEqual([1, 1]);
		}
	});

	test('empty stations → empty columns', () => {
		const cols = buildMinuteShard({ ts: 0, polled_at: 0, stations: [] });
		for (const c of cols) expect(c.data).toEqual([]);
	});
});

describe('parquet round-trip', () => {
	test('written shard is decodable; values + dt preserved', async () => {
		const cols = buildMinuteShard({
			ts: 1700000005,
			polled_at: 1700000007,
			stations: [
				station('A', { num_bikes_available: 5, num_docks_available: 10 }),
				station('B', { num_bikes_available: 3, num_docks_available: 12 }),
			],
		});
		const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };

		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		expect(rows).toHaveLength(2);

		// Sorted by station_id; dt is BigInt → coerce for comparison.
		// dt = floor(1700000007/60)*60 = 1699999980.
		expect(rows[0].station_id).toBe('A');
		expect(Number(rows[0].dt)).toBe(1699999980);
		expect(rows[0].bikes_sum).toBe(5);
		expect(rows[0].docks_sum).toBe(10);
		expect(rows[1].station_id).toBe('B');
		expect(rows[1].bikes_sum).toBe(3);
	});

	test('station_id row-group stats present (enables prune)', async () => {
		// Spread across enough stations to force >1 rg at rowGroupSize=600
		const stations = Array.from({ length: 1500 }, (_, i) =>
			station(`s${i.toString().padStart(4, '0')}`, { num_bikes_available: i % 30 }),
		);
		const cols = buildMinuteShard({ ts: 1700000000, polled_at: 1700000000, stations });
		const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };

		const meta = await parquetMetadataAsync(file);
		expect(meta.row_groups.length).toBeGreaterThanOrEqual(2);
		// Each rg's station_id stats span a contiguous lex range
		for (const rg of meta.row_groups) {
			const sidCol = rg.columns.find((c) => c.meta_data?.path_in_schema?.[0] === 'station_id')!;
			const stats = sidCol.meta_data?.statistics;
			expect(stats?.min_value).toBeDefined();
			expect(stats?.max_value).toBeDefined();
			expect(String(stats!.min_value) <= String(stats!.max_value)).toBe(true);
		}
	});
});
