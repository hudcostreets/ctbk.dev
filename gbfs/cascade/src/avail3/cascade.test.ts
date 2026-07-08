import { describe, test, expect } from 'vitest';
import { LADDERS, shardKey } from './cascade';

const toMin = (d: string): number => {
	const m = /^(\d+)(min|h|d)$/.exec(d)!;
	const n = Number(m[1]);
	const unit = m[2];
	return unit === 'min' ? n : unit === 'h' ? n * 60 : n * 60 * 24;
};

describe('LADDERS', () => {
	test('has all 15 tiers', () => {
		expect(Object.keys(LADDERS).sort()).toEqual([
			'10m', '12h', '15m', '1d', '1h', '1m', '2h', '2m', '30m',
			'3d', '3h', '3m', '5m', '6h', '7d',
		]);
	});

	test('every tier is divisibility-chained (each rung divides the next)', () => {
		for (const [tier, ladder] of Object.entries(LADDERS)) {
			for (let i = 1; i < ladder.length; i++) {
				const prev = toMin(ladder[i - 1]!);
				const cur = toMin(ladder[i]!);
				expect(cur % prev, `${tier}: ${ladder[i]} % ${ladder[i - 1]} != 0`).toBe(0);
			}
		}
	});

	test('every tier’s adjacent-rung ratio ≤ 3×', () => {
		for (const [tier, ladder] of Object.entries(LADDERS)) {
			for (let i = 1; i < ladder.length; i++) {
				const ratio = toMin(ladder[i]!) / toMin(ladder[i - 1]!);
				expect(ratio, `${tier}: ${ladder[i - 1]} → ${ladder[i]} = ${ratio}×`)
					.toBeLessThanOrEqual(3);
			}
		}
	});

	test('/1m ladder matches api worker tier config', () => {
		// Labels MUST match pyrmts Duration strings the api worker uses for
		// `Tier.shards`. Drift here means the cascade writes paths the api
		// worker can't find.
		expect(LADDERS['1m']).toEqual([
			'5min', '10min', '30min', '1h', '3h', '6h', '12h', '1d',
		]);
	});
});

describe('shardKey (unified `<tier>/<shardDur>/<period>` layout)', () => {
	test('formats with minute precision for sub-hour rungs', () => {
		const t = new Date('2026-06-27T15:40:00Z');
		expect(shardKey('1m', '5min', t)).toBe('avail-v3/1m/5min/2026-06-27T15-40.parquet');
		expect(shardKey('1m', '10min', t)).toBe('avail-v3/1m/10min/2026-06-27T15-40.parquet');
		expect(shardKey('1m', '30min', t)).toBe('avail-v3/1m/30min/2026-06-27T15-40.parquet');
	});

	test('formats with hour precision for sub-day rungs', () => {
		const t = new Date('2026-06-27T15:00:00Z');
		expect(shardKey('1m', '1h', t)).toBe('avail-v3/1m/1h/2026-06-27T15.parquet');
		expect(shardKey('1m', '3h', t)).toBe('avail-v3/1m/3h/2026-06-27T15.parquet');
		const noon = new Date('2026-06-27T12:00:00Z');
		expect(shardKey('1m', '12h', noon)).toBe('avail-v3/1m/12h/2026-06-27T12.parquet');
	});

	test('formats /1m@1d with date precision', () => {
		const dayStart = new Date('2026-06-27T00:00:00Z');
		expect(shardKey('1m', '1d', dayStart)).toBe('avail-v3/1m/1d/2026-06-27.parquet');
	});
});

describe('tick alignment', () => {
	// Replicates the avail3Tick gate logic: at tick T (a UTC ms divisible
	// by 5min), which rungs close?
	const toMin = (d: string): number => {
		const m = /^(\d+)(min|h|d)$/.exec(d)!;
		const n = Number(m[1]);
		const unit = m[2];
		return unit === 'min' ? n : unit === 'h' ? n * 60 : n * 60 * 24;
	};
	const rungCloses = (tickIso: string, shardDur: string): boolean => {
		const tickMs = new Date(tickIso).getTime();
		return tickMs % (toMin(shardDur) * 60_000) === 0;
	};

	test('5min always closes at every /5m tick', () => {
		expect(rungCloses('2026-06-27T15:05:00Z', '5min')).toBe(true);
		expect(rungCloses('2026-06-27T15:10:00Z', '5min')).toBe(true);
		expect(rungCloses('2026-06-27T16:00:00Z', '5min')).toBe(true);
	});

	test('10min closes every other tick', () => {
		expect(rungCloses('2026-06-27T15:05:00Z', '10min')).toBe(false);
		expect(rungCloses('2026-06-27T15:10:00Z', '10min')).toBe(true);
		expect(rungCloses('2026-06-27T15:15:00Z', '10min')).toBe(false);
		expect(rungCloses('2026-06-27T15:20:00Z', '10min')).toBe(true);
	});

	test('1h closes only at HH:00 ticks', () => {
		expect(rungCloses('2026-06-27T15:55:00Z', '1h')).toBe(false);
		expect(rungCloses('2026-06-27T16:00:00Z', '1h')).toBe(true);
		expect(rungCloses('2026-06-27T17:00:00Z', '1h')).toBe(true);
	});

	test('12h closes only at 00:00Z and 12:00Z', () => {
		expect(rungCloses('2026-06-27T00:00:00Z', '12h')).toBe(true);
		expect(rungCloses('2026-06-27T12:00:00Z', '12h')).toBe(true);
		expect(rungCloses('2026-06-27T11:00:00Z', '12h')).toBe(false);
		expect(rungCloses('2026-06-27T13:00:00Z', '12h')).toBe(false);
	});

	test('every rung closes at midnight UTC (1d boundary)', () => {
		const midnight = '2026-06-28T00:00:00Z';
		for (const d of LADDERS['1m']!) {
			expect(rungCloses(midnight, d)).toBe(true);
		}
	});
});
