import { describe, expect, test } from 'vitest';
import { buildColumnData, targetHour } from './index';

describe('targetHour', () => {
	test('subtracts 1h and buckets to UTC date+hour', () => {
		// Cron fires at 14:05 UTC → compact 13:00-13:59 → date 'today', hour '13'
		const fired = new Date('2026-04-20T14:05:00Z');
		expect(targetHour(fired)).toEqual({ date: '2026-04-20', hour: '13' });
	});

	test('crosses midnight UTC into previous day', () => {
		// Cron at 00:05 UTC → compact yesterday's 23:00-23:59
		const fired = new Date('2026-04-20T00:05:00Z');
		expect(targetHour(fired)).toEqual({ date: '2026-04-19', hour: '23' });
	});

	test('handles month boundary', () => {
		// Cron at 00:05 UTC on the 1st → previous month's last day, hour 23
		const fired = new Date('2026-05-01T00:05:00Z');
		expect(targetHour(fired)).toEqual({ date: '2026-04-30', hour: '23' });
	});

	test('handles year boundary', () => {
		const fired = new Date('2027-01-01T00:05:00Z');
		expect(targetHour(fired)).toEqual({ date: '2026-12-31', hour: '23' });
	});

	test('hour minute padding', () => {
		const fired = new Date('2026-04-20T05:05:00Z');
		expect(targetHour(fired)).toEqual({ date: '2026-04-20', hour: '04' });
	});
});

describe('buildColumnData', () => {
	const snap = (ts: number, polled: number, stations: Array<Record<string, number | string>>) => ({
		ts,
		polled_at: polled,
		stations: stations as never,
	});
	const station = (id: string, vals: Partial<Record<string, number>> = {}) => ({
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

	test('flattens snapshots × stations and produces all columns', () => {
		const cols = buildColumnData([
			snap(100, 101, [station('A'), station('B')]),
			snap(200, 201, [station('A'), station('B')]),
		]);
		// Expected schema: station_id, ts, polled_at, 8 INT16, last_reported = 12 columns
		expect(cols.map((c) => c.name)).toEqual([
			'station_id',
			'ts',
			'polled_at',
			'num_bikes_available',
			'num_ebikes_available',
			'num_docks_available',
			'num_bikes_disabled',
			'num_docks_disabled',
			'is_installed',
			'is_renting',
			'is_returning',
			'last_reported',
		]);
		expect(cols[0].data).toHaveLength(4);
		expect(cols.find((c) => c.name === 'ts')!.data).toEqual([100n, 100n, 200n, 200n]);
		expect(cols.find((c) => c.name === 'station_id')!.data).toEqual(['A', 'B', 'A', 'B']);
	});

	test('sorts by (ts, station_id)', () => {
		const cols = buildColumnData([
			// Out-of-order input: ts=200 comes first, station_id=B before A
			snap(200, 201, [station('B'), station('A')]),
			snap(100, 101, [station('B'), station('A')]),
		]);
		expect(cols.find((c) => c.name === 'ts')!.data).toEqual([100n, 100n, 200n, 200n]);
		expect(cols.find((c) => c.name === 'station_id')!.data).toEqual(['A', 'B', 'A', 'B']);
	});

	test('coerces ts/polled_at/last_reported to BigInt', () => {
		const cols = buildColumnData([snap(100, 101, [station('A', { last_reported: 1700000000 })])]);
		const ts = cols.find((c) => c.name === 'ts')!.data;
		const polled = cols.find((c) => c.name === 'polled_at')!.data;
		const lr = cols.find((c) => c.name === 'last_reported')!.data;
		expect(typeof ts[0]).toBe('bigint');
		expect(typeof polled[0]).toBe('bigint');
		expect(typeof lr[0]).toBe('bigint');
		expect(ts[0]).toBe(100n);
		expect(polled[0]).toBe(101n);
		expect(lr[0]).toBe(1700000000n);
	});

	test('preserves int16 column values', () => {
		const cols = buildColumnData([
			snap(100, 101, [station('A', { num_bikes_available: 12, is_installed: 0, is_renting: 1 })]),
		]);
		expect(cols.find((c) => c.name === 'num_bikes_available')!.data).toEqual([12]);
		expect(cols.find((c) => c.name === 'is_installed')!.data).toEqual([0]);
		expect(cols.find((c) => c.name === 'is_renting')!.data).toEqual([1]);
	});

	test('empty snapshot list → empty columns', () => {
		const cols = buildColumnData([]);
		for (const c of cols) expect(c.data).toEqual([]);
	});

	test('snapshot with zero stations → no rows', () => {
		const cols = buildColumnData([snap(100, 101, [])]);
		for (const c of cols) expect(c.data).toEqual([]);
	});

	test('handles missing last_reported (defaults to 0)', () => {
		const cols = buildColumnData([
			snap(100, 101, [{
				station_id: 'A',
				num_bikes_available: 0,
				num_ebikes_available: 0,
				num_docks_available: 0,
				num_bikes_disabled: 0,
				num_docks_disabled: 0,
				is_installed: 1,
				is_renting: 1,
				is_returning: 1,
				// last_reported absent
			} as never]),
		]);
		expect(cols.find((c) => c.name === 'last_reported')!.data).toEqual([0n]);
	});
});
