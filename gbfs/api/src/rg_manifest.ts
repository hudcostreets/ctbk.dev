/** RG manifest — D1 row-group index for parquet pyramid serving
 *  (`specs/rg-manifest.md` P1).
 *
 *  `rg_manifest` mirrors each shard's per-row-group metadata: byte span,
 *  `cell`/`dt` column statistics, and enough per-column chunk metadata to
 *  decode an RG without ever reading the file's 7-8MB footer. Serving a
 *  segment becomes: one D1 batch (presence + matched RGs) → parallel R2
 *  range reads of exactly the matched RGs → hyparquet decode against a
 *  SYNTHETIC single-shard metadata object built from the manifest rows.
 *
 *  Trust model: best-effort cache, never authority. Rows are stamped with
 *  the `pyramid_shards.written_at` they were built against; a mismatch
 *  (shard rewritten in place + re-registered), an absent fill, or a
 *  decode error all fall back to the footer path (`fallbackFetch`) —
 *  which serves correctly, and re-fills the manifest via `defer`
 *  (ctx.waitUntil). Dropping the table degrades latency, not
 *  correctness.
 */
import { parquetMetadataAsync, parquetReadObjects, type FileMetaData } from 'hyparquet';
import type { Storage } from 'pyrmts';
import type { Row } from 'pyrmts';
import { acquireFooterSlot } from './fetch_guard';

// Matches pyrmts `fetchShardData`'s footer-read behavior: 64KB initial
// range covers small footers in one read; big footers cost a second.
const INITIAL_FETCH_SIZE = 64 * 1024;

// D1 caps bind params at 100. Each include token costs 2 binds in the
// cell-overlap predicate; beyond this we degrade to one conservative
// [minTok, maxTok] range (correct superset — row-level filtering
// downstream keeps exactness).
const MAX_CELL_TOKENS = 45;

// Fill-worthiness floor: shards below this RG count have sub-MB footers
// that parse in tens of ms via the fallback path — filling them buys
// little, and for the avail pyramids the SMALL shards are exactly the
// ones the Lambda cascade churns continuously (every rewrite would
// invalidate + re-fill, ~$10/mo of pointless D1 writes). Big
// consolidated shards — the ones whose footers are expensive — rarely
// churn. Applies to both lazy fills and the backfill op.
//
// Rides pyramids get NO floor: their shards are monthly-frozen (no
// Lambda churn, negligible D1 write cost), and full manifest coverage
// is what lets the Home chart's 3 concurrent region queries bypass the
// footer-fetch guard entirely (unmanifested calendar shards otherwise
// serialize behind `FOOTER_FETCH_MAX_INFLIGHT=1` and shed 503s under
// the default-pyramid=v5 load shape).
const MIN_FILL_RGS = 512;
const minFillRgs = (pyramid: string): number => pyramid.startsWith('rides-') ? 0 : MIN_FILL_RGS;

interface ManifestRg {
	rg_idx: number;
	row_start: number;
	num_rows: number;
	byte_start: number;
	byte_end: number;
	chunk_meta: string;
}

interface ChunkMeta {
	name: string;
	type: string;
	codec: string;
	encodings?: string[];
	num_values: number;
	total_compressed_size: number;
	data_page_offset: number;
	dictionary_page_offset?: number;
}

export interface SegmentFetchOpts {
	db: D1Database;
	storage: Storage;
	pyramid: string;          // e.g. 'rides-v5-start'
	key: string;              // R2 shard key
	writtenAt: number;        // pyramid_shards.written_at (ms) for this key
	from: Date;               // segment range (bin overlap)
	to: Date;
	cells: string[];          // include tokens (row-level filtering happens downstream)
	cellCol: string;          // parquet cell column ('cell' for rides, 's2_cell' for avail)
	defer: (p: Promise<unknown>) => void;
}

/** In-isolate cache of per-pyramid schema JSON (stable across shards). */
const schemaCache = new Map<string, unknown[]>();

const num = (v: unknown): number => typeof v === 'bigint' ? Number(v) : (v as number);

function normalizeRow(row: Record<string, unknown>): Row {
	const out: Row = {};
	for (const k in row) {
		const v = row[k];
		out[k] = typeof v === 'bigint' ? Number(v) : (v as Row[string]);
	}
	return out;
}

/** AsyncBuffer over `Storage` byte-range reads (absolute file offsets). */
function storageBuffer(storage: Storage, key: string, byteLength: number) {
	return {
		byteLength,
		async slice(start: number, end?: number): Promise<ArrayBuffer> {
			const bytes = await storage.getRange(key, start, end ?? byteLength);
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		},
	};
}

/** Fetch one shard's rows for a segment: manifest-served when filled +
 *  fresh, else footer fallback + deferred manifest fill. */
export async function fetchShardRows(opts: SegmentFetchOpts): Promise<Row[]> {
	const { db, pyramid, key, writtenAt } = opts;
	const tokens = [...opts.cells].sort();
	const fromMs = opts.from.getTime();
	const toMs = opts.to.getTime();

	// Presence + matched RGs + schema, one D1 round trip.
	const cellConds: string[] = [];
	const cellBinds: (string | number)[] = [];
	if (tokens.length > MAX_CELL_TOKENS) {
		cellConds.push('(cell_min <= ? AND cell_max >= ?)');
		cellBinds.push(tokens[tokens.length - 1], tokens[0]);
	} else {
		for (const t of tokens) {
			cellConds.push('(cell_min <= ? AND cell_max >= ?)');
			cellBinds.push(t, t);
		}
	}
	// Presence = the `rg_manifest_fills` sentinel, written LAST by
	// `fillManifest` — a fill that dies midway leaves no sentinel, so
	// partial rows are never trusted.
	const [presence, matches, schemaRow] = await db.batch([
		db.prepare('SELECT n_rgs FROM rg_manifest_fills WHERE pyramid = ? AND key = ? AND shard_written_at = ?')
			.bind(pyramid, key, writtenAt),
		db.prepare(
			'SELECT rg_idx, row_start, num_rows, byte_start, byte_end, chunk_meta FROM rg_manifest '
			+ 'WHERE pyramid = ? AND key = ? AND shard_written_at = ? '
			+ 'AND (dt_max IS NULL OR dt_max >= ?) AND (dt_min IS NULL OR dt_min < ?) '
			+ `AND (cell_min IS NULL OR ${cellConds.join(' OR ')}) ORDER BY rg_idx`,
		).bind(pyramid, key, writtenAt, fromMs, toMs, ...cellBinds),
		db.prepare('SELECT schema_json FROM rg_manifest_schema WHERE pyramid = ?').bind(pyramid),
	]);

	const filled = (presence.results?.length ?? 0) > 0;
	const schemaJson = (schemaRow.results?.[0] as { schema_json: string } | undefined)?.schema_json;
	if (!filled || schemaJson === undefined) {
		return fallbackFetch(opts);
	}

	const schema = schemaCache.get(pyramid) ?? (() => {
		const s = JSON.parse(schemaJson) as unknown[];
		schemaCache.set(pyramid, s);
		return s;
	})();
	const rgs = (matches.results ?? []) as unknown as ManifestRg[];
	if (rgs.length === 0) return [];

	try {
		return await decodeManifestRgs(opts, schema, rgs);
	} catch (err) {
		// Stale or corrupt manifest rows (e.g. shard rewritten without
		// re-registration). Drop the key's rows, serve via footer, refill.
		console.warn(`rg_manifest decode failed for ${key}: ${(err as Error).message}; falling back`);
		opts.defer(db.batch([
			db.prepare('DELETE FROM rg_manifest_fills WHERE pyramid = ? AND key = ?').bind(pyramid, key),
			db.prepare('DELETE FROM rg_manifest WHERE pyramid = ? AND key = ?').bind(pyramid, key),
		]));
		return fallbackFetch(opts);
	}
}

async function decodeManifestRgs(opts: SegmentFetchOpts, schema: unknown[], rgs: ManifestRg[]): Promise<Row[]> {
	const row_groups = rgs.map((rg) => {
		const chunks = JSON.parse(rg.chunk_meta) as ChunkMeta[];
		return {
			columns: chunks.map((c) => ({
				file_offset: c.dictionary_page_offset ?? c.data_page_offset,
				meta_data: {
					type: c.type,
					encodings: c.encodings,
					path_in_schema: [c.name],
					codec: c.codec,
					num_values: c.num_values,
					total_compressed_size: c.total_compressed_size,
					total_uncompressed_size: c.total_compressed_size,
					data_page_offset: c.data_page_offset,
					dictionary_page_offset: c.dictionary_page_offset,
				},
			})),
			total_byte_size: rg.byte_end - rg.byte_start,
			num_rows: rg.num_rows,
		};
	});
	const metadata = {
		version: 2,
		schema,
		num_rows: rgs.reduce((a, rg) => a + rg.num_rows, 0),
		row_groups,
		metadata_length: 0,
	} as unknown as FileMetaData;
	const byteLength = Math.max(...rgs.map((rg) => rg.byte_end));
	const file = storageBuffer(opts.storage, opts.key, byteLength);
	const rows = await parquetReadObjects({ file, metadata });
	return rows.map(normalizeRow);
}

// ─── Footer fallback + fill ──────────────────────────────────────────────

function findColIdx(metadata: FileMetaData, name: string): number {
	const cols = metadata.row_groups[0]?.columns ?? [];
	return cols.findIndex((c) => c.meta_data?.path_in_schema.length === 1 && c.meta_data.path_in_schema[0] === name);
}

function statNum(v: unknown): number | null {
	if (v === undefined || v === null) return null;
	if (typeof v === 'bigint') return Number(v);
	if (typeof v === 'number') return v;
	if (v instanceof Date) return v.getTime();
	return null;
}

function statStr(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

/** Footer path: parse metadata (guarded — this is the memory-expensive
 *  step), serve matched RGs, and defer a manifest fill built from the
 *  SAME parsed metadata (no second parse). */
async function fallbackFetch(opts: SegmentFetchOpts): Promise<Row[]> {
	const release = await acquireFooterSlot();
	try {
		const head = await opts.storage.head(opts.key);
		if (head === null) throw new Error(`rg_manifest fallback: object not found: ${opts.key}`);
		const file = storageBuffer(opts.storage, opts.key, head.size);
		const metadata = await parquetMetadataAsync(file, { initialFetchSize: INITIAL_FETCH_SIZE });

		if (metadata.row_groups.length >= minFillRgs(opts.pyramid)) {
			opts.defer(fillManifest(opts, metadata).catch((err) => {
				console.warn(`rg_manifest fill failed for ${opts.key}: ${(err as Error).message}`);
			}));
		}

		// RG-prune by cell/dt stats (same semantics as pyrmts
		// `selectRowGroupRuns`), then read matched runs.
		const cellIdx = findColIdx(metadata, opts.cellCol);
		const dtIdx = findColIdx(metadata, 'dt');
		const fromMs = opts.from.getTime();
		const toMs = opts.to.getTime();
		const tokens = [...opts.cells].sort();
		const runs: { rowStart: number; rowEnd: number }[] = [];
		let cursor = 0;
		let run: { rowStart: number; rowEnd: number } | null = null;
		for (const rg of metadata.row_groups) {
			const nRows = num(rg.num_rows);
			const rgStart = cursor;
			cursor += nRows;
			const cellStats = cellIdx >= 0 ? rg.columns[cellIdx]?.meta_data?.statistics : undefined;
			const dtStats = dtIdx >= 0 ? rg.columns[dtIdx]?.meta_data?.statistics : undefined;
			const cMin = statStr(cellStats?.min_value);
			const cMax = statStr(cellStats?.max_value);
			const dMin = statNum(dtStats?.min_value);
			const dMax = statNum(dtStats?.max_value);
			const cellPass = cMin === null || cMax === null
				|| tokens.some((t) => t >= cMin && t <= cMax);
			const dtPass = dMin === null || dMax === null || !(dMax < fromMs || dMin >= toMs);
			if (!(cellPass && dtPass)) {
				if (run) { runs.push(run); run = null; }
				continue;
			}
			if (run === null) run = { rowStart: rgStart, rowEnd: cursor };
			else run.rowEnd = cursor;
		}
		if (run) runs.push(run);
		if (runs.length === 0) return [];
		const perRun = await Promise.all(runs.map(({ rowStart, rowEnd }) =>
			parquetReadObjects({ file, metadata, rowStart, rowEnd })));
		return perRun.flat().map(normalizeRow);
	} finally {
		release();
	}
}

/** Registry-proxy backfill (`ctbk gbfs manifest backfill`): parse one
 *  shard's footer and fill its manifest rows, synchronously. `written_at`
 *  is read from `pyramid_shards` via the same binding (truthful side of
 *  the 2026-07-28 split-brain). */
export async function backfillManifestKey(
	db: D1Database,
	storage: Storage,
	pyramid: string,
	key: string,
	cellCol: string,
): Promise<{ n_rgs: number; written_at: number; skipped?: boolean }> {
	const row = await db.prepare('SELECT written_at FROM pyramid_shards WHERE pyramid = ? AND key = ?')
		.bind(pyramid, key).first<{ written_at: number }>();
	const writtenAt = row?.written_at ?? 0;
	const release = await acquireFooterSlot(30_000);
	try {
		const head = await storage.head(key);
		if (head === null) throw new Error(`backfillManifestKey: object not found: ${key}`);
		const file = storageBuffer(storage, key, head.size);
		const metadata = await parquetMetadataAsync(file, { initialFetchSize: INITIAL_FETCH_SIZE });
		if (metadata.row_groups.length < minFillRgs(pyramid)) {
			return { n_rgs: metadata.row_groups.length, written_at: writtenAt, skipped: true };
		}
		await fillManifestInner(db, pyramid, key, writtenAt, metadata, cellCol);
		return { n_rgs: metadata.row_groups.length, written_at: writtenAt };
	} finally {
		release();
	}
}

/** Fill coverage for a pyramid: registered keys vs completed fills, with
 *  stale fills (shard re-registered since) called out separately. */
export async function manifestStatus(
	db: D1Database,
	pyramid: string,
): Promise<{ registered: number; filled: number; stale: string[]; unfilled: string[] }> {
	const [shards, fills] = await db.batch([
		db.prepare('SELECT key, written_at FROM pyramid_shards WHERE pyramid = ?').bind(pyramid),
		db.prepare('SELECT key, shard_written_at FROM rg_manifest_fills WHERE pyramid = ?').bind(pyramid),
	]);
	const fillMap = new Map(
		((fills.results ?? []) as { key: string; shard_written_at: number }[])
			.map((r) => [r.key, r.shard_written_at]),
	);
	const stale: string[] = [];
	const unfilled: string[] = [];
	let filled = 0;
	for (const s of (shards.results ?? []) as { key: string; written_at: number }[]) {
		const fillAt = fillMap.get(s.key);
		if (fillAt === undefined) unfilled.push(s.key);
		else if (fillAt !== s.written_at) stale.push(s.key);
		else filled++;
	}
	return { registered: (shards.results ?? []).length, filled, stale, unfilled };
}

/** In-isolate single-flight: skip duplicate fills for a key already being
 *  filled here. Cross-isolate races are harmless: fills are idempotent
 *  (OR REPLACE, identical content for identical (key, written_at)), and
 *  the completeness sentinel is only written by a fill that ran to the
 *  end. */
const fillsInFlight = new Set<string>();

async function fillManifest(opts: SegmentFetchOpts, metadata: FileMetaData): Promise<void> {
	const { db, pyramid, key, writtenAt } = opts;
	const flightKey = `${pyramid}\0${key}`;
	if (fillsInFlight.has(flightKey)) return;
	fillsInFlight.add(flightKey);
	try {
		await fillManifestInner(db, pyramid, key, writtenAt, metadata, opts.cellCol);
	} finally {
		fillsInFlight.delete(flightKey);
	}
}

async function fillManifestInner(db: D1Database, pyramid: string, key: string, writtenAt: number, metadata: FileMetaData, cellCol: string): Promise<void> {
	const cellIdx = findColIdx(metadata, cellCol);
	const dtIdx = findColIdx(metadata, 'dt');
	const insert = db.prepare(
		'INSERT OR REPLACE INTO rg_manifest '
		+ '(pyramid, key, shard_written_at, rg_idx, row_start, num_rows, byte_start, byte_end, cell_min, cell_max, dt_min, dt_max, chunk_meta) '
		+ 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	);
	const stmts: D1PreparedStatement[] = [
		db.prepare('DELETE FROM rg_manifest_fills WHERE pyramid = ? AND key = ?').bind(pyramid, key),
		db.prepare('DELETE FROM rg_manifest WHERE pyramid = ? AND key = ?').bind(pyramid, key),
		db.prepare('INSERT OR REPLACE INTO rg_manifest_schema (pyramid, schema_json) VALUES (?, ?)')
			.bind(pyramid, JSON.stringify(metadata.schema, (_k, v) => typeof v === 'bigint' ? Number(v) : v)),
	];
	let rowStart = 0;
	metadata.row_groups.forEach((rg, rgIdx) => {
		const chunks: ChunkMeta[] = rg.columns.map((c) => {
			const md = c.meta_data!;
			return {
				name: md.path_in_schema[0],
				type: md.type as unknown as string,
				codec: md.codec as unknown as string,
				encodings: md.encodings as unknown as string[] | undefined,
				num_values: num(md.num_values),
				total_compressed_size: num(md.total_compressed_size),
				data_page_offset: num(md.data_page_offset),
				dictionary_page_offset: md.dictionary_page_offset !== undefined ? num(md.dictionary_page_offset) : undefined,
			};
		});
		const starts = chunks.map((c) => c.dictionary_page_offset ?? c.data_page_offset);
		const ends = chunks.map((c) => (c.dictionary_page_offset ?? c.data_page_offset) + c.total_compressed_size);
		const cellStats = cellIdx >= 0 ? rg.columns[cellIdx]?.meta_data?.statistics : undefined;
		const dtStats = dtIdx >= 0 ? rg.columns[dtIdx]?.meta_data?.statistics : undefined;
		const nRows = num(rg.num_rows);
		stmts.push(insert.bind(
			pyramid, key, writtenAt, rgIdx, rowStart, nRows,
			Math.min(...starts), Math.max(...ends),
			statStr(cellStats?.min_value), statStr(cellStats?.max_value),
			statNum(dtStats?.min_value), statNum(dtStats?.max_value),
			JSON.stringify(chunks),
		));
		rowStart += nRows;
	});
	// Sentinel last: only a fill that ran to completion is ever trusted.
	stmts.push(db.prepare(
		'INSERT OR REPLACE INTO rg_manifest_fills (pyramid, key, shard_written_at, n_rgs, filled_at) VALUES (?, ?, ?, ?, ?)',
	).bind(pyramid, key, writtenAt, metadata.row_groups.length, Date.now()));
	// D1 batches are atomic per call; chunk to keep individual batches
	// modest (big shards → ~5.6k inserts). Order across chunks is
	// sequential, so DELETEs run first and the sentinel lands last.
	const CHUNK = 50;
	for (let i = 0; i < stmts.length; i += CHUNK) {
		await db.batch(stmts.slice(i, i + CHUNK));
	}
}
