import { describe, test, expect } from 'vitest';
import {
	transformMinuteRows,
	mergeRows,
	sortRows,
	type AvailV3Row,
} from './transform';
import type { LucIndex } from './luc';

// Minimal LUC index for tests. Two stations:
//   A: chain at L10..L12 (3 cells)
//   B: chain at L10..L15 (6 cells), overlapping with A at L10
const TEST_LUC: LucIndex = {
	chains: new Map([
		['A', ['c10', 'c11', 'c12']],
		['B', ['c10', 'c11_b', 'c12_b', 'c13_b', 'c14_b', 'c15_b']],
	]),
};

const DT_15_00 = 1782574800000n;  // 2026-06-27T15:00:00.000Z in ms

/** Build a raw 1m@1m row (with `dt` in SECONDS per loader convention). */
function rawRow(stationId: string, dtSec: bigint, metrics: Record<string, number>): Record<string, unknown> {
	const row: Record<string, unknown> = { station_id: stationId, dt: dtSec };
	for (const [m, v] of Object.entries(metrics)) {
		row[`${m}_n`] = 1;
		row[`${m}_sum`] = v;
		row[`${m}_sum_sq`] = v * v;
	}
	return row;
}

describe('transformMinuteRows', () => {
	test('emits row per (s2_cell, dt) for each station × chain × minute', () => {
		// One station A at one minute → emits 3 rows (one per chain cell).
		const out = transformMinuteRows(
			[rawRow('A', DT_15_00 / 1000n, { bikes: 7, ebikes: 2, docks: 5, disabled: 1, pending: 0 })],
			TEST_LUC,
		);
		expect(sortRows(out)).toEqual([
			{ s2_cell: 'c10', dt: DT_15_00, bikes: '{"7":1}', ebikes: '{"2":1}', docks: '{"5":1}', disabled: '{"1":1}', pending: '{"0":1}' },
			{ s2_cell: 'c11', dt: DT_15_00, bikes: '{"7":1}', ebikes: '{"2":1}', docks: '{"5":1}', disabled: '{"1":1}', pending: '{"0":1}' },
			{ s2_cell: 'c12', dt: DT_15_00, bikes: '{"7":1}', ebikes: '{"2":1}', docks: '{"5":1}', disabled: '{"1":1}', pending: '{"0":1}' },
		]);
	});

	test('converts dt from seconds to milliseconds', () => {
		const out = transformMinuteRows(
			[rawRow('A', 1782574800n, { bikes: 1 })],
			TEST_LUC,
		);
		expect(out[0]!.dt).toBe(1782574800000n);
	});

	test('aggregates multiple stations at the same shared cell (L10)', () => {
		// Both A and B share `c10`. With different bike counts.
		const out = transformMinuteRows(
			[
				rawRow('A', DT_15_00 / 1000n, { bikes: 7 }),
				rawRow('B', DT_15_00 / 1000n, { bikes: 12 }),
			],
			TEST_LUC,
		);
		const atC10 = out.filter((r) => r.s2_cell === 'c10');
		expect(atC10).toHaveLength(1);
		expect(atC10[0]!.bikes).toBe('{"7":1,"12":1}');
	});

	test('aggregates same-value reports as count > 1', () => {
		// Both A and B report bikes=5. At c10 (shared), histogram is {5: 2}.
		const out = transformMinuteRows(
			[
				rawRow('A', DT_15_00 / 1000n, { bikes: 5 }),
				rawRow('B', DT_15_00 / 1000n, { bikes: 5 }),
			],
			TEST_LUC,
		);
		const atC10 = out.find((r) => r.s2_cell === 'c10');
		expect(atC10?.bikes).toBe('{"5":2}');
	});

	test('skips unknown station_id (not in LUC)', () => {
		const out = transformMinuteRows(
			[rawRow('UNKNOWN', DT_15_00 / 1000n, { bikes: 7 })],
			TEST_LUC,
		);
		expect(out).toEqual([]);
	});

	test('skips rows with null/missing metrics', () => {
		const row: Record<string, unknown> = { station_id: 'A', dt: DT_15_00 / 1000n };
		// All metrics null/zero → no output.
		row.bikes_n = 0;
		row.bikes_sum = null;
		const out = transformMinuteRows([row], TEST_LUC);
		expect(out).toEqual([]);
	});

	test('keeps rows where SOME metrics are reported', () => {
		const row: Record<string, unknown> = { station_id: 'A', dt: DT_15_00 / 1000n };
		row.bikes_n = 1;
		row.bikes_sum = 5;
		row.ebikes_n = 0;
		row.ebikes_sum = null;
		// docks/disabled/pending all missing → those histograms stay empty
		const out = transformMinuteRows([row], TEST_LUC);
		expect(out[0]!.bikes).toBe('{"5":1}');
		expect(out[0]!.ebikes).toBe('{}');
		expect(out[0]!.docks).toBe('{}');
	});

	test('produces stable JSON key ordering (smallest first)', () => {
		// Three stations at the same cell, different values, out of order.
		const TEST_LUC_3: LucIndex = {
			chains: new Map([
				['A', ['c10']],
				['B', ['c10']],
				['C', ['c10']],
			]),
		};
		const out = transformMinuteRows(
			[
				rawRow('C', DT_15_00 / 1000n, { bikes: 15 }),
				rawRow('A', DT_15_00 / 1000n, { bikes: 3 }),
				rawRow('B', DT_15_00 / 1000n, { bikes: 7 }),
			],
			TEST_LUC_3,
		);
		expect(out[0]!.bikes).toBe('{"3":1,"7":1,"15":1}');
	});
});

describe('mergeRows', () => {
	test('sums histograms across input row sets at same (cell, dt)', () => {
		const set1: AvailV3Row[] = [{
			s2_cell: 'c10', dt: DT_15_00,
			bikes: '{"7":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}',
		}];
		const set2: AvailV3Row[] = [{
			s2_cell: 'c10', dt: DT_15_00,
			bikes: '{"7":1,"12":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}',
		}];
		const merged = mergeRows([set1, set2]);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.bikes).toBe('{"7":2,"12":1}');
	});

	test('preserves distinct (cell, dt) rows independently', () => {
		const set1: AvailV3Row[] = [
			{ s2_cell: 'c10', dt: DT_15_00,        bikes: '{"7":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
			{ s2_cell: 'c11', dt: DT_15_00,        bikes: '{"3":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
			{ s2_cell: 'c10', dt: DT_15_00 + 60000n, bikes: '{"5":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
		];
		const merged = sortRows(mergeRows([set1]));
		expect(merged).toHaveLength(3);
		expect(merged.map(r => [r.s2_cell, r.dt, r.bikes])).toEqual([
			['c10', DT_15_00, '{"7":1}'],
			['c10', DT_15_00 + 60000n, '{"5":1}'],
			['c11', DT_15_00, '{"3":1}'],
		]);
	});

	test('fast-path: non-overlapping inputs return input rows verbatim (no JSON round-trip)', () => {
		// In cadence cascades (e.g. /p3h reading 3× /p1h covering disjoint
		// hours), every (cell, dt) bucket has exactly one contributor. The
		// merged output must be referentially equal to the input rows — the
		// JSON parse/serialize round-trip is what was timing out the CFW
		// for /p3h before this fast path landed.
		const set1: AvailV3Row[] = [{
			s2_cell: 'c10', dt: DT_15_00,
			bikes: '{"7":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}',
		}];
		const set2: AvailV3Row[] = [{
			s2_cell: 'c10', dt: DT_15_00 + 3600_000n,  // 1h later — disjoint
			bikes: '{"8":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}',
		}];
		const set3: AvailV3Row[] = [{
			s2_cell: 'c10', dt: DT_15_00 + 7200_000n,  // 2h later — disjoint
			bikes: '{"9":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}',
		}];
		const merged = mergeRows([set1, set2, set3]);
		expect(merged).toHaveLength(3);
		// Critical: each output row is the SAME object as the input row
		// (no copy, no JSON parse, no Map round-trip).
		const byDt = new Map(merged.map((r) => [r.dt, r]));
		expect(byDt.get(DT_15_00)).toBe(set1[0]);
		expect(byDt.get(DT_15_00 + 3600_000n)).toBe(set2[0]);
		expect(byDt.get(DT_15_00 + 7200_000n)).toBe(set3[0]);
	});

	test('mixed: some buckets single-contributor, some multi', () => {
		// Validates that the lazy-promote logic correctly routes per-bucket:
		// (c10, T0) sees 2 contributors → slow path. (c11, T0) sees 1 → fast.
		const set1: AvailV3Row[] = [
			{ s2_cell: 'c10', dt: DT_15_00, bikes: '{"7":1}',  ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
			{ s2_cell: 'c11', dt: DT_15_00, bikes: '{"3":1}',  ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
		];
		const set2: AvailV3Row[] = [
			{ s2_cell: 'c10', dt: DT_15_00, bikes: '{"7":1,"12":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
		];
		const merged = sortRows(mergeRows([set1, set2]));
		expect(merged).toHaveLength(2);
		const c10 = merged.find((r) => r.s2_cell === 'c10')!;
		const c11 = merged.find((r) => r.s2_cell === 'c11')!;
		// c10: 2 contributors → summed
		expect(c10.bikes).toBe('{"7":2,"12":1}');
		// c11: 1 contributor → fast path returns input row verbatim
		expect(c11).toBe(set1[1]);
	});

	test('re-bins dt when binMs is provided', () => {
		const set: AvailV3Row[] = [
			{ s2_cell: 'c10', dt: DT_15_00,              bikes: '{"7":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
			{ s2_cell: 'c10', dt: DT_15_00 + 60_000n,    bikes: '{"8":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
			{ s2_cell: 'c10', dt: DT_15_00 + 120_000n,   bikes: '{"9":1}', ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}' },
		];
		// Rebin to 2m bins. Minutes 15:00 + 15:01 fall into 2m bucket
		// starting at 15:00 (since 15:00 = 14:00 + 60min = floor to 2min
		// boundary is 15:00). Minute 15:02 falls into next bucket at
		// 15:02. Resulting buckets:
		//   15:00 bucket (60-sec) → contains rows from 15:00 + 15:01 (sum)
		//   15:02 bucket → contains 15:02
		// Wait — 2m bin means span = 120_000ms. Bin start = (dt) - (dt % 120_000).
		// For dt = 15:00 = 0 mod 2min → bucket = 15:00.
		// For dt = 15:01 → 15:01 - 60_000 mod 120_000 = 60_000, bucket = 15:00.
		// For dt = 15:02 → bucket = 15:02.
		const merged = sortRows(mergeRows([set], 120_000n));
		expect(merged).toHaveLength(2);
		expect(merged[0]!.dt).toBe(DT_15_00);              // 15:00 bucket
		expect(merged[0]!.bikes).toBe('{"7":1,"8":1}');    // 15:00 + 15:01
		expect(merged[1]!.dt).toBe(DT_15_00 + 120_000n);   // 15:02 bucket
		expect(merged[1]!.bikes).toBe('{"9":1}');          // 15:02 alone
	});
});

describe('sortRows', () => {
	test('sorts ascending by (s2_cell, dt)', () => {
		const rows: AvailV3Row[] = [
			{ s2_cell: 'c11', dt: 1n, bikes: '', ebikes: '', docks: '', disabled: '', pending: '' },
			{ s2_cell: 'c10', dt: 2n, bikes: '', ebikes: '', docks: '', disabled: '', pending: '' },
			{ s2_cell: 'c10', dt: 1n, bikes: '', ebikes: '', docks: '', disabled: '', pending: '' },
		];
		expect(sortRows(rows).map((r) => [r.s2_cell, r.dt])).toEqual([
			['c10', 1n],
			['c10', 2n],
			['c11', 1n],
		]);
	});
});
