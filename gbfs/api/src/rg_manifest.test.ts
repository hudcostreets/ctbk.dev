/// <reference types="node" />
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';
import {
	cellTokenChunks,
	compactManifestKeys,
	decodeChunkMeta,
	decodeManifestRgs,
	encodeChunkMeta,
	matchQuery,
	mergeManifestRgs,
	pruneManifestOrphans,
	rgChunkMetas,
	schemaFingerprint,
	schemaLeaves,
	type ChunkMeta,
	type ManifestRg,
} from './rg_manifest';

// D1's hard ceiling — the reason the cell predicate chunks at all.
const D1_MAX_BINDS = 100;

const SELECT = 'SELECT rg_idx, row_start, num_rows, byte_start, byte_end, chunk_meta FROM rg_manifest '
	+ 'WHERE pyramid = ? AND key = ? AND shard_written_at = ? '
	+ 'AND (dt_max IS NULL OR dt_max >= ?) AND (dt_min IS NULL OR dt_min < ?) ';

const rg = (rg_idx: number): ManifestRg => ({
	rg_idx,
	row_start: rg_idx * 2048,
	num_rows: 2048,
	byte_start: rg_idx * 40_000,
	byte_end: (rg_idx + 1) * 40_000,
	chunk_meta: `[{"name":"cell","rg":${rg_idx}}]`,
});

// `s:<short_name>` identity keys, the shape `vocabCover` emits for
// per-station leaves.
const stations = (n: number): string[] =>
	Array.from({ length: n }, (_, i) => `s:${(5000 + i / 100).toFixed(2)}`);

describe('cellTokenChunks', () => {
	it('no tokens: one empty chunk (match statement carries no cell predicate)', () => {
		expect(cellTokenChunks([])).toEqual([[]]);
	});

	it('at the cap: a single chunk', () => {
		const toks = stations(45);
		expect(cellTokenChunks(toks)).toEqual([toks]);
	});

	it('one past the cap: splits 45 + 1 rather than degrading to a range', () => {
		const toks = stations(46);
		expect(cellTokenChunks(toks)).toEqual([toks.slice(0, 45), toks.slice(45)]);
	});

	it('100 tokens: 45 + 45 + 10', () => {
		const toks = stations(100);
		expect(cellTokenChunks(toks).map((c) => c.length)).toEqual([45, 45, 10]);
	});
});

describe('matchQuery', () => {
	it('no tokens: cell predicate omitted entirely; only the 5 fixed binds', () => {
		expect(matchQuery('rides-v5-start', 'k.parquet', 1_700_000_000_000, 10, 20, [])).toEqual({
			sql: `${SELECT}ORDER BY rg_idx`,
			binds: ['rides-v5-start', 'k.parquet', 1_700_000_000_000, 10, 20],
		});
	});

	it('two tokens: one exact overlap term each, OR-joined, 2 binds apiece', () => {
		expect(matchQuery('rides-v5-start', 'k.parquet', 1_700_000_000_000, 10, 20, ['s:5000.00', 's:5001.00'])).toEqual({
			sql: `${SELECT}AND (cell_min IS NULL OR (cell_min <= ? AND cell_max >= ?) OR (cell_min <= ? AND cell_max >= ?)) ORDER BY rg_idx`,
			binds: ['rides-v5-start', 'k.parquet', 1_700_000_000_000, 10, 20, 's:5000.00', 's:5000.00', 's:5001.00', 's:5001.00'],
		});
	});

	it('a full 45-token chunk stays within D1’s 100-bind ceiling', () => {
		const { binds } = matchQuery('rides-v5-start', 'k.parquet', 1_700_000_000_000, 10, 20, stations(45));
		expect(binds.length).toBe(95);
		expect(binds.length <= D1_MAX_BINDS).toBe(true);
	});
});

describe('mergeManifestRgs', () => {
	it('single chunk: returned as-is', () => {
		const rgs = [rg(0), rg(3), rg(7)];
		expect(mergeManifestRgs([rgs])).toEqual(rgs);
	});

	it('disjoint chunks: unioned in rg_idx order, not chunk order', () => {
		expect(mergeManifestRgs([[rg(5), rg(9)], [rg(1), rg(7)]]).map((r) => r.rg_idx)).toEqual([1, 5, 7, 9]);
	});

	it('overlapping chunks: an RG matched by tokens in several chunks appears once', () => {
		expect(mergeManifestRgs([[rg(2), rg(4)], [rg(4), rg(6)], [rg(2)]]).map((r) => r.rg_idx)).toEqual([2, 4, 6]);
	});

	it('all chunks empty: no RGs', () => {
		expect(mergeManifestRgs([[], []])).toEqual([]);
	});
});

// The pathological shape: a station selection that defeats `vocabCover`'s
// rollup entirely, so every wanted station descends to its own `s:` leaf.
// Real selections are contiguous and roll up to a handful of terms; this
// is the contrived worst case the chunking exists to keep exact.
describe('checkerboard selection (rollup-defeating)', () => {
	const vocab = stations(2397);           // full ctbk station vocabulary
	const picked = vocab.filter((_, i) => i % 2 === 0);

	it('splits into ceil(n/45) statements, each within the bind ceiling', () => {
		const chunks = cellTokenChunks(picked);
		expect(picked.length).toBe(1199);
		expect(chunks.length).toBe(27);
		expect(chunks.map((c) => c.length)).toEqual([...Array(26).fill(45), 29]);
		const bindCounts = chunks.map((c) => matchQuery('p', 'k', 0, 10, 20, c).binds.length);
		expect(bindCounts).toEqual([...Array(26).fill(95), 63]);
		expect(bindCounts.filter((n) => n > D1_MAX_BINDS)).toEqual([]);
	});

	it('partitions the tokens exactly: every token once, order preserved', () => {
		expect(cellTokenChunks(picked).flat()).toEqual(picked);
	});

	it('the whole vocabulary is still exact, not degraded', () => {
		const chunks = cellTokenChunks(vocab);
		expect(chunks.length).toBe(54);
		expect(chunks.flat()).toEqual(vocab);
	});
});

// Vite 5 doesn't know `node:sqlite` as a builtin; load it through require.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** D1 over `node:sqlite`: `prepare().bind().all()` + transactional `batch()`,
 *  with just the columns `pruneManifestOrphans` touches. */
function sqliteD1(rgManifestCols = 'pyramid TEXT, key TEXT, rg_idx INTEGER') {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE pyramid_shards (pyramid TEXT, key TEXT);
		CREATE TABLE rg_manifest (${rgManifestCols}, PRIMARY KEY (pyramid, key, rg_idx));
		CREATE TABLE rg_manifest_fills (pyramid TEXT, key TEXT, n_rgs INTEGER, PRIMARY KEY (pyramid, key));
		CREATE TABLE rg_manifest_schema (pyramid TEXT PRIMARY KEY, schema_json TEXT NOT NULL);
	`);
	type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; all: () => Promise<{ results: unknown[] }> };
	const stmt = (sql: string, args: unknown[] = []): Stmt => ({
		sql, args,
		bind: (...a) => stmt(sql, a),
		all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
	});
	return {
		db,
		prepare: (sql: string) => stmt(sql),
		batch: async (stmts: Stmt[]) => {
			db.exec('BEGIN');
			const out = stmts.map((st) => st.sql.startsWith('SELECT')
				? { results: db.prepare(st.sql).all(...(st.args as never[])) }
				: (db.prepare(st.sql).run(...(st.args as never[])), { results: [] }));
			db.exec('COMMIT');
			return out;
		},
	};
}

describe('pruneManifestOrphans', () => {
	/** `live` is registered; `old.a`/`old.b` were superseded (orphans); `other`
	 *  is another pyramid's orphan-looking key, which must be left alone. */
	function seed() {
		const d1 = sqliteD1();
		const add = (pyramid: string, key: string, rgs: number, registered: boolean) => {
			if (registered) d1.db.prepare('INSERT INTO pyramid_shards VALUES (?, ?)').run(pyramid, key);
			d1.db.prepare('INSERT INTO rg_manifest_fills VALUES (?, ?, ?)').run(pyramid, key, rgs);
			for (let i = 0; i < rgs; i++) d1.db.prepare('INSERT INTO rg_manifest VALUES (?, ?, ?)').run(pyramid, key, i);
		};
		add('rides-start', 'live', 2, true);
		add('rides-start', 'old.a', 3, false);
		add('rides-start', 'old.b', 1, false);
		add('rides-end', 'other', 4, false);
		return d1;
	}
	const rows = (d1: ReturnType<typeof sqliteD1>) => ({
		fills: d1.db.prepare('SELECT pyramid, key FROM rg_manifest_fills ORDER BY pyramid, key').all().map((r) => ({ ...(r as object) })),
		rgs: Number((d1.db.prepare('SELECT COUNT(*) AS n FROM rg_manifest').get() as { n: number }).n),
	});

	it('deletes only this pyramid\'s unregistered keys, `limit` at a time', async () => {
		const d1 = seed();
		expect(await pruneManifestOrphans(d1 as never, 'rides-start', { limit: 1 })).toEqual({ keys: ['old.a'], rgs: 3, remaining: 1 });
		expect(await pruneManifestOrphans(d1 as never, 'rides-start', { limit: 1 })).toEqual({ keys: ['old.b'], rgs: 1, remaining: 0 });
		expect(await pruneManifestOrphans(d1 as never, 'rides-start')).toEqual({ keys: [], rgs: 0, remaining: 0 });
		expect(rows(d1)).toEqual({
			fills: [{ pyramid: 'rides-end', key: 'other' }, { pyramid: 'rides-start', key: 'live' }],
			rgs: 2 + 4,
		});
	});

	it('dry run reports without deleting', async () => {
		const d1 = seed();
		expect(await pruneManifestOrphans(d1 as never, 'rides-start', { dryRun: true })).toEqual({ keys: ['old.a', 'old.b'], rgs: 4, remaining: 2 });
		expect(rows(d1).rgs).toBe(2 + 3 + 1 + 4);
	});
});

// Two of the 11 rides columns, as `fillManifestInner` extracts them from a
// footer, and the pyramid's stored (hyparquet) schema they line up with.
const SCHEMA = [
	{ repetition_type: 'REQUIRED', name: 'schema', num_children: 2 },
	{ type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL', name: 'cell', converted_type: 'UTF8' },
	{ type: 'INT64', repetition_type: 'OPTIONAL', name: 'dt' },
];
const LEAVES = schemaLeaves(SCHEMA);
const FP = schemaFingerprint(LEAVES);
const LEGACY: ChunkMeta[] = [
	{ name: 'cell', type: 'BYTE_ARRAY', codec: 'SNAPPY', encodings: ['PLAIN', 'RLE', 'RLE_DICTIONARY'], num_values: 2048, total_compressed_size: 104, data_page_offset: 47, dictionary_page_offset: 4 },
	{ name: 'dt', type: 'INT64', codec: 'SNAPPY', encodings: ['PLAIN', 'RLE'], num_values: 2048, total_compressed_size: 3268, data_page_offset: 151 },
];
const withoutEncodings = (cs: ChunkMeta[]) => cs.map(({ encodings: _e, ...c }) => c);

describe('chunk_meta encoding', () => {
	it('schema leaves skip the root', () => {
		expect(LEAVES).toEqual([{ name: 'cell', type: 'BYTE_ARRAY' }, { name: 'dt', type: 'INT64' }]);
		expect(FP).toMatch(/^[0-9a-f]{8}$/);
	});

	it('aligned chunks encode compactly, and decode back minus `encodings`', () => {
		const enc = encodeChunkMeta(LEGACY, LEAVES, 2048);
		expect(enc).toBe(`{"s":"${FP}","c":[["SNAPPY",47,104,4],["SNAPPY",151,3268,null]]}`);
		expect(decodeChunkMeta(enc, LEAVES, 2048)).toEqual(withoutEncodings(LEGACY));
	});

	it('`num_values` is kept only when it differs from the RG\'s row count', () => {
		const enc = encodeChunkMeta(LEGACY, LEAVES, 2050);
		expect(enc).toBe(`{"s":"${FP}","c":[["SNAPPY",47,104,4,2048],["SNAPPY",151,3268,null,2048]]}`);
		expect(decodeChunkMeta(enc, LEAVES, 2050)).toEqual(withoutEncodings(LEGACY));
	});

	it('chunks that don\'t line up with the schema stay legacy', () => {
		const reordered = [LEGACY[1]!, LEGACY[0]!];
		expect(encodeChunkMeta(reordered, LEAVES, 2048)).toBe(JSON.stringify(reordered));
		expect(encodeChunkMeta(LEGACY.slice(0, 1), LEAVES, 2048)).toBe(JSON.stringify(LEGACY.slice(0, 1)));
	});

	it('legacy rows decode as-is', () => {
		expect(decodeChunkMeta(JSON.stringify(LEGACY), LEAVES, 2048)).toEqual(LEGACY);
	});

	it('a compact row written against another schema throws (→ footer fallback + refill)', () => {
		const enc = encodeChunkMeta(LEGACY, LEAVES, 2048);
		const renamed = [LEAVES[0]!, { name: 'dt2', type: 'INT64' }];
		expect(() => decodeChunkMeta(enc, renamed, 2048)).toThrow(`chunk_meta schema fingerprint ${FP} != current ${schemaFingerprint(renamed)}`);
	});
});

describe('compactManifestKeys', () => {
	function seed() {
		const d1 = sqliteD1('pyramid TEXT, key TEXT, rg_idx INTEGER, num_rows INTEGER, chunk_meta TEXT');
		d1.db.prepare('INSERT INTO rg_manifest_schema VALUES (?, ?)').run('rides-start', JSON.stringify(SCHEMA));
		const add = (key: string, metas: string[]) => {
			d1.db.prepare('INSERT INTO rg_manifest_fills VALUES (?, ?, ?)').run('rides-start', key, metas.length);
			metas.forEach((m, i) => d1.db.prepare('INSERT INTO rg_manifest VALUES (?, ?, ?, ?, ?)').run('rides-start', key, i, 2048, m));
		};
		add('a', [JSON.stringify(LEGACY), JSON.stringify(LEGACY)]);
		add('b', [JSON.stringify([LEGACY[1], LEGACY[0]]), encodeChunkMeta(LEGACY, LEAVES, 2048)]);
		return d1;
	}
	const metas = (d1: ReturnType<typeof seed>) => d1.db.prepare('SELECT key, rg_idx, chunk_meta FROM rg_manifest ORDER BY key, rg_idx').all()
		.map((r) => { const { key, rg_idx, chunk_meta } = r as { key: string; rg_idx: number; chunk_meta: string }; return `${key}/${rg_idx} ${chunk_meta.startsWith('[') ? 'legacy' : 'compact'}`; });
	const compactLen = encodeChunkMeta(LEGACY, LEAVES, 2048).length;
	const legacyLen = JSON.stringify(LEGACY).length;

	it('converts legacy rows one key per call, leaving unaligned and already-compact rows alone', async () => {
		const d1 = seed();
		expect(await compactManifestKeys(d1 as never, 'rides-start')).toEqual({
			keys: ['a'], rgs: 2, converted: 2, compact: 0, unaligned: 0, mismatched: 0,
			bytes_before: 2 * legacyLen, bytes_after: 2 * compactLen, next: 'a',
		});
		expect(await compactManifestKeys(d1 as never, 'rides-start', { after: 'a' })).toEqual({
			keys: ['b'], rgs: 2, converted: 0, compact: 1, unaligned: 1, mismatched: 0,
			bytes_before: legacyLen + compactLen, bytes_after: legacyLen + compactLen, next: 'b',
		});
		expect(await compactManifestKeys(d1 as never, 'rides-start', { after: 'b' })).toMatchObject({ keys: [], next: null });
		expect(metas(d1)).toEqual(['a/0 compact', 'a/1 compact', 'b/0 legacy', 'b/1 compact']);
	});

	it('dry run reports without writing', async () => {
		const d1 = seed();
		expect(await compactManifestKeys(d1 as never, 'rides-start', { limit: 2, dryRun: true })).toMatchObject({ keys: ['a', 'b'], converted: 2, next: 'b' });
		expect(metas(d1)).toEqual(['a/0 legacy', 'a/1 legacy', 'b/0 legacy', 'b/1 compact']);
	});
});

describe('decodeManifestRgs over a real shard', () => {
	// `tl-1m.parquet`: one RG, dictionary-encoded `cell`, plain `dt`/`count_n`.
	const buf = readFileSync(new URL('./fixtures/tl-1m.parquet', import.meta.url));
	const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	const ab = bytes.slice().buffer;
	const metadata = parquetMetadata(ab);
	const schema = JSON.parse(JSON.stringify(metadata.schema, (_k, v) => typeof v === 'bigint' ? Number(v) : v)) as unknown[];
	const leaves = schemaLeaves(schema);
	const storage = { getRange: async (_key: string, start: number, end: number) => bytes.subarray(start, end) };
	const manifestRgs = (encode: (cs: ChunkMeta[], numRows: number) => string): ManifestRg[] =>
		metadata.row_groups.map((rg, rg_idx) => ({
			rg_idx, row_start: 0, num_rows: Number(rg.num_rows), byte_start: 0, byte_end: bytes.byteLength,
			chunk_meta: encode(rgChunkMetas(rg), Number(rg.num_rows)),
		}));

	it('compact and legacy rows decode to the same rows as a full-file read', async () => {
		const full = (await parquetReadObjects({ file: ab })).map((r) => ({ ...r, dt: new Date(Number(r.dt)), count_n: Number(r.count_n) }));
		const compact = manifestRgs((cs, n) => encodeChunkMeta(cs, leaves, n));
		expect(compact[0]!.chunk_meta.startsWith('{"s":')).toBe(true);
		const opts = { storage: storage as never, key: 'tl-1m.parquet' };
		const fromCompact = await decodeManifestRgs(opts, schema, compact);
		const fromLegacy = await decodeManifestRgs(opts, schema, manifestRgs((cs) => JSON.stringify(cs)));
		expect(fromCompact).toEqual(fromLegacy);
		expect(fromCompact.map((r) => ({ ...r }))).toEqual(full);
	});
});
