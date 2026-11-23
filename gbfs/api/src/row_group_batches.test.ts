import { describe, expect, it } from 'vitest';
import { rowGroupBatches } from './row_group_batches';

describe('rowGroupBatches', () => {
	it('packs whole row groups up to maxRows', () => {
		expect(rowGroupBatches([40, 40, 40, 10], 100)).toEqual([
			{ rowStart: 0, rowEnd: 80 },
			{ rowStart: 80, rowEnd: 130 },
		]);
	});
	it('gives an oversized row group its own range', () => {
		expect(rowGroupBatches([10, 500, 10], 100)).toEqual([
			{ rowStart: 0, rowEnd: 10 },
			{ rowStart: 10, rowEnd: 510 },
			{ rowStart: 510, rowEnd: 520 },
		]);
	});
	it('handles no row groups', () => {
		expect(rowGroupBatches([], 100)).toEqual([]);
	});
});
