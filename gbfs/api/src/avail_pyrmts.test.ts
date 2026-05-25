import { describe, expect, it } from 'vitest';
import { applyReducer, availWatermarks, pivotPerMetric } from './avail_pyrmts';
import type { Row } from 'pyrmts';

describe('pivotPerMetric', () => {
	it('collapses tall rows per (dt_ms, station_id) with all 5 metrics inline', () => {
		// Two stations, one minute-bucket, 3 metrics × 2 states each (bikes, docks, ebikes).
		// Other metrics absent → no column emitted for them.
		const dt_s = 1779404400;  // 2026-05-21T23:00:00Z
		const tall: Row[] = [
			{ dt: dt_s, station_id: 'A', metric: 'bikes', state: 5, minutes: 30 },
			{ dt: dt_s, station_id: 'A', metric: 'bikes', state: 7, minutes: 30 },
			{ dt: dt_s, station_id: 'A', metric: 'docks', state: 3, minutes: 60 },
			{ dt: dt_s, station_id: 'A', metric: 'ebikes', state: 0, minutes: 60 },
			{ dt: dt_s, station_id: 'B', metric: 'bikes', state: 10, minutes: 60 },
		];
		const wide = pivotPerMetric(tall);
		// Sort by station_id for deterministic comparison.
		wide.sort((a, b) => (a.station_id as string).localeCompare(b.station_id as string));
		expect(wide).toEqual([
			{
				dt_ms: dt_s * 1000,
				station_id: 'A',
				bikes: { '5': 30, '7': 30 },
				docks: { '3': 60 },
				ebikes: { '0': 60 },
			},
			{
				dt_ms: dt_s * 1000,
				station_id: 'B',
				bikes: { '10': 60 },
			},
		]);
	});

	it('sums duplicate (dt, station, metric, state) rows within a group', () => {
		const tall: Row[] = [
			{ dt: 1000, station_id: 'A', metric: 'bikes', state: 5, minutes: 10 },
			{ dt: 1000, station_id: 'A', metric: 'bikes', state: 5, minutes: 7 },
		];
		expect(pivotPerMetric(tall)).toEqual([
			{ dt_ms: 1_000_000, station_id: 'A', bikes: { '5': 17 } },
		]);
	});

	it('returns empty array for empty input', () => {
		expect(pivotPerMetric([])).toEqual([]);
	});
});

describe('applyReducer', () => {
	const dt_ms = 1779404400_000;
	const stitchedOneRow = (hist: Record<string, number>): Row[] => [
		{ dt_ms, station_id: 'A', bikes: hist },
	];

	it('mean: weighted average of states by minutes', () => {
		// 30 min at 5 + 30 min at 7 → mean = 6
		const out = applyReducer(stitchedOneRow({ '5': 30, '7': 30 }), 'bikes', 'mean');
		expect(out).toEqual([{ dt: 1779404400, station_id: 'A', value: 6 }]);
	});

	it('min: lowest state with nonzero minutes', () => {
		const out = applyReducer(stitchedOneRow({ '3': 0, '5': 10, '7': 5 }), 'bikes', 'min');
		expect(out).toEqual([{ dt: 1779404400, station_id: 'A', value: 5 }]);
	});

	it('max: highest state with nonzero minutes', () => {
		const out = applyReducer(stitchedOneRow({ '3': 10, '5': 5, '10': 0 }), 'bikes', 'max');
		expect(out).toEqual([{ dt: 1779404400, station_id: 'A', value: 5 }]);
	});

	it('p50: median state — matches legacy `availHistQuantile`', () => {
		// Note: legacy's R-7 impl has a quirk at exact bucket-boundary targets
		// (target = 4.5 with 5-weight buckets falls through iter 0's
		// `target ≤ next-1` check and lands in iter 1, returning state[1]).
		// The port reproduces this faithfully for byte-equal shadow-mode parity.
		// (Open issue: separate spec / fix once the port is verified.)
		const out = applyReducer(stitchedOneRow({ '0': 5, '10': 5 }), 'bikes', 'p50');
		expect(out[0]!.value).toBe(10);
	});

	it('p50: interior state with clean cumulative-weight straddle', () => {
		// 3 mins at 0, 4 mins at 5, 3 mins at 10. total=10, target=4.5.
		// iter 0: cum=0, next=3. 4.5 ≤ 2 = false.
		// iter 1: cum=3, next=7. 4.5 ≤ 6 = true. frac=0.5, 4.5 < 6 → return state 5.
		const out = applyReducer(stitchedOneRow({ '0': 3, '5': 4, '10': 3 }), 'bikes', 'p50');
		expect(out[0]!.value).toBe(5);
	});

	it('p95: high-percentile state', () => {
		// 100 min at 5, 1 min at 50 → target = 0.95 * 100 = 95
		// cum: [100, 101]. 95 ≤ 100-1=99 → answer = 5.
		const out = applyReducer(stitchedOneRow({ '5': 100, '50': 1 }), 'bikes', 'p95');
		expect(out[0]!.value).toBe(5);
	});

	it('hist: passes histogram through as-is', () => {
		const hist = { '3': 10, '7': 20 };
		const out = applyReducer(stitchedOneRow(hist), 'bikes', 'hist');
		expect(out).toEqual([{ dt: 1779404400, station_id: 'A', value: hist }]);
	});

	it('mean over empty histogram returns null', () => {
		const out = applyReducer([{ dt_ms, station_id: 'A', bikes: {} }], 'bikes', 'mean');
		expect(out).toEqual([{ dt: 1779404400, station_id: 'A', value: null }]);
	});

	it('min over all-zero histogram returns null (no nonzero state)', () => {
		const out = applyReducer(stitchedOneRow({ '5': 0, '7': 0 }), 'bikes', 'min');
		expect(out).toEqual([{ dt: 1779404400, station_id: 'A', value: null }]);
	});

	it('preserves dt and station_id per row', () => {
		const rows: Row[] = [
			{ dt_ms: 1000, station_id: 'A', bikes: { '5': 1 } },
			{ dt_ms: 2000, station_id: 'B', bikes: { '7': 1 } },
		];
		expect(applyReducer(rows, 'bikes', 'mean')).toEqual([
			{ dt: 1, station_id: 'A', value: 5 },
			{ dt: 2, station_id: 'B', value: 7 },
		]);
	});
});

describe('availWatermarks', () => {
	it('h1 = UTC midnight; d1 = start of current UTC month; mo1 = start of current UTC year', () => {
		const now = new Date(Date.UTC(2026, 4, 24, 19, 36, 12));  // 2026-05-24T19:36:12Z
		const wm = availWatermarks(now);
		expect(wm.h1).toEqual(new Date(Date.UTC(2026, 4, 24)));
		expect(wm.d1).toEqual(new Date(Date.UTC(2026, 4, 1)));
		expect(wm.mo1).toEqual(new Date(Date.UTC(2026, 0, 1)));
	});
});
