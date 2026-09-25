import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { HealthSnapshot } from './health';
import {
	DEFAULT_RULES,
	diffRules,
	feedStaleMinutes,
	hourlyCompactionStaleMinutes,
	pyramidTipAgeHours,
	snapshotAgeMinutes,
	stationsStaleHours,
	trailingHourMissing,
	type AlertState,
	type FiringEntry,
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
			drift: null,
			todayCount: 720,
			todayExpected: 721,
			last7Days: [],
		},
		compactions: {
			daily: { latestDate: '2026-05-23', count: 1 },
			hourly: { latestKey: 'gbfs/avail/h1/2026-05-24/11.parquet', todayCount: 12 },
		},
		cascade: { cells: [], expectedCells: [] },
		pyramids: [],
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

	function entry(firingSince: string): FiringEntry {
		return { firingSince, threadTs: `ts-${firingSince}`, firingText: 'prior firing text' };
	}

	it('emits firing transition for newly-firing rule', () => {
		const transitions = diffRules([fireRule], { firing: {} }, snap());
		expect(transitions).toEqual([{ rule: fireRule, kind: 'firing', firingText: 'firing!' }]);
	});

	it('emits resolved transition when rule clears', () => {
		const resolvedRule: Rule = { id: 'always-fire', description: 'desc', check: () => false, firingText: () => '' };
		const prior = entry('2026-05-24T11:00:00Z');
		const transitions = diffRules([resolvedRule], { firing: { 'always-fire': prior } }, snap());
		expect(transitions).toEqual([
			{ rule: resolvedRule, kind: 'resolved', priorEntry: prior },
		]);
	});

	it('no resolved transition when rule isn\'t in current rule set', () => {
		// `restRule` is `never-fire`; `always-fire` from prev isn't in this rule set, so no transition.
		const transitions = diffRules([restRule], { firing: { 'always-fire': entry('2026-05-24T11:00:00Z') } }, snap());
		expect(transitions).toEqual([]);
	});

	it('no transition when rule keeps firing (deduped)', () => {
		const transitions = diffRules([fireRule], { firing: { 'always-fire': entry('2026-05-24T11:00:00Z') } }, snap());
		expect(transitions).toEqual([]);
	});

	it('no transition when rule keeps not-firing', () => {
		const transitions = diffRules([restRule], { firing: {} }, snap());
		expect(transitions).toEqual([]);
	});

	it('handles mixed firing/resolved/steady-state in one pass', () => {
		const ruleA: Rule = { id: 'a', description: 'A', check: () => true, firingText: () => 'A fires' };
		const ruleB: Rule = { id: 'b', description: 'B', check: () => false, firingText: () => 'B fires' };
		const ruleC: Rule = { id: 'c', description: 'C', check: () => true, firingText: () => 'C fires' };
		const prev: AlertState = {
			firing: {
				b: entry('2026-05-24T11:00:00Z'),
				c: entry('2026-05-24T11:00:00Z'),
			},
		};
		const transitions = diffRules([ruleA, ruleB, ruleC], prev, snap());
		expect(transitions.map((t) => [t.rule.id, t.kind])).toEqual([
			['a', 'firing'],   // new
			['b', 'resolved'], // was firing, now not
			// c stays firing — no transition
		]);
	});
});

/** `pyramidTips` with each watched pyramid's newest shard ending `h` hours ago. */
const tipsAt = (ages: Record<string, number>) => Object.fromEntries(Object.entries(ages).map(([name, h]) =>
	[name, FIXED_NOW.getTime() - h * 3_600_000]));
const HEALTHY_TIPS = { 'avail-v5': 0.2, 'avail-v6': 0.2, 'smg-v1': 12, 'rides-start': 24 * 24, 'rides-end': 24 * 24 };

const firingIds = (s: HealthSnapshot) => DEFAULT_RULES.filter((r) => r.check(s)).map((r) => r.id);

describe('pyramidTipAgeHours', () => {
	it('ages the newest registered period_end', () => {
		expect(pyramidTipAgeHours(snap({ pyramidTips: tipsAt({ 'avail-v6': 3 }) }), 'avail-v6')).toBe(3);
	});
	it('Infinity for a pyramid with no shards; 0 for a pre-feature snapshot', () => {
		expect(pyramidTipAgeHours(snap({ pyramidTips: { 'avail-v6': null } }), 'avail-v6')).toBe(Infinity);
		expect(pyramidTipAgeHours(snap(), 'avail-v6')).toBe(0);
	});
});

describe('stationsStaleHours / snapshotAgeMinutes', () => {
	it('hours since the last stations upsert; Infinity when unknown', () => {
		expect(stationsStaleHours(snap({ stations: { lastUpdatedAt: FIXED_NOW.getTime() / 1000 - 7200 } }))).toBe(2);
		expect(stationsStaleHours(snap({ stations: null }))).toBe(Infinity);
		expect(stationsStaleHours(snap())).toBe(0);  // pre-feature cached snapshot
	});
	it('minutes since the snapshot was generated', () => {
		expect(snapshotAgeMinutes(snap({ generatedAt: FIXED_NOW.getTime() / 1000 - 600 }))).toBe(10);
	});
});

describe('DEFAULT_RULES on a full snapshot', () => {
	const fresh = (overrides: Partial<HealthSnapshot> = {}) => snap({
		pyramidTips: tipsAt(HEALTHY_TIPS),
		stations: { lastUpdatedAt: FIXED_NOW.getTime() / 1000 - 12 * 3600 },
		...overrides,
	});

	it('healthy → nothing fires', () => {
		expect(firingIds(fresh())).toEqual([]);
	});

	it('a dead cascade (avail tips 1.5h behind) fires both avail tip rules only', () => {
		expect(firingIds(fresh({ pyramidTips: tipsAt({ ...HEALTHY_TIPS, 'avail-v5': 1.5, 'avail-v6': 1.5 }) }))).toEqual([
			'pyramid-tip-stale:avail-v5',
			'pyramid-tip-stale:avail-v6',
		]);
	});

	it('a missed daily smg fill fires at >36h, a late monthly ingest at >50d', () => {
		expect(firingIds(fresh({ pyramidTips: tipsAt({ ...HEALTHY_TIPS, 'smg-v1': 37, 'rides-end': 51 * 24 }) }))).toEqual([
			'pyramid-tip-stale:smg-v1',
			'pyramid-tip-stale:rides-end',
		]);
	});

	it('stale stations (the 2026-06 loader failure) and a dead snapshot cron each fire', () => {
		expect(firingIds(fresh({
			stations: { lastUpdatedAt: FIXED_NOW.getTime() / 1000 - 90 * 24 * 3600 },
			generatedAt: FIXED_NOW.getTime() / 1000 - 20 * 60,
		}))).toEqual(['stations-stale', 'health-snapshot-stale']);
	});
});
