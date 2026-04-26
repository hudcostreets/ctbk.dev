import { describe, expect, it } from 'vitest';
import {
	aggregateTotals,
	daysIn,
	parseTotalsParams,
	pickTripsAggTier,
	tripsAggKeys,
	tripsTotalsFallbackPaths,
	type TotalsParams,
} from './totals';

const T = {
	'2024-01-01': Date.UTC(2024, 0, 1) / 1000,
	'2024-01-02': Date.UTC(2024, 0, 2) / 1000,
	'2024-01-08': Date.UTC(2024, 0, 8) / 1000,
	'2024-02-01': Date.UTC(2024, 1, 1) / 1000,
	'2024-03-15': Date.UTC(2024, 2, 15) / 1000,
	'2025-01-01': Date.UTC(2025, 0, 1) / 1000,
	'2025-06-01': Date.UTC(2025, 5, 1) / 1000,
};

describe('parseTotalsParams', () => {
	const base = (extra: Record<string, string> = {}) =>
		new URLSearchParams({
			kind: 'trips',
			from: String(T['2024-01-01']),
			to: String(T['2024-02-01']),
			...extra,
		});

	it('parses minimal params with sensible defaults', () => {
		expect(parseTotalsParams(base())).toEqual({
			kind: 'trips',
			metric: 'count',
			fromS: T['2024-01-01'],
			toS: T['2024-02-01'],
			scope: 'stations',
			dims: [],
			filterShortName: undefined,
			filterRegion: undefined,
			filterSide: undefined,
		});
	});

	it('parses metric, scope, dims, filters', () => {
		expect(parseTotalsParams(base({
			metric: 'duration_s',
			scope: 'regions',
			dims: 'side,user_type',
			'filter.short_name': 'A,B,C',
			'filter.region': 'nyc,jc',
			'filter.side': 'start',
		}))).toEqual({
			kind: 'trips',
			metric: 'duration_s',
			fromS: T['2024-01-01'],
			toS: T['2024-02-01'],
			scope: 'regions',
			dims: ['side', 'user_type'],
			filterShortName: ['A', 'B', 'C'],
			filterRegion: ['nyc', 'jc'],
			filterSide: 'start',
		});
	});

	it('throws on invalid kind', () => {
		expect(() => parseTotalsParams(base({ kind: 'bogus' })))
			.toThrow(/kind must be/);
	});

	it('throws on invalid metric', () => {
		expect(() => parseTotalsParams(base({ metric: 'mean' })))
			.toThrow(/metric must be/);
	});

	it('throws on invalid scope', () => {
		expect(() => parseTotalsParams(base({ scope: 'cluster' })))
			.toThrow(/scope must be/);
	});

	it('throws on invalid dim for trips', () => {
		expect(() => parseTotalsParams(base({ dims: 'side,bogus' })))
			.toThrow(/invalid dim for trips: bogus/);
	});

	it('throws on invalid filter.region', () => {
		expect(() => parseTotalsParams(base({ 'filter.region': 'nyc,xyz' })))
			.toThrow(/invalid filter.region: xyz/);
	});

	it('throws on invalid filter.side', () => {
		expect(() => parseTotalsParams(base({ 'filter.side': 'middle' })))
			.toThrow(/filter.side must be/);
	});

	it('throws on invalid from/to (from > to)', () => {
		expect(() => parseTotalsParams(new URLSearchParams({
			kind: 'trips', from: '5', to: '4',
		}))).toThrow(/invalid from\/to/);
	});

	it('treats availability kind as parseable but allows arbitrary dims (per spec)', () => {
		// Availability dim allowlist is TBD pending histogram-schema EDA; for
		// now we just don't validate dim names for availability.
		const p = parseTotalsParams(base({ kind: 'availability', metric: 'count', dims: 'whatever' }));
		expect(p.kind).toBe('availability');
		expect(p.dims).toEqual(['whatever']);
	});
});

describe('pickTripsAggTier', () => {
	it('span >= 1 year → mo1', () => {
		expect(pickTripsAggTier(T['2024-01-01'], T['2025-01-01'])).toBe('mo1');
		expect(pickTripsAggTier(T['2024-01-01'], T['2025-06-01'])).toBe('mo1');
	});

	it('span >= 1 month but < 1 year → d1', () => {
		expect(pickTripsAggTier(T['2024-01-01'], T['2024-02-01'])).toBe('d1');
		expect(pickTripsAggTier(T['2024-01-01'], T['2024-03-15'])).toBe('d1');
	});

	it('span >= 1 day but < 1 month → h1', () => {
		expect(pickTripsAggTier(T['2024-01-01'], T['2024-01-02'])).toBe('h1');
		expect(pickTripsAggTier(T['2024-01-01'], T['2024-01-08'])).toBe('h1');
	});

	it('span < 1 day → null (caller falls back)', () => {
		expect(pickTripsAggTier(T['2024-01-01'], T['2024-01-01'] + 3600)).toBe(null);
		expect(pickTripsAggTier(T['2024-01-01'], T['2024-01-01'])).toBe(null);
	});
});

describe('tripsAggKeys', () => {
	it('mo1: yearly shards', () => {
		expect(tripsAggKeys('mo1', T['2024-01-01'], T['2025-06-01']))
			.toEqual(['trips/agg/mo1/2024.parquet', 'trips/agg/mo1/2025.parquet']);
	});

	it('d1: monthly shards', () => {
		expect(tripsAggKeys('d1', T['2024-01-01'], T['2024-03-15']))
			.toEqual([
				'trips/agg/d1/2024-01.parquet',
				'trips/agg/d1/2024-02.parquet',
				'trips/agg/d1/2024-03.parquet',
			]);
	});

	it('h1: daily shards', () => {
		expect(tripsAggKeys('h1', T['2024-01-01'], T['2024-01-02']))
			.toEqual(['trips/agg/h1/2024-01-01.parquet', 'trips/agg/h1/2024-01-02.parquet']);
	});
});

describe('daysIn', () => {
	it('single day window includes that day', () => {
		expect(daysIn(T['2024-01-01'], T['2024-01-01'])).toEqual(['2024-01-01']);
	});

	it('multi-day window includes all touched days', () => {
		expect(daysIn(T['2024-01-01'], T['2024-01-02'])).toEqual(['2024-01-01', '2024-01-02']);
	});
});

describe('tripsTotalsFallbackPaths', () => {
	const baseParams: TotalsParams = {
		kind: 'trips',
		metric: 'count',
		fromS: T['2024-01-01'],
		toS: T['2024-02-01'],
		scope: 'stations',
		dims: [],
	};

	it('scope=stations + filter.short_name → per-station files', () => {
		const r = tripsTotalsFallbackPaths({
			...baseParams,
			filterShortName: ['HB101', '6002.04'],
		});
		expect(r).toEqual({
			paths: ['trips/stations/HB101.parquet', 'trips/stations/6002.04.parquet'],
			tier: 'fallback-stations',
		});
	});

	it('scope=regions → per-region h1 yearly shards (default all regions)', () => {
		const r = tripsTotalsFallbackPaths({
			...baseParams,
			scope: 'regions',
		});
		expect(r).toEqual({
			paths: [
				'trips/region/nyc/h1/2024.parquet',
				'trips/region/jc/h1/2024.parquet',
				'trips/region/hob/h1/2024.parquet',
			],
			tier: 'fallback-regions',
		});
	});

	it('scope=all spans 2 years → 6 region/year shards', () => {
		const r = tripsTotalsFallbackPaths({
			...baseParams,
			scope: 'all',
			fromS: T['2024-01-01'],
			toS: T['2025-06-01'],
		});
		expect(r.tier).toBe('fallback-regions');
		expect(r.paths).toEqual([
			'trips/region/nyc/h1/2024.parquet',
			'trips/region/nyc/h1/2025.parquet',
			'trips/region/jc/h1/2024.parquet',
			'trips/region/jc/h1/2025.parquet',
			'trips/region/hob/h1/2024.parquet',
			'trips/region/hob/h1/2025.parquet',
		]);
	});
});

describe('aggregateTotals', () => {
	const baseParams: TotalsParams = {
		kind: 'trips',
		metric: 'count',
		fromS: T['2024-01-01'],
		toS: T['2024-02-01'],
		scope: 'stations',
		dims: [],
	};

	it('scope=stations, no dims, synthesizeCount=true → one row per station', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, short_name: 'A', duration_s: 50 },
			{ dt: T['2024-01-01'] + 180, short_name: 'B', duration_s: 200 },
		];
		const out = aggregateTotals(rows, baseParams, true);
		expect(out).toEqual([
			{ short_name: 'A', count: 2, duration_s: 150 },
			{ short_name: 'B', count: 1, duration_s: 200 },
		]);
	});

	it('scope=stations, dims=[side] → one row per (station, side)', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', side: 'start', duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, short_name: 'A', side: 'end', duration_s: 50 },
			{ dt: T['2024-01-01'] + 180, short_name: 'A', side: 'start', duration_s: 200 },
			{ dt: T['2024-01-01'] + 240, short_name: 'B', side: 'end', duration_s: 75 },
		];
		const out = aggregateTotals(rows, { ...baseParams, dims: ['side'] }, true);
		expect(out).toEqual([
			{ short_name: 'A', side: 'end', count: 1, duration_s: 50 },
			{ short_name: 'A', side: 'start', count: 2, duration_s: 300 },
			{ short_name: 'B', side: 'end', count: 1, duration_s: 75 },
		]);
	});

	it('scope=all, no dims → single ungrouped row', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, short_name: 'B', duration_s: 200 },
		];
		const out = aggregateTotals(rows, { ...baseParams, scope: 'all' }, true);
		expect(out).toEqual([{ count: 2, duration_s: 300 }]);
	});

	it('scope=regions → group by region', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, region: 'nyc', count: 5, duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, region: 'nyc', count: 3, duration_s: 50 },
			{ dt: T['2024-01-01'] + 180, region: 'jc', count: 2, duration_s: 75 },
		];
		const out = aggregateTotals(rows, { ...baseParams, scope: 'regions' }, false);
		expect(out).toEqual([
			{ region: 'jc', count: 2, duration_s: 75 },
			{ region: 'nyc', count: 8, duration_s: 150 },
		]);
	});

	it('drops rows outside [fromS, toS]', () => {
		const rows = [
			{ dt: T['2024-01-01'] - 1, short_name: 'A', duration_s: 999 },
			{ dt: T['2024-01-01'], short_name: 'A', duration_s: 10 },
			{ dt: T['2024-02-01'], short_name: 'A', duration_s: 20 },
			{ dt: T['2024-02-01'] + 1, short_name: 'A', duration_s: 999 },
		];
		const out = aggregateTotals(rows, baseParams, true);
		expect(out).toEqual([{ short_name: 'A', count: 2, duration_s: 30 }]);
	});

	it('filterShortName restricts to listed stations', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, short_name: 'B', duration_s: 50 },
			{ dt: T['2024-01-01'] + 180, short_name: 'C', duration_s: 200 },
		];
		const out = aggregateTotals(
			rows,
			{ ...baseParams, filterShortName: ['A', 'C'] },
			true,
		);
		expect(out).toEqual([
			{ short_name: 'A', count: 1, duration_s: 100 },
			{ short_name: 'C', count: 1, duration_s: 200 },
		]);
	});

	it('filterSide restricts to one side', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', side: 'start', duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, short_name: 'A', side: 'end', duration_s: 50 },
		];
		const out = aggregateTotals(
			rows,
			{ ...baseParams, filterSide: 'start' },
			true,
		);
		expect(out).toEqual([{ short_name: 'A', count: 1, duration_s: 100 }]);
	});

	it('synthesizeCount=false: sums explicit `count` (pre-agg shards)', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', count: 7, duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, short_name: 'A', count: 3, duration_s: 50 },
		];
		const out = aggregateTotals(rows, baseParams, false);
		expect(out).toEqual([{ short_name: 'A', count: 10, duration_s: 150 }]);
	});

	it('drops rows missing the scope key', () => {
		const rows = [
			{ dt: T['2024-01-01'] + 60, short_name: 'A', duration_s: 100 },
			{ dt: T['2024-01-01'] + 120, /* no short_name */ duration_s: 999 },
		];
		const out = aggregateTotals(rows, baseParams, true);
		expect(out).toEqual([{ short_name: 'A', count: 1, duration_s: 100 }]);
	});

	it('empty input → empty output', () => {
		expect(aggregateTotals([], baseParams, true)).toEqual([]);
	});
});
