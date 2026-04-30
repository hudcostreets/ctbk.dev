/**
 * E2E tests for `/api/totals` against a live worker.
 *
 * Skipped by default. Set `E2E_BASE_URL` (or `E2E_RUN=1` for the default URL)
 * to run them. Examples:
 *
 *   E2E_RUN=1 pnpm test src/totals.e2e.test.ts
 *   E2E_BASE_URL=http://localhost:8787 pnpm test src/totals.e2e.test.ts
 *
 * Asserts response shape and tier-routing across the full (tier × scope ×
 * metric) matrix. Avoids exact value assertions because the data grows
 * monthly; uses sanity bands (count > 0, mean ride 30s-1d, etc.) instead.
 */
import { describe, expect, it } from 'vitest';
import type { TotalsResponse } from './totals.js';

const DEFAULT_BASE = 'https://ctbk-gbfs-api.ryan-0dc.workers.dev';
const BASE = process.env.E2E_BASE_URL ?? (process.env.E2E_RUN ? DEFAULT_BASE : '');

const HB101 = 'HB101';
const HB102 = 'HB102';

// Anchor windows (UTC unix seconds). Pick stable historical ranges so row
// counts can be loosely asserted without breaking when new months land.
const Y2024 = 1704067200; // 2024-01-01
const Y2025 = 1735689600; // 2025-01-01
const FEB1_2025 = 1738368000; // 2025-02-01
const JAN8_2025 = 1736294400; // 2025-01-08
const Y2018 = 1514764800; // 2018-01-01 (cross-decade with Y2025)
const Y2014 = 1388534400; // 2014-01-01 (within 2010s decade)
const Y2015 = 1420070400; // 2015-01-01

async function totals(params: Record<string, string | number>): Promise<TotalsResponse> {
	const u = new URL('/api/totals', BASE);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const r = await fetch(u.toString());
	const body = await r.text();
	expect(r.status, `${u}: ${body}`).toBe(200);
	return JSON.parse(body) as TotalsResponse;
}

async function totalsExpectStatus(
	params: Record<string, string | number>,
	status: number,
): Promise<string> {
	const u = new URL('/api/totals', BASE);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	const r = await fetch(u.toString());
	const body = await r.text();
	expect(r.status, `${u}: ${body}`).toBe(status);
	return body;
}

function assertSumRow(row: Record<string, unknown>) {
	expect(typeof row.count).toBe('number');
	expect(typeof row.duration_s).toBe('number');
	expect(typeof row.duration_s_sq).toBe('number');
	const count = row.count as number;
	const duration_s = row.duration_s as number;
	const duration_s_sq = row.duration_s_sq as number;
	expect(count).toBeGreaterThan(0);
	expect(duration_s).toBeGreaterThan(0);
	expect(duration_s_sq).toBeGreaterThan(0);
	// Mean ride duration: 30s ≤ mean ≤ 1 day (sanity, not exact).
	const mean = duration_s / count;
	expect(mean).toBeGreaterThan(30);
	expect(mean).toBeLessThan(86400);
	// Variance non-negative: E[X²] ≥ (E[X])²  ⇔  duration_s_sq*count ≥ duration_s².
	expect(duration_s_sq * count).toBeGreaterThanOrEqual(duration_s * duration_s);
}

describe.skipIf(!BASE)('totals e2e (live worker)', () => {
	describe('per-station agg-tier (kind=trips, scope=stations, filter.short_name)', () => {
		it('h1 tier: 1-week window → tier=h1, rows non-empty, sum-monoid invariants hold', async () => {
			const r = await totals({ kind: 'trips', from: Y2025, to: JAN8_2025, 'filter.short_name': HB101 });
			expect(r.kind).toBe('trips');
			expect(r.scope).toBe('stations');
			expect(r.tier).toBe('h1');
			expect(r.rows.length).toBe(1);
			expect(r.rows[0].short_name).toBe(HB101);
			assertSumRow(r.rows[0]);
		});

		it('d1 tier: 1-month window → tier=d1', async () => {
			const r = await totals({ kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': HB101 });
			expect(r.tier).toBe('d1');
			expect(r.rows.length).toBe(1);
			assertSumRow(r.rows[0]);
		});

		it('mo1 tier: 1-year window → tier=mo1, single decade key', async () => {
			const r = await totals({ kind: 'trips', from: Y2024, to: Y2025, 'filter.short_name': HB101 });
			expect(r.tier).toBe('mo1');
			expect(r.rows.length).toBe(1);
			assertSumRow(r.rows[0]);
		});

		it('mo1 tier: cross-decade window → tier=mo1, both decade files merged', async () => {
			const r = await totals({ kind: 'trips', from: Y2018, to: Y2025, 'filter.short_name': HB101 });
			expect(r.tier).toBe('mo1');
			expect(r.rows.length).toBe(1);
			assertSumRow(r.rows[0]);
			// Cross-decade total should exceed the 1-year subset (basic monotonicity).
			const subset = await totals({ kind: 'trips', from: Y2024, to: Y2025, 'filter.short_name': HB101 });
			expect((r.rows[0].count as number)).toBeGreaterThan(subset.rows[0].count as number);
		});

		it('multi-station filter: returns one row per station', async () => {
			const r = await totals({
				kind: 'trips', from: Y2025, to: FEB1_2025,
				'filter.short_name': `${HB101},${HB102}`,
			});
			expect(r.tier).toBe('d1');
			const names = new Set(r.rows.map((row) => row.short_name as string));
			expect(names.has(HB101)).toBe(true);
			expect(names.has(HB102)).toBe(true);
			for (const row of r.rows) assertSumRow(row);
		});

		it('metric=duration_s: same sum-fields populated regardless of metric param', async () => {
			const r1 = await totals({ kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': HB101, metric: 'count' });
			const r2 = await totals({ kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': HB101, metric: 'duration_s' });
			const r3 = await totals({ kind: 'trips', from: Y2025, to: FEB1_2025, 'filter.short_name': HB101, metric: 'duration_s_sq' });
			expect(r1.rows[0].count).toBe(r2.rows[0].count);
			expect(r1.rows[0].duration_s).toBe(r2.rows[0].duration_s);
			expect(r1.rows[0].duration_s).toBe(r3.rows[0].duration_s);
			expect(r1.metric).toBe('count');
			expect(r2.metric).toBe('duration_s');
			expect(r3.metric).toBe('duration_s_sq');
		});

		it('historical h1 (2014): old data also flows through agg tier', async () => {
			const r = await totals({ kind: 'trips', from: Y2014, to: Y2015, 'filter.short_name': HB101 });
			expect(r.tier).toBe('mo1');
			// HB101 may not exist in 2014; allow empty rows here.
			if (r.rows.length > 0) assertSumRow(r.rows[0]);
		});
	});

	describe('non-station scopes (fall through to per-region fallback)', () => {
		// Per `specs/trips-agg.md` "Out of scope": scope=regions currently returns
		// zero rows because per-region files don't carry a `region` column. Flip
		// to `it(...)` once the deferred fix lands.
		it.skip('scope=regions: tier=fallback-regions, rows non-empty', async () => {
			const r = await totals({ kind: 'trips', from: Y2025, to: FEB1_2025, scope: 'regions' });
			expect(r.tier).toBe('fallback-regions');
			expect(r.rows.length).toBeGreaterThan(0);
		});

		it('scope=regions today: routes to fallback, returns empty rows (documented limitation)', async () => {
			const r = await totals({ kind: 'trips', from: Y2025, to: FEB1_2025, scope: 'regions' });
			expect(r.tier).toBe('fallback-regions');
			expect(r.rows.length).toBe(0);
		});
	});

	describe('input validation (4xx without hitting R2)', () => {
		it('missing kind → 400', async () => {
			await totalsExpectStatus({ from: Y2025, to: FEB1_2025 }, 400);
		});

		it('invalid metric for trips → 400', async () => {
			await totalsExpectStatus(
				{ kind: 'trips', metric: 'bikes', from: Y2025, to: FEB1_2025, 'filter.short_name': HB101 },
				400,
			);
		});

		it('from > to → 400', async () => {
			await totalsExpectStatus(
				{ kind: 'trips', from: FEB1_2025, to: Y2025, 'filter.short_name': HB101 },
				400,
			);
		});
	});

	describe('cache headers', () => {
		it('warm request returns cache-control with public,max-age', async () => {
			const u = new URL('/api/totals', BASE);
			u.searchParams.set('kind', 'trips');
			u.searchParams.set('from', String(Y2025));
			u.searchParams.set('to', String(FEB1_2025));
			u.searchParams.set('filter.short_name', HB101);
			// First request primes edge cache; second should be hit (or at least not error).
			await fetch(u.toString());
			const r = await fetch(u.toString());
			expect(r.status).toBe(200);
			const cc = r.headers.get('cache-control') ?? '';
			expect(cc).toMatch(/max-age/);
		});
	});
});
