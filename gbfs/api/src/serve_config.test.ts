import { afterEach, describe, expect, it } from 'vitest';
import { v5BBoxCover } from './avail_geo';
import { loadCanonMap } from './canon';
import { getPyramidTips, WATCHED_PYRAMIDS } from './health';
import { RIDES } from './rides_v1';
import { configureServe, extraStationsKey, ridesPyramidName } from './serve_config';

function mockBucket(objs: Record<string, unknown>): R2Bucket {
	return {
		get: async (key: string) => (key in objs ? { json: async () => objs[key] } : null),
	} as unknown as R2Bucket;
}

/** D1 stand-in recording each `pyramid = ?` binding; `period_end` = 1000 × position. */
function mockDb(asked: string[]): D1Database {
	return {
		prepare: () => ({
			bind: (p: string) => ({
				first: async () => { asked.push(p); return { t: 1000 * asked.length }; },
			}),
		}),
	} as unknown as D1Database;
}

const LUC = { by_short_name: { '6474.03': { lat: 40.7527, lng: -73.9812, cell: '89c25900d' } } };
const MIDTOWN = { minLat: 40.752, maxLat: 40.7535, minLng: -73.982, maxLng: -73.9805 };

afterEach(() => configureServe({}));

describe('serve_config', () => {
	it('defaults are prod: `rides-{start,end}` + the fixed asset keys', () => {
		configureServe({});
		expect([ridesPyramidName('start'), RIDES.registry!(), extraStationsKey()]).toEqual([
			'rides-start', 'rides', 'stations/rides-extra-stations.json',
		]);
	});

	it('a candidate registry name reaches the rides variant', () => {
		configureServe({ RIDES_PYRAMID: 'rides-next' });
		expect([ridesPyramidName('end'), RIDES.registry!(), RIDES.prefix]).toEqual(['rides-next-end', 'rides-next', 'rides']);
	});

	it('the id-map is read from the configured key, re-read when it changes', async () => {
		const bucket = mockBucket({
			'stations/station-canonicalize-map.json': { 's:364': 'c:4452.01' },
			'stations/station-canonicalize-map.abc123.json': { 's:3640': 'c:4452.01' },
		});
		configureServe({});
		expect((await loadCanonMap(bucket)).toCanon).toEqual(new Map([['s:364', 'c:4452.01']]));
		configureServe({ CANON_MAP_KEY: 'stations/station-canonicalize-map.abc123.json' });
		expect((await loadCanonMap(bucket)).toCanon).toEqual(new Map([['s:3640', 'c:4452.01']]));
	});

	it('the station registry is read from the configured key', async () => {
		const bucket = mockBucket({ 'station-luc.abc123.json': LUC });
		configureServe({ STATION_LUC_KEY: 'station-luc.abc123.json' });
		expect(await v5BBoxCover(bucket, MIDTOWN)).toEqual(['89c259']);
		configureServe({});
		await expect(v5BBoxCover(bucket, MIDTOWN)).rejects.toThrow('station-luc.json not found on R2');
	});

	it('pyramid tips stay keyed by role but query the configured registry', async () => {
		configureServe({ RIDES_PYRAMID: 'rides-next' });
		const asked: string[] = [];
		const tips = await getPyramidTips(mockDb(asked));
		expect(asked.slice().sort()).toEqual(['avail-v5', 'avail-v6', 'rides-next-end', 'rides-next-start', 'smg-v1']);
		expect(Object.keys(tips)).toEqual(WATCHED_PYRAMIDS);
	});
});
