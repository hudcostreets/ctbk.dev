import { describe, expect, it } from 'vitest';
import { addDays, coverageKey, coverageRange, daysBetween, defaultCoverageRange, type CoverageDay } from './coverage';

function doc(day: string, gaps: Array<[number, number, number]>, counts?: number[]): CoverageDay {
	return { day, live: 2400, observed_minutes: 1440 - gaps.reduce((n, g) => n + g[1], 0), gaps, counts };
}

describe('daysBetween', () => {
	it('is inclusive and crosses month ends', () => {
		expect(daysBetween('2026-08-30', '2026-09-02')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
		expect(daysBetween('2026-05-01', '2026-05-01')).toEqual(['2026-05-01']);
	});
	it('rejects malformed, inverted, and oversized ranges', () => {
		expect(() => daysBetween('2026-8-30', '2026-09-02')).toThrow('bad day');
		expect(() => daysBetween('2026-09-02', '2026-08-30')).toThrow('from > to');
		expect(() => daysBetween('2020-01-01', '2026-09-02')).toThrow('range too large');
	});
});

describe('defaultCoverageRange', () => {
	it('is the 30 days ending yesterday UTC', () => {
		expect(defaultCoverageRange(new Date('2026-09-04T17:56:00Z'))).toEqual({ from: '2026-08-05', to: '2026-09-03' });
		expect(addDays('2026-09-03', -29)).toBe('2026-08-05');
	});
});

describe('coverageRange', () => {
	const store: Record<string, CoverageDay> = {
		[coverageKey('2026-08-30')]: doc('2026-08-30', [[60, 1, 0], [65, 2, 0]], Array(1440).fill(2400)),
		[coverageKey('2026-08-31')]: doc('2026-08-31', [], Array(1440).fill(2400)),
	};
	const get = async (key: string) => store[key] ?? null;

	it('returns docs without counts by default and lists missing days', async () => {
		expect(await coverageRange(get, '2026-08-30', '2026-09-01')).toEqual({
			from: '2026-08-30',
			to: '2026-09-01',
			days: [
				{ day: '2026-08-30', live: 2400, observed_minutes: 1437, gaps: [[60, 1, 0], [65, 2, 0]] },
				{ day: '2026-08-31', live: 2400, observed_minutes: 1440, gaps: [] },
			],
			missing: ['2026-09-01'],
		});
	});

	it('includes counts when asked', async () => {
		const r = await coverageRange(get, '2026-08-31', '2026-08-31', true);
		expect(r.days.map((d) => d.day)).toEqual(['2026-08-31']);
		expect(r.days[0].counts).toEqual(Array(1440).fill(2400));
		expect(r.missing).toEqual([]);
	});
});
