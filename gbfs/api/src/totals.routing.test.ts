/**
 * Routing UTs for `/api/totals` (kind=trips).
 *
 * Mocks R2.get to record every key the worker requests and return null
 * (object-missing). For a given input (from, to, scope, filter), assert
 * which R2 keys the worker fetches.
 *
 * When R2 returns null for everything the worker walks BOTH the agg-tier
 * path and the fallback path, recording all attempted keys in the call
 * list. The response itself is shape `tier: 'fallback-*', rows: []`, but
 * routing-correctness is observable in the call list — that's the unit
 * under test here.
 *
 * Aggregation correctness is covered by the pure `aggregateTotals` tests
 * in `totals.test.ts`. End-to-end (real R2 + decode) is covered by
 * `totals.e2e.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	(globalThis as Record<string, unknown>).caches = {
		default: {
			match: async () => undefined,
			put: async () => {},
		},
	};
});

afterEach(() => {
	delete (globalThis as Record<string, unknown>).caches;
	vi.restoreAllMocks();
});

const Y2018 = 1514764800; // 2018-01-01
const Y2024 = 1704067200; // 2024-01-01
const Y2025 = 1735689600; // 2025-01-01
const FEB1_2025 = 1738368000; // 2025-02-01
const MAR1_2025 = 1740787200; // 2025-03-01
const JAN8_2025 = 1736294400; // 2025-01-08

interface Fix {
	calls: string[];
	env: { R2: unknown; DB: unknown; CORS_ORIGIN: string };
	ctx: { waitUntil: () => void };
}

function makeFix(): Fix {
	const calls: string[] = [];
	// Range-read path: parquet readers call `r2.head` first (via
	// `asyncBufferFromR2`); when head returns null the reader short-circuits
	// without calling `r2.get`. Record both so routing assertions work
	// regardless of which entry point hit each key.
	const r2 = {
		head: vi.fn((key: string) => {
			calls.push(key);
			return Promise.resolve(null);
		}),
		get: vi.fn((key: string) => {
			calls.push(key);
			return Promise.resolve(null);
		}),
		list: vi.fn(() => Promise.resolve({ objects: [] })),
	};
	return {
		calls,
		env: { R2: r2, DB: {}, CORS_ORIGIN: '*' },
		ctx: { waitUntil: () => {} },
	};
}

async function totals(
	params: Record<string, string | number>,
): Promise<{ status: number; calls: string[]; body: Record<string, unknown> }> {
	const { default: worker } = await import('./index.js');
	const fix = makeFix();
	const u = new URL('http://test/api/totals');
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const res = await worker.fetch(
		new Request(u.toString()),
		fix.env as never,
		fix.ctx as never,
	);
	const text = await res.text();
	const body = res.status === 200 ? JSON.parse(text) : { error: text };
	return { status: res.status, calls: fix.calls, body };
}

describe('routing: trips per-station agg-tier (filter.short_name set)', () => {
	it('h1: 1-week window → fetches monthly h1 file (then fallback after agg returns null)', async () => {
		const { status, calls } = await totals({
			kind: 'trips', from: Y2025, to: JAN8_2025, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(200);
		// Worker tries agg first (h1 monthly), then falls through to per-station fallback.
		expect(calls).toEqual(['trips/agg/h1/2025-01.parquet', 'trips/stations/HB101.parquet']);
	});

	it('d1: 1-month window → fetches yearly d1 file', async () => {
		const { calls } = await totals({
			kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': 'HB101',
		});
		expect(calls).toEqual(['trips/agg/d1/2025.parquet', 'trips/stations/HB101.parquet']);
	});

	it('mo1: 1-year window within decade → single decade mo1 key', async () => {
		const { calls } = await totals({
			kind: 'trips', from: Y2024, to: Y2025, 'filter.short_name': 'HB101',
		});
		expect(calls).toEqual(['trips/agg/mo1/2020.parquet', 'trips/stations/HB101.parquet']);
	});

	it('mo1: cross-decade window → two decade mo1 keys', async () => {
		const { calls } = await totals({
			kind: 'trips', from: Y2018, to: Y2025, 'filter.short_name': 'HB101',
		});
		// Promise.all: agg keys order is preserved (decadesIn returns ['2010', '2020']).
		expect(calls.slice(0, 2)).toEqual([
			'trips/agg/mo1/2010.parquet',
			'trips/agg/mo1/2020.parquet',
		]);
		expect(calls).toContain('trips/stations/HB101.parquet');
	});

	it('d1: 2-month window → still single yearly d1 file', async () => {
		const { calls } = await totals({
			kind: 'trips', from: Y2025, to: MAR1_2025, 'filter.short_name': 'HB101',
		});
		expect(calls[0]).toBe('trips/agg/d1/2025.parquet');
		expect(calls).toContain('trips/stations/HB101.parquet');
	});

	it('multi-station: agg key set unchanged; fallback fans out per station', async () => {
		const { calls } = await totals({
			kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': 'HB101,HB102',
		});
		// One d1 yearly file (rg-pruned by both station ids inline).
		expect(calls[0]).toBe('trips/agg/d1/2025.parquet');
		// Fallback fans out: one per-station rides file per id.
		expect(calls.slice(1).sort()).toEqual([
			'trips/stations/HB101.parquet',
			'trips/stations/HB102.parquet',
		]);
	});
});

describe('routing: trips fallback paths (no station filter → agg skipped)', () => {
	it('scope=regions: only fallback per-region yearly h1 files', async () => {
		const { body, calls } = await totals({
			kind: 'trips', from: Y2025, to: FEB1_2025, scope: 'regions',
		});
		expect(body.tier).toBe('fallback-regions');
		// No agg-tier keys requested.
		expect(calls.filter((k) => k.startsWith('trips/agg/'))).toEqual([]);
		expect(calls.sort()).toEqual([
			'trips/region/hob/h1/2025.parquet',
			'trips/region/jc/h1/2025.parquet',
			'trips/region/nyc/h1/2025.parquet',
		]);
	});

	it('scope=regions + filter.region=nyc: only that region\'s file', async () => {
		const { body, calls } = await totals({
			kind: 'trips', from: Y2025, to: FEB1_2025, scope: 'regions', 'filter.region': 'nyc',
		});
		expect(body.tier).toBe('fallback-regions');
		expect(calls).toEqual(['trips/region/nyc/h1/2025.parquet']);
	});

	it('scope=all: fallback per-region keys × years (cross-year span)', async () => {
		const { body, calls } = await totals({
			kind: 'trips', from: Y2024, to: FEB1_2025, scope: 'all',
		});
		expect(body.tier).toBe('fallback-regions');
		// 2 years × 3 regions = 6 files.
		expect(calls.sort()).toEqual([
			'trips/region/hob/h1/2024.parquet',
			'trips/region/hob/h1/2025.parquet',
			'trips/region/jc/h1/2024.parquet',
			'trips/region/jc/h1/2025.parquet',
			'trips/region/nyc/h1/2024.parquet',
			'trips/region/nyc/h1/2025.parquet',
		]);
	});
});

describe('routing: short windows (sub-day) → agg-tier null → per-station fallback only', () => {
	it('1-hour per-station: no agg keys requested', async () => {
		const T0 = Y2025;
		const T1 = Y2025 + 3600;
		const { body, calls } = await totals({
			kind: 'trips', from: T0, to: T1, 'filter.short_name': 'HB101',
		});
		expect(body.tier).toBe('fallback-stations');
		expect(calls).toEqual(['trips/stations/HB101.parquet']);
	});
});

describe('routing: input validation 4xx — no R2 calls', () => {
	it('missing kind → 400', async () => {
		const { status, calls } = await totals({ from: Y2025, to: FEB1_2025 });
		expect(status).toBe(400);
		expect(calls).toEqual([]);
	});

	it('invalid metric for trips → 400', async () => {
		const { status, calls } = await totals({
			kind: 'trips', metric: 'bikes', from: Y2025, to: FEB1_2025, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(400);
		expect(calls).toEqual([]);
	});

	it('from > to → 400', async () => {
		const { status, calls } = await totals({
			kind: 'trips', from: FEB1_2025, to: Y2025, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(400);
		expect(calls).toEqual([]);
	});

	it('invalid scope → 400', async () => {
		const { status, calls } = await totals({
			kind: 'trips', scope: 'galaxy', from: Y2025, to: FEB1_2025,
		});
		expect(status).toBe(400);
		expect(calls).toEqual([]);
	});

	it('bin= for kind=trips → 400 (only valid for availability)', async () => {
		const { status, calls } = await totals({
			kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': 'HB101', bin: 3600,
		});
		expect(status).toBe(400);
		expect(calls).toEqual([]);
	});
});

async function totalsHeaders(
	params: Record<string, string | number>,
): Promise<{ status: number; cacheControl: string }> {
	const { default: worker } = await import('./index.js');
	const fix = makeFix();
	const u = new URL('http://test/api/totals');
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const res = await worker.fetch(
		new Request(u.toString()),
		fix.env as never,
		fix.ctx as never,
	);
	await res.text();
	return { status: res.status, cacheControl: res.headers.get('cache-control') ?? '' };
}

describe('Cache-Control: closed-window vs open-window', () => {
	const FROZEN_NOW_MS = 1746230400_000; // 2026-05-03 00:00:00 UTC
	const FROZEN_NOW_S = FROZEN_NOW_MS / 1000;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(FROZEN_NOW_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('closed window (toS far in past) → max-age=86400, immutable', async () => {
		const { status, cacheControl } = await totalsHeaders({
			kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(200);
		expect(cacheControl).toBe('public, max-age=86400, immutable');
	});

	it('open window (toS = now) → max-age=60', async () => {
		const { status, cacheControl } = await totalsHeaders({
			kind: 'trips', from: FROZEN_NOW_S - 3600, to: FROZEN_NOW_S, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(200);
		expect(cacheControl).toBe('public, max-age=60');
	});

	it('window ending at slack boundary (toS = now - 300) still treated as open', async () => {
		const { status, cacheControl } = await totalsHeaders({
			kind: 'trips', from: FROZEN_NOW_S - 7200, to: FROZEN_NOW_S - 300, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(200);
		expect(cacheControl).toBe('public, max-age=60');
	});

	it('window ending just past slack (toS = now - 301) treated as closed', async () => {
		const { status, cacheControl } = await totalsHeaders({
			kind: 'trips', from: FROZEN_NOW_S - 7200, to: FROZEN_NOW_S - 301, 'filter.short_name': 'HB101',
		});
		expect(status).toBe(200);
		expect(cacheControl).toBe('public, max-age=86400, immutable');
	});
});
