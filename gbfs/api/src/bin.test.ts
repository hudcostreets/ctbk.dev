import { describe, expect, it } from 'vitest';
import {
	AVAILABILITY_METRIC_COLUMNS,
	binAndAggregate,
	binAndAggregateAvailability,
	binAndAggregateTrips,
	quantileSorted,
} from './bin';

const HOUR_S = 3600;
const HOUR_MS = HOUR_S * 1000;
const MINUTE_S = 60;
const MINUTE_MS = MINUTE_S * 1000;

// Anchor bins on a UTC midnight so `Math.floor(dt / binS) * binS` gives
// predictable bucket boundaries.
const T0 = Date.UTC(2024, 0, 1) / 1000;  // 2024-01-01 00:00 UTC

describe('quantileSorted', () => {
	it('single element: returns it for any p', () => {
		expect(quantileSorted([42], 0)).toBe(42);
		expect(quantileSorted([42], 0.5)).toBe(42);
		expect(quantileSorted([42], 1)).toBe(42);
	});

	it('p=0/p=1 return min/max', () => {
		expect(quantileSorted([1, 2, 3, 4, 5], 0)).toBe(1);
		expect(quantileSorted([1, 2, 3, 4, 5], 1)).toBe(5);
	});

	it('p=0.5 on odd-length: middle element', () => {
		expect(quantileSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
	});

	it('p=0.5 on even-length: linear interpolation between middles', () => {
		expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
	});

	it('R type-7 / NumPy default on [10,20,30,40]', () => {
		// idx = (n-1)*p = 3 * 0.25 = 0.75 → 10 + 0.75 * 10 = 17.5
		expect(quantileSorted([10, 20, 30, 40], 0.25)).toBe(17.5);
		// idx = 3 * 0.75 = 2.25 → 30 + 0.25 * 10 = 32.5
		expect(quantileSorted([10, 20, 30, 40], 0.75)).toBe(32.5);
	});
});

describe('binAndAggregateTrips', () => {
	it('synthesizes count + sums duration_s, no dims', () => {
		const rows = [
			{ dt: T0 + 60, duration_s: 100 },
			{ dt: T0 + 120, duration_s: 200 },
			{ dt: T0 + 180, duration_s: 300 },
		];
		const out = binAndAggregateTrips(rows, HOUR_MS, T0, T0 + HOUR_S, [], true);
		expect(out).toEqual([{ dt: T0, count: 3, duration_s: 600 }]);
	});

	it('groups by dim (side); each (bin, side) gets independent sums', () => {
		const rows = [
			{ dt: T0 + 10, side: 'start', duration_s: 100 },
			{ dt: T0 + 20, side: 'start', duration_s: 150 },
			{ dt: T0 + 30, side: 'end',   duration_s: 200 },
		];
		const out = binAndAggregateTrips(rows, HOUR_MS, T0, T0 + HOUR_S, ['side'], true);
		expect(out).toEqual([
			{ dt: T0, side: 'end',   count: 1, duration_s: 200 },
			{ dt: T0, side: 'start', count: 2, duration_s: 250 },
		]);
	});

	it('does not synthesize count when synthesizeCount=false; sums explicit count', () => {
		const rows = [
			{ dt: T0 + 10, count: 5, duration_s: 100 },
			{ dt: T0 + 20, count: 7, duration_s: 200 },
		];
		const out = binAndAggregateTrips(rows, HOUR_MS, T0, T0 + HOUR_S, [], false);
		expect(out).toEqual([{ dt: T0, count: 12, duration_s: 300 }]);
	});

	it('drops rows outside [fromS, toS]', () => {
		const rows = [
			{ dt: T0 - 1, duration_s: 999 },         // before
			{ dt: T0,     duration_s: 100 },         // inside (lower bound)
			{ dt: T0 + HOUR_S, duration_s: 200 },    // inside (upper bound — inclusive)
			{ dt: T0 + HOUR_S + 1, duration_s: 999 },// after
		];
		const out = binAndAggregateTrips(rows, HOUR_MS, T0, T0 + HOUR_S, [], true);
		// Both inside rows fall in different bins (T0 and T0+HOUR_S).
		expect(out).toEqual([
			{ dt: T0, count: 1, duration_s: 100 },
			{ dt: T0 + HOUR_S, count: 1, duration_s: 200 },
		]);
	});

	it('does NOT sum non-allowlisted numeric cols (e.g. gender)', () => {
		const rows = [
			{ dt: T0 + 10, gender: 1 },
			{ dt: T0 + 20, gender: 2 },
		];
		const out = binAndAggregateTrips(rows, HOUR_MS, T0, T0 + HOUR_S, [], true);
		expect(out).toEqual([{ dt: T0, count: 2 }]);
	});
});

describe('binAndAggregateAvailability', () => {
	it('single bin, multiple metrics → mean/min/max/quantiles per field + sample_count', () => {
		// 5 polls with bikes ∈ {1,2,3,4,5} and ebikes ∈ {10,10,10,10,20}.
		const rows = [1, 2, 3, 4, 5].map((b, i) => ({
			dt: T0 + i * 60,
			num_bikes_available: b,
			num_ebikes_available: i === 4 ? 20 : 10,
			num_docks_available: 50 - b,
			num_bikes_disabled: 0,
			num_docks_disabled: 0,
		}));
		const out = binAndAggregateAvailability(rows, HOUR_MS, T0, T0 + HOUR_S);
		expect(out.length).toBe(1);
		const row = out[0];
		expect(row.dt).toBe(T0);
		expect(row.sample_count).toBe(5);

		// num_bikes_available stats on [1,2,3,4,5]
		expect(row.num_bikes_available_mean).toBe(3);
		expect(row.num_bikes_available_min).toBe(1);
		expect(row.num_bikes_available_max).toBe(5);
		expect(row.num_bikes_available_p05).toBe(quantileSorted([1, 2, 3, 4, 5], 0.05));
		expect(row.num_bikes_available_p25).toBe(2);
		expect(row.num_bikes_available_p50).toBe(3);
		expect(row.num_bikes_available_p75).toBe(4);
		expect(row.num_bikes_available_p95).toBe(quantileSorted([1, 2, 3, 4, 5], 0.95));

		// num_ebikes_available stats on [10,10,10,10,20]
		expect(row.num_ebikes_available_mean).toBe(12);
		expect(row.num_ebikes_available_min).toBe(10);
		expect(row.num_ebikes_available_max).toBe(20);
		expect(row.num_ebikes_available_p50).toBe(10);

		// num_docks_available stats on [49,48,47,46,45]
		expect(row.num_docks_available_mean).toBe(47);
		expect(row.num_docks_available_min).toBe(45);
		expect(row.num_docks_available_max).toBe(49);

		// Disabled fields all 0
		expect(row.num_bikes_disabled_mean).toBe(0);
		expect(row.num_docks_disabled_max).toBe(0);
	});

	it('rows split across two bin boundaries → independent stats per bin', () => {
		const rows = [
			// Bin 1 (T0): bikes ∈ {2, 4}
			{ dt: T0 + 10, num_bikes_available: 2 },
			{ dt: T0 + 20, num_bikes_available: 4 },
			// Bin 2 (T0 + HOUR_S): bikes ∈ {10, 30}
			{ dt: T0 + HOUR_S + 10, num_bikes_available: 10 },
			{ dt: T0 + HOUR_S + 20, num_bikes_available: 30 },
		];
		const out = binAndAggregateAvailability(rows, HOUR_MS, T0, T0 + 2 * HOUR_S);
		expect(out.length).toBe(2);
		expect(out[0].dt).toBe(T0);
		expect(out[0].sample_count).toBe(2);
		expect(out[0].num_bikes_available_mean).toBe(3);
		expect(out[0].num_bikes_available_min).toBe(2);
		expect(out[0].num_bikes_available_max).toBe(4);

		expect(out[1].dt).toBe(T0 + HOUR_S);
		expect(out[1].sample_count).toBe(2);
		expect(out[1].num_bikes_available_mean).toBe(20);
		expect(out[1].num_bikes_available_min).toBe(10);
		expect(out[1].num_bikes_available_max).toBe(30);
	});

	it('groups by dim (region), each (bin, dim-combo) gets full stat suite', () => {
		const rows = [
			{ dt: T0 + 10, region: 'nyc', num_bikes_available: 5 },
			{ dt: T0 + 20, region: 'nyc', num_bikes_available: 15 },
			{ dt: T0 + 30, region: 'jc',  num_bikes_available: 100 },
		];
		const out = binAndAggregateAvailability(rows, HOUR_MS, T0, T0 + HOUR_S, ['region']);
		expect(out.length).toBe(2);
		const jc = out.find((r) => r.region === 'jc')!;
		const nyc = out.find((r) => r.region === 'nyc')!;
		expect(jc.sample_count).toBe(1);
		expect(jc.num_bikes_available_mean).toBe(100);
		expect(jc.num_bikes_available_min).toBe(100);
		expect(jc.num_bikes_available_max).toBe(100);
		expect(nyc.sample_count).toBe(2);
		expect(nyc.num_bikes_available_mean).toBe(10);
		expect(nyc.num_bikes_available_min).toBe(5);
		expect(nyc.num_bikes_available_max).toBe(15);
	});

	it('does NOT aggregate non-allowlisted columns (is_renting, last_reported)', () => {
		const rows = [
			{ dt: T0 + 10, num_bikes_available: 2, is_renting: 1, last_reported: 1700000000 },
			{ dt: T0 + 20, num_bikes_available: 4, is_renting: 1, last_reported: 1700000060 },
		];
		const out = binAndAggregateAvailability(rows, HOUR_MS, T0, T0 + HOUR_S);
		expect(out.length).toBe(1);
		const row = out[0];
		expect(row).not.toHaveProperty('is_renting_mean');
		expect(row).not.toHaveProperty('is_renting_min');
		expect(row).not.toHaveProperty('last_reported_mean');
		expect(row).not.toHaveProperty('last_reported_p50');
	});

	it('rows missing a metric field → that field omitted from output, others still present', () => {
		const rows = [
			{ dt: T0 + 10, num_bikes_available: 2 },
			{ dt: T0 + 20, num_bikes_available: 4 },
			// no num_ebikes_available anywhere
		];
		const out = binAndAggregateAvailability(rows, HOUR_MS, T0, T0 + HOUR_S);
		expect(out.length).toBe(1);
		expect(out[0].num_bikes_available_mean).toBe(3);
		expect(out[0]).not.toHaveProperty('num_ebikes_available_mean');
		expect(out[0]).not.toHaveProperty('num_ebikes_available_min');
	});

	it('empty input → empty output', () => {
		expect(binAndAggregateAvailability([], HOUR_MS, T0, T0 + HOUR_S)).toEqual([]);
	});

	it('AVAILABILITY_METRIC_COLUMNS lists exactly the 5 expected metrics', () => {
		expect(AVAILABILITY_METRIC_COLUMNS).toEqual([
			'num_bikes_available',
			'num_ebikes_available',
			'num_docks_available',
			'num_bikes_disabled',
			'num_docks_disabled',
		]);
	});
});

describe('binAndAggregate (dispatcher)', () => {
	it('kind=trips routes to trip aggregator (sums + count synth)', () => {
		const rows = [
			{ dt: T0 + 10, duration_s: 100 },
			{ dt: T0 + 20, duration_s: 200 },
		];
		const out = binAndAggregate(rows, {
			kind: 'trips',
			binMs: HOUR_MS,
			fromS: T0,
			toS: T0 + HOUR_S,
			synthesizeCount: true,
		});
		expect(out).toEqual([{ dt: T0, count: 2, duration_s: 300 }]);
	});

	it('kind=availability routes to availability aggregator (mean/min/max/quantiles)', () => {
		const rows = [
			{ dt: T0 + 10, num_bikes_available: 2 },
			{ dt: T0 + 20, num_bikes_available: 4 },
		];
		const out = binAndAggregate(rows, {
			kind: 'availability',
			binMs: HOUR_MS,
			fromS: T0,
			toS: T0 + HOUR_S,
		});
		expect(out.length).toBe(1);
		expect(out[0].dt).toBe(T0);
		expect(out[0].sample_count).toBe(2);
		expect(out[0].num_bikes_available_mean).toBe(3);
		expect(out[0]).not.toHaveProperty('count');  // no trips-style count
	});
});
