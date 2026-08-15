import { describe, expect, it } from 'vitest';
import type { Row } from 'pyrmts';
import { reduceRows } from './rides_v1';

describe('reduceRows', () => {
	const baseRow = (m: { count: [number, number, number]; duration: [number, number, number] }): Row => ({
		dt: 1779404400_000,
		start_s2_cell: '89c2588',
		gender: 'unknown',
		user_type: 'Subscriber',
		bike_type: 'classic_bike',
		count_n:     m.count[0],
		count_sum:   m.count[1],
		count_sumsq: m.count[2],
		duration_n:     m.duration[0],
		duration_sum:   m.duration[1],
		duration_sumsq: m.duration[2],
	});

	it('sum (default): returns the `sum` field; metric triplets dropped from output', () => {
		const rows = [baseRow({ count: [10, 10, 10], duration: [10, 6000, 4_800_000] })];
		expect(reduceRows(rows, 'sum')).toEqual([{
			dt: 1779404400_000,
			start_s2_cell: '89c2588',
			gender: 'unknown',
			user_type: 'Subscriber',
			bike_type: 'classic_bike',
			count: 10,
			duration: 6000,
		}]);
	});

	it('count: returns the `n` field for each metric', () => {
		const rows = [baseRow({ count: [42, 42, 42], duration: [42, 9999, 2_000_000] })];
		expect(reduceRows(rows, 'count')).toEqual([{
			dt: 1779404400_000,
			start_s2_cell: '89c2588',
			gender: 'unknown',
			user_type: 'Subscriber',
			bike_type: 'classic_bike',
			count: 42,
			duration: 42,
		}]);
	});

	it('mean: sum / n; returns null for empty groups (n=0)', () => {
		const rows = [
			baseRow({ count: [4, 4, 4], duration: [4, 1200, 400_000] }),     // mean(duration)=300
			baseRow({ count: [0, 0, 0], duration: [0, 0, 0] }),               // empty group
		];
		expect(reduceRows(rows, 'mean')).toEqual([
			{
				dt: 1779404400_000,
				start_s2_cell: '89c2588',
				gender: 'unknown',
				user_type: 'Subscriber',
				bike_type: 'classic_bike',
				count: 1,
				duration: 300,
			},
			{
				dt: 1779404400_000,
				start_s2_cell: '89c2588',
				gender: 'unknown',
				user_type: 'Subscriber',
				bike_type: 'classic_bike',
				count: null,
				duration: null,
			},
		]);
	});

	it('stddev: sample stddev from (n, sum, sumsq); returns 0 for n<2', () => {
		// durations: [100, 200, 300] → n=3, sum=600, sumsq=140000.
		// variance = (140000 - 600²/3) / 2 = (140000 - 120000)/2 = 10000. stddev = 100.
		const rows = [baseRow({ count: [3, 3, 3], duration: [3, 600, 140000] })];
		expect(reduceRows(rows, 'stddev')).toEqual([{
			dt: 1779404400_000,
			start_s2_cell: '89c2588',
			gender: 'unknown',
			user_type: 'Subscriber',
			bike_type: 'classic_bike',
			count: 0,                 // counts are all 1s → variance 0, stddev 0
			duration: 100,
		}]);
	});

	it('raw: rows pass through unchanged (no scalar collapse)', () => {
		const rows = [baseRow({ count: [5, 5, 5], duration: [5, 1500, 500_000] })];
		expect(reduceRows(rows, 'raw')).toEqual(rows);
	});

	it('dropCols (sum): strips named columns from output (used to scrub `start_s2_cell` from rollup rows)', () => {
		const rows = [baseRow({ count: [10, 10, 10], duration: [10, 6000, 4_800_000] })];
		expect(reduceRows(rows, 'sum', ['start_s2_cell'])).toEqual([{
			dt: 1779404400_000,
			gender: 'unknown',
			user_type: 'Subscriber',
			bike_type: 'classic_bike',
			count: 10,
			duration: 6000,
		}]);
	});

	it('dropCols (raw): scrubs without collapsing metric triplets', () => {
		const rows = [baseRow({ count: [3, 3, 3], duration: [3, 600, 140000] })];
		const out = reduceRows(rows, 'raw', ['start_s2_cell']);
		expect(out).toEqual([{
			dt: 1779404400_000,
			gender: 'unknown',
			user_type: 'Subscriber',
			bike_type: 'classic_bike',
			count_n: 3, count_sum: 3, count_sumsq: 3,
			duration_n: 3, duration_sum: 600, duration_sumsq: 140000,
		}]);
		// Source array untouched — defensive copy semantics.
		expect(rows[0]!.start_s2_cell).toBe('89c2588');
	});
});
