import { describe, test, expect } from 'vitest';
import { buildChains, COARSEST_LEVEL, FINEST_LEVEL } from './luc';

// Test data shaped like real `gbfs/station-luc.json` (subset of fields
// the chain builder needs):
//   - L15-anchored station: chain length 6 (L10..L15)
//   - L13-anchored station: chain length 4 (L10..L13)
//   - L10-anchored station: chain length 1 (L10 only)
const SAMPLE_LUC = {
	by_short_name: {
		'A.01': { cell: '89c25852c', level: 15, lat: 40.7508, lng: -73.9869, uuid: 'uuid-A' },
		'B.01': { cell: '89c2585',  level: 13, lat: 40.7421, lng: -74.0048, uuid: 'uuid-B' },
		'C.01': { cell: '89c258',   level: 10, lat: 40.7,    lng: -73.95,   uuid: 'uuid-C' },
	},
	by_uuid: {
		'uuid-A': 'A.01',
		'uuid-B': 'B.01',
		'uuid-C': 'C.01',
	},
};

describe('buildChains', () => {
	test('produces a chain entry per uuid', () => {
		const idx = buildChains(SAMPLE_LUC);
		expect(idx.chains.size).toBe(3);
		expect(idx.chains.has('uuid-A')).toBe(true);
		expect(idx.chains.has('uuid-B')).toBe(true);
		expect(idx.chains.has('uuid-C')).toBe(true);
	});

	test('chain length matches LUC level — coarsest..LUC inclusive', () => {
		const idx = buildChains(SAMPLE_LUC);
		// L15 station: cells at L10..L15 = 6 levels
		expect(idx.chains.get('uuid-A')).toHaveLength(FINEST_LEVEL - COARSEST_LEVEL + 1);
		// L13 station: L10..L13 = 4 levels
		expect(idx.chains.get('uuid-B')).toHaveLength(13 - COARSEST_LEVEL + 1);
		// L10 station: only L10 itself (the LUC anchor)
		expect(idx.chains.get('uuid-C')).toHaveLength(1);
	});

	test('chain ends with the stored LUC anchor cell', () => {
		const idx = buildChains(SAMPLE_LUC);
		expect(idx.chains.get('uuid-A')!.at(-1)).toBe('89c25852c');
		expect(idx.chains.get('uuid-B')!.at(-1)).toBe('89c2585');
		expect(idx.chains.get('uuid-C')!.at(-1)).toBe('89c258');
	});

	test('skips uuids whose short_name is absent from by_short_name', () => {
		const corrupted = {
			by_short_name: { 'A.01': SAMPLE_LUC.by_short_name['A.01'] },
			by_uuid: { 'uuid-A': 'A.01', 'uuid-ghost': 'A.99-missing' },
		};
		const idx = buildChains(corrupted);
		expect(idx.chains.size).toBe(1);
		expect(idx.chains.has('uuid-ghost')).toBe(false);
	});

	test('computed S2 cells at intermediate levels are non-empty strings', () => {
		const idx = buildChains(SAMPLE_LUC);
		const chainA = idx.chains.get('uuid-A')!;
		// All 6 cells should be hex tokens (non-empty strings).
		for (const cell of chainA) {
			expect(cell).toMatch(/^[0-9a-f]+$/);
			expect(cell.length).toBeGreaterThan(0);
		}
	});
});
