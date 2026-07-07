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
import { parquetPlan } from 'hyparquet/src/plan.js';
import { readRowGroup, assembleAsync, asyncGroupToRows } from 'hyparquet/src/rowgroup.js';
import { ByteWriter, ParquetWriter, schemaFromColumnData } from 'hyparquet-writer';
import {
	AVAIL_METRICS,
	sortRows,
	type AvailV3Row,
} from './transform';

// ─── Streaming reader ──────────────────────────────────────────────

/** Sliced-buffer wrapper backed by a single whole-file R2 GET. The CFW
 *  1000-subrequest cap dominates over memory for cascade sources: a
 *  /1m@3h shard has ~100 row-groups, so serving each row-group's column
 *  chunks as individual range reads would issue several hundred
 *  subrequests per source — /1m@1d (8 sources × ~100 groups) blows the
 *  cap. Fetching the whole file once (typical /1m@3h ≈ 3 MB, /1m@1d
 *  ≈ 60 MB, well within isolate memory when only a handful are in
 *  flight) costs one subrequest per source; hyparquet then slices
 *  synchronously in-process. */
export function r2SlicedBuffer(r2: R2Bucket, key: string, byteLength: number) {
	let whole: Promise<ArrayBuffer> | null = null;
	const getWhole = () => {
		if (!whole) {
			whole = r2.get(key).then((obj) => {
				if (!obj) throw new Error(`r2 get returned null: ${key}`);
				return obj.arrayBuffer();
			});
		}
		return whole;
	};
	return {
		byteLength,
		async slice(start: number, end: number = byteLength): Promise<ArrayBuffer> {
			const buf = await getWhole();
			return buf.slice(start, end);
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
	const schemaTree = parquetSchema(metadata);
	// Build the plan (byte ranges per row-group), but DON'T eagerly
	// prefetch all row-group bytes. `parquetReadAsync` does exactly
	// that (calls `prefetchAsyncBuffer` on the full plan), which
	// materializes the whole file in memory upfront — the reason
	// `/1m@12h` (4 × 24 MB sources = ~100 MB) OOMs the 128 MB isolate.
	// Instead: iterate row-groups sequentially, calling `readRowGroup`
	// against the sliced-buffer wrapper. `r2SlicedBuffer` memoizes
	// ranges as a per-shard cache; the reader issues its own
	// coalesced fetches per row-group. Peak in-flight: one row-group's
	// column chunks, not the whole shard.
	const plan = parquetPlan({ file, metadata } as never);
	for (const groupPlan of plan.groups) {
		const arg = readRowGroup({ file } as never, plan, groupPlan);
		const rg = assembleAsync(arg, schemaTree);
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

// ─── Multipart streaming R2 writer ─────────────────────────────────

/** Multipart part size. R2 requires:
 *   1. Non-terminal parts ≥ 5 MB.
 *   2. **All non-terminal parts MUST have identical size** (stricter
 *      than S3's protocol; enforced by CF's `completeMultipartUpload`
 *      with error 10048).
 *  We flush in EXACT `PART_SIZE`-byte chunks so every non-terminal
 *  upload has the same length. The trailing part (from `commit()`)
 *  has no size constraint. */
const PART_SIZE = 8 * 1024 * 1024;

/** Wraps `hyparquet-writer`'s `ByteWriter` interface but transparently
 *  uploads accumulated bytes to R2 as multipart parts once the buffer
 *  crosses a size threshold. `ParquetWriter` writes to this the same
 *  way it would to a raw `ByteWriter` — all `append*` / `ensure`
 *  methods delegate to an inner `ByteWriter` — but `offset` reports
 *  the TOTAL bytes written (including already-uploaded parts), which
 *  is what `ParquetWriter` uses for row-group `file_offset` metadata.
 *
 *  Peak memory: one part (~5-10 MB) plus one row-group's encode state.
 *  Bounded regardless of total output size — writes multi-GB shards
 *  in a 128 MB isolate without OOM.
 *
 *  Lifecycle:
 *
 *    const mw = new MultipartR2Writer(r2, key);
 *    const pq = new ParquetWriter({ writer: mw, schema, codec });
 *    for await (const row of rows) {
 *      // ... push to batch ...
 *      if (batch full) {
 *        pq.write({ columnData });
 *        await mw.flushIfLarge();   // <-- async, natural await point
 *      }
 *    }
 *    pq.finish();                    // writes footer to mw.inner
 *    const bytes = await mw.commit(); // finalizes multipart (or single put)
 */
export class MultipartR2Writer {
	private inner: ByteWriter;
	private readonly r2: R2Bucket;
	private readonly key: string;
	private upload: R2MultipartUpload | null = null;
	private parts: R2UploadedPart[] = [];
	private uploadedBytes = 0;

	constructor(r2: R2Bucket, key: string, initialSize = 1024) {
		this.r2 = r2;
		this.key = key;
		this.inner = new ByteWriter(initialSize);
	}

	// Writer interface — delegate to inner.
	// `buffer` / `view` / `index` are read as getters so any consumer that
	// caches them across a flush picks up the fresh inner buffer.
	get buffer(): ArrayBuffer { return this.inner.buffer; }
	get view(): DataView { return this.inner.view; }
	get index(): number { return this.inner.index; }

	/** Total bytes written across all parts + current buffer. This is
	 *  what `ParquetWriter` records as row-group `file_offset` metadata,
	 *  so it MUST monotonically increase across flushes. */
	get offset(): number { return this.uploadedBytes + this.inner.index; }

	ensure(size: number): void { this.inner.ensure(size); }
	getBuffer(): ArrayBuffer { return this.inner.getBuffer(); }
	getBytes(): Uint8Array { return this.inner.getBytes(); }
	finish(): void { /* sync no-op; async commit() below */ }

	appendUint8(v: number):    void { this.inner.appendUint8(v); }
	appendUint32(v: number):   void { this.inner.appendUint32(v); }
	appendInt32(v: number):    void { this.inner.appendInt32(v); }
	appendInt64(v: bigint):    void { this.inner.appendInt64(v); }
	appendFloat32(v: number):  void { this.inner.appendFloat32(v); }
	appendFloat64(v: number):  void { this.inner.appendFloat64(v); }
	appendBuffer(v: ArrayBuffer): void { this.inner.appendBuffer(v); }
	appendBytes(v: Uint8Array):   void { this.inner.appendBytes(v); }
	appendVarInt(v: number):    void { this.inner.appendVarInt(v); }
	appendVarBigInt(v: bigint): void { this.inner.appendVarBigInt(v); }
	appendZigZag(v: number | bigint): void { this.inner.appendZigZag(v); }

	/** Extract exactly `PART_SIZE` bytes off the front of the buffer,
	 *  upload as one part, and re-buffer the remainder. Idempotent while
	 *  below `PART_SIZE`. Called repeatedly by `flushIfLarge` so a
	 *  single row-group write producing > 2× `PART_SIZE` still produces
	 *  same-size parts. */
	private async flushOnePart(): Promise<void> {
		if (this.inner.index < PART_SIZE) return;
		if (this.upload === null) {
			this.upload = await this.r2.createMultipartUpload(this.key, {
				httpMetadata: { contentType: 'application/octet-stream' },
			});
		}
		const partNumber = this.parts.length + 1;
		// Copy exactly `PART_SIZE` bytes for the part (R2 enforces
		// same-size non-terminal parts).
		const partBytes = new Uint8Array(PART_SIZE);
		partBytes.set(new Uint8Array(this.inner.buffer, 0, PART_SIZE));
		const part = await this.upload.uploadPart(partNumber, partBytes);
		this.parts.push(part);
		this.uploadedBytes += PART_SIZE;
		// Shift the remainder (this.inner.index - PART_SIZE bytes) to
		// the front of a fresh inner buffer.
		const remainderSize = this.inner.index - PART_SIZE;
		const newInner = new ByteWriter(Math.max(PART_SIZE, remainderSize || 1024));
		if (remainderSize > 0) {
			newInner.appendBytes(new Uint8Array(this.inner.buffer, PART_SIZE, remainderSize));
		}
		this.inner = newInner;
	}

	/** Upload the current buffer as multipart parts as long as it holds
	 *  at least `PART_SIZE` bytes. Cheap no-op below the threshold.
	 *  Loops because a single ParquetWriter.write() call can push more
	 *  than one `PART_SIZE` of bytes into the buffer. */
	async flushIfLarge(): Promise<void> {
		while (this.inner.index >= PART_SIZE) {
			await this.flushOnePart();
		}
	}

	/** Finalize: either single `r2.put` (if no multipart was ever
	 *  started) or upload remainder as final part + `complete()`. */
	async commit(): Promise<number> {
		if (this.upload === null) {
			// Total output stayed under the flush threshold — single put.
			const bytes = this.inner.getBytes();
			const byteLength = bytes.byteLength;
			if (byteLength === 0) return 0;
			await this.r2.put(this.key, bytes, {
				httpMetadata: { contentType: 'application/octet-stream' },
			});
			return byteLength;
		}
		// Flush any remainder as the final part. Final part has no min-size.
		if (this.inner.index > 0) {
			const partNumber = this.parts.length + 1;
			const partBytes = new Uint8Array(this.inner.index);
			partBytes.set(new Uint8Array(this.inner.buffer, 0, this.inner.index));
			const part = await this.upload.uploadPart(partNumber, partBytes);
			this.parts.push(part);
			this.uploadedBytes += this.inner.index;
		}
		await this.upload.complete(this.parts);
		return this.uploadedBytes;
	}

	/** Abort an in-flight multipart upload. Call in error paths so R2
	 *  doesn't keep partial uploads around indefinitely. */
	async abort(): Promise<void> {
		if (this.upload !== null) await this.upload.abort();
	}
}

/** Stream rows through `ParquetWriter` + `MultipartR2Writer`. Peak
 *  memory is bounded by one row-group's encoded bytes + one multipart
 *  part (~5 MB) regardless of total output size — writes `/1m@1d`
 *  (~55 MB) in a 128 MB isolate without OOM.
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
	const mw = new MultipartR2Writer(r2, key);
	const w = new ParquetWriter({
		writer: mw,
		schema: availV3Schema(),
		codec: 'SNAPPY',
		// Statistics allocate min/max value copies + null counts per
		// column-chunk; disabling saves per-RG transient state at the cost
		// of no min/max predicate push-down at read time. For avail-v3
		// queries (dt-range, s2_cell equality) push-down doesn't help
		// meaningfully — row-groups are sort-ordered by (s2_cell, dt) so
		// callers use offset-index-driven scans, not stats.
		statistics: false,
	});
	let batch = emptyBatch();
	let totalRows = 0;
	try {
		for await (const row of rows) {
			pushRow(batch, row);
			totalRows++;
			if (batchLen(batch) >= rowGroupSize) {
				w.write({ columnData: batchToColumns(batch), rowGroupSize });
				batch = emptyBatch();
				// Natural await point between row-groups — flush accumulated
				// bytes to R2 if the current part has crossed the threshold.
				await mw.flushIfLarge();
			}
		}
		if (batchLen(batch) > 0) {
			w.write({ columnData: batchToColumns(batch), rowGroupSize });
		}
		w.finish();
	} catch (err) {
		await mw.abort();
		throw err;
	}
	if (totalRows === 0) return { bytes: 0, rows: 0 };
	const byteLength = await mw.commit();
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

