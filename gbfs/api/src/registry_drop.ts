/** Retire a pyramid from the D1 registry (`ctbk gbfs d1 drop`, via the
 *  `/api/registry` `drop` op so it writes through the worker's D1 binding).
 *  Deletes `pyramid_shards` rows in bounded chunks (one call per chunk keeps
 *  each statement well inside D1's per-query limits); once none remain, clears
 *  the pyramid's `pyramid_watermarks` + RG-manifest rows. R2 shards are
 *  untouched. Refuses the watched (live) pyramids. */

import { WATCHED_PYRAMIDS, watchedRegistryName } from './health';

interface Stmt {
	bind(...args: unknown[]): Stmt;
	all<T = unknown>(): Promise<{ results?: T[] }>;
}
export interface DropDb {
	prepare(sql: string): Stmt;
	batch(stmts: Stmt[]): Promise<unknown[]>;
}

export interface DropResult {
	pyramid: string;
	deleted: number;
	remaining: number;
	/** Set once `remaining` hits 0: the pyramid's side tables were cleared. */
	cleared?: boolean;
	dryRun?: boolean;
}

const SIDE_TABLES = ['pyramid_watermarks', 'rg_manifest', 'rg_manifest_fills', 'rg_manifest_schema'];

export function livePyramids(): string[] {
	return WATCHED_PYRAMIDS.map(watchedRegistryName);
}

async function count(db: DropDb, pyramid: string): Promise<number> {
	const rs = await db.prepare('SELECT COUNT(*) AS n FROM pyramid_shards WHERE pyramid = ?').bind(pyramid).all<{ n: number }>();
	return rs.results?.[0]?.n ?? 0;
}

export async function dropPyramidRows(
	db: DropDb,
	pyramid: string,
	{ limit = 5000, dryRun = false }: { limit?: number; dryRun?: boolean } = {},
): Promise<DropResult> {
	if (livePyramids().includes(pyramid)) throw new Error(`refusing to drop live pyramid ${pyramid}`);
	const before = await count(db, pyramid);
	if (dryRun) return { pyramid, deleted: 0, remaining: before, dryRun: true };
	if (before > 0) {
		// `pyramid_shards` is `WITHOUT ROWID`: address the chunk by its PK.
		await db.prepare(
			'DELETE FROM pyramid_shards WHERE pyramid = ? AND (tier, shard_dur, period_start) IN '
			+ '(SELECT tier, shard_dur, period_start FROM pyramid_shards WHERE pyramid = ? LIMIT ?)',
		).bind(pyramid, pyramid, limit).all();
	}
	const remaining = await count(db, pyramid);
	const result: DropResult = { pyramid, deleted: before - remaining, remaining };
	if (remaining === 0) {
		await db.batch(SIDE_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE pyramid = ?`).bind(pyramid)));
		result.cleared = true;
	}
	return result;
}
