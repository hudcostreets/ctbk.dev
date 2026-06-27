import { describe, test, expect } from 'vitest';
import { CADENCES, partialKey, canonicalKey } from './cascade';

describe('CADENCES ladder', () => {
	test('is divisibility-chained (each cadence divides the next)', () => {
		for (let i = 1; i < CADENCES.length; i++) {
			const cur = CADENCES[i]!.minutes;
			const prev = CADENCES[i - 1]!.minutes;
			expect(cur % prev).toBe(0);
		}
	});

	test('uses the same labels pyrmts substitutes into `{shard}`', () => {
		// Labels MUST match pyrmts Duration template-literal forms so the
		// api worker's `partialKey: avail-v3/{tier}/p{shard}/{period}` and
		// the cascade's `partialKey()` produce byte-equal R2 keys.
		expect(CADENCES.map((c) => c.label)).toEqual([
			'5min', '10min', '30min', '1h', '3h', '12h',
		]);
	});

	test('durationStr matches label (pyrmts Duration encoding)', () => {
		for (const c of CADENCES) {
			expect(c.durationStr).toBe(c.label);
		}
	});
});

describe('partialKey', () => {
	test('formats with minute precision for sub-hour cadences', () => {
		const t = new Date('2026-06-27T15:40:00Z');
		expect(partialKey('1m', CADENCES[0]!, t)).toBe('avail-v3/1m/p5min/2026-06-27T15-40.parquet');
		expect(partialKey('1m', CADENCES[1]!, t)).toBe('avail-v3/1m/p10min/2026-06-27T15-40.parquet');
		expect(partialKey('1m', CADENCES[2]!, t)).toBe('avail-v3/1m/p30min/2026-06-27T15-40.parquet');
	});

	test('formats with hour precision for sub-day cadences', () => {
		const t = new Date('2026-06-27T15:00:00Z');
		// 1h cadence (60min): hour precision (2026-06-27T15)
		expect(partialKey('1m', CADENCES[3]!, t)).toBe('avail-v3/1m/p1h/2026-06-27T15.parquet');
		// 3h cadence: hour precision
		expect(partialKey('1m', CADENCES[4]!, t)).toBe('avail-v3/1m/p3h/2026-06-27T15.parquet');
		// 12h cadence: hour precision
		const noon = new Date('2026-06-27T12:00:00Z');
		expect(partialKey('1m', CADENCES[5]!, noon)).toBe('avail-v3/1m/p12h/2026-06-27T12.parquet');
	});
});

describe('canonicalKey', () => {
	test('formats /1m canonical with date precision', () => {
		const dayStart = new Date('2026-06-27T00:00:00Z');
		expect(canonicalKey('1m', dayStart, 86_400_000)).toBe('avail-v3/1m/2026-06-27.parquet');
	});
});

describe('tick alignment', () => {
	// Replicates the avail3Tick gate logic: at tick T (a UTC ms divisible
	// by 5min), which cadences close?
	const cadenceCloses = (tickIso: string, cadenceLabel: string): boolean => {
		const tickMs = new Date(tickIso).getTime();
		const cadence = CADENCES.find((c) => c.label === cadenceLabel)!;
		return tickMs % (cadence.minutes * 60_000) === 0;
	};

	test('5min always closes at every /5m tick', () => {
		expect(cadenceCloses('2026-06-27T15:05:00Z', '5min')).toBe(true);
		expect(cadenceCloses('2026-06-27T15:10:00Z', '5min')).toBe(true);
		expect(cadenceCloses('2026-06-27T16:00:00Z', '5min')).toBe(true);
	});

	test('10min closes every other tick', () => {
		expect(cadenceCloses('2026-06-27T15:05:00Z', '10min')).toBe(false);
		expect(cadenceCloses('2026-06-27T15:10:00Z', '10min')).toBe(true);
		expect(cadenceCloses('2026-06-27T15:15:00Z', '10min')).toBe(false);
		expect(cadenceCloses('2026-06-27T15:20:00Z', '10min')).toBe(true);
	});

	test('1h closes only at HH:00 ticks', () => {
		expect(cadenceCloses('2026-06-27T15:55:00Z', '1h')).toBe(false);
		expect(cadenceCloses('2026-06-27T16:00:00Z', '1h')).toBe(true);
		expect(cadenceCloses('2026-06-27T17:00:00Z', '1h')).toBe(true);
	});

	test('12h closes only at 00:00Z and 12:00Z', () => {
		expect(cadenceCloses('2026-06-27T00:00:00Z', '12h')).toBe(true);
		expect(cadenceCloses('2026-06-27T12:00:00Z', '12h')).toBe(true);
		expect(cadenceCloses('2026-06-27T11:00:00Z', '12h')).toBe(false);
		expect(cadenceCloses('2026-06-27T13:00:00Z', '12h')).toBe(false);
	});

	test('every cadence closes at midnight UTC (1d boundary)', () => {
		const midnight = '2026-06-28T00:00:00Z';
		for (const c of CADENCES) {
			expect(cadenceCloses(midnight, c.label)).toBe(true);
		}
	});
});
