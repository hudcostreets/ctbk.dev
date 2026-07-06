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
	type AvailV3Row,
} from './transform';
import {
	streamShardRows,
	kwayMerge,
	aggregateStream,
	writeShardStreaming,
	writeShardRows,
} from './aggregate';

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
 *  api worker reads what the cascade writes.
 *
 *  Ladder design (see `configs/pyramids/avail.yaml` for the principles):
 *  fixed-duration only, adjacent ratios ≤ 5×, largest ≈ N=1440 × bin.
 *  Within-tier rungs must satisfy pyrmts's parser-enforced divisibility
 *  (each rung divides the next). */
export const LADDERS: Record<string, Duration[]> = {
	'1m':  ['5min', '10min', '30min', '1h', '3h', '12h', '1d'],
	'2m':  ['10min', '30min', '1h', '3h', '12h', '1d', '2d'],
	'3m':  ['15min', '30min', '1h', '3h', '12h', '1d', '3d'],
	'5m':  ['15min', '30min', '1h', '3h', '12h', '1d', '5d'],
	'10m': ['30min', '1h', '3h', '12h', '1d', '5d', '10d'],
	'15m': ['1h', '3h', '12h', '1d', '5d', '15d'],
	'30m': ['2h', '6h', '1d', '5d', '15d', '30d'],
	'1h':  ['3h', '12h', '2d', '10d', '30d', '60d'],
	'2h':  ['6h', '1d', '5d', '20d', '60d', '120d'],
	'3h':  ['12h', '2d', '10d', '30d', '90d', '180d'],
	'6h':  ['1d', '5d', '20d', '60d', '180d', '360d'],
	'12h': ['2d', '10d', '30d', '90d', '360d', '720d'],
	'1d':  ['3d', '15d', '30d', '90d', '360d', '1440d'],
	'3d':  ['15d', '30d', '60d', '120d', '360d', '720d', '1440d', '4320d'],
	'7d':  ['35d', '70d', '140d', '280d', '840d', '1680d', '3360d', '10080d'],
};

/** Tier-bin (in minutes), parsed once. Used to re-bin /1m source rows
 *  when a non-/1m tier's smallest rung sources from /1m shards. */
const TIER_BIN_MIN: Record<string, number> = Object.fromEntries(
	Object.entries({
		'1m': '1min', '2m': '2min', '3m': '3min', '5m': '5min',
		'10m': '10min', '15m': '15min', '30m': '30min',
		'1h': '1h', '2h': '2h', '3h': '3h', '6h': '6h', '12h': '12h',
		'1d': '1d', '3d': '3d', '7d': '7d',
	}).map(([k, v]) => [k, durationToMin(v as Duration)])
);

/** /1m's shard ladder in ascending minutes — used to pick a source rung
 *  for non-/1m tiers' smallest rungs. */
const ONE_M_RUNGS_MIN = LADDERS['1m']!.map((d) => durationToMin(d));

/** Pick the largest /1m rung L such that L ≤ shardDurMin AND L divides
 *  shardDurMin. Reads of `L`-sized shards span exactly `shardDurMin/L`
 *  shards and tile the [periodStart, periodStart+shardDurMin) window. */
function pickOneMSourceRung(shardDurMin: number): { sourceRungMin: number; sourceRungDur: Duration } {
	for (let i = ONE_M_RUNGS_MIN.length - 1; i >= 0; i--) {
		const r = ONE_M_RUNGS_MIN[i]!;
		if (r <= shardDurMin && shardDurMin % r === 0) {
			return { sourceRungMin: r, sourceRungDur: LADDERS['1m']![i]! };
		}
	}
	throw new Error(`no /1m rung divides ${shardDurMin}min`);
}

// ─── Source readers ─────────────────────────────────────────────────────

async function readRawMinute(r2: R2Bucket, t: Date): Promise<Record<string, unknown>[] | null> {
	const key = rawMinuteKey(t);
	const obj = await r2.get(key);
	if (!obj) return null;
	const buf = await obj.arrayBuffer();
	const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
	return (await parquetReadObjects({ file })) as Record<string, unknown>[];
}

/** Priority-ordered `(sourceTier, sourceRungDur, sourceRungMin, n)`
 *  candidates for building a shard at `(targetTier, shardDurMin)`.
 *  Mirrors `ctbk/pyramid_cascade/materialize.py:enumerate_source_candidates`
 *  — the Python planner already proven on the fsck fill.
 *
 *  Order:
 *    1. Within-target-tier smaller rungs, largest-first (strictly smaller
 *       than target). Skipped for the smallest rung of the target tier.
 *    2. Previous tiers (coarsest-bin-first, i.e. tier-index descending),
 *       each tier's rungs largest-first. Only rungs whose duration
 *       divides `shardDurMin` are eligible.
 *
 *  Caller checks each candidate's shard-existence (D1 or R2 HEAD) and
 *  picks the first fully-populated one. */
function priorityRungPairs(
	targetTier: string,
	shardDurMin: number,
): Array<{ tier: string; rungDur: Duration; rungMin: number }> {
	const out: Array<{ tier: string; rungDur: Duration; rungMin: number }> = [];
	const targetRungs = LADDERS[targetTier];
	if (!targetRungs) throw new Error(`unknown tier ${targetTier}`);
	const tierNames = Object.keys(LADDERS);
	const targetIdx = tierNames.indexOf(targetTier);

	// 1. Within-target-tier smaller rungs, largest-first
	for (let i = targetRungs.length - 1; i >= 0; i--) {
		const r = targetRungs[i]!;
		const rm = durationToMin(r);
		if (rm >= shardDurMin) continue;
		if (shardDurMin % rm !== 0) continue;
		out.push({ tier: targetTier, rungDur: r, rungMin: rm });
	}
	// 2. Previous tiers (coarsest first), each rung largest-first
	for (let prev = targetIdx - 1; prev >= 0; prev--) {
		const prevTier = tierNames[prev]!;
		const prevRungs = LADDERS[prevTier]!;
		for (let j = prevRungs.length - 1; j >= 0; j--) {
			const r = prevRungs[j]!;
			const rm = durationToMin(r);
			if (rm > shardDurMin) continue;
			if (shardDurMin % rm !== 0) continue;
			out.push({ tier: prevTier, rungDur: r, rungMin: rm });
		}
	}
	return out;
}

/** For a target `(tier, shardDurMin, periodStart)`, walk priority pairs
 *  and pick the first candidate where every source-shard key is present
 *  on R2. Falls through to `/1m` fallback only if nothing coarser works —
 *  matches fsck's heterogeneous planner behavior.
 *
 *  Returns the picked candidate as (sourceTier, sourceRungDur, keys[]).
 *  HEAD-checks are done in parallel per candidate to bound latency. */
async function pickSourceForShard(
	r2: R2Bucket,
	targetTier: string,
	shardDurMin: number,
	periodStart: Date,
): Promise<{ sourceTier: string; sourceRungDur: Duration; sourceRungMin: number; keys: string[] }> {
	for (const cand of priorityRungPairs(targetTier, shardDurMin)) {
		const n = shardDurMin / cand.rungMin;
		const keys: string[] = [];
		for (let i = 0; i < n; i++) {
			const start = new Date(periodStart.getTime() + i * cand.rungMin * 60_000);
			keys.push(shardKey(cand.tier, cand.rungDur, start));
		}
		const heads = await Promise.all(keys.map((k) => r2.head(k)));
		if (heads.every((h) => h !== null)) {
			return { sourceTier: cand.tier, sourceRungDur: cand.rungDur, sourceRungMin: cand.rungMin, keys };
		}
	}
	// Fallback: /1m@X — largest /1m rung that divides. Matches the historic
	// naive path; keys may 404 (pre-data or unwritten), read loop tolerates.
	const { sourceRungMin, sourceRungDur } = pickOneMSourceRung(shardDurMin);
	const n = shardDurMin / sourceRungMin;
	const keys: string[] = [];
	for (let i = 0; i < n; i++) {
		const start = new Date(periodStart.getTime() + i * sourceRungMin * 60_000);
		keys.push(shardKey('1m', sourceRungDur, start));
	}
	return { sourceTier: '1m', sourceRungDur, sourceRungMin, keys };
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

/** HEAD-check N candidate keys in parallel. Returns the subset that
 *  exists, preserving order. */
async function existingKeys(r2: R2Bucket, keys: string[]): Promise<string[]> {
	const heads = await Promise.all(keys.map((k) => r2.head(k)));
	return keys.filter((_, i) => heads[i] !== null);
}

/** Unified writer. Reads from raw 1m@1m (when shardDur is the smallest
 *  rung of /1m) or from previously-written shards (coarser rungs +
 *  non-/1m tiers). Streams merged output straight through `ParquetWriter`
 *  — no intermediate `AvailV3Row[]` buffer, no output-cardinality
 *  aggregator; peak heap is bounded by one row-group's rows regardless
 *  of shard size (per specs/avail-v3-cascade-streaming.md Phase A). */
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

	if (prevShardDur === null && tier === '1m') {
		// /1m base case: read shardDurMin raw 1m@1m files, LUC-expand, build
		// histograms. Bounded input (~5 min × ~19K post-LUC-expansion rows =
		// ~95K rows for /1m@5min) — keep in-memory, stream through the writer.
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
		const { bytes, rows: written } = await writeShardRows(r2, key, rows);
		return { status: 'wrote', key, bytes, rows: written, inputsPresent, inputsExpected };
	}

	// Streaming source read: HEAD-check candidates, open one iterator per
	// present key, k-way heap-merge into a sorted stream, single-bucket
	// aggregate, write incrementally.
	let sourceKeys: string[];
	let inputsExpected: number;
	let targetBinMs: bigint;

	if (prevShardDur === null) {
		// Non-/1m smallest rung: pick coarsest-available prev-tier source
		// via the heterogeneous cover chain. Rebin to this tier's bin.
		const picked = await pickSourceForShard(r2, tier, shardDurMin, periodStart);
		sourceKeys = picked.keys;
		inputsExpected = picked.keys.length;
		const tierBinMin = TIER_BIN_MIN[tier]!;
		targetBinMs = BigInt(tierBinMin * 60_000);
	} else {
		// Coarser same-tier rung: read N × prev-rung shards. Sources are
		// already at this tier's bin — no rebin needed.
		const prevShardDurMin = durationToMin(prevShardDur);
		inputsExpected = shardDurMin / prevShardDurMin;
		sourceKeys = [];
		for (let i = 0; i < inputsExpected; i++) {
			const inputStart = new Date(periodStart.getTime() + i * prevShardDurMin * 60_000);
			sourceKeys.push(shardKey(tier, prevShardDur, inputStart));
		}
		targetBinMs = 0n;
	}

	const present = await existingKeys(r2, sourceKeys);
	const inputsPresent = present.length;
	if (inputsPresent === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };

	const iters = present.map((k) => streamShardRows(r2, k));
	const merged = kwayMerge(iters, targetBinMs);
	const aggregated = aggregateStream(merged);
	const { bytes, rows: written } = await writeShardStreaming(r2, key, aggregated);
	if (written === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	return { status: 'wrote', key, bytes, rows: written, inputsPresent, inputsExpected };
}

// ─── Per-tick orchestration ─────────────────────────────────────────────

/** Per-/5m tick handler. Loops every tier's ladder, writes rungs whose
 *  boundary closed at this tick. Returns the list of attempted writes
 *  for logging.
 *
 *  `opts.tiers` optionally restricts the walk to a subset of tiers (for
 *  debugging / isolation tests); default = all tiers.
 *  `opts.shardDurs` optionally restricts to a subset of shard-durations. */
export async function avail3Tick(
	r2: R2Bucket,
	db: D1Database,
	tickTime: Date,
	opts?: { tiers?: string[]; shardDurs?: string[] },
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
	const tierFilter = opts?.tiers ? new Set(opts.tiers) : null;
	const shardDurFilter = opts?.shardDurs ? new Set(opts.shardDurs) : null;

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
		if (tierFilter && !tierFilter.has(tier)) continue;
		for (let i = 0; i < ladder.length; i++) {
			const shardDur = ladder[i]!;
			if (shardDurFilter && !shardDurFilter.has(shardDur)) continue;
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
