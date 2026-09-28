/**
 * `/api/tl` against the live scratch pyramid on `data.ctbk.dev`, no worker in
 * the loop: `serveTl` over `httpStorage` (the same path `wrangler dev
 * --var TL_HTTP_BASE:…` takes). Skipped unless `E2E_RUN=1`:
 *
 *   E2E_RUN=1 pnpm test:e2e src/tl.e2e.test.ts
 *
 * The validation gate from `specs/timelapse-map.md` P0, restated per chunk:
 * Σ over every station of a `1d` frame (+ its `unmapped`) equals the
 * system-wide `/api/rides?bbox=` total for that day, and the 24 `1h` frames
 * of the day re-aggregate to the same number. `TL_E2E_PREFIX` overrides the
 * prefix (default: the 2025-06 scratch build).
 */
import { describe, expect, it } from 'vitest';
import { httpStorage } from './http_storage';
import { chunkRange, frameOf, serveTl, TL_K } from './tl';

const RUN = !!process.env.E2E_RUN;
const DATA_BASE = 'https://data.ctbk.dev';
const RIDES_BASE = process.env.E2E_BASE_URL ?? 'https://ctbk-gbfs-api.hccs-ctbk.workers.dev';
const PREFIX = process.env.TL_E2E_PREFIX ?? 'rides-tl-p0b';
const DAY = Date.UTC(2025, 5, 10);

interface TlResponse {
	bin: string;
	chunk: number;
	k: number;
	t0: string;
	ids: string[];
	counts: number[];
	unmapped: number[];
	partial: boolean;
	covered: [number, number][];
}

async function tl(anchor: string, bin: '1h' | '1d', chunk: number): Promise<TlResponse> {
	const req = new Request(`https://x/api/tl?anchor=${anchor}&bin=${bin}&chunk=${chunk}`);
	const res = await serveTl(httpStorage(DATA_BASE), req, '*', { prefix: PREFIX, canonicalized: false });
	expect(res.status).toBe(200);
	return res.json() as Promise<TlResponse>;
}

/** Σ counts of frame `f` (chunk-relative), plus its unmapped total. */
function frameTotal(r: TlResponse, f: number): number {
	const S = r.ids.length;
	let sum = r.unmapped[f];
	for (let s = 0; s < S; s++) sum += r.counts[f * S + s];
	return sum;
}

async function ridesTotal(anchor: string): Promise<number> {
	const u = new URL('/api/rides', RIDES_BASE);
	u.searchParams.set('anchor', anchor);
	u.searchParams.set('bbox', '40.5,-74.3,41.0,-73.6');
	u.searchParams.set('from', new Date(DAY).toISOString());
	u.searchParams.set('to', new Date(DAY + 86_400_000).toISOString());
	u.searchParams.set('bin', '1d');
	const res = await fetch(u);
	expect(res.status).toBe(200);
	const body = await res.json() as { records: { count: number }[] };
	return body.records.reduce((a, r) => a + r.count, 0);
}

describe.skipIf(!RUN)('/api/tl e2e (data.ctbk.dev)', () => {
	for (const anchor of ['start', 'end']) {
		it(`${anchor}: Σ 1d frame == /api/rides system total == Σ 24 1h frames (2025-06-10)`, async () => {
			const expected = await ridesTotal(anchor);
			const kd = Math.floor(frameOf('1d', DAY) / TL_K['1d']);
			const day = await tl(anchor, '1d', kd);
			expect([day.partial, day.covered, day.t0]).toEqual([false, [[0, 32]], new Date(chunkRange('1d', kd)[0]).toISOString().slice(0, 19)]);
			const fd = frameOf('1d', DAY) - kd * TL_K['1d'];
			expect(frameTotal(day, fd)).toBe(expected);

			const kh = Math.floor(frameOf('1h', DAY) / TL_K['1h']);
			const hours = await tl(anchor, '1h', kh);
			expect([hours.partial, hours.covered]).toEqual([false, [[0, 48]]]);
			const fh = frameOf('1h', DAY) - kh * TL_K['1h'];
			let sum = 0;
			for (let f = fh; f < fh + 24; f++) sum += frameTotal(hours, f);
			expect(sum).toBe(expected);
		});
	}
});
