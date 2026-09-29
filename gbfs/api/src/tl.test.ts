import { describe, expect, it } from 'vitest';
import { memStorage } from 'pyrmts';
import { parseCanonMap } from './canon';
import {
	chunkRange, coveredFrames, finerTiers, frameOf, frameStartMs, latestShards, originMs, pivotFrames, planCover,
	resolveCell, serveTl, TL_GENESIS_MS, type TlShard,
} from './tl';

const D = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

describe('frame grid', () => {
	it('origin = genesis floored to the K·bin grid (epoch-aligned fixed spans, year-0 months)', () => {
		expect(originMs('1h')).toBe(D(2013, 5, 31));
		expect(originMs('3h')).toBe(D(2013, 5, 31));
		expect(originMs('6h')).toBe(D(2013, 5, 31));
		expect(originMs('12h')).toBe(D(2013, 5, 31));
		expect(originMs('1d')).toBe(D(2013, 5, 15));
		expect(originMs('3d')).toBe(D(2013, 5, 15));
		expect(originMs('7d')).toBe(D(2012, 12, 6));
		expect(originMs('14d')).toBe(D(2012, 12, 6));
		expect(originMs('1mo')).toBe(D(2012, 1, 1));
	});
	it('genesis frame indexes', () => {
		expect(frameOf('1h', TL_GENESIS_MS)).toBe(24);
		expect(frameOf('1d', TL_GENESIS_MS)).toBe(17);
		expect(frameOf('3d', TL_GENESIS_MS)).toBe(5);
		expect(frameOf('7d', TL_GENESIS_MS)).toBe(25);
		expect(frameOf('1mo', TL_GENESIS_MS)).toBe(17);
	});
	it('frameOf / frameStartMs / chunkRange land on the shard grid', () => {
		expect(frameOf('1d', D(2025, 6, 10))).toBe(4409);
		expect(frameOf('1d', D(2025, 6, 10, 23))).toBe(4409);
		expect(frameStartMs('1d', 4409)).toBe(D(2025, 6, 10));
		expect(chunkRange('1d', 137)).toEqual([D(2025, 5, 16), D(2025, 6, 17)]);
		expect(chunkRange('1d', 138)).toEqual([D(2025, 6, 17), D(2025, 7, 19)]);
		expect(frameOf('1h', D(2025, 6, 10, 8))).toBe(105440);
		expect(chunkRange('1h', 2196)).toEqual([D(2025, 6, 9), D(2025, 6, 11)]);
		expect(chunkRange('1h', 2206)).toEqual([D(2025, 6, 29), D(2025, 7, 1)]);
		expect(frameOf('1mo', D(2025, 6, 1))).toBe(161);
		expect(frameOf('1mo', D(2025, 6, 30, 23))).toBe(161);
		expect(frameStartMs('1mo', 161)).toBe(D(2025, 6, 1));
		expect(chunkRange('1mo', 6)).toEqual([D(2024, 1, 1), D(2026, 1, 1)]);
		expect(chunkRange('1mo', 0)).toEqual([D(2012, 1, 1), D(2014, 1, 1)]);
	});
	it('finerTiers: dividing fixed tiers, coarsest first; whole-day-nesting tiers for 1mo', () => {
		expect(finerTiers('1h')).toEqual([]);
		expect(finerTiers('3h')).toEqual(['1h']);
		expect(finerTiers('1d')).toEqual(['12h', '6h', '3h', '1h']);
		expect(finerTiers('3d')).toEqual(['1d', '12h', '6h', '3h', '1h']);
		expect(finerTiers('7d')).toEqual(['1d', '12h', '6h', '3h', '1h']);
		expect(finerTiers('14d')).toEqual(['7d', '1d', '12h', '6h', '3h', '1h']);
		expect(finerTiers('1mo')).toEqual(['1d', '12h', '6h', '3h', '1h']);
	});
});

// The 2025-06 scratch build's `start` manifest (`rides-tl-p0b`, P0 results),
// minus md5s: the min-cover of one month.
const P0B: TlShard[] = [
	{ tier: '1h', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'p/start/1h/32d/2025-05-16.aa.parquet', written_at: 1, bytes: 1982338 },
	{ tier: '1h', shard_dur: '8d', period_start: D(2025, 6, 17), period_end: D(2025, 6, 25), key: 'p/start/1h/8d/2025-06-17.aa.parquet', written_at: 1, bytes: 1027644 },
	{ tier: '1h', shard_dur: '4d', period_start: D(2025, 6, 25), period_end: D(2025, 6, 29), key: 'p/start/1h/4d/2025-06-25.aa.parquet', written_at: 1, bytes: 535853 },
	{ tier: '1h', shard_dur: '2d', period_start: D(2025, 6, 29), period_end: D(2025, 7, 1), key: 'p/start/1h/2d/2025-06-29.aa.parquet', written_at: 1, bytes: 236518 },
	{ tier: '3h', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'p/start/3h/32d/2025-05-16.aa.parquet', written_at: 1, bytes: 939075 },
	{ tier: '3h', shard_dur: '8d', period_start: D(2025, 6, 17), period_end: D(2025, 6, 25), key: 'p/start/3h/8d/2025-06-17.aa.parquet', written_at: 1, bytes: 486801 },
	{ tier: '3h', shard_dur: '4d', period_start: D(2025, 6, 25), period_end: D(2025, 6, 29), key: 'p/start/3h/4d/2025-06-25.aa.parquet', written_at: 1, bytes: 243695 },
	{ tier: '6h', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'p/start/6h/32d/2025-05-16.aa.parquet', written_at: 1, bytes: 545816 },
	{ tier: '6h', shard_dur: '8d', period_start: D(2025, 6, 17), period_end: D(2025, 6, 25), key: 'p/start/6h/8d/2025-06-17.aa.parquet', written_at: 1, bytes: 268073 },
	{ tier: '12h', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'p/start/12h/32d/2025-05-16.aa.parquet', written_at: 1, bytes: 338562 },
	{ tier: '1d', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'p/start/1d/32d/2025-05-16.aa.parquet', written_at: 1, bytes: 219906 },
	{ tier: '3d', shard_dur: '96d', period_start: D(2025, 3, 13), period_end: D(2025, 6, 17), key: 'p/start/3d/96d/2025-03-13.aa.parquet', written_at: 1, bytes: 101561 },
	{ tier: '1mo', shard_dur: '1mo', period_start: D(2025, 6, 1), period_end: D(2025, 7, 1), key: 'p/start/1mo/1mo/2025-06.aa.parquet', written_at: 1, bytes: 46238 },
];
const shard = (key: string) => P0B.find((s) => s.key.includes(key))!;

describe('latestShards', () => {
	it('keeps the latest written_at per (tier, shard_dur, period_start); accepts ISO or ms', () => {
		const text = [
			JSON.stringify({ tier: '1d', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'a/old.parquet', written_at: 1000, bytes: 1 }),
			JSON.stringify({ tier: '1d', shard_dur: '32d', period_start: '2025-05-16T00:00:00Z', period_end: '2025-06-17T00:00:00Z', key: 'a/new.parquet', written_at: '1970-01-01T00:00:02Z', bytes: 2 }),
			'',
			JSON.stringify({ tier: '1d', shard_dur: '64d', period_start: D(2025, 5, 16), period_end: D(2025, 7, 19), key: 'a/big.parquet', written_at: 500, bytes: 3 }),
		].join('\n');
		expect(latestShards(text)).toEqual([
			{ tier: '1d', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'a/new.parquet', written_at: 2000, bytes: 2 },
			{ tier: '1d', shard_dur: '64d', period_start: D(2025, 5, 16), period_end: D(2025, 7, 19), key: 'a/big.parquet', written_at: 500, bytes: 3 },
		]);
	});
});

describe('planCover', () => {
	it('1d chunk 137 = exactly the 1d@32d shard', () => {
		expect(planCover(P0B, '1d', ...chunkRange('1d', 137))).toEqual({
			reads: [{ shard: shard('1d/32d'), from: D(2025, 5, 16), to: D(2025, 6, 17) }],
			gaps: [],
		});
	});
	it('1d chunk 138: the tip min-cover re-aggregates finer rungs; the rest is a gap', () => {
		expect(planCover(P0B, '1d', ...chunkRange('1d', 138))).toEqual({
			reads: [
				{ shard: shard('6h/8d'), from: D(2025, 6, 17), to: D(2025, 6, 25) },
				{ shard: shard('3h/4d'), from: D(2025, 6, 25), to: D(2025, 6, 29) },
				{ shard: shard('1h/2d'), from: D(2025, 6, 29), to: D(2025, 7, 1) },
			],
			gaps: [[D(2025, 7, 1), D(2025, 7, 19)]],
		});
	});
	it('1h chunks read one rung each', () => {
		expect(planCover(P0B, '1h', ...chunkRange('1h', 2196))).toEqual({
			reads: [{ shard: shard('1h/32d'), from: D(2025, 6, 9), to: D(2025, 6, 11) }],
			gaps: [],
		});
		expect(planCover(P0B, '1h', ...chunkRange('1h', 2206))).toEqual({
			reads: [{ shard: shard('1h/2d'), from: D(2025, 6, 29), to: D(2025, 7, 1) }],
			gaps: [],
		});
	});
	it('larger rung wins where rungs overlap; a shard serves only its uncovered sub-ranges', () => {
		const big: TlShard = { tier: '1d', shard_dur: '64d', period_start: D(2025, 5, 16), period_end: D(2025, 7, 19), key: 'p/start/1d/64d/2025-05-16.aa.parquet', written_at: 1, bytes: 1 };
		const late: TlShard = { tier: '1d', shard_dur: '32d', period_start: D(2025, 7, 19), period_end: D(2025, 8, 20), key: 'p/start/1d/32d/2025-07-19.aa.parquet', written_at: 1, bytes: 1 };
		expect(planCover([...P0B, big, late], '1d', ...chunkRange('1d', 138))).toEqual({
			reads: [{ shard: big, from: D(2025, 6, 17), to: D(2025, 7, 19) }],
			gaps: [],
		});
		expect(planCover([...P0B, big, late], '1d', ...chunkRange('1d', 139))).toEqual({
			reads: [{ shard: late, from: D(2025, 7, 19), to: D(2025, 8, 20)}],
			gaps: [],
		});
	});
	it('1mo chunk 6 (= the 2024–25 `1mo@2y` rung): the month shard, finer rungs only where the month tier is absent', () => {
		expect(planCover(P0B, '1mo', ...chunkRange('1mo', 6))).toEqual({
			reads: [
				{ shard: shard('1d/32d'), from: D(2025, 5, 16), to: D(2025, 6, 1) },
				{ shard: shard('1mo/1mo'), from: D(2025, 6, 1), to: D(2025, 7, 1) },
			],
			gaps: [[D(2024, 1, 1), D(2025, 5, 16)], [D(2025, 7, 1), D(2026, 1, 1)]],
		});
	});
	it('nothing covers → one gap', () => {
		expect(planCover(P0B, '1d', ...chunkRange('1d', 100))).toEqual({ reads: [], gaps: [chunkRange('1d', 100)] });
	});
});

describe('coveredFrames', () => {
	it('merges adjacent reads into frame spans relative to the chunk', () => {
		expect(coveredFrames(planCover(P0B, '1d', ...chunkRange('1d', 138)), '1d', 138)).toEqual([[0, 14]]);
		expect(coveredFrames(planCover(P0B, '1mo', ...chunkRange('1mo', 6)), '1mo', 6)).toEqual([[16, 18]]);
		expect(coveredFrames(planCover(P0B, '1d', ...chunkRange('1d', 100)), '1d', 100)).toEqual([]);
	});
});

const CANON = parseCanonMap({
	's:6148.01': 'c:6148.02',
	's:6148.02': 'c:6148.02',
});

describe('resolveCell', () => {
	it('pre-canonicalize: canonical folds merged leaves via the id-map', () => {
		expect(resolveCell('s:6148.01', CANON, 'canonical', false)).toBe('6148.02');
		expect(resolveCell('s:6148.02', CANON, 'canonical', false)).toBe('6148.02');
		expect(resolveCell('s:5000.01', CANON, 'canonical', false)).toBe('5000.01');
		expect(resolveCell('89c25', CANON, 'canonical', false)).toBeNull();
	});
	it('canonicalized: c: rows as-is, merged members skipped', () => {
		expect(resolveCell('c:6148.02', CANON, 'canonical', true)).toBe('6148.02');
		expect(resolveCell('s:6148.01', CANON, 'canonical', true)).toBeUndefined();
		expect(resolveCell('s:5000.01', CANON, 'canonical', true)).toBe('5000.01');
	});
	it('raw: s: leaves verbatim, c: rollups skipped', () => {
		expect(resolveCell('s:6148.01', CANON, 'raw', true)).toBe('6148.01');
		expect(resolveCell('c:6148.02', CANON, 'raw', true)).toBeUndefined();
		expect(resolveCell('89c25', null, 'raw', false)).toBeNull();
	});
});

describe('pivotFrames', () => {
	const rows = [
		{ cell: 's:6148.01', dt: D(2025, 6, 9), count: 2 },
		{ cell: 's:6148.02', dt: D(2025, 6, 9), count: 3 },
		{ cell: 's:5000.01', dt: D(2025, 6, 10), count: 7 },
		{ cell: 's:5000.01', dt: D(2025, 6, 10, 6), count: 1 },  // a 6h row re-aggregates into the 1d frame
		{ cell: '89c25', dt: D(2025, 6, 10), count: 5 },
		{ cell: 's:zzz', dt: D(2025, 5, 15), count: 9 },          // before the chunk
		{ cell: 's:zzz', dt: D(2025, 6, 17), count: 9 },          // after the chunk
	];
	it('canonical, pre-canonicalize: dense K×S, ids sorted, merged folded, unmapped per frame', () => {
		const block = pivotFrames(rows, '1d', 137, CANON, 'canonical', false);
		const counts = new Array<number>(32 * 2).fill(0);
		counts[24 * 2 + 1] = 5;   // 6148.02 @ 2025-06-09 (frame 24 of chunk 137)
		counts[25 * 2 + 0] = 8;   // 5000.01 @ 2025-06-10
		const unmapped = new Array<number>(32).fill(0);
		unmapped[25] = 5;
		expect(block).toEqual({ ids: ['5000.01', '6148.02'], counts, unmapped });
	});
	it('raw: members separate', () => {
		const block = pivotFrames(rows, '1d', 137, CANON, 'raw', false);
		const counts = new Array<number>(32 * 3).fill(0);
		counts[24 * 3 + 1] = 2;
		counts[24 * 3 + 2] = 3;
		counts[25 * 3 + 0] = 8;
		const unmapped = new Array<number>(32).fill(0);
		unmapped[25] = 5;
		expect(block).toEqual({ ids: ['5000.01', '6148.01', '6148.02'], counts, unmapped });
	});
	it('empty', () => {
		expect(pivotFrames([], '1h', 0, null, 'canonical', false)).toEqual({ ids: [], counts: [], unmapped: new Array<number>(48).fill(0) });
	});
});

describe('serveTl', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	const storage = memStorage(new Map([
		['tl/start/manifest.jsonl', enc(JSON.stringify({ tier: '1d', shard_dur: '32d', period_start: D(2025, 5, 16), period_end: D(2025, 6, 17), key: 'tl/start/1d/32d/x.parquet', written_at: 1, bytes: 1 }))],
		['stations/station-canonicalize-map.json', enc('{}')],
	]));
	const cfg = { prefix: 'tl', canonicalized: false };
	const req = (qs: string) => new Request(`https://x/api/tl?${qs}`);
	const now = () => D(2026, 9, 28);

	it('400s on bad params', async () => {
		const cases: [string, string][] = [
			['anchor=mid&bin=1d&chunk=1', "bad anchor 'mid'; one of start|end"],
			['bin=5d&chunk=1', "bad bin '5d'; one of 1h|3h|6h|12h|1d|3d|7d|14d|1mo"],
			['bin=1d', "chunk query param required (non-negative integer); got 'null'"],
			['bin=1d&chunk=-1', "chunk query param required (non-negative integer); got '-1'"],
			['bin=1d&chunk=1.5', "chunk query param required (non-negative integer); got '1.5'"],
			['bin=1d&chunk=1&raw=2', "bad raw '2'; expected 0|1"],
		];
		for (const [qs, error] of cases) {
			const res = await serveTl(storage, req(qs), '*', cfg, now);
			expect([res.status, await res.json()]).toEqual([400, { error }]);
		}
	});
	it('404 when the anchor has no manifest', async () => {
		const res = await serveTl(storage, req('anchor=end&bin=1d&chunk=137'), '*', cfg, now);
		expect([res.status, await res.json()]).toEqual([404, { error: 'tl/end/manifest.jsonl not found' }]);
	});
	it('an uncovered chunk is an empty, partial, short-cached block', async () => {
		const res = await serveTl(storage, req('bin=1d&chunk=100'), '*', cfg, now);
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await res.json()).toEqual({
			anchor: 'start',
			bin: '1d',
			chunk: 100,
			k: 32,
			t0: '2022-02-17T00:00:00',
			t1: '2022-03-21T00:00:00',
			ids: [],
			counts: [],
			unmapped: new Array<number>(32).fill(0),
			partial: true,
			covered: [],
			plan: { reads: [], gaps: [['2022-02-17T00:00:00', '2022-03-21T00:00:00']] },
		});
	});
});
