import { describe, expect, it } from 'vitest';
import {
	aggregateAvailTotals,
	aggregateTotals,
	availAggKeys,
	availHistQuantile,
	daysIn,
	parseTotalsParams,
	pickAvailAggTier,
	pickTripsAggTier,
	tripsAggKeys,
	tripsTotalsFallbackPaths,
	type AvailHistRow,
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
			filterStationId: undefined,
			filterRegion: undefined,
			filterSide: undefined,
			availAgg: undefined,
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
			filterStationId: undefined,
			filterRegion: ['nyc', 'jc'],
			filterSide: 'start',
			availAgg: undefined,
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
		// Availability dim allowlist is TBD; for now we don't validate dim
		// names for availability (the histogram aggregator just ignores
		// unknown dims at group time).
		const p = parseTotalsParams(base({ kind: 'availability', metric: 'bikes', dims: 'whatever' }));
		expect(p.kind).toBe('availability');
		expect(p.metric).toBe('bikes');
		expect(p.dims).toEqual(['whatever']);
	});

	it('availability requires a valid AvailMetric', () => {
		expect(() => parseTotalsParams(base({ kind: 'availability', metric: 'count' })))
			.toThrow(/metric must be one of/);
	});

	it('availability defaults metric to "bikes" if omitted', () => {
		const params = base({ kind: 'availability' });
		params.delete('metric');
		const p = parseTotalsParams(params);
		expect(p.metric).toBe('bikes');
		expect(p.availAgg).toBe('mean');
	});

	it('availability accepts agg= reducer', () => {
		const p = parseTotalsParams(base({ kind: 'availability', metric: 'docks', agg: 'p50' }));
		expect(p.availAgg).toBe('p50');
	});

	it('availability rejects unknown agg= reducer', () => {
		expect(() => parseTotalsParams(base({ kind: 'availability', metric: 'docks', agg: 'median' })))
			.toThrow(/agg must be one of/);
	});

	it('rejects agg= for kind=trips', () => {
		expect(() => parseTotalsParams(base({ kind: 'trips', agg: 'mean' })))
			.toThrow(/agg= is only valid for kind=availability/);
	});

	it('parses filter.station_id (UUIDs) for availability', () => {
		const p = parseTotalsParams(base({
			kind: 'availability', metric: 'bikes',
			'filter.station_id': 'uuid-1,uuid-2',
		}));
		expect(p.filterStationId).toEqual(['uuid-1', 'uuid-2']);
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

describe('availability: pickAvailAggTier', () => {
	it('span >= 1 year → mo1', () => {
		expect(pickAvailAggTier(T['2024-01-01'], T['2025-01-01'])).toBe('mo1');
	});
	it('span >= 1 month → d1', () => {
		expect(pickAvailAggTier(T['2024-01-01'], T['2024-02-01'])).toBe('d1');
	});
	it('span < 1 month → h1 (no n0/raw fallback for totals)', () => {
		expect(pickAvailAggTier(T['2024-01-01'], T['2024-01-08'])).toBe('h1');
		expect(pickAvailAggTier(T['2024-01-01'], T['2024-01-01'] + 3600)).toBe('h1');
	});
});

describe('availability: availAggKeys', () => {
	it('mo1 → years', () => {
		expect(availAggKeys('mo1', T['2024-01-01'], T['2025-06-01'])).toEqual([
			'avail/agg/mo1/2024.parquet',
			'avail/agg/mo1/2025.parquet',
		]);
	});
	it('d1 → YYYY-MM months', () => {
		expect(availAggKeys('d1', T['2024-01-01'], T['2024-03-15'])).toEqual([
			'avail/agg/d1/2024-01.parquet',
			'avail/agg/d1/2024-02.parquet',
			'avail/agg/d1/2024-03.parquet',
		]);
	});
	it('h1 → YYYY-MM-DD days', () => {
		expect(availAggKeys('h1', T['2024-01-01'], T['2024-01-02'])).toEqual([
			'avail/agg/h1/2024-01-01.parquet',
			'avail/agg/h1/2024-01-02.parquet',
		]);
	});
});

describe('availHistQuantile', () => {
	it('single state → returns that state for any p', () => {
		expect(availHistQuantile([5], [100], 0)).toBe(5);
		expect(availHistQuantile([5], [100], 0.5)).toBe(5);
		expect(availHistQuantile([5], [100], 1)).toBe(5);
	});
	it('uniform two-state histogram', () => {
		// 50 minutes at state=2, 50 at state=8 → median is 2 (lower of the
		// 50th-percentile sample boundary, since linear-interp lands at the
		// boundary state).
		const states = [2, 8], weights = [50, 50];
		expect(availHistQuantile(states, weights, 0)).toBe(2);
		expect(availHistQuantile(states, weights, 0.49)).toBe(2);
		expect(availHistQuantile(states, weights, 1)).toBe(8);
	});
	it('matches direct quantile from sample-expanded array', () => {
		// 3 states with different weights — verify against numpy-equivalent.
		const states = [0, 5, 10], weights = [10, 30, 60];
		// Expand to 100 samples: [0]*10 + [5]*30 + [10]*60.
		// p25 → 25th sample (0-indexed: 24) → 5 (since samples 0-9 are 0,
		// 10-39 are 5, 40-99 are 10).
		expect(availHistQuantile(states, weights, 0.25)).toBe(5);
		expect(availHistQuantile(states, weights, 0.5)).toBe(10);
		expect(availHistQuantile(states, weights, 0.95)).toBe(10);
	});
	it('throws on empty', () => {
		expect(() => availHistQuantile([], [], 0.5)).toThrow();
	});
});

describe('aggregateAvailTotals', () => {
	const T0 = T['2024-01-01'];
	const baseAvailParams: TotalsParams = {
		kind: 'availability', metric: 'bikes',
		fromS: T0, toS: T0 + 86400,
		scope: 'stations', dims: [],
		availAgg: 'mean',
	};

	it('mean: weighted average across (station, state, minutes) histogram', () => {
		const rows: AvailHistRow[] = [
			{ dt: T0,        station_id: 'S1', metric: 'bikes', state: 0, minutes: 30 },
			{ dt: T0,        station_id: 'S1', metric: 'bikes', state: 5, minutes: 30 },
			{ dt: T0 + 3600, station_id: 'S1', metric: 'bikes', state: 5, minutes: 60 },
			// other-metric row should be ignored
			{ dt: T0,        station_id: 'S1', metric: 'docks', state: 99, minutes: 60 },
		];
		const out = aggregateAvailTotals(rows, baseAvailParams);
		// Total bikes minutes for S1: 30 + 30 + 60 = 120.
		// Weighted state-mean: (0*30 + 5*30 + 5*60)/120 = 450/120 = 3.75
		expect(out).toEqual([{ station_id: 'S1', sample_count: 120, mean: 3.75 }]);
	});

	it('hist reducer: returns merged sparse histogram', () => {
		const rows: AvailHistRow[] = [
			{ dt: T0, station_id: 'S1', metric: 'bikes', state: 0, minutes: 10 },
			{ dt: T0, station_id: 'S1', metric: 'bikes', state: 3, minutes: 5 },
			{ dt: T0 + 3600, station_id: 'S1', metric: 'bikes', state: 3, minutes: 7 },
		];
		const out = aggregateAvailTotals(rows, { ...baseAvailParams, availAgg: 'hist' });
		expect(out).toEqual([{
			station_id: 'S1', sample_count: 22,
			hist: [{ state: 0, minutes: 10 }, { state: 3, minutes: 12 }],
		}]);
	});

	it('min/max reducers', () => {
		const rows: AvailHistRow[] = [
			{ dt: T0, station_id: 'S1', metric: 'bikes', state: 1, minutes: 20 },
			{ dt: T0, station_id: 'S1', metric: 'bikes', state: 8, minutes: 40 },
		];
		expect(aggregateAvailTotals(rows, { ...baseAvailParams, availAgg: 'min' }))
			.toEqual([{ station_id: 'S1', sample_count: 60, min: 1 }]);
		expect(aggregateAvailTotals(rows, { ...baseAvailParams, availAgg: 'max' }))
			.toEqual([{ station_id: 'S1', sample_count: 60, max: 8 }]);
	});

	it('scope=all collapses all stations into one bucket', () => {
		const rows: AvailHistRow[] = [
			{ dt: T0, station_id: 'S1', metric: 'bikes', state: 0, minutes: 60 },
			{ dt: T0, station_id: 'S2', metric: 'bikes', state: 10, minutes: 60 },
		];
		const out = aggregateAvailTotals(rows, { ...baseAvailParams, scope: 'all' });
		// Mean across 60+60 minutes weighted by state: (0*60 + 10*60)/120 = 5
		expect(out).toEqual([{ sample_count: 120, mean: 5 }]);
	});

	it('filter.station_id restricts to listed UUIDs', () => {
		const rows: AvailHistRow[] = [
			{ dt: T0, station_id: 'S1', metric: 'bikes', state: 5, minutes: 60 },
			{ dt: T0, station_id: 'S2', metric: 'bikes', state: 9, minutes: 60 },
		];
		const out = aggregateAvailTotals(rows, {
			...baseAvailParams,
			filterStationId: ['S2'],
		});
		expect(out).toEqual([{ station_id: 'S2', sample_count: 60, mean: 9 }]);
	});

	it('drops rows outside [fromS, toS]', () => {
		const rows: AvailHistRow[] = [
			{ dt: T0 - 60, station_id: 'S1', metric: 'bikes', state: 99, minutes: 1 },
			{ dt: T0,      station_id: 'S1', metric: 'bikes', state: 5,  minutes: 60 },
			{ dt: T0 + 86401, station_id: 'S1', metric: 'bikes', state: 88, minutes: 1 },
		];
		const out = aggregateAvailTotals(rows, baseAvailParams);
		expect(out).toEqual([{ station_id: 'S1', sample_count: 60, mean: 5 }]);
	});

	it('empty input → empty output', () => {
		expect(aggregateAvailTotals([], baseAvailParams)).toEqual([]);
	});
});
