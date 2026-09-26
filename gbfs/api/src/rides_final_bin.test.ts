import { describe, expect, it } from 'vitest';
import type { RecordedShard } from 'pyrmts';
import { planGeoQueryFromInventory } from 'pyrmts-geo';
import { RIDES, ridesV5Pyramid, V5_TIERS } from './rides_v1';

/** The live `rides-start` `1mo`-tier inventory (D1 `pyramid_shards`,
 *  2026-09-26): one closed 16y/8y/2y shard per era + per-month shards for
 *  the open year. */
const row = (shardDur: string, from: string, to: string, key: string): RecordedShard => ({
	tier: '1mo',
	shardDur: shardDur as RecordedShard['shardDur'],
	periodStart: new Date(from),
	periodEnd: new Date(to),
	key,
});
const INVENTORY: RecordedShard[] = [
	row('16y', '2000-01-01', '2016-01-01', 'rides/start/1mo/16y/2000.9d74fed5cdb1.parquet'),
	row('8y', '2016-01-01', '2024-01-01', 'rides/start/1mo/8y/2016.7307fdc9a75b.parquet'),
	row('2y', '2024-01-01', '2026-01-01', 'rides/start/1mo/2y/2024.a7d4c4d612c5.parquet'),
	row('1mo', '2026-01-01', '2026-02-01', 'rides/start/1mo/1mo/2026-01.cbbcfc3be09f.parquet'),
	row('1mo', '2026-02-01', '2026-03-01', 'rides/start/1mo/1mo/2026-02.ba055ab58dd8.parquet'),
	row('1mo', '2026-03-01', '2026-04-01', 'rides/start/1mo/1mo/2026-03.a3610fb5903c.parquet'),
];

const pyramid = ridesV5Pyramid({} as R2Bucket, RIDES, 'start', false);

/** Plan a `bin=1mo` query over `[from, to)`; return the covered span and
 *  the number of monthly bins it yields. */
function plan(from: string, to: string) {
	const p = planGeoQueryFromInventory(
		pyramid,
		{
			range: { from: new Date(from), to: new Date(to) },
			binBudget: 1024,
			outputCells: { res: -1, cells: ['c:4452.01'] },
			targetBin: '1mo',
			limits: { maxOutputBins: 2048, maxAtoms: 512, maxKeys: 128 },
		},
		INVENTORY,
	);
	return {
		atomCount: p.atomCount,
		segments: p.segments.map((s) => ({ from: s.from.toISOString().slice(0, 10), to: s.to.toISOString().slice(0, 10), keys: s.keys })),
	};
}

// `to` is exclusive: a monthly `[from, to)` query must include the bin that
// ends at `to`. Prod dropped exactly that last bin for every rides query
// until ~2026-09-26 14:00Z (e.g. `to=2025-07-01` stopped at 2025-06-01).
describe('rides: half-open ranges include the final full bin', () => {
	it('mid-shard end (the 2y 2024 shard)', () => {
		expect(plan('2024-01-01', '2025-07-01')).toEqual({
			atomCount: 18,
			segments: [{ from: '2024-01-01', to: '2025-07-01', keys: ['rides/start/1mo/2y/2024.a7d4c4d612c5.parquet'] }],
		});
	});

	it('end at a shard boundary (16y shard ends 2016-01-01)', () => {
		expect(plan('2013-06-01', '2016-01-01')).toEqual({
			atomCount: 31,
			segments: [{ from: '2013-06-01', to: '2016-01-01', keys: ['rides/start/1mo/16y/2000.9d74fed5cdb1.parquet'] }],
		});
	});

	it('end inside the per-month shards of the open year', () => {
		expect(plan('2025-11-01', '2026-03-01')).toEqual({
			atomCount: 4,
			segments: [{
				from: '2025-11-01',
				to: '2026-03-01',
				keys: [
					'rides/start/1mo/2y/2024.a7d4c4d612c5.parquet',
					'rides/start/1mo/1mo/2026-01.cbbcfc3be09f.parquet',
					'rides/start/1mo/1mo/2026-02.ba055ab58dd8.parquet',
				],
			}],
		});
	});
});
