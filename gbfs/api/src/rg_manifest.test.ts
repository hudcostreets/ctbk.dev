/// <reference types="node" />
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { cellTokenChunks, matchQuery, mergeManifestRgs, pruneManifestOrphans, type ManifestRg } from './rg_manifest';

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
function sqliteD1() {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE pyramid_shards (pyramid TEXT, key TEXT);
		CREATE TABLE rg_manifest (pyramid TEXT, key TEXT, rg_idx INTEGER, PRIMARY KEY (pyramid, key, rg_idx));
		CREATE TABLE rg_manifest_fills (pyramid TEXT, key TEXT, n_rgs INTEGER, PRIMARY KEY (pyramid, key));
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
			for (const st of stmts) db.prepare(st.sql).run(...(st.args as never[]));
			db.exec('COMMIT');
			return [];
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
