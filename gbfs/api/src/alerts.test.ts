import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { HealthSnapshot } from './health';
import {
	diffRules,
	feedStaleMinutes,
	hourlyCompactionStaleMinutes,
	trailingHourMissing,
	type AlertState,
	type Rule,
} from './alerts';

const FIXED_NOW = new Date('2026-05-24T12:00:00Z');

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

function snap(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
	const base: HealthSnapshot = {
		generatedAt: FIXED_NOW.getTime() / 1000,
		feed: {
			latestPoll: {
				key: 'gbfs/status/2026-05-24/11-59.json',
				date: '2026-05-24',
				time: '11:59',
				uploadedAt: '2026-05-24T11:59:00.000Z',
			},
			todayCount: 720,
			todayExpected: 721,
			last7Days: [],
		},
		compactions: {
			daily: { latestDate: '2026-05-23', count: 1 },
			hourly: { latestKey: 'gbfs/avail/h1/2026-05-24/11.parquet', todayCount: 12 },
		},
		cascade: { cells: [], expectedCells: [] },
		tripdata: null,
	};
	return { ...base, ...overrides };
}

describe('feedStaleMinutes', () => {
	it('returns 0–1min when poll just landed', () => {
		expect(feedStaleMinutes(snap())).toBeCloseTo(1, 0);
	});
	it('returns Infinity when no poll', () => {
		const s = snap({ feed: { ...snap().feed, latestPoll: null } });
		expect(feedStaleMinutes(s)).toBe(Infinity);
	});
	it('scales linearly with poll age', () => {
		const s = snap({
			feed: { ...snap().feed, latestPoll: { ...snap().feed.latestPoll!, uploadedAt: '2026-05-24T11:50:00.000Z' } },
		});
		expect(feedStaleMinutes(s)).toBeCloseTo(10, 1);
	});
});

describe('trailingHourMissing', () => {
	it('returns 0 when caught up', () => {
		const s = snap({ feed: { ...snap().feed, todayCount: 721, todayExpected: 721 } });
		expect(trailingHourMissing(s)).toBe(0);
	});
	it('returns gap when behind', () => {
		const s = snap({ feed: { ...snap().feed, todayCount: 715, todayExpected: 720 } });
		expect(trailingHourMissing(s)).toBe(5);
	});
});

describe('hourlyCompactionStaleMinutes', () => {
	it('returns ~0 when hourly is current', () => {
		// Hour 11 compaction covers through end of hour 11 (12:00); at noon, age = 0.
		expect(hourlyCompactionStaleMinutes(snap())).toBeCloseTo(0, 0);
	});
	it('returns Infinity for missing key', () => {
		const s = snap({ compactions: { ...snap().compactions, hourly: { latestKey: null, todayCount: 0 } } });
		expect(hourlyCompactionStaleMinutes(s)).toBe(Infinity);
	});
	it('returns minutes since hour-end for stale hourly', () => {
		const s = snap({
			compactions: { ...snap().compactions, hourly: { latestKey: 'gbfs/avail/h1/2026-05-24/09.parquet', todayCount: 10 } },
		});
		// Hour 09 covers through 10:00; from 12:00 that's 2 hours = 120min.
		expect(hourlyCompactionStaleMinutes(s)).toBeCloseTo(120, 0);
	});
});

describe('diffRules', () => {
	const fireRule: Rule = {
		id: 'always-fire',
		description: 'always',
		check: () => true,
		firingText: () => 'firing!',
	};
	const restRule: Rule = {
		id: 'never-fire',
		description: 'never',
		check: () => false,
		firingText: () => 'should not appear',
	};

	it('emits firing transition for newly-firing rule', () => {
		const prev: AlertState = { firing: {} };
		const { next, transitions } = diffRules([fireRule], prev, snap(), '2026-05-24T12:00:00Z');
		expect(transitions).toEqual([{ rule: fireRule, kind: 'firing', text: 'firing!' }]);
		expect(next.firing).toEqual({ 'always-fire': '2026-05-24T12:00:00Z' });
	});

	it('emits resolved transition when rule clears', () => {
		const prev: AlertState = { firing: { 'always-fire': '2026-05-24T11:00:00Z' } };
		const { next, transitions } = diffRules([restRule], prev, snap(), '2026-05-24T12:00:00Z');
		// `restRule` has different id — `always-fire` is in prev but not in current rules, so no transition.
		// Test the actual resolved path with matching id:
		const resolvedRule: Rule = { id: 'always-fire', description: 'desc', check: () => false, firingText: () => '' };
		const r2 = diffRules([resolvedRule], prev, snap(), '2026-05-24T12:00:00Z');
		expect(r2.transitions).toEqual([
			{ rule: resolvedRule, kind: 'resolved', firingSince: '2026-05-24T11:00:00Z', text: ':white_check_mark: *Resolved* — desc' },
		]);
		expect(r2.next.firing).toEqual({});
		// And the earlier no-op result:
		expect(transitions).toEqual([]);
		expect(next.firing).toEqual({ 'always-fire': '2026-05-24T11:00:00Z' });
	});

	it('no transition when rule keeps firing (deduped)', () => {
		const prev: AlertState = { firing: { 'always-fire': '2026-05-24T11:00:00Z' } };
		const { next, transitions } = diffRules([fireRule], prev, snap(), '2026-05-24T12:00:00Z');
		expect(transitions).toEqual([]);
		expect(next.firing).toEqual({ 'always-fire': '2026-05-24T11:00:00Z' });
	});

	it('no transition when rule keeps not-firing', () => {
		const prev: AlertState = { firing: {} };
		const { transitions } = diffRules([restRule], prev, snap(), '2026-05-24T12:00:00Z');
		expect(transitions).toEqual([]);
	});

	it('handles mixed firing/resolved/steady-state in one pass', () => {
		const ruleA: Rule = { id: 'a', description: 'A', check: () => true, firingText: () => 'A fires' };
		const ruleB: Rule = { id: 'b', description: 'B', check: () => false, firingText: () => 'B fires' };
		const ruleC: Rule = { id: 'c', description: 'C', check: () => true, firingText: () => 'C fires' };
		const prev: AlertState = { firing: { b: '2026-05-24T11:00:00Z', c: '2026-05-24T11:00:00Z' } };
		const { next, transitions } = diffRules([ruleA, ruleB, ruleC], prev, snap(), '2026-05-24T12:00:00Z');
		expect(transitions.map((t) => [t.rule.id, t.kind])).toEqual([
			['a', 'firing'],   // new
			['b', 'resolved'], // was firing, now not
			// c stays firing — no transition
		]);
		expect(next.firing).toEqual({
			a: '2026-05-24T12:00:00Z',
			c: '2026-05-24T11:00:00Z',
		});
	});
});
