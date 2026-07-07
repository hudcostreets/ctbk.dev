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
import { D1ShardIndex, r2Storage } from 'pyrmts-cfw';
import {
	listExpectedShards,
	listMissingShards,
	parquetBackend,
	pyramidFromConfig,
	type Duration,
	type ExpectedShard,
	type PyramidConfig,
	type RecordedShard,
} from 'pyrmts';
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

/** Convert a Duration ("5min", "1h", "1d", or legacy "1mo"/"1y"/"Nd")
 *  to minutes. Legacy calendar units (`mo`, `y`) are approximations —
 *  used only for sort ordering / covering-parent checks in `gcSweep()`
 *  against pre-cutover D1 rows. Current-ladder writes never emit
 *  `mo`/`y` durations, so the approximation is inertial-only. */
function durationToMin(d: string): number {
	const m = /^(\d+)(min|h|d|mo|y)$/.exec(d);
	if (!m) throw new Error(`unsupported Duration in cascade ladder: ${d}`);
	const n = Number(m[1]);
	const unit = m[2];
	if (unit === 'min') return n;
	if (unit === 'h')   return n * 60;
	if (unit === 'd')   return n * 60 * 24;
	if (unit === 'mo')  return n * 60 * 24 * 30;
	if (unit === 'y')   return n * 60 * 24 * 365;
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
	status: 'wrote' | 'exists' | 'no_inputs' | 'empty' | 'too_large';
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
	// For `too_large`: estimated output cells×bins so operators can see
	// which rungs got skipped and why.
	estimatedRows?: number;
}

/** Cell-count in the LUC index (stations × mean-chain-length after dedup).
 *  Empirically ~9k for avail-v3. Used to bound output-row estimates. */
let _cellCountCache: number | null = null;
function lucCellCount(luc: import('./luc').LucIndex): number {
	if (_cellCountCache !== null) return _cellCountCache;
	const uniq = new Set<string>();
	for (const chain of luc.chains.values()) for (const c of chain) uniq.add(c);
	_cellCountCache = uniq.size;
	return _cellCountCache;
}

/** Maximum output rows a CFW isolate can build in one writeShard call
 *  without OOM. Under the multipart R2 writer, peak per-write memory
 *  is bounded (~8 MB part + one row-group's encode state + streaming
 *  inputs) regardless of shard size, so the ceiling is CPU, not
 *  memory: 5.5M rows × ~5 µs/row for parquet encode ≈ 27 s, close to
 *  the paid tier 30 s cap. Set to 10M as a safety net — anything
 *  legitimately over should get filled offline via the Node CLI. */
const MAX_OUTPUT_ROWS = 10_000_000;

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
	let sourceKeys: string[] = [];
	let inputsExpected = 0;
	let targetBinMs: bigint = 0n;

	// Try same-tier prev-rung first (fast path when it's populated —
	// no rebinning needed, and under the boundary-fire regime that
	// was the common case). If the prev-rung isn't on R2 (typical
	// under min-cover, where trailing rungs aren't materialized for
	// historical periods), fall through to `pickSourceForShard`'s
	// heterogeneous cover chain, which walks priority-ordered
	// candidates (within-tier smaller rungs → prev tiers → /1m
	// fallback) and picks the first fully-populated set.
	let usedSameTierPrev = false;
	if (prevShardDur !== null) {
		const prevShardDurMin = durationToMin(prevShardDur);
		const expected = shardDurMin / prevShardDurMin;
		const candidateKeys: string[] = [];
		for (let i = 0; i < expected; i++) {
			const inputStart = new Date(periodStart.getTime() + i * prevShardDurMin * 60_000);
			candidateKeys.push(shardKey(tier, prevShardDur, inputStart));
		}
		const heads = await Promise.all(candidateKeys.map((k) => r2.head(k)));
		if (heads.every((h) => h !== null)) {
			sourceKeys = candidateKeys;
			inputsExpected = expected;
			targetBinMs = 0n;
			usedSameTierPrev = true;
		}
	}

	if (!usedSameTierPrev) {
		// Fall back to heterogeneous cover (used by non-/1m smallest
		// rungs and coarser rungs whose prev-rung isn't materialized).
		// Rebin to this tier's bin — sources may come from a different
		// tier with a finer bin.
		const picked = await pickSourceForShard(r2, tier, shardDurMin, periodStart);
		sourceKeys = picked.keys;
		inputsExpected = picked.keys.length;
		const tierBinMin = TIER_BIN_MIN[tier]!;
		targetBinMs = BigInt(tierBinMin * 60_000);
	}

	const present = await existingKeys(r2, sourceKeys);
	const inputsPresent = present.length;
	if (inputsPresent === 0) return { status: 'no_inputs', key, inputsPresent, inputsExpected };

	// Pre-flight OOM guard. Output row count is bounded by
	// `unique_cells × bins_per_shard`. Rungs above the empirical CFW
	// threshold get skipped so subsequent tier rungs at this tick still
	// fire (an OOM would terminate the isolate, killing them all).
	// Offline `converge()` on `e`/laptop picks up the skipped shards.
	const tierBinMin = TIER_BIN_MIN[tier]!;
	const estimatedRows = lucCellCount(luc) * (shardDurMin / tierBinMin);
	if (estimatedRows > MAX_OUTPUT_ROWS) {
		return { status: 'too_large', key, inputsPresent, inputsExpected, estimatedRows };
	}

	const iters = present.map((k) => streamShardRows(r2, k));
	const merged = kwayMerge(iters, targetBinMs);
	const aggregated = aggregateStream(merged);
	const { bytes, rows: written } = await writeShardStreaming(r2, key, aggregated);
	if (written === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	return { status: 'wrote', key, bytes, rows: written, inputsPresent, inputsExpected };
}

// ─── Per-tick orchestration ─────────────────────────────────────────────

// ─── converge(): the runtime-agnostic tick primitive ────────────────

/** Options for `converge()`. Per `specs/avail-v3-cascade-streaming.md`.
 *  The CFW cron adapter passes `{now: tickTime, timeBudgetMs: 25_000}`;
 *  a laptop / e adapter would pass `{parallelism: 16, timeBudgetMs: Infinity}`
 *  and loop until `report.results` is stable. */
export interface ConvergeOpts {
	/** Reference time — defaults to `new Date()`. */
	now?: Date;
	/** Restrict to a subset of tiers. Default: all tiers in `LADDERS`. */
	tiers?: string[];
	/** Restrict to a subset of shard-durations. Default: all in the tier. */
	shardDurs?: string[];
	/** Stop before wall-clock exceeds this (ms). Default: no limit. */
	timeBudgetMs?: number;
	/** Hard cap on operations this call. Default: no limit. */
	maxOps?: number;
	/** Compute results but don't write — for planning / diff monitoring. */
	dryRun?: boolean;
}

export interface ConvergeReport {
	now: Date;
	/** Total missing shards in the [genesis, now] range (before this
	 *  call). `results.length ≤ totalMissing` — anything the call didn't
	 *  attempt (budget hit / filter) contributes to a subsequent call's
	 *  totalMissing. */
	totalMissing: number;
	results: WriteResult[];
	stats: Record<string, number>;
	/** Non-null if we bailed early. */
	stoppedReason?: 'time' | 'ops';
}

/** avail-v3 genesis: earliest UTC timestamp for which raw /1m WAL data
 *  exists (per `ctbk/avail_v3.py`'s `AVAIL_GENESIS`). Range floor for
 *  gap-discovery — anything before this is trivially `no_inputs`. */
const AVAIL_GENESIS = new Date('2026-04-07T00:00:00Z');

/** avail-v3 pyramid config. Kept in sync with `configs/pyramids/avail.yaml`
 *  by hand (the YAML remains the source of truth for the Python fsck and
 *  the api worker; ideally the CFW bundles it too, but vitest/wrangler
 *  disagree on YAML import loaders — inlining is the least-bad workaround
 *  until we standardize on a plugin). If you edit the YAML, edit this. */
const AVAIL_PYRAMID_CONFIG: PyramidConfig = {
	storage: { type: 's3', bucket: 'ctbk', key: 'avail-v3/{tier}/{shard}/{period}.parquet' },
	keyTemplate: 'avail-v3/{tier}/{shard}/{period}.parquet',
	axis: 'time',
	binCol: 'dt',
	dims: [{ name: 's2_cell', type: 'string' }],
	metrics: [
		{ name: 'bikes',    monoid: 'histogram' },
		{ name: 'ebikes',   monoid: 'histogram' },
		{ name: 'docks',    monoid: 'histogram' },
		{ name: 'disabled', monoid: 'histogram' },
		{ name: 'pending',  monoid: 'histogram' },
	],
	tiers: [
		{ name: '1m',  bin: '1min',  shards: ['5min', '10min', '30min', '1h', '3h', '12h', '1d'] },
		{ name: '2m',  bin: '2min',  shards: ['10min', '30min', '1h', '3h', '12h', '1d', '2d'] },
		{ name: '3m',  bin: '3min',  shards: ['15min', '30min', '1h', '3h', '12h', '1d', '3d'] },
		{ name: '5m',  bin: '5min',  shards: ['15min', '30min', '1h', '3h', '12h', '1d', '5d'] },
		{ name: '10m', bin: '10min', shards: ['30min', '1h', '3h', '12h', '1d', '5d', '10d'] },
		{ name: '15m', bin: '15min', shards: ['1h', '3h', '12h', '1d', '5d', '15d'] },
		{ name: '30m', bin: '30min', shards: ['2h', '6h', '1d', '5d', '15d', '30d'] },
		{ name: '1h',  bin: '1h',    shards: ['3h', '12h', '2d', '10d', '30d', '60d'] },
		{ name: '2h',  bin: '2h',    shards: ['6h', '1d', '5d', '20d', '60d', '120d'] },
		{ name: '3h',  bin: '3h',    shards: ['12h', '2d', '10d', '30d', '90d', '180d'] },
		{ name: '6h',  bin: '6h',    shards: ['1d', '5d', '20d', '60d', '180d', '360d'] },
		{ name: '12h', bin: '12h',   shards: ['2d', '10d', '30d', '90d', '360d', '720d'] },
		{ name: '1d',  bin: '1d',    shards: ['3d', '15d', '30d', '90d', '360d', '1440d'] },
		{ name: '3d',  bin: '3d',    shards: ['15d', '30d', '60d', '120d', '360d', '720d', '1440d', '4320d'] },
		{ name: '7d',  bin: '7d',    shards: ['35d', '70d', '140d', '280d', '840d', '1680d', '3360d', '10080d'] },
	],
	geo: { cellCol: 's2_cell', resolutions: [15, 14, 13, 12, 11, 10] },
};

/** Look up prev-rung shard_dur from the ladder for a given (tier, shardDur).
 *  Returns null if `shardDur` is the smallest rung of `tier` (in which
 *  case `writeShard` uses raw ingest for `/1m` or the heterogeneous
 *  cover chain for non-/1m). */
function prevShardDurOf(tier: string, shardDur: Duration): Duration | null {
	const ladder = LADDERS[tier];
	if (!ladder) throw new Error(`unknown tier: ${tier}`);
	const i = ladder.indexOf(shardDur);
	if (i < 0) throw new Error(`shardDur ${shardDur} not in ${tier} ladder`);
	return i === 0 ? null : ladder[i - 1]!;
}

/** Dependency sort for missing shards. Writes are safe iff every input
 *  a shard reads is either (a) already on R2 or (b) written earlier in
 *  the same pass. Smallest shard_dur first (within a tier, coarser rungs
 *  read finer rungs); across tiers, /1m first (raw-ingest sources); then
 *  by period_start ascending so a same-tier coarser rung's finer
 *  siblings land first when both are missing. */
function sortMissing(a: ExpectedShard, b: ExpectedShard): number {
	const tiers = Object.keys(LADDERS);
	const ta = tiers.indexOf(a.tier);
	const tb = tiers.indexOf(b.tier);
	const da = durationToMin(a.shardDur as Duration);
	const db = durationToMin(b.shardDur as Duration);
	if (da !== db) return da - db;
	if (ta !== tb) return ta - tb;
	return a.periodStart.getTime() - b.periodStart.getTime();
}

/** Runtime-agnostic cascade primitive. Diff-loop semantics: for every
 *  tick (or CLI invocation), compute the min-cover expected shards over
 *  [genesis, now], subtract what's registered in D1, and write the
 *  delta smallest-rung-first until the budget's spent. Missed ticks
 *  self-heal on the next call — same primitive, larger `to Write` set.
 *
 *  Adapters:
 *  - CFW cron (`avail3Tick`): `converge(r2, db, {now: tickTime, timeBudgetMs: 25_000})`
 *  - `/avail3?t=…` debug endpoint: as above + optional tier/shardDur / dryRun
 *  - Node CLI (follow-on): `converge(r2, db, {timeBudgetMs: Infinity})` loop
 *
 *  Never throws for individual rung failures — those land in `results[]`
 *  with a non-`wrote` status. Throws only for hard errors (LUC load, D1
 *  binding invalid, YAML parse, etc.). */
export async function converge(
	r2: R2Bucket,
	db: D1Database,
	opts: ConvergeOpts = {},
): Promise<ConvergeReport> {
	const now = opts.now ?? new Date();
	const startedAt = Date.now();
	const results: WriteResult[] = [];
	const stats: Record<string, number> = {};

	const tierFilter = opts.tiers ? new Set(opts.tiers) : null;
	const shardDurFilter = opts.shardDurs ? new Set(opts.shardDurs) : null;
	const dryRun = opts.dryRun ?? false;
	const maxOps = opts.maxOps ?? Infinity;
	const timeBudgetMs = opts.timeBudgetMs ?? Infinity;

	// Build Pyramid from YAML + R2 binding. `pyramidFromConfig` needs a
	// StorageBackend; gap-discovery only touches `pyramid.tiers` and
	// `pyramid.keyTemplate`, so the storage is unused here — same
	// `parquetBackend(r2Storage(r2))` the api worker uses keeps the
	// type happy without pulling in more machinery.
	const pyramid = pyramidFromConfig(AVAIL_PYRAMID_CONFIG, parquetBackend(r2Storage(r2)));
	const shardIndex = new D1ShardIndex(db);

	// Diff: what does the min-cover ladder declare over [genesis, now],
	// minus what's already in D1?
	const range = { from: AVAIL_GENESIS, to: now };
	let missing = await listMissingShards(pyramid, PYRAMID_NAME, shardIndex, range);
	// Apply user filters.
	if (tierFilter) missing = missing.filter((m) => tierFilter.has(m.tier));
	if (shardDurFilter) missing = missing.filter((m) => shardDurFilter.has(m.shardDur));
	// Dependency-sort so finer rungs get written before their coarser
	// consumers (see `sortMissing`).
	missing.sort(sortMissing);
	const totalMissing = missing.length;

	const outOfBudget = (): 'time' | 'ops' | null => {
		if (results.length >= maxOps) return 'ops';
		if (Date.now() - startedAt >= timeBudgetMs) return 'time';
		return null;
	};

	// Watermark integrity: only record when input coverage was complete
	// (partial coverage → shard has holes, watermark would mislead
	// the planner into trusting them).
	const fullyCovered = (r: WriteResult) =>
		r.status === 'wrote' &&
		r.inputsPresent !== undefined &&
		r.inputsExpected !== undefined &&
		r.inputsPresent === r.inputsExpected;

	// LUC needed only for /1m raw-ingest writes; lazy-load on first use
	// so a dry-run (or a run that only touches non-/1m tiers) skips it.
	let luc: import('./luc').LucIndex | null = null;
	const getLuc = async () => luc ?? (luc = await getLucIndex(r2));

	let stopped: 'time' | 'ops' | undefined;
	for (const shard of missing) {
		const budgetHit = outOfBudget();
		if (budgetHit) { stopped = budgetHit; break; }

		if (dryRun) {
			// HEAD-only sweep — cheap classification for planning /
			// /health alerting. No sources read, no writes.
			const r: WriteResult = {
				status: (await r2.head(shard.key)) ? 'exists' : 'no_inputs',
				key: shard.key,
			};
			results.push(r);
			stats[r.status] = (stats[r.status] ?? 0) + 1;
			continue;
		}

		const prevShardDur = prevShardDurOf(shard.tier, shard.shardDur as Duration);
		const r = await writeShard(r2, await getLuc(), shard.tier, shard.shardDur as Duration, prevShardDur, shard.periodStart);
		results.push(r);
		stats[r.status] = (stats[r.status] ?? 0) + 1;

		if (fullyCovered(r)) {
			await shardIndex.recordShard({
				pyramidName: PYRAMID_NAME,
				tier: shard.tier,
				shardDur: shard.shardDur as Duration,
				periodStart: shard.periodStart,
				periodEnd: shard.periodEnd,
				key: r.key,
			});
		}
	}

	return { now, totalMissing, results, stats, stoppedReason: stopped };
}

/** CFW cron adapter. Preserves the historical (r2, db, tickTime) surface
 *  used by `worker.scheduled` + the `/avail3` debug endpoint. Thin wrapper
 *  over `converge()`; kept as a stable name so consumers don't have to
 *  update on each Phase B/C refactor. */
export async function avail3Tick(
	r2: R2Bucket,
	db: D1Database,
	tickTime: Date,
	opts?: { tiers?: string[]; shardDurs?: string[]; dryRun?: boolean; timeBudgetMs?: number },
): Promise<WriteResult[]> {
	const report = await converge(r2, db, {
		now: tickTime,
		timeBudgetMs: opts?.timeBudgetMs ?? 25_000,
		tiers: opts?.tiers,
		shardDurs: opts?.shardDurs,
		dryRun: opts?.dryRun,
	});
	return report.results;
}

// ─── gcSweep(): the GC companion to converge() ──────────────────────

export interface GcSweepOpts {
	now?: Date;
	tiers?: string[];
	/** Skip GC of shards whose `period_end + graceMinutes > now`. Buys
	 *  read-repair time for in-flight queries reading the sub-max shard
	 *  before the max-rung replacement lands. Default 15 min. */
	graceMinutes?: number;
	dryRun?: boolean;
	maxOps?: number;
	timeBudgetMs?: number;
}

export interface GcSweepReport {
	now: Date;
	/** Count of registered-but-not-in-min-cover shards found at call start. */
	totalEligible: number;
	deleted: RecordedShard[];
	/** Registered-but-not-in-min-cover shards NOT deleted this call, with
	 *  reason (no covering parent on R2, past grace window, etc.). */
	skipped: Array<{ shard: RecordedShard; reason: string }>;
	stats: Record<string, number>;
	stoppedReason?: 'time' | 'ops';
}

/** GC companion to `converge()`. Deletes registered shards that are
 *  superseded by a min-cover shard covering the same period (and past
 *  the grace window). Kept as a SEPARATE primitive from `converge()` —
 *  the writer stays monotone-additive; GC is a distinct, opt-in
 *  operation. Turning it off (skip the cron / don't invoke) just
 *  leaves R2/D1 fat but functionally correct.
 *
 *  Safety: only deletes when the covering min-cover parent is
 *  demonstrably on R2 (r2.head returns non-null). No parent → skip.
 *  Prevents deleting a shard before its replacement lands.
 *
 *  Adapters: dedicated cron (e.g. `0 6 * * *`) or CLI subcommand.
 *  Same shape as `converge()` for symmetry. */
export async function gcSweep(
	r2: R2Bucket,
	db: D1Database,
	opts: GcSweepOpts = {},
): Promise<GcSweepReport> {
	const now = opts.now ?? new Date();
	const startedAt = Date.now();
	const deleted: RecordedShard[] = [];
	const skipped: Array<{ shard: RecordedShard; reason: string }> = [];
	const stats: Record<string, number> = {};

	const tierFilter = opts.tiers ? new Set(opts.tiers) : null;
	const graceMs = (opts.graceMinutes ?? 15) * 60_000;
	const dryRun = opts.dryRun ?? false;
	const maxOps = opts.maxOps ?? Infinity;
	const timeBudgetMs = opts.timeBudgetMs ?? Infinity;

	const pyramid = pyramidFromConfig(AVAIL_PYRAMID_CONFIG, parquetBackend(r2Storage(r2)));
	const shardIndex = new D1ShardIndex(db);

	// Compute the min-cover expected set for [genesis, now]. Index by
	// (tier, shardDur, periodStart-ms) so we can quickly answer
	// "is this recorded shard in min-cover?"
	const expected = listExpectedShards(pyramid, { from: AVAIL_GENESIS, to: now });
	const expectedIds = new Set<string>();
	// Also bucket by tier so we can find covering parents efficiently.
	const expectedByTier = new Map<string, ExpectedShard[]>();
	for (const e of expected) {
		expectedIds.add(`${e.tier}\x00${e.shardDur}\x00${e.periodStart.getTime()}`);
		let bucket = expectedByTier.get(e.tier);
		if (!bucket) { bucket = []; expectedByTier.set(e.tier, bucket); }
		bucket.push(e);
	}

	const recorded = await shardIndex.listShards(PYRAMID_NAME);
	// Eligible: registered but NOT in current min-cover.
	let eligible = recorded.filter((r) => {
		if (tierFilter && !tierFilter.has(r.tier)) return false;
		const id = `${r.tier}\x00${r.shardDur}\x00${r.periodStart.getTime()}`;
		return !expectedIds.has(id);
	});
	const totalEligible = eligible.length;

	// Sort deterministically for reproducible reports: by (tier, shardDur, periodStart).
	eligible.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
		const da = durationToMin(a.shardDur as Duration);
		const dbb = durationToMin(b.shardDur as Duration);
		if (da !== dbb) return da - dbb;
		return a.periodStart.getTime() - b.periodStart.getTime();
	});

	const outOfBudget = (): 'time' | 'ops' | null => {
		if (deleted.length + skipped.length >= maxOps) return 'ops';
		if (Date.now() - startedAt >= timeBudgetMs) return 'time';
		return null;
	};

	/** Find a min-cover expected shard within `r.tier` whose period
	 *  fully contains `r`'s period AND has a strictly larger shardDur.
	 *  Returns the smallest such shard (tightest parent). null if none. */
	const findCoveringParent = (r: RecordedShard): ExpectedShard | null => {
		const bucket = expectedByTier.get(r.tier);
		if (!bucket) return null;
		const rDur = durationToMin(r.shardDur as Duration);
		const rStart = r.periodStart.getTime();
		const rEnd = r.periodEnd.getTime();
		let best: ExpectedShard | null = null;
		let bestDur = Infinity;
		for (const e of bucket) {
			const eDur = durationToMin(e.shardDur as Duration);
			if (eDur <= rDur) continue;
			if (e.periodStart.getTime() > rStart) continue;
			if (e.periodEnd.getTime() < rEnd) continue;
			if (eDur < bestDur) { best = e; bestDur = eDur; }
		}
		return best;
	};

	let stopped: 'time' | 'ops' | undefined;
	for (const r of eligible) {
		const budgetHit = outOfBudget();
		if (budgetHit) { stopped = budgetHit; break; }

		// Grace: shard.period_end + graceMinutes must be ≤ now.
		if (r.periodEnd.getTime() + graceMs > now.getTime()) {
			skipped.push({ shard: r, reason: 'within-grace' });
			stats['within-grace'] = (stats['within-grace'] ?? 0) + 1;
			continue;
		}

		const parent = findCoveringParent(r);
		if (!parent) {
			skipped.push({ shard: r, reason: 'no-covering-parent' });
			stats['no-covering-parent'] = (stats['no-covering-parent'] ?? 0) + 1;
			continue;
		}
		// Parent must be on R2 — else deleting `r` would leave a gap.
		const parentHead = await r2.head(parent.key);
		if (!parentHead) {
			skipped.push({ shard: r, reason: 'parent-not-on-r2' });
			stats['parent-not-on-r2'] = (stats['parent-not-on-r2'] ?? 0) + 1;
			continue;
		}

		if (dryRun) {
			// Report what WOULD be deleted; don't touch R2/D1.
			deleted.push(r);
			stats['dry-run'] = (stats['dry-run'] ?? 0) + 1;
			continue;
		}

		// Delete R2 object, then D1 row. R2 first so a mid-op crash
		// leaves D1 pointing at a missing key (which the api planner
		// handles) instead of an orphaned R2 object.
		try {
			await r2.delete(r.key);
		} catch (err) {
			skipped.push({ shard: r, reason: `r2-delete-failed: ${err}` });
			stats['r2-delete-failed'] = (stats['r2-delete-failed'] ?? 0) + 1;
			continue;
		}
		try {
			await db.prepare(
				`DELETE FROM pyramid_shards WHERE pyramid = ? AND tier = ? AND shard_dur = ? AND period_start = ?`,
			).bind(PYRAMID_NAME, r.tier, r.shardDur, r.periodStart.getTime()).run();
		} catch (err) {
			// R2 delete succeeded but D1 didn't. Next sweep will re-see
			// the shard as recorded (since D1 still has the row) but
			// r.key HEAD will return null. Should probably retry the
			// D1 delete then; for now, record the skip.
			skipped.push({ shard: r, reason: `d1-delete-failed: ${err}` });
			stats['d1-delete-failed'] = (stats['d1-delete-failed'] ?? 0) + 1;
			continue;
		}
		deleted.push(r);
		stats['deleted'] = (stats['deleted'] ?? 0) + 1;
	}

	return { now, totalEligible, deleted, skipped, stats, stoppedReason: stopped };
}
