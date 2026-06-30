/**
 * avail-v3 unified-shard-ladder cascade.
 *
 * Per-/5m tick algorithm:
 *
 *   At T (UTC ms, T % 5min == 0), for each tier, walk the tier's
 *   shard-duration ladder (smallest → largest). For each shardDur where
 *   T % shardDur == 0, the ladder rung just closed — write that shard.
 *   Coarser rungs read the just-written finer rungs (R2 strong
 *   read-after-write).
 *
 * Storage layout (per `~/c/pyrmts/specs/unified-shard-ladder.md`):
 *
 *   avail-v3/{tier}/{shardDur}/{period}.parquet
 *
 *   Examples:
 *     avail-v3/1m/5min/2026-06-29T13-40.parquet
 *     avail-v3/1m/1h/2026-06-29T13.parquet
 *     avail-v3/1m/1d/2026-06-29.parquet           ← was "canonical"
 *
 * No special "canonical" vs "partial" code paths — the largest ladder
 * rung is the canonical (1d for /1m).
 *
 * v1 scope: /1m tier only. Coarser tiers (/2m..7d) get their own
 * ladders in v2 — same loop, different rungs.
 */
import { parquetReadObjects } from 'hyparquet';
import { D1ShardIndex } from 'pyrmts-cfw';
import type { Duration } from 'pyrmts';
import { getLucIndex } from './luc';
import {
	transformMinuteRows,
	mergeRows,
	sortRows,
	rowsToColumns,
	type AvailV3Row,
} from './transform';

export const PYRAMID_NAME = 'avail';
export const AVAIL_V3_PREFIX = 'avail-v3';

/** Source: legacy gbfs/loader per-minute parquet path. */
function rawMinuteKey(t: Date): string {
	const dateStr = t.toISOString().slice(0, 10);  // YYYY-MM-DD
	const hh = String(t.getUTCHours()).padStart(2, '0');
	const mm = String(t.getUTCMinutes()).padStart(2, '0');
	return `gbfs/avail/agg=1m/cons=1m/${dateStr}/${hh}${mm}.parquet`;
}

/** Unified avail-v3 shard key. Uniform `<tier>/<shardDur>/<period>`
 *  layout — no canonical/partial dichotomy. */
export function shardKey(tier: string, shardDur: Duration, periodStart: Date): string {
	return `${AVAIL_V3_PREFIX}/${tier}/${shardDur}/${formatPeriod(periodStart, durationToMin(shardDur))}.parquet`;
}

/** Period label by minute granularity. Minute-precision for sub-hour,
 *  hour-precision for sub-day, date-precision for ≥1d. */
function formatPeriod(periodStart: Date, shardDurMin: number): string {
	const iso = periodStart.toISOString();  // 2026-06-27T14:35:00.000Z
	if (shardDurMin < 60) {
		// minute-precision: 2026-06-27T14-35
		return iso.slice(0, 16).replace(':', '-');
	}
	if (shardDurMin < 60 * 24) {
		// hour-precision: 2026-06-27T14
		return iso.slice(0, 13);
	}
	// day-precision: 2026-06-27
	return iso.slice(0, 10);
}

/** Convert a Duration ("5min", "1h", "1d") to minutes. Avoids pulling
 *  pyrmts's full parser into the CFW. */
function durationToMin(d: Duration): number {
	const m = /^(\d+)(min|h|d)$/.exec(d);
	if (!m) throw new Error(`unsupported Duration in cascade ladder: ${d}`);
	const n = Number(m[1]);
	const unit = m[2];
	if (unit === 'min') return n;
	if (unit === 'h') return n * 60;
	if (unit === 'd') return n * 60 * 24;
	throw new Error(`unreachable: ${d}`);
}

// ─── Tier ladders ────────────────────────────────────────────────────

/** Per-tier shard-duration ladder, smallest → largest. Must match
 *  `gbfs/api/src/avail_geo.ts#TIERS` for the corresponding tier; the
 *  api worker reads what the cascade writes. */
export const LADDERS: Record<string, Duration[]> = {
	'1m': ['5min', '10min', '30min', '1h', '3h', '12h', '1d'],
	// v2: /2m..7d ladders. Sketched in `specs/avail-v3-steady-state.md`.
};

// ─── Source readers ─────────────────────────────────────────────────────

async function readRawMinute(r2: R2Bucket, t: Date): Promise<Record<string, unknown>[] | null> {
	const key = rawMinuteKey(t);
	const obj = await r2.get(key);
	if (!obj) return null;
	const buf = await obj.arrayBuffer();
	const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
	return (await parquetReadObjects({ file })) as Record<string, unknown>[];
}

async function readShard(r2: R2Bucket, key: string): Promise<AvailV3Row[] | null> {
	const obj = await r2.get(key);
	if (!obj) return null;
	const buf = await obj.arrayBuffer();
	const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
	const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
	return rows.map((r) => ({
		s2_cell: r.s2_cell as string,
		dt: r.dt as bigint,
		bikes: r.bikes as string,
		ebikes: r.ebikes as string,
		docks: r.docks as string,
		disabled: r.disabled as string,
		pending: r.pending as string,
	}));
}

async function writeParquet(r2: R2Bucket, key: string, rows: AvailV3Row[]): Promise<number> {
	if (rows.length === 0) return 0;
	const sorted = sortRows(rows);
	const cols = rowsToColumns(sorted);
	const { parquetWriteBuffer } = await import('hyparquet-writer');
	// `rg_size: 2048` per avail.yaml defaults.
	const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize: 2048 });
	await r2.put(key, buf, { httpMetadata: { contentType: 'application/octet-stream' } });
	return buf.byteLength;
}

// ─── Per-shard writer ───────────────────────────────────────────────────

export interface WriteResult {
	status: 'wrote' | 'exists' | 'no_inputs' | 'empty';
	key: string;
	bytes?: number;
	rows?: number;
	// Input-coverage tracking for watermark integrity. A `wrote` result with
	// `inputsPresent < inputsExpected` means we shipped a parquet with HOLES
	// — the watermark MUST NOT be recorded as authoritative, else queries
	// will see those holes as zero-data (silently wrong). Caller gates
	// `recordShard` on `inputsPresent === inputsExpected`.
	inputsPresent?: number;
	inputsExpected?: number;
}

/** Unified writer. Reads from raw 1m@1m (when shardDur is the smallest
 *  rung) or from the next-smaller rung's just-written shards. Merges,
 *  writes the parquet at the unified path. */
async function writeShard(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	tier: string,
	shardDur: Duration,
	prevShardDur: Duration | null,
	periodStart: Date,
): Promise<WriteResult> {
	const shardDurMin = durationToMin(shardDur);
	const key = shardKey(tier, shardDur, periodStart);
	if (await r2.head(key)) return { status: 'exists', key };

	if (prevShardDur === null) {
		// Smallest rung: read shardDurMin raw 1m@1m files, LUC-expand, build
		// histograms.
		const inputsExpected = shardDurMin;
		let inputsPresent = 0;
		const rows: AvailV3Row[] = [];
		for (let i = 0; i < shardDurMin; i++) {
			const t = new Date(periodStart.getTime() + i * 60_000);
			const raw = await readRawMinute(r2, t);
			if (raw === null) continue;
			inputsPresent++;
			rows.push(...transformMinuteRows(raw, luc));
		}
		if (rows.length === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };
		const bytes = await writeParquet(r2, key, rows);
		return { status: 'wrote', key, bytes, rows: rows.length, inputsPresent, inputsExpected };
	}

	// Coarser rung: read N× smaller-rung shards from this tier, merge.
	const prevShardDurMin = durationToMin(prevShardDur);
	const inputsExpected = shardDurMin / prevShardDurMin;
	const inputRowSets: AvailV3Row[][] = [];
	for (let i = 0; i < inputsExpected; i++) {
		const inputStart = new Date(periodStart.getTime() + i * prevShardDurMin * 60_000);
		const inputKey = shardKey(tier, prevShardDur, inputStart);
		const rows = await readShard(r2, inputKey);
		if (rows === null) continue;
		inputRowSets.push(rows);
	}
	const inputsPresent = inputRowSets.length;
	if (inputsPresent === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };
	const merged = mergeRows(inputRowSets);
	if (merged.length === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	const bytes = await writeParquet(r2, key, merged);
	return { status: 'wrote', key, bytes, rows: merged.length, inputsPresent, inputsExpected };
}

// ─── Per-tick orchestration ─────────────────────────────────────────────

/** Per-/5m tick handler. Loops every tier's ladder, writes rungs whose
 *  boundary closed at this tick. Returns the list of attempted writes
 *  for logging. */
export async function avail3Tick(
	r2: R2Bucket,
	db: D1Database,
	tickTime: Date,
): Promise<WriteResult[]> {
	// Floor to the minute before /5m alignment check. Cloudflare's cron
	// `scheduledTime` carries seconds-of-the-minute offset (~53s observed
	// in prod tail) — the gate must operate on the rounded minute, not
	// the actual fire time.
	const tickMinMs = Math.floor(tickTime.getTime() / 60_000) * 60_000;
	if (tickMinMs % (5 * 60_000) !== 0) return [];
	const tickMs = tickMinMs;
	const luc = await getLucIndex(r2);
	const shardIndex = new D1ShardIndex(db);
	const results: WriteResult[] = [];

	// Record a watermark ONLY when input coverage was complete. A wrote
	// result with partial coverage means we shipped a parquet with holes
	// (e.g. the loader missed a minute); recording its periodEnd as
	// authoritative would mislead the planner into trusting the gaps.
	const fullyCovered = (r: WriteResult) =>
		r.status === 'wrote' &&
		r.inputsPresent !== undefined &&
		r.inputsExpected !== undefined &&
		r.inputsPresent === r.inputsExpected;

	for (const [tier, ladder] of Object.entries(LADDERS)) {
		for (let i = 0; i < ladder.length; i++) {
			const shardDur = ladder[i]!;
			const shardDurMin = durationToMin(shardDur);
			if (tickMs % (shardDurMin * 60_000) !== 0) continue;

			const periodStart = new Date(tickMs - shardDurMin * 60_000);
			const prevShardDur = i === 0 ? null : ladder[i - 1]!;
			const r = await writeShard(r2, luc, tier, shardDur, prevShardDur, periodStart);
			results.push(r);

			if (fullyCovered(r)) {
				await shardIndex.recordShard({
					pyramidName: PYRAMID_NAME, tier, shardDur,
					periodStart, periodEnd: new Date(tickMs), key: r.key,
				});
			}
		}
	}

	return results;
}
