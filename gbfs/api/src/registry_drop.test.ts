/// <reference types="node" />
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { dropPyramidRows, livePyramids, type DropDb } from './registry_drop';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const TABLES = ['pyramid_shards', 'pyramid_watermarks', 'rg_manifest', 'rg_manifest_fills', 'rg_manifest_schema'];

/** D1 over `node:sqlite`, seeded with a retired pyramid (`old`: 5 shards + a
 *  row in every side table) and a kept one (`keep`). */
function seed() {
	const db = new DatabaseSync(':memory:');
	for (const t of TABLES) db.exec(`CREATE TABLE ${t} (pyramid TEXT, key TEXT)`);
	for (const p of ['old', 'keep']) {
		const n = p === 'old' ? 5 : 2;
		for (let i = 0; i < n; i++) db.prepare('INSERT INTO pyramid_shards VALUES (?, ?)').run(p, `${p}/${i}`);
		for (const t of TABLES.slice(1)) db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).run(p, `${p}/0`);
	}
	type Stmt = { sql: string; args: unknown[]; bind: (...a: unknown[]) => Stmt; all: () => Promise<{ results: unknown[] }> };
	const stmt = (sql: string, args: unknown[] = []): Stmt => ({
		sql, args,
		bind: (...a) => stmt(sql, a),
		all: async () => sql.startsWith('SELECT')
			? { results: db.prepare(sql).all(...(args as never[])) }
			: (db.prepare(sql).run(...(args as never[])), { results: [] }),
	});
	const d1 = {
		prepare: (sql: string) => stmt(sql),
		batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.all())),
	};
	const counts = () => Object.fromEntries(TABLES.map((t) => [t,
		db.prepare(`SELECT pyramid, COUNT(*) AS n FROM ${t} GROUP BY 1 ORDER BY 1`).all().map((r) => `${(r as any).pyramid}:${(r as any).n}`),
	]));
	return { d1: d1 as never as DropDb, counts };
}

describe('dropPyramidRows', () => {
	it('deletes shard rows `limit` at a time, then clears side tables; other pyramids untouched', async () => {
		const { d1, counts } = seed();
		expect(await dropPyramidRows(d1, 'old', { limit: 3 })).toEqual({ pyramid: 'old', deleted: 3, remaining: 2 });
		expect(counts().pyramid_watermarks).toEqual(['keep:1', 'old:1']);
		expect(await dropPyramidRows(d1, 'old', { limit: 3 })).toEqual({ pyramid: 'old', deleted: 2, remaining: 0, cleared: true });
		expect(counts()).toEqual({
			pyramid_shards: ['keep:2'],
			pyramid_watermarks: ['keep:1'],
			rg_manifest: ['keep:1'],
			rg_manifest_fills: ['keep:1'],
			rg_manifest_schema: ['keep:1'],
		});
		expect(await dropPyramidRows(d1, 'old')).toEqual({ pyramid: 'old', deleted: 0, remaining: 0, cleared: true });
	});

	it('dry run reports without deleting', async () => {
		const { d1, counts } = seed();
		expect(await dropPyramidRows(d1, 'old', { dryRun: true })).toEqual({ pyramid: 'old', deleted: 0, remaining: 5, dryRun: true });
		expect(counts().pyramid_shards).toEqual(['keep:2', 'old:5']);
	});

	it('refuses live pyramids', async () => {
		const { d1 } = seed();
		expect(livePyramids()).toEqual(['avail-v6', 'smg-v1', 'rides-start', 'rides-end']);
		await expect(dropPyramidRows(d1, 'avail-v6')).rejects.toThrow('refusing to drop live pyramid avail-v6');
	});
});
