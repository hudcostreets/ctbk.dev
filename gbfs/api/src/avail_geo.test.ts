import { describe, expect, it } from 'vitest';
import { v5BBoxCover } from './avail_geo';

// Minimal R2 stand-in: `get(key)` → `{ json() }` over fixed objects.
function mockBucket(objs: Record<string, unknown>): R2Bucket {
	return {
		get: async (key: string) => (key in objs ? { json: async () => objs[key] } : null),
	} as unknown as R2Bucket;
}

// `3460.05` (Bay Ridge) is one of the canonicals `station-luc.json` lacks;
// the registry here holds one unrelated Midtown station.
const LUC = { by_short_name: { '6474.03': { lat: 40.7527, lng: -73.9812, cell: '89c25900d' } } };
const EXTRAS = { '3460.05': { lat: 40.6557, lng: -74.01, cell: '89c25abec1d4' } };
const AROUND_3460_05 = { minLat: 40.655, maxLat: 40.657, minLng: -74.011, maxLng: -74.009 };

describe('v5BBoxCover extras', () => {
	it('without extras, a registry-less station is invisible to bbox covers', async () => {
		const bucket = mockBucket({ 'station-luc.json': LUC });
		expect(await v5BBoxCover(bucket, AROUND_3460_05)).toEqual([]);
	});

	it('with extras, the station is covered (by its only-occupied vocab root)', async () => {
		const bucket = mockBucket({ 'station-luc.json': LUC, 'x/extras.json': EXTRAS });
		expect(await v5BBoxCover(bucket, AROUND_3460_05, 'x/extras.json')).toEqual(['89c25b']);
	});

	it('an extra already in the registry is an error', async () => {
		const bucket = mockBucket({ 'station-luc.json': LUC, 'x/dup.json': { '6474.03': LUC.by_short_name['6474.03'] } });
		await expect(v5BBoxCover(bucket, AROUND_3460_05, 'x/dup.json')).rejects.toThrow('x/dup.json: 6474.03 is already in station-luc.json');
	});
});
