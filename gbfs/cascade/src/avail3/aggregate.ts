/**
 * Streaming primitives for avail-v3 cascade Phase A
 * (see `specs/avail-v3-cascade-streaming.md`).
 *
 * Replaces the map-based `StreamingMerger` (whose peak state scaled
 * with `cells × bins` and OOM'd on `/1m@12h`+) with a k-way heap-merge
 * pipeline: sources sorted by `(s2_cell, dt)` are merged into a
 * sorted output stream, one bucket at a time. The output side writes
 * to `hyparquet-writer`'s `ParquetWriter` incrementally — no
 * intermediate `AvailV3Row[]` buffer, no full-buffer sort. Peak heap
 * is bounded by one row-group's worth of rows regardless of input or
 * output size.
 */
import {
	parquetMetadataAsync,
	parquetSchema,
} from 'hyparquet';
import { parquetReadAsync } from 'hyparquet/src/read.js';
import { assembleAsync, asyncGroupToRows } from 'hyparquet/src/rowgroup.js';
import { ByteWriter, ParquetWriter, schemaFromColumnData } from 'hyparquet-writer';
import {
	AVAIL_METRICS,
	sortRows,
	type AvailV3Row,
} from './transform';

// ─── Streaming reader ──────────────────────────────────────────────

/** Same sliced-buffer wrapper as `cascade.ts:r2SlicedBuffer` — exposed
 *  here so callers of the streaming path can share the memoization. */
export function r2SlicedBuffer(r2: R2Bucket, key: string, byteLength: number) {
	const cache = new Map<string, Promise<ArrayBuffer>>();
	return {
		byteLength,
		slice(start: number, end: number = byteLength): Promise<ArrayBuffer> {
			const k = `${start}\x00${end}`;
			let p = cache.get(k);
			if (!p) {
				p = r2.get(key, { range: { offset: start, length: end - start } })
					.then((obj) => {
						if (!obj) throw new Error(`r2 range read returned null: ${key} [${start}, ${end})`);
						return obj.arrayBuffer();
					});
				cache.set(k, p);
			}
			return p;
		},
	};
}

/** Stream a shard's rows as an `AsyncGenerator<AvailV3Row>`. Rows are
 *  emitted in on-disk order (which the writer guarantees to be
 *  `(s2_cell, dt)`-sorted via `sortRows`; see `transform.ts` +
 *  `specs/done/per-station-luc-v3.md`). Awaits happen at row-group
 *  boundaries only; per-row `yield` is O(1) from an in-memory buffer.
 *
 *  Returns immediately (no rows) if the key doesn't exist on R2. */
export async function* streamShardRows(
	r2: R2Bucket,
	key: string,
): AsyncGenerator<AvailV3Row> {
	const head = await r2.head(key);
	if (!head) return;
	const file = r2SlicedBuffer(r2, key, head.size);
	const metadata = await parquetMetadataAsync(file);
	const asyncGroups = parquetReadAsync({ file, metadata });
	const schemaTree = parquetSchema(metadata);
	const assembled = asyncGroups.map((arg) => assembleAsync(arg, schemaTree));
	for (const rg of assembled) {
		const rows = (await asyncGroupToRows(rg, 0, rg.groupRows, undefined, 'object')) as Record<string, unknown>[];
		for (const r of rows) {
			yield {
				s2_cell: r.s2_cell as string,
				dt: r.dt as bigint,
				bikes: r.bikes as string,
				ebikes: r.ebikes as string,
				docks: r.docks as string,
				disabled: r.disabled as string,
				pending: r.pending as string,
			};
		}
	}
}

// ─── k-way heap-merge ──────────────────────────────────────────────

/** Minimal binary min-heap. Keys are compared via `<`/`>` on `string`
 *  (which we use for the `(s2_cell, dt)` composite). Small hot-loop
 *  impl to keep k-way-merge fast. */
class MinHeap<T extends { key: string }> {
	private items: T[] = [];
	get size(): number { return this.items.length; }

	push(x: T): void {
		this.items.push(x);
		this.bubbleUp(this.items.length - 1);
	}
	pop(): T | undefined {
		if (this.items.length === 0) return undefined;
		const top = this.items[0]!;
		const last = this.items.pop()!;
		if (this.items.length > 0) {
			this.items[0] = last;
			this.bubbleDown(0);
		}
		return top;
	}
	private bubbleUp(i: number): void {
		const items = this.items;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (items[parent]!.key <= items[i]!.key) break;
			[items[i], items[parent]] = [items[parent]!, items[i]!];
			i = parent;
		}
	}
	private bubbleDown(i: number): void {
		const items = this.items;
		const n = items.length;
		for (;;) {
			const l = 2 * i + 1;
			const r = 2 * i + 2;
			let smallest = i;
			if (l < n && items[l]!.key < items[smallest]!.key) smallest = l;
			if (r < n && items[r]!.key < items[smallest]!.key) smallest = r;
			if (smallest === i) break;
			[items[i], items[smallest]] = [items[smallest]!, items[i]!];
			i = smallest;
		}
	}
}

/** Composite sort key for `(s2_cell, dt)`. Same shape used by
 *  `transform.ts:sortRows`. Padded dt is critical: naive string
 *  compare on bigints of different lengths gives wrong order
 *  ('10' < '9'). Pad to 20 chars (max INT64 digits). */
function sortKey(row: AvailV3Row, targetBinMs: bigint): string {
	const dt = targetBinMs > 0n ? row.dt - (row.dt % targetBinMs) : row.dt;
	return `${row.s2_cell}\x00${dt.toString().padStart(20, '0')}`;
}

/** k-way merge of N sorted row iterators. Emits rows in
 *  `(s2_cell, targetBinMs-floored-dt)` ascending order. If
 *  `targetBinMs === 0n`, no rebinning — `dt` passes through untouched.
 *
 *  Precondition: each input iterator's rows are sorted by
 *  `(s2_cell, dt)` at the source bin. Since floor is monotonic, the
 *  post-rebin key order is preserved per-iterator, which is what makes
 *  the k-way merge correct.
 *
 *  Peak heap: N heap entries + N in-flight next-row promises. Row
 *  buffers inside each `streamShardRows` are already bounded to one
 *  row-group. */
export async function* kwayMerge(
	iters: AsyncGenerator<AvailV3Row>[],
	targetBinMs: bigint,
): AsyncGenerator<AvailV3Row> {
	const heap = new MinHeap<{ key: string; row: AvailV3Row; iterIdx: number }>();
	// Prime with each iterator's first row.
	await Promise.all(
		iters.map(async (it, iterIdx) => {
			const first = await it.next();
			if (!first.done) {
				heap.push({ key: sortKey(first.value, targetBinMs), row: first.value, iterIdx });
			}
		}),
	);
	while (heap.size > 0) {
		const { row, iterIdx } = heap.pop()!;
		// Yield with rebinned dt (floor). Callers that don't want
		// rebinning pass targetBinMs=0n; leave dt untouched.
		if (targetBinMs > 0n && row.dt % targetBinMs !== 0n) {
			yield { ...row, dt: row.dt - (row.dt % targetBinMs) };
		} else {
			yield row;
		}
		const next = await iters[iterIdx]!.next();
		if (!next.done) {
			heap.push({ key: sortKey(next.value, targetBinMs), row: next.value, iterIdx });
		}
	}
}

// ─── Streaming aggregator (single-bucket fold) ─────────────────────

type Histogram = Map<number, number>;

const parseHist = (s: string): Histogram => {
	const h: Histogram = new Map();
	const obj = JSON.parse(s) as Record<string, number>;
	for (const [k, v] of Object.entries(obj)) h.set(Number(k), v);
	return h;
};

function histToJson(h: Histogram): string {
	if (h.size === 0) return '{}';
	const sorted = Array.from(h.entries()).sort((a, b) => a[0] - b[0]);
	const obj: Record<string, number> = {};
	for (const [k, v] of sorted) obj[String(k)] = v;
	return JSON.stringify(obj);
}

/** Fold consecutive same-`(s2_cell, dt)` rows into aggregated rows.
 *  Peak heap = ONE bucket (one accumulator per metric plus the pass-
 *  through single-contributor fast path).
 *
 *  Fast path: if the same key only appears once in the stream, the
 *  input row passes through verbatim (no JSON.parse/stringify
 *  round-trip). This matters for the common cadence-cascade case
 *  (`/6h@1d` reading `/3h@12h × 2` covers disjoint 3h bins per cell,
 *  so every output row has exactly one contributor).
 *
 *  Slow path activates only on second same-key contributor: parse
 *  the first contributor's histograms into `Map`s, add the second,
 *  and continue adding subsequent same-key rows. On key change, emit
 *  the accumulated bucket. */
export async function* aggregateStream(
	rows: AsyncGenerator<AvailV3Row>,
): AsyncGenerator<AvailV3Row> {
	let curKey: string | null = null;
	let firstRow: AvailV3Row | null = null;
	let bucket: { bikes: Histogram; ebikes: Histogram; docks: Histogram; disabled: Histogram; pending: Histogram } | null = null;

	for await (const row of rows) {
		const key = `${row.s2_cell}\x00${row.dt.toString()}`;
		if (curKey === null) {
			curKey = key;
			firstRow = row;
			bucket = null;
			continue;
		}
		if (key === curKey) {
			// Same key — accumulate.
			if (bucket === null) {
				// Promote fast → slow.
				bucket = {
					bikes:    parseHist(firstRow!.bikes),
					ebikes:   parseHist(firstRow!.ebikes),
					docks:    parseHist(firstRow!.docks),
					disabled: parseHist(firstRow!.disabled),
					pending:  parseHist(firstRow!.pending),
				};
			}
			for (const m of AVAIL_METRICS) {
				const incoming = parseHist(row[m]);
				for (const [k, v] of incoming) bucket[m].set(k, (bucket[m].get(k) ?? 0) + v);
			}
			continue;
		}
		// Key advanced — emit accumulated bucket for `curKey`.
		if (bucket === null) {
			yield firstRow!;  // fast path — verbatim
		} else {
			yield {
				s2_cell: firstRow!.s2_cell,
				dt:      firstRow!.dt,
				bikes:    histToJson(bucket.bikes),
				ebikes:   histToJson(bucket.ebikes),
				docks:    histToJson(bucket.docks),
				disabled: histToJson(bucket.disabled),
				pending:  histToJson(bucket.pending),
			};
		}
		curKey = key;
		firstRow = row;
		bucket = null;
	}
	// Flush trailing bucket.
	if (curKey !== null) {
		if (bucket === null) {
			yield firstRow!;
		} else {
			yield {
				s2_cell: firstRow!.s2_cell,
				dt:      firstRow!.dt,
				bikes:    histToJson(bucket.bikes),
				ebikes:   histToJson(bucket.ebikes),
				docks:    histToJson(bucket.docks),
				disabled: histToJson(bucket.disabled),
				pending:  histToJson(bucket.pending),
			};
		}
	}
}

// ─── Streaming writer ──────────────────────────────────────────────

/** Batch buffer for one row-group's worth of columnar data. */
interface Batch {
	s2_cell: string[];
	dt: bigint[];
	bikes: string[];
	ebikes: string[];
	docks: string[];
	disabled: string[];
	pending: string[];
}
const emptyBatch = (): Batch => ({
	s2_cell: [], dt: [], bikes: [], ebikes: [], docks: [], disabled: [], pending: [],
});
const batchLen = (b: Batch): number => b.s2_cell.length;
const pushRow = (b: Batch, r: AvailV3Row): void => {
	b.s2_cell.push(r.s2_cell);
	b.dt.push(r.dt);
	b.bikes.push(r.bikes);
	b.ebikes.push(r.ebikes);
	b.docks.push(r.docks);
	b.disabled.push(r.disabled);
	b.pending.push(r.pending);
};
const batchToColumns = (b: Batch) => [
	{ name: 's2_cell',  data: b.s2_cell,  type: 'STRING' as const },
	{ name: 'dt',       data: b.dt,       type: 'INT64'  as const },
	{ name: 'bikes',    data: b.bikes,    type: 'STRING' as const },
	{ name: 'ebikes',   data: b.ebikes,   type: 'STRING' as const },
	{ name: 'docks',    data: b.docks,    type: 'STRING' as const },
	{ name: 'disabled', data: b.disabled, type: 'STRING' as const },
	{ name: 'pending',  data: b.pending,  type: 'STRING' as const },
];

/** Cache the avail-v3 schema (derived once from the columnar shape). */
let cachedSchema: unknown = null;
function availV3Schema() {
	if (cachedSchema === null) {
		cachedSchema = schemaFromColumnData({ columnData: batchToColumns(emptyBatch()) });
	}
	return cachedSchema as ReturnType<typeof schemaFromColumnData>;
}

/** Stream rows through `ParquetWriter` in row-group-sized batches.
 *  Peak heap: `ROW_GROUP_SIZE`-row columnar batch + accumulated
 *  ByteWriter buffer (bounded by output shard bytes, tens of MB even
 *  for `/1m@1d`). Fits paid-tier 512 MB isolate with headroom.
 *
 *  Returns bytes written and row count. Zero-row streams return
 *  { bytes: 0, rows: 0 } WITHOUT touching R2 — caller decides how to
 *  report status (typically `'empty'`). */
export async function writeShardStreaming(
	r2: R2Bucket,
	key: string,
	rows: AsyncGenerator<AvailV3Row>,
	rowGroupSize: number = 2048,
): Promise<{ bytes: number; rows: number }> {
	const bw = new ByteWriter();
	const w = new ParquetWriter({
		writer: bw,
		schema: availV3Schema(),
		codec: 'SNAPPY',
		statistics: true,
	});
	let batch = emptyBatch();
	let totalRows = 0;
	for await (const row of rows) {
		pushRow(batch, row);
		totalRows++;
		if (batchLen(batch) >= rowGroupSize) {
			w.write({ columnData: batchToColumns(batch), rowGroupSize });
			batch = emptyBatch();
		}
	}
	if (batchLen(batch) > 0) {
		w.write({ columnData: batchToColumns(batch), rowGroupSize });
	}
	w.finish();
	if (totalRows === 0) return { bytes: 0, rows: 0 };
	// `getBytes()` returns a Uint8Array VIEW over the internal buffer (no
	// copy); `getBuffer()` would `.slice()` which briefly holds 2× the
	// output size. Save the byteLength before upload so we can release the
	// ParquetWriter/ByteWriter refs immediately after.
	const bytes = bw.getBytes();
	const byteLength = bytes.byteLength;
	await r2.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
	return { bytes: byteLength, rows: totalRows };
}

/** Convenience: rows-in-memory adapter for callers whose input already
 *  fits in memory (e.g. /1m raw path). Sorts + streams through the
 *  same writer path as the async-iterator case. Keeps sort ordering
 *  consistent across raw-input and cascaded-input write paths. */
export async function writeShardRows(
	r2: R2Bucket,
	key: string,
	rows: AvailV3Row[],
	rowGroupSize: number = 2048,
): Promise<{ bytes: number; rows: number }> {
	if (rows.length === 0) return { bytes: 0, rows: 0 };
	const sorted = sortRows(rows);
	async function* gen(): AsyncGenerator<AvailV3Row> {
		for (const r of sorted) yield r;
	}
	return writeShardStreaming(r2, key, gen(), rowGroupSize);
}

