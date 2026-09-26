import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompactionHealth, getFeedHealth, type HealthR2 } from './health';

/** In-memory `HealthR2` over a fixed key set: prefix listing (no delimiter
 *  support needed beyond the daily-parquet scan), single page. */
function fakeR2(keys: string[]): HealthR2 {
	const uploaded = new Date('2026-09-25T23:59:30Z');
	return {
		async list({ prefix = '', delimiter }) {
			const matched = keys.filter((k) => k.startsWith(prefix));
			const objects = delimiter ? matched.filter((k) => !k.slice(prefix.length).includes(delimiter)) : matched;
			return { objects: objects.map((key) => ({ key, uploaded })), truncated: false, delimitedPrefixes: [] } as never;
		},
		async get() {
			return null;
		},
	};
}

describe('health just after 00:00Z (today has no keys yet)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-26T00:00:30Z'));
	});
	afterEach(() => vi.useRealTimers());

	const r2 = fakeR2([
		'gbfs/status/2026-09-25/23-58.json',
		'gbfs/status/2026-09-25/23-59.json',
		'gbfs/avail/h1/2026-09-25/22.parquet',
		'gbfs/avail/h1/2026-09-25/23.parquet',
	]);

	it('feed: latest poll comes from yesterday', async () => {
		const f = await getFeedHealth(r2);
		expect(f.latestPoll).toEqual({
			key: 'gbfs/status/2026-09-25/23-59.json',
			date: '2026-09-25',
			time: '23:59',
			uploadedAt: '2026-09-25T23:59:30.000Z',
		});
		expect([f.todayCount, f.todayExpected]).toEqual([0, 1]);
		expect(f.last7Days.slice(-2)).toEqual([
			{ date: '2026-09-25', count: 2, expected: 1440 },
			{ date: '2026-09-26', count: 0, expected: 1 },
		]);
	});

	it('hourly: latest h1 comes from yesterday; todayCount stays 0', async () => {
		const c = await getCompactionHealth(r2);
		expect(c.hourly).toEqual({ latestKey: 'gbfs/avail/h1/2026-09-25/23.parquet', todayCount: 0 });
	});
});
