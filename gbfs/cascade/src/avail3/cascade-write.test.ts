// Tests for the same-tier "consolidate the dust" writer path
// (`planDustTiling` + `writeShard`'s same-tier branch).
//
// Regression suite for the 2026-07-09 prod wedge: the previous
// prev-rung × k source rule required shards that the min-cover never
// materializes (a closing rung's LAST constituent closes and is
// superseded in the same tick), so every consolidation wedged with
// `no_inputs` from the first 10min rung on up.
import { describe, test, expect } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import type { Duration, ExpectedShard } from 'pyrmts';
import { planDustTiling, writeShard, shardKey } from './cascade';
import { streamShardRows, writeShardRows } from './aggregate';
import type { AvailV3Row } from './transform';
import type { LucIndex } from './luc';
import { makeR2 } from './mock-r2';

const MIN = 60_000;
const ms = (iso: string) => Date.parse(iso);

function availRow(s2_cell: string, dtMs: number, bikes: Record<number, number>): AvailV3Row {
	return {
		s2_cell, dt: BigInt(dtMs),
		bikes: JSON.stringify(bikes),
		ebikes: '{}', docks: '{}', disabled: '{}', pending: '{}',
	};
}

async function collect(gen: AsyncGenerator<AvailV3Row>): Promise<AvailV3Row[]> {
	const out: AvailV3Row[] = [];
	for await (const r of gen) out.push(r);
	return out;
}

describe('planDustTiling', () => {
	const probeFrom = (existing: Set<string>) =>
		async (rung: Duration, startMs: number) =>
			existing.has(`${rung}@${startMs}`) ? { size: 1000 } : null;

	test('steady-state midnight consolidation: dust tiles + one finest-rung tail hole', async () => {
		// /1m@12h closing at 2026-07-09T00:00Z. The dust that accumulated
		// over [12:00, 24:00) — each shard was written when it entered the
		// min-cover; the instantly-superseded "last constituents"
		// (6h@18:00, 3h@21:00, 1h@23:00, 30min@23:30, 10min@23:50,
		// 5min@23:55) never existed.
		const S = ms('2026-07-08T12:00:00Z');
		const E = ms('2026-07-09T00:00:00Z');
		const existing = new Set([
			`6h@${S}`,
			`3h@${S + 360 * MIN}`,      // 18:00
			`1h@${S + 540 * MIN}`,      // 21:00
			`1h@${S + 600 * MIN}`,      // 22:00
			`30min@${S + 660 * MIN}`,   // 23:00
			`10min@${S + 690 * MIN}`,   // 23:30
			`10min@${S + 700 * MIN}`,   // 23:40
			`5min@${S + 710 * MIN}`,    // 23:50
		]);
		const finer: Duration[] = ['5min', '10min', '30min', '1h', '3h', '6h'];
		const { tiles, holes, aborted } = await planDustTiling(finer, S, E, probeFrom(existing));
		expect(aborted).toBe(false);
		expect(tiles.map((t) => `${t.rung}@${(t.startMs - S) / MIN}min`)).toEqual([
			'6h@0min', '3h@360min', '1h@540min', '1h@600min',
			'30min@660min', '10min@690min', '10min@700min', '5min@710min',
		]);
		// One hole: the 5min last-constituent [23:55, 24:00).
		expect(holes).toEqual([[S + 715 * MIN, E]]);
	});

	test('complete prev-rung × k dust needs no holes', async () => {
		const S = ms('2026-07-09T00:30:00Z');
		const existing = new Set([`5min@${S}`, `5min@${S + 5 * MIN}`]);
		const { tiles, holes, aborted } = await planDustTiling(['5min'], S, S + 10 * MIN, probeFrom(existing));
		expect(aborted).toBe(false);
		expect(tiles.map((t) => `${t.rung}@${t.startMs}`)).toEqual([`5min@${S}`, `5min@${S + 5 * MIN}`]);
		expect(holes).toEqual([]);
	});

	test('nothing existing coalesces into a single full-period hole', async () => {
		const S = ms('2026-07-09T00:00:00Z');
		const E = S + 720 * MIN;
		const { tiles, holes, aborted } = await planDustTiling(
			['5min', '10min', '30min', '1h', '3h', '6h'], S, E, probeFrom(new Set()));
		expect(aborted).toBe(false);
		expect(tiles).toEqual([]);
		expect(holes).toEqual([[S, E]]);
	});

	test('alternating existing/missing (degraded backlog) aborts at MAX_TILES', async () => {
		// Mimics the post-wedge backlog: only first-half 5min shards exist.
		const S = ms('2026-07-09T00:00:00Z');
		const E = S + 720 * MIN;
		const existing = new Set<string>();
		for (let t = S; t < E; t += 10 * MIN) existing.add(`5min@${t}`);
		const { aborted } = await planDustTiling(['5min'], S, E, probeFrom(existing));
		expect(aborted).toBe(true);
	});
});

// ─── writeShard same-tier integration (mock R2) ─────────────────────

const lucStub = { chains: new Map([['st1', ['aa', 'ab']]]) } as LucIndex;

/** Raw loader-format minute parquet: one row per station with
 *  `{metric}_n` / `{metric}_sum` columns and `dt` in SECONDS. */
function putRawMinute(r2: ReturnType<typeof makeR2>, tIso: string, bikesValue: number): void {
	const t = new Date(tIso);
	const dateStr = t.toISOString().slice(0, 10);
	const hh = String(t.getUTCHours()).padStart(2, '0');
	const mm = String(t.getUTCMinutes()).padStart(2, '0');
	const key = `gbfs/avail/agg=1m/cons=1m/${dateStr}/${hh}${mm}.parquet`;
	const buf = parquetWriteBuffer({
		columnData: [
			{ name: 'station_id', data: ['st1'], type: 'STRING' },
			{ name: 'dt', data: [Math.floor(t.getTime() / 1000)], type: 'INT32' },
			{ name: 'bikes_n', data: [1], type: 'INT32' },
			{ name: 'bikes_sum', data: [bikesValue], type: 'INT32' },
		],
	});
	void r2.put(key, buf);
}

describe('writeShard same-tier consolidation', () => {
	test('wedge repro: /1m@10min from one 5min tile + raw-WAL hole fill', async () => {
		// The exact prod-wedge shape: 5min@00:30 exists (was dust for one
		// tick), 5min@00:35 never materialized. Old prev-rung × 2 rule →
		// no_inputs forever. New rule: tile [00:30, 00:35) from the shard,
		// fill [00:35, 00:40) from raw minutes.
		const r2 = makeR2();
		const S = ms('2026-07-09T00:30:00Z');
		const rows: AvailV3Row[] = [];
		for (let i = 0; i < 5; i++) {
			rows.push(availRow('aa', S + i * MIN, { 5: 1 }));
			rows.push(availRow('ab', S + i * MIN, { 5: 1 }));
		}
		await writeShardRows(r2 as never, shardKey('1m', '5min', new Date(S)), rows);
		for (let i = 5; i < 10; i++) {
			putRawMinute(r2, new Date(S + i * MIN).toISOString(), 7);
		}

		const result = await writeShard(
			r2 as never, lucStub, '1m', '10min',
			new Date(S), new Date(S), new Date(S + 10 * MIN), new Map());
		expect(result.status).toBe('wrote');
		// 1 tile + 5 raw minutes, all present.
		expect(result.inputsExpected).toBe(6);
		expect(result.inputsPresent).toBe(6);

		const written = await collect(streamShardRows(r2 as never, result.key));
		// 2 cells × 10 minutes; first 5 minutes from the tile ({5:1}),
		// last 5 from raw ({7:1}).
		const byCell = (cell: string) => written
			.filter((r) => r.s2_cell === cell)
			.map((r) => [Number(r.dt - BigInt(S)) / MIN, r.bikes]);
		const expected = [
			...[0, 1, 2, 3, 4].map((m) => [m, '{"5":1}']),
			...[5, 6, 7, 8, 9].map((m) => [m, '{"7":1}']),
		];
		expect(byCell('aa')).toEqual(expected);
		expect(byCell('ab')).toEqual(expected);
	});

	test('/1m no_inputs when the hole has no raw data', async () => {
		const r2 = makeR2();
		const S = ms('2026-07-09T00:30:00Z');
		await writeShardRows(r2 as never, shardKey('1m', '5min', new Date(S)),
			[availRow('aa', S, { 5: 1 })]);
		// No raw minutes for [00:35, 00:40).
		const result = await writeShard(
			r2 as never, lucStub, '1m', '10min',
			new Date(S), new Date(S), new Date(S + 10 * MIN), new Map());
		expect(result.status).toBe('no_inputs');
	});

	test('/2m@30min: same-tier tiles + cross-tier hole fill, clipped + rebinned', async () => {
		// /2m@10min tiles exist for [00:00, 00:20); the hole [00:20, 00:30)
		// fills from a /1m@30min cover shard spanning the WHOLE period —
		// its rows outside the hole must be clipped (the tiles already
		// cover them), and its 1min rows must rebin to 2min buckets.
		const r2 = makeR2();
		const S = ms('2026-07-09T00:00:00Z');
		for (const tileStart of [S, S + 10 * MIN]) {
			const rows: AvailV3Row[] = [];
			for (let t = tileStart; t < tileStart + 10 * MIN; t += 2 * MIN) {
				rows.push(availRow('aa', t, { 4: 2 }));
			}
			await writeShardRows(r2 as never, shardKey('2m', '10min', new Date(tileStart)), rows);
		}
		const srcKey = shardKey('1m', '30min', new Date(S));
		const srcRows: AvailV3Row[] = [];
		for (let t = S; t < S + 30 * MIN; t += MIN) {
			srcRows.push(availRow('aa', t, { 9: 1 }));
		}
		await writeShardRows(r2 as never, srcKey, srcRows);
		const expectedByTier = new Map<string, ExpectedShard[]>([['1m', [{
			tier: '1m', shardDur: '30min' as Duration,
			periodStart: new Date(S), periodEnd: new Date(S + 30 * MIN),
			effectiveStart: new Date(S), effectiveEnd: new Date(S + 30 * MIN),
			key: srcKey,
		}]]]);

		const result = await writeShard(
			r2 as never, lucStub, '2m', '30min',
			new Date(S), new Date(S), new Date(S + 30 * MIN), expectedByTier);
		expect(result.status).toBe('wrote');
		// 2 tiles + 1 hole-fill source.
		expect(result.inputsExpected).toBe(3);
		expect(result.inputsPresent).toBe(3);

		const written = await collect(streamShardRows(r2 as never, result.key));
		// [00:00, 00:20): tile rows pass through untouched ({4:2} per 2min).
		// [00:20, 00:30): hole-filled from /1m — two 1min rows fold into
		// each 2min bucket ({9:2}). No double counting in the tiled range.
		expect(written.map((r) => [Number(r.dt - BigInt(S)) / MIN, r.bikes])).toEqual([
			...[0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((m) => [m, '{"4":2}']),
			...[20, 22, 24, 26, 28].map((m) => [m, '{"9":2}']),
		]);
	});

	test('fragmented dust falls back to pure cross-tier fill (wedge-scar heal)', async () => {
		// Wedge-day scar: /2m@12h whose window has only alternating 10min
		// fragments (36 tiles + 36 holes > MAX_TILES). The tiling is
		// abandoned wholesale and the period fills purely from the /1m
		// cover shard — output must reflect ONLY the cross-tier source
		// (no double-count from the discarded fragments).
		const r2 = makeR2();
		const S = ms('2026-07-09T00:00:00Z');
		const E = S + 720 * MIN;
		for (let t = S; t < E; t += 20 * MIN) {
			// Fragment content deliberately distinct ({1:1}) from the /1m
			// source ({9:1}) so double-counting would be visible.
			await writeShardRows(r2 as never, shardKey('2m', '10min', new Date(t)),
				[availRow('aa', t, { 1: 1 })]);
		}
		const srcKey = shardKey('1m', '12h', new Date(S));
		const srcRows: AvailV3Row[] = [];
		for (let t = S; t < E; t += MIN) {
			srcRows.push(availRow('aa', t, { 9: 1 }));
		}
		await writeShardRows(r2 as never, srcKey, srcRows);
		const expectedByTier = new Map<string, ExpectedShard[]>([['1m', [{
			tier: '1m', shardDur: '12h' as Duration,
			periodStart: new Date(S), periodEnd: new Date(E),
			effectiveStart: new Date(S), effectiveEnd: new Date(E),
			key: srcKey,
		}]]]);

		const result = await writeShard(
			r2 as never, lucStub, '2m', '12h',
			new Date(S), new Date(S), new Date(E), expectedByTier);
		expect(result.status).toBe('wrote');
		expect(result.inputsExpected).toBe(1);
		expect(result.inputsPresent).toBe(1);

		const written = await collect(streamShardRows(r2 as never, result.key));
		// 360 2min bins, each folding two 1min source rows → {9:2}; the
		// fragments' {1:1} must NOT appear anywhere.
		expect(written.length).toBe(360);
		expect(new Set(written.map((r) => r.bikes))).toEqual(new Set(['{"9":2}']));
	});

	test('/2m no_inputs when the hole-fill source shard is missing on R2', async () => {
		const r2 = makeR2();
		const S = ms('2026-07-09T00:00:00Z');
		for (const tileStart of [S, S + 10 * MIN]) {
			await writeShardRows(r2 as never, shardKey('2m', '10min', new Date(tileStart)),
				[availRow('aa', tileStart, { 4: 2 })]);
		}
		const srcKey = shardKey('1m', '30min', new Date(S));
		const expectedByTier = new Map<string, ExpectedShard[]>([['1m', [{
			tier: '1m', shardDur: '30min' as Duration,
			periodStart: new Date(S), periodEnd: new Date(S + 30 * MIN),
			effectiveStart: new Date(S), effectiveEnd: new Date(S + 30 * MIN),
			key: srcKey,  // never written to R2
		}]]]);
		const result = await writeShard(
			r2 as never, lucStub, '2m', '30min',
			new Date(S), new Date(S), new Date(S + 30 * MIN), expectedByTier);
		expect(result.status).toBe('no_inputs');
	});
});
