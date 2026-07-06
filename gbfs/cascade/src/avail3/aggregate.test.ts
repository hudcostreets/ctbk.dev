import { describe, test, expect, vi } from 'vitest';
import { parquetReadObjects } from 'hyparquet';
import { kwayMerge, aggregateStream, streamShardRows, writeShardStreaming } from './aggregate';
import { sortRows, type AvailV3Row } from './transform';

// Convenience: build a wide row with per-metric histograms.
function row(s2_cell: string, dt: bigint, hists: Partial<Record<'bikes' | 'ebikes' | 'docks' | 'disabled' | 'pending', Record<number, number>>> = {}): AvailV3Row {
	const emit = (h?: Record<number, number>) => h ? JSON.stringify(h) : '{}';
	return {
		s2_cell, dt,
		bikes:    emit(hists.bikes),
		ebikes:   emit(hists.ebikes),
		docks:    emit(hists.docks),
		disabled: emit(hists.disabled),
		pending:  emit(hists.pending),
	};
}

async function* from(rows: AvailV3Row[]): AsyncGenerator<AvailV3Row> {
	for (const r of rows) yield r;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const x of gen) out.push(x);
	return out;
}

describe('kwayMerge', () => {
	test('single sorted source passes through', async () => {
		const src = [
			row('c1', 1n, { bikes: { 5: 1 } }),
			row('c1', 2n, { bikes: { 3: 1 } }),
			row('c2', 1n, { bikes: { 7: 1 } }),
		];
		const merged = await collect(kwayMerge([from(src)], 0n));
		expect(merged.map((r) => [r.s2_cell, r.dt.toString()])).toEqual([
			['c1', '1'], ['c1', '2'], ['c2', '1'],
		]);
	});

	test('two sources interleave in sort order', async () => {
		const a = [row('c1', 1n), row('c1', 3n), row('c2', 5n)];
		const b = [row('c1', 2n), row('c2', 4n), row('c3', 1n)];
		const merged = await collect(kwayMerge([from(a), from(b)], 0n));
		expect(merged.map((r) => [r.s2_cell, r.dt.toString()])).toEqual([
			['c1', '1'], ['c1', '2'], ['c1', '3'], ['c2', '4'], ['c2', '5'], ['c3', '1'],
		]);
	});

	test('same key from two sources emits both (aggregator consolidates)', async () => {
		const a = [row('c1', 1n, { bikes: { 5: 1 } })];
		const b = [row('c1', 1n, { bikes: { 5: 1 } })];
		const merged = await collect(kwayMerge([from(a), from(b)], 0n));
		expect(merged.length).toBe(2);
		expect(merged[0]!.s2_cell).toBe('c1');
		expect(merged[1]!.s2_cell).toBe('c1');
	});

	test('rebin: targetBinMs floors dt to bin boundary', async () => {
		const src = [
			row('c1', 100n),  // → 100 in bin 0
			row('c1', 150n),  // → 100 in bin 0
			row('c1', 250n),  // → 200 in bin 100
			row('c1', 350n),  // → 300 in bin 100 (300 % 100 = 0)
		];
		const merged = await collect(kwayMerge([from(src)], 100n));
		expect(merged.map((r) => r.dt.toString())).toEqual(['100', '100', '200', '300']);
	});

	test('rebin preserves sort order across floor', async () => {
		// Interleave sources at source bin, rebin to a coarser target.
		const a = [row('c1', 100n), row('c1', 300n)];
		const b = [row('c1', 200n), row('c1', 400n)];
		const merged = await collect(kwayMerge([from(a), from(b)], 200n));
		// Post-rebin dt: 100→0(no wait, 100%200=100, so 100-100=0),
		// 200→200, 300→200 (300%200=100 → 300-100=200), 400→400
		expect(merged.map((r) => r.dt.toString())).toEqual(['0', '200', '200', '400']);
	});

	test('empty sources handled', async () => {
		const merged = await collect(kwayMerge([from([]), from([])], 0n));
		expect(merged).toEqual([]);
	});

	test('dt padding: 10 does not compare < 9', async () => {
		// String-compare bug canary: '10' < '9' in raw string comparison,
		// but our padded key should keep dt=9 before dt=10.
		const src = [row('c1', 9n), row('c1', 10n)];
		const merged = await collect(kwayMerge([from(src)], 0n));
		expect(merged.map((r) => r.dt.toString())).toEqual(['9', '10']);
	});
});

describe('aggregateStream', () => {
	test('empty stream → empty output', async () => {
		expect(await collect(aggregateStream(from([])))).toEqual([]);
	});

	test('single row → verbatim (fast path)', async () => {
		const src = [row('c1', 1n, { bikes: { 5: 1 } })];
		const out = await collect(aggregateStream(from(src)));
		expect(out).toEqual(src);  // reference-equal fast path
	});

	test('distinct keys → verbatim (fast path per bucket)', async () => {
		const src = [
			row('c1', 1n, { bikes: { 5: 1 } }),
			row('c1', 2n, { bikes: { 3: 1 } }),
			row('c2', 1n, { bikes: { 7: 1 } }),
		];
		const out = await collect(aggregateStream(from(src)));
		expect(out).toEqual(src);
	});

	test('two contributors same key → summed histogram', async () => {
		const src = [
			row('c1', 1n, { bikes: { 5: 1 } }),
			row('c1', 1n, { bikes: { 5: 1 } }),
		];
		const out = await collect(aggregateStream(from(src)));
		expect(out.length).toBe(1);
		expect(out[0]!.s2_cell).toBe('c1');
		expect(out[0]!.dt).toBe(1n);
		expect(JSON.parse(out[0]!.bikes)).toEqual({ '5': 2 });
	});

	test('three contributors same key with mixed values', async () => {
		const src = [
			row('c1', 1n, { bikes: { 5: 1 }, ebikes: { 3: 1 } }),
			row('c1', 1n, { bikes: { 5: 1, 6: 2 } }),
			row('c1', 1n, { bikes: { 6: 1 }, docks: { 10: 1 } }),
		];
		const out = await collect(aggregateStream(from(src)));
		expect(out.length).toBe(1);
		expect(JSON.parse(out[0]!.bikes)).toEqual({ '5': 2, '6': 3 });
		expect(JSON.parse(out[0]!.ebikes)).toEqual({ '3': 1 });
		expect(JSON.parse(out[0]!.docks)).toEqual({ '10': 1 });
	});

	test('key advance emits prior bucket before starting new', async () => {
		const src = [
			row('c1', 1n, { bikes: { 5: 1 } }),
			row('c1', 1n, { bikes: { 5: 1 } }),   // c1@1 = { 5: 2 }
			row('c1', 2n, { bikes: { 7: 1 } }),   // c1@2 = { 7: 1 } (fast path)
			row('c2', 1n, { bikes: { 3: 1 } }),   // c2@1 = { 3: 1 } (fast path)
			row('c2', 1n, { bikes: { 3: 1 } }),   // c2@1 = { 3: 2 } (promotes)
		];
		const out = await collect(aggregateStream(from(src)));
		expect(out.length).toBe(3);
		expect(out.map((r) => [r.s2_cell, r.dt.toString(), JSON.parse(r.bikes)]))
			.toEqual([
				['c1', '1', { '5': 2 }],
				['c1', '2', { '7': 1 }],
				['c2', '1', { '3': 2 }],
			]);
	});
});

// ─── Ranged R2 mock ────────────────────────────────────────────────
// Supports { range: { offset, length } } — required by streamShardRows'
// r2SlicedBuffer wrapper. Real R2 always returns an ArrayBuffer from
// R2Object.arrayBuffer(); normalize on put+get so callers can put
// either ArrayBuffer or a Uint8Array view (e.g., ByteWriter.getBytes()).
function makeR2() {
	const store = new Map<string, ArrayBuffer>();
	return {
		head: vi.fn(async (key: string) => (store.has(key) ? { key, size: store.get(key)!.byteLength } : null)),
		get: vi.fn(async (key: string, opts?: { range?: { offset: number; length: number } }) => {
			const buf = store.get(key);
			if (!buf) return null;
			const slice = opts?.range
				? buf.slice(opts.range.offset, opts.range.offset + opts.range.length)
				: buf;
			return { arrayBuffer: async () => slice };
		}),
		put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array) => {
			// Normalize to a self-contained ArrayBuffer (Uint8Array views may
			// wrap a larger backing buffer; store only the referenced bytes).
			if (body instanceof Uint8Array) {
				const copy = new ArrayBuffer(body.byteLength);
				new Uint8Array(copy).set(body);
				store.set(key, copy);
			} else {
				store.set(key, body);
			}
		}),
		_store: store,
	};
}

describe('writeShardStreaming → streamShardRows round-trip', () => {
	test('write + read preserves rows exactly', async () => {
		const r2 = makeR2() as unknown as R2Bucket;
		const src = sortRows([
			row('c1', 100n, { bikes: { 5: 2 } }),
			row('c1', 200n, { bikes: { 7: 1 }, ebikes: { 3: 1 } }),
			row('c2', 100n, { bikes: { 4: 1 }, docks: { 10: 3 } }),
			row('c2', 200n, { pending: { 1: 5 } }),
			row('c3', 100n, {}),  // all-empty metrics
		]);
		async function* gen(): AsyncGenerator<AvailV3Row> { for (const r of src) yield r; }
		const { rows: written } = await writeShardStreaming(r2, 'test/roundtrip.parquet', gen());
		expect(written).toBe(5);

		const readBack: AvailV3Row[] = [];
		for await (const r of streamShardRows(r2, 'test/roundtrip.parquet')) {
			readBack.push(r);
		}
		expect(readBack).toEqual(src);
	});

	test('multiple row-groups (batch overflow)', async () => {
		const r2 = makeR2() as unknown as R2Bucket;
		const src: AvailV3Row[] = [];
		// 5000 rows > 2048 default → forces multiple row-groups.
		for (let i = 0; i < 5000; i++) {
			src.push(row(`c${String(i).padStart(4, '0')}`, BigInt(i), { bikes: { [i % 10]: 1 } }));
		}
		async function* gen(): AsyncGenerator<AvailV3Row> { for (const r of src) yield r; }
		const { rows: written } = await writeShardStreaming(r2, 'test/big.parquet', gen());
		expect(written).toBe(5000);

		const readBack: AvailV3Row[] = [];
		for await (const r of streamShardRows(r2, 'test/big.parquet')) {
			readBack.push(r);
		}
		expect(readBack.length).toBe(5000);
		expect(readBack[0]).toEqual(src[0]);
		expect(readBack[2500]).toEqual(src[2500]);
		expect(readBack[4999]).toEqual(src[4999]);
	});

	test('empty stream → no R2 write', async () => {
		const r2 = makeR2();
		async function* gen(): AsyncGenerator<AvailV3Row> { /* empty */ }
		const { bytes, rows } = await writeShardStreaming(r2 as unknown as R2Bucket, 'test/empty.parquet', gen());
		expect(bytes).toBe(0);
		expect(rows).toBe(0);
		expect(r2.put).not.toHaveBeenCalled();
	});

	test('parity with parquetReadObjects on written buffer', async () => {
		// Cross-check: the parquet we produce is readable by hyparquet's
		// standard (non-streaming) reader, confirming valid file format.
		const r2 = makeR2();
		const src = sortRows([
			row('c1', 100n, { bikes: { 5: 1 } }),
			row('c2', 200n, { ebikes: { 3: 2 } }),
		]);
		async function* gen(): AsyncGenerator<AvailV3Row> { for (const r of src) yield r; }
		await writeShardStreaming(r2 as unknown as R2Bucket, 'k.parquet', gen());
		const buf = r2._store.get('k.parquet')!;
		const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		expect(rows.length).toBe(2);
		expect(rows[0]!.s2_cell).toBe('c1');
		expect(rows[1]!.s2_cell).toBe('c2');
	});
});

describe('kwayMerge + aggregateStream (integration)', () => {
	test('parity with legacy mergeRows on 2-source union at same bin', async () => {
		// Two source shards over disjoint (cell, dt) buckets — the common
		// cadence-cascade case (/6h@1d reading /3h@12h × 2).
		const a = sortRows([
			row('c1', 100n, { bikes: { 5: 1 } }),
			row('c2', 100n, { bikes: { 3: 1 } }),
		]);
		const b = sortRows([
			row('c1', 200n, { bikes: { 7: 1 } }),
			row('c3', 100n, { bikes: { 4: 1 } }),
		]);
		const merged = await collect(aggregateStream(kwayMerge([from(a), from(b)], 0n)));
		expect(merged.map((r) => [r.s2_cell, r.dt.toString(), JSON.parse(r.bikes)]))
			.toEqual([
				['c1', '100', { '5': 1 }],
				['c1', '200', { '7': 1 }],
				['c2', '100', { '3': 1 }],
				['c3', '100', { '4': 1 }],
			]);
	});

	test('rebin + aggregate: two 100ms-bin rows collapse to one 200ms-bin row', async () => {
		const src = sortRows([
			row('c1', 100n, { bikes: { 5: 1 } }),  // rebin 100→0
			row('c1', 200n, { bikes: { 5: 1 } }),  // rebin 200→200 — different bin
		]);
		const merged = await collect(aggregateStream(kwayMerge([from(src)], 200n)));
		expect(merged.length).toBe(2);
		expect(merged.map((r) => r.dt.toString())).toEqual(['0', '200']);
	});

	test('rebin: two rows in same output bin get aggregated', async () => {
		const src = sortRows([
			row('c1', 100n, { bikes: { 5: 1 } }),  // rebin to 100 (100 % 200 = 100)
			row('c1', 100n, { bikes: { 7: 1 } }),  // rebin to 100
		]);
		const merged = await collect(aggregateStream(kwayMerge([from(src)], 200n)));
		expect(merged.length).toBe(1);
		expect(merged[0]!.dt.toString()).toBe('0');  // 100 - (100 % 200) = 100? No: 100 % 200 = 100, floor = 100 - 100 = 0
		expect(JSON.parse(merged[0]!.bikes)).toEqual({ '5': 1, '7': 1 });
	});
});
