import { describe, expect, it } from 'vitest';
import { parseCanonMap, selectLeaves } from './canon';

// Shapes from the real map: `6148.02` is a merged canonical that is itself a
// reported id (self-member kept); `4101.17` is an alias folded into `4101.18`
// that also has its own registry entry (so vocab covers can emit its leaf).
const MAP = parseCanonMap({
	's:6148.01': 'c:6148.02',
	's:6148.02': 'c:6148.02',
	's:4101.17': 'c:4101.18',
	's:4101.18': 'c:4101.18',
});

describe('parseCanonMap', () => {
	it('indexes members per canonical, in map order', () => {
		expect([...MAP.members]).toEqual([
			['c:6148.02', ['s:6148.01', 's:6148.02']],
			['c:4101.18', ['s:4101.17', 's:4101.18']],
		]);
	});
});

describe('selectLeaves', () => {
	const cover = ['89c25', 's:6148.02', 's:5000.01', 's:4101.17', 's:4101.18'];

	it('canonical: merged leaf → `c:` row; unmerged + S2 unchanged; alias dropped', () => {
		expect(selectLeaves(cover, MAP, 'canonical')).toEqual([
			'89c25', 'c:6148.02', 's:5000.01', 'c:4101.18',
		]);
	});

	it('raw: merged leaf → its members; unmerged + S2 unchanged; alias dropped', () => {
		expect(selectLeaves(cover, MAP, 'raw')).toEqual([
			'89c25', 's:6148.01', 's:6148.02', 's:5000.01', 's:4101.17', 's:4101.18',
		]);
	});

	it('an alias-only cover selects nothing (its rides live under its canonical)', () => {
		expect(selectLeaves(['s:4101.17'], MAP, 'canonical')).toEqual([]);
	});

	it('explicit `c:` terms pass through and dedupe against rewritten leaves', () => {
		expect(selectLeaves(['c:6148.02', 's:6148.02'], MAP, 'canonical')).toEqual(['c:6148.02']);
	});
});
