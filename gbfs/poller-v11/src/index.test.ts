import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { _reset, observe, pollTick, type Source } from './index';

/** In-memory R2: key → { body, customMetadata }. */
function fakeBucket() {
	const store = new Map<string, { body: string; meta?: Record<string, string> }>();
	const bucket = {
		async put(key: string, body: string, opts?: { customMetadata?: Record<string, string> }) {
			store.set(key, { body, meta: opts?.customMetadata });
		},
		async head(key: string) {
			const o = store.get(key);
			return o ? { customMetadata: o.meta } : null;
		},
	} as unknown as R2Bucket;
	return { bucket, store };
}

const doc = (lu: number, bikes = 3) => ({
	last_updated: lu,
	data: { stations: [{ station_id: 'A', num_bikes_available: bikes, legacy_id: 'A', last_reported: lu - 5 }] },
});

// 2026-09-26T13:48:01Z
const LU = 1790430481;
const keys = (store: Map<string, unknown>) => [...store.keys()].sort();
const body = (store: Map<string, { body: string }>, k: string) => JSON.parse(store.get(k)!.body);

beforeEach(() => _reset());

describe('observe', () => {
	test('first source saves the snapshot; an identical second sighting only records an obs', async () => {
		const { bucket, store } = fakeBucket();
		expect(await observe(bucket, 'cb', doc(LU), LU + 15)).toBe(true);
		expect(await observe(bucket, 'lyft', doc(LU), LU + 48)).toBe(true);
		expect(keys(store)).toEqual([
			'gbfs/probe/v11-obs/cb/2026-09-26/13-48.json',
			'gbfs/probe/v11-obs/lyft/2026-09-26/13-48.json',
			'gbfs/probe/v11/2026-09-26/13-48.json',
		]);
		const full = body(store, 'gbfs/probe/v11/2026-09-26/13-48.json');
		expect({ ...full, stations: full.stations.length }).toEqual({ ts: LU, polled_at: LU + 15, src: 'cb', hash: full.hash, stations: 1 });
		expect(full.stations[0]).toEqual({
			station_id: 'A', num_bikes_available: 3, num_ebikes_available: 0, num_docks_available: 0,
			num_bikes_disabled: 0, num_docks_disabled: 0, is_installed: 0, is_renting: 0, is_returning: 0,
			last_reported: LU - 5,
		});
		expect(body(store, 'gbfs/probe/v11-obs/lyft/2026-09-26/13-48.json')).toEqual({ ts: LU, polled_at: LU + 48, hash: full.hash, full: false });
	});

	test('differing content for the same LU is saved under v11-alt', async () => {
		const { bucket, store } = fakeBucket();
		await observe(bucket, 'cb', doc(LU, 3), LU + 15);
		await observe(bucket, 'lyft', doc(LU, 4), LU + 48);
		expect(keys(store)).toEqual([
			'gbfs/probe/v11-alt/lyft/2026-09-26/13-48.json',
			'gbfs/probe/v11-obs/cb/2026-09-26/13-48.json',
			'gbfs/probe/v11-obs/lyft/2026-09-26/13-48.json',
			'gbfs/probe/v11/2026-09-26/13-48.json',
		]);
		expect(body(store, 'gbfs/probe/v11-obs/lyft/2026-09-26/13-48.json').full).toBe(true);
	});

	test('dedup survives a cold isolate via the saved object\'s metadata', async () => {
		const { bucket, store } = fakeBucket();
		await observe(bucket, 'cb', doc(LU), LU + 15);
		_reset();
		await observe(bucket, 'lyft', doc(LU), LU + 48);
		expect(keys(store)).toEqual([
			'gbfs/probe/v11-obs/cb/2026-09-26/13-48.json',
			'gbfs/probe/v11-obs/lyft/2026-09-26/13-48.json',
			'gbfs/probe/v11/2026-09-26/13-48.json',
		]);
	});

	test('a repeat or older LU from the same source is a no-op', async () => {
		const { bucket, store } = fakeBucket();
		await observe(bucket, 'lyft', doc(LU), LU + 48);
		expect(await observe(bucket, 'lyft', doc(LU), LU + 50)).toBe(false);
		expect(await observe(bucket, 'lyft', doc(LU - 60), LU + 52)).toBe(false);
		expect(store.size).toBe(2);
	});
});

describe('pollTick', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-26T13:49:00Z'));
	});
	afterEach(() => vi.useRealTimers());

	test('a source failing every sample gets an error marker; the other still saves', async () => {
		const { bucket, store } = fakeBucket();
		const fetcher = async (src: Source) => {
			if (src === 'cb') throw new Error('cb 503');
			return doc(LU);
		};
		let done = false;
		const tick = pollTick(bucket, Date.parse('2026-09-26T13:49:00Z'), fetcher).then(() => { done = true; });
		while (!done) await vi.advanceTimersByTimeAsync(1_000);
		await tick;
		expect(keys(store)).toEqual([
			'gbfs/probe/v11-err/cb/2026-09-26/13-49.json',
			'gbfs/probe/v11-obs/lyft/2026-09-26/13-48.json',
			'gbfs/probe/v11/2026-09-26/13-48.json',
		]);
		expect(body(store, 'gbfs/probe/v11-err/cb/2026-09-26/13-49.json')).toEqual({
			scheduled: Date.parse('2026-09-26T13:49:00Z'),
			samples: 4,
			errors: ['Error: cb 503', 'Error: cb 503', 'Error: cb 503', 'Error: cb 503'],
		});
	});
});
