// In-memory R2 mock shared by test files. Supports ranged `get`
// ({ range: { offset, length } } — required by streamShardRows'
// r2SlicedBuffer wrapper) and the minimal `createMultipartUpload` API
// used by `MultipartR2Writer` — uploaded parts accumulate in-memory and
// are concatenated in `complete()`, enforcing R2's
// non-terminal-parts-must-be-same-size constraint (error 10048).
//
// Real R2 always returns an ArrayBuffer from R2Object.arrayBuffer();
// normalize on put+get so callers can put either ArrayBuffer or a
// Uint8Array view (e.g., ByteWriter.getBytes()).
//
// Lives outside *.test.ts so multiple suites can import it; only test
// code should import this module (it depends on vitest's `vi`).
import { vi } from 'vitest';

export function makeR2() {
	const store = new Map<string, ArrayBuffer>();
	const multiparts = new Map<string, { key: string; parts: Map<number, Uint8Array>; aborted: boolean }>();
	let uploadCounter = 0;
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
		createMultipartUpload: vi.fn(async (key: string) => {
			const uploadId = `upload-${++uploadCounter}`;
			const state = { key, parts: new Map<number, Uint8Array>(), aborted: false };
			multiparts.set(uploadId, state);
			return {
				uploadId,
				key,
				uploadPart: vi.fn(async (partNumber: number, body: Uint8Array) => {
					if (state.aborted) throw new Error(`upload ${uploadId} aborted`);
					// Copy — caller may recycle its buffer immediately.
					const copy = new Uint8Array(body.byteLength);
					copy.set(body);
					state.parts.set(partNumber, copy);
					return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
				}),
				complete: vi.fn(async (parts: Array<{ partNumber: number; etag: string }>) => {
					if (state.aborted) throw new Error(`upload ${uploadId} aborted`);
					// Concatenate parts in order.
					const sortedPartNums = parts.map((p) => p.partNumber).sort((a, b) => a - b);
					// Enforce R2's part-size constraint (error 10048 in real
					// R2): all non-trailing parts identical, and the trailing
					// part no LARGER than them (smaller is fine). Catches
					// regressions in flush logic.
					if (sortedPartNums.length >= 2) {
						const sizes = sortedPartNums.map((pn) => state.parts.get(pn)!.byteLength);
						const nonTerminalSizes = sizes.slice(0, -1);
						const first = nonTerminalSizes[0]!;
						for (const s of nonTerminalSizes) {
							if (s !== first) {
								throw new Error(`completeMultipartUpload: All non-trailing parts must have the same length. (10048) — got sizes ${sizes.join(', ')}`);
							}
						}
						if (sizes[sizes.length - 1]! > first) {
							throw new Error(`completeMultipartUpload: All non-trailing parts must have the same length. (10048) — trailing part ${sizes[sizes.length - 1]} > uniform ${first}`);
						}
					}
					const total = sortedPartNums.reduce((n, pn) => n + state.parts.get(pn)!.byteLength, 0);
					const assembled = new Uint8Array(total);
					let off = 0;
					for (const pn of sortedPartNums) {
						const part = state.parts.get(pn)!;
						assembled.set(part, off);
						off += part.byteLength;
					}
					const buf = new ArrayBuffer(total);
					new Uint8Array(buf).set(assembled);
					store.set(state.key, buf);
					multiparts.delete(uploadId);
				}),
				abort: vi.fn(async () => {
					state.aborted = true;
					multiparts.delete(uploadId);
				}),
			};
		}),
		_store: store,
		_multiparts: multiparts,
	};
}
