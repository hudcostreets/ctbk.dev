import { describe, expect, it } from 'vitest';
import {
	ALL_REGIONS,
	DAY_MS,
	HOUR_MS,
	MINUTE_MS,
	deriveBinMs,
	monthsIn,
	monthsInDashed,
	planQuery,
	snapToStandardBin,
	yearsIn,
} from './planQuery';

// Unix seconds for UTC midnight of various dates (computed via `Date.UTC`).
const T = {
	'2023-06-01': Date.UTC(2023, 5, 1) / 1000,
	'2023-12-15': Date.UTC(2023, 11, 15) / 1000,
	'2024-01-01': Date.UTC(2024, 0, 1) / 1000,
	'2024-01-08': Date.UTC(2024, 0, 8) / 1000,
	'2024-01-15': Date.UTC(2024, 0, 15) / 1000,
	'2024-02-01': Date.UTC(2024, 1, 1) / 1000,
	'2024-02-15': Date.UTC(2024, 1, 15) / 1000,
	'2024-03-01': Date.UTC(2024, 2, 1) / 1000,
	'2024-03-15': Date.UTC(2024, 2, 15) / 1000,
	'2024-04-05': Date.UTC(2024, 3, 5) / 1000,
	'2025-01-01': Date.UTC(2025, 0, 1) / 1000,
};

describe('planQuery: station mode', () => {
	it('trips, single station, explicit hour bin → one raw file', () => {
		const plan = planQuery({
			kind: 'trips',
			station: '6002.04',
			fromS: T['2024-01-01'],
			toS: T['2025-01-01'],
			binMs: HOUR_MS,
		});
		expect(plan).toEqual({
			paths: ['trips/stations/6002.04.parquet'],
			tier: 'raw',
			binMs: HOUR_MS,
			mode: 'station',
		});
	});

	it('availability, single station → one raw file (ignores regions)', () => {
		const plan = planQuery({
			kind: 'availability',
			station: '6002.04',
			fromS: T['2024-01-01'],
			toS: T['2024-03-01'],
			binMs: MINUTE_MS,
		});
		expect(plan).toEqual({
			paths: ['avail/stations/6002.04.parquet'],
			tier: 'raw',
			binMs: MINUTE_MS,
			mode: 'station',
		});
	});

	it('station wins over regions when both are set', () => {
		const plan = planQuery({
			kind: 'trips',
			station: 'HB101',
			regions: ['nyc', 'jc'],
			fromS: T['2024-01-01'],
			toS: T['2024-02-01'],
			binMs: HOUR_MS,
		});
		expect(plan.paths).toEqual(['trips/stations/HB101.parquet']);
		expect(plan.mode).toBe('station');
	});
});

describe('planQuery: region + availability', () => {
	it('single region, 3-month window → 3 monthly shards', () => {
		const plan = planQuery({
			kind: 'availability',
			regions: ['nyc'],
			fromS: T['2024-01-01'],
			toS: T['2024-03-01'],
			binMs: MINUTE_MS,
		});
		expect(plan).toEqual({
			paths: [
				'avail/region/nyc/2024-01.parquet',
				'avail/region/nyc/2024-02.parquet',
				'avail/region/nyc/2024-03.parquet',
			],
			tier: 'avail-region',
			binMs: MINUTE_MS,
			mode: 'region',
		});
	});

	it('range within single month → 1 shard', () => {
		const plan = planQuery({
			kind: 'availability',
			regions: ['nyc'],
			fromS: T['2024-02-01'],
			toS: T['2024-02-15'],
			binMs: MINUTE_MS,
		});
		expect(plan.paths).toEqual(['avail/region/nyc/2024-02.parquet']);
		expect(plan.tier).toBe('avail-region');
	});

	it('omitted regions defaults to all 3 regions', () => {
		const plan = planQuery({
			kind: 'availability',
			fromS: T['2024-02-01'],
			toS: T['2024-02-15'],
			binMs: MINUTE_MS,
		});
		expect(plan.paths).toEqual([
			'avail/region/nyc/2024-02.parquet',
			'avail/region/jc/2024-02.parquet',
			'avail/region/hob/2024-02.parquet',
		]);
	});

	it('multi-region, range spanning a month boundary → region × 2 months', () => {
		const plan = planQuery({
			kind: 'availability',
			regions: ['nyc', 'jc', 'hob'],
			fromS: T['2024-01-15'],
			toS: T['2024-02-15'],
			binMs: MINUTE_MS,
		});
		expect(plan.paths).toEqual([
			'avail/region/nyc/2024-01.parquet',
			'avail/region/nyc/2024-02.parquet',
			'avail/region/jc/2024-01.parquet',
			'avail/region/jc/2024-02.parquet',
			'avail/region/hob/2024-01.parquet',
			'avail/region/hob/2024-02.parquet',
		]);
	});
});

describe('planQuery: region + trips (h1 tier, bin >= 1h)', () => {
	it('bin = 1h, range in a single year → 1 year shard per region', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-01-15'],
			toS: T['2024-03-15'],
			binMs: HOUR_MS,
		});
		expect(plan).toEqual({
			paths: ['trips/region/nyc/h1/2024.parquet'],
			tier: 'h1',
			binMs: HOUR_MS,
			mode: 'region',
		});
	});

	it('bin > 1h (1 day) still routes to h1', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-01-01'],
			toS: T['2024-03-01'],
			binMs: DAY_MS,
		});
		expect(plan.tier).toBe('h1');
		expect(plan.paths).toEqual(['trips/region/nyc/h1/2024.parquet']);
	});

	it('range spans a year boundary → 2 h1 shards per region', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2023-06-01'],
			toS: T['2024-02-01'],
			binMs: HOUR_MS,
		});
		expect(plan.paths).toEqual([
			'trips/region/nyc/h1/2023.parquet',
			'trips/region/nyc/h1/2024.parquet',
		]);
		expect(plan.tier).toBe('h1');
	});

	it('range spans a year boundary around Dec/Jan', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2023-12-15'],
			toS: T['2024-01-15'],
			binMs: HOUR_MS,
		});
		expect(plan.paths).toEqual([
			'trips/region/nyc/h1/2023.parquet',
			'trips/region/nyc/h1/2024.parquet',
		]);
	});

	it('all 3 regions × 2 years = 6 paths (region-major ordering)', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc', 'jc', 'hob'],
			fromS: T['2023-06-01'],
			toS: T['2024-02-01'],
			binMs: HOUR_MS,
		});
		expect(plan.paths).toEqual([
			'trips/region/nyc/h1/2023.parquet',
			'trips/region/nyc/h1/2024.parquet',
			'trips/region/jc/h1/2023.parquet',
			'trips/region/jc/h1/2024.parquet',
			'trips/region/hob/h1/2023.parquet',
			'trips/region/hob/h1/2024.parquet',
		]);
	});
});

describe('planQuery: region + trips (n1 tier, bin < 1h)', () => {
	it('bin = 5m, range within a month → 1 n1 shard per region', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-03-01'],
			toS: T['2024-03-15'],
			binMs: 5 * MINUTE_MS,
		});
		expect(plan).toEqual({
			paths: ['trips/region/nyc/n1/202403.parquet'],
			tier: 'n1',
			binMs: 5 * MINUTE_MS,
			mode: 'region',
		});
	});

	it('bin = 1m just under 1h → n1', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-03-01'],
			toS: T['2024-03-15'],
			binMs: MINUTE_MS,
		});
		expect(plan.tier).toBe('n1');
		expect(plan.binMs).toBe(MINUTE_MS);
	});

	it('bin = 59m (< 1h) → n1 even with huge range', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-03-01'],
			toS: T['2024-04-05'],
			binMs: 59 * MINUTE_MS,
		});
		expect(plan.tier).toBe('n1');
	});

	it('range spans a month boundary → 2 n1 shards per region', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-03-15'],
			toS: T['2024-04-05'],
			binMs: 5 * MINUTE_MS,
		});
		expect(plan.paths).toEqual([
			'trips/region/nyc/n1/202403.parquet',
			'trips/region/nyc/n1/202404.parquet',
		]);
		expect(plan.tier).toBe('n1');
	});

	it('multi-region (nyc + jc) × 2 months = 4 n1 paths', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc', 'jc'],
			fromS: T['2024-03-01'],
			toS: T['2024-04-05'],
			binMs: 5 * MINUTE_MS,
		});
		expect(plan.paths).toEqual([
			'trips/region/nyc/n1/202403.parquet',
			'trips/region/nyc/n1/202404.parquet',
			'trips/region/jc/n1/202403.parquet',
			'trips/region/jc/n1/202404.parquet',
		]);
	});

	it('all 3 regions (default) × 2 months = 6 n1 paths', () => {
		const plan = planQuery({
			kind: 'trips',
			fromS: T['2024-03-15'],
			toS: T['2024-04-05'],
			binMs: 5 * MINUTE_MS,
		});
		expect(plan.paths).toEqual([
			'trips/region/nyc/n1/202403.parquet',
			'trips/region/nyc/n1/202404.parquet',
			'trips/region/jc/n1/202403.parquet',
			'trips/region/jc/n1/202404.parquet',
			'trips/region/hob/n1/202403.parquet',
			'trips/region/hob/n1/202404.parquet',
		]);
	});
});

describe('planQuery: auto-bin (targetPxPerBin + plotWidth)', () => {
	it('7 days / plotWidth=700 / target=3 → ~43m raw → snaps up to 1h (h1 tier)', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-01-01'],
			toS: T['2024-01-08'],
			targetPxPerBin: 3,
			plotWidth: 700,
		});
		// 7d = 604800000 ms; 700/3 = 233 bins; 604800000/233 ≈ 2596566 ms; snap→1h.
		expect(plan.binMs).toBe(HOUR_MS);
		expect(plan.tier).toBe('h1');
		expect(plan.paths).toEqual(['trips/region/nyc/h1/2024.parquet']);
	});

	it('1 day / plotWidth=1000 / target=3 → ~259s raw → snaps up to 5m (n1 tier)', () => {
		const plan = planQuery({
			kind: 'trips',
			regions: ['nyc'],
			fromS: T['2024-03-01'],
			toS: T['2024-03-01'] + 86400,  // +1 day
			targetPxPerBin: 3,
			plotWidth: 1000,
		});
		// 86400000 ms / (1000/3=333 bins) ≈ 259460 ms; floor min 1m → ceil 259460 → snap up
		// Candidates >= 259460: 5m (300000). So expect 5m.
		expect(plan.binMs).toBe(5 * MINUTE_MS);
		expect(plan.tier).toBe('n1');
	});

	it('throws if neither binMs nor (targetPxPerBin+plotWidth) provided', () => {
		expect(() =>
			planQuery({
				kind: 'trips',
				regions: ['nyc'],
				fromS: T['2024-01-01'],
				toS: T['2024-02-01'],
			}),
		).toThrow(/bin XOR/);
	});

	it('throws if only targetPxPerBin without plotWidth', () => {
		expect(() =>
			planQuery({
				kind: 'trips',
				regions: ['nyc'],
				fromS: T['2024-01-01'],
				toS: T['2024-02-01'],
				targetPxPerBin: 3,
			}),
		).toThrow(/bin XOR/);
	});
});

describe('helpers', () => {
	it('snapToStandardBin: snaps exact match to itself', () => {
		expect(snapToStandardBin(HOUR_MS)).toBe(HOUR_MS);
		expect(snapToStandardBin(5 * MINUTE_MS)).toBe(5 * MINUTE_MS);
	});

	it('snapToStandardBin: snaps between-bins UP', () => {
		expect(snapToStandardBin(MINUTE_MS + 1)).toBe(2 * MINUTE_MS);
		expect(snapToStandardBin(HOUR_MS - 1)).toBe(HOUR_MS);
		expect(snapToStandardBin(HOUR_MS + 1)).toBe(2 * HOUR_MS);
	});

	it('snapToStandardBin: caps at max (365d)', () => {
		expect(snapToStandardBin(365 * DAY_MS)).toBe(365 * DAY_MS);
		expect(snapToStandardBin(1000 * DAY_MS)).toBe(365 * DAY_MS);
	});

	it('deriveBinMs: minimum is 1 minute (even for tiny ranges)', () => {
		// 1-second range, 1000px wide, 3 px/bin → nBins=333, rangeMs=1000, rangeMs/nBins=3ms
		// floor(max(1m, 3ms)) = 1m → snapped = 1m.
		expect(deriveBinMs(T['2024-01-01'], T['2024-01-01'] + 1, 3, 1000)).toBe(MINUTE_MS);
	});

	it('yearsIn: single year', () => {
		expect(yearsIn(T['2024-01-15'], T['2024-03-15'])).toEqual(['2024']);
	});

	it('yearsIn: spans 3 years', () => {
		expect(yearsIn(T['2023-06-01'], T['2025-01-01'])).toEqual(['2023', '2024', '2025']);
	});

	it('monthsIn: single month', () => {
		expect(monthsIn(T['2024-02-01'], T['2024-02-15'])).toEqual(['202402']);
	});

	it('monthsIn: spans year boundary', () => {
		expect(monthsIn(T['2023-12-15'], T['2024-02-15'])).toEqual(['202312', '202401', '202402']);
	});

	it('monthsInDashed: formats YYYY-MM', () => {
		expect(monthsInDashed(T['2024-01-01'], T['2024-03-01'])).toEqual([
			'2024-01', '2024-02', '2024-03',
		]);
	});

	it('ALL_REGIONS is [nyc, jc, hob]', () => {
		expect(ALL_REGIONS).toEqual(['nyc', 'jc', 'hob']);
	});
});
