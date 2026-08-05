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
	sortRows,
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
 *  fixed-duration only, adjacent ratios ≤ 3×. Sub-day rungs follow the
 *  base-60 chain; day-and-above rungs follow powers-of-2 for uniform
 *  SUF=2. Within-tier rungs must satisfy pyrmts's parser-enforced
 *  divisibility (each rung divides the next). */
export const LADDERS: Record<string, Duration[]> = {
	'1m':  ['5min', '10min', '30min', '1h', '3h', '6h', '12h'],
	'2m':  ['10min', '30min', '1h', '3h', '6h', '12h', '1d'],
	'3m':  ['15min', '30min', '1h', '3h', '6h', '12h', '1d', '2d'],
	'5m':  ['15min', '30min', '1h', '3h', '6h', '12h', '1d', '2d'],
	'10m': ['30min', '1h', '3h', '6h', '12h', '1d', '2d', '4d'],
	'15m': ['1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d'],
	'30m': ['2h', '6h', '12h', '1d', '2d', '4d', '8d', '16d'],
	'1h':  ['3h', '6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d'],
	'2h':  ['6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d'],
	'3h':  ['12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d'],
	'6h':  ['1d', '2d', '4d', '8d', '16d', '32d', '64d', '128d'],
	'12h': ['2d', '4d', '8d', '16d', '32d', '64d', '128d', '256d'],
	'1d':  ['4d', '8d', '16d', '32d', '64d', '128d', '256d', '512d'],
	'3d':  ['12d', '24d', '48d', '96d', '192d', '384d', '768d', '1536d'],
	'7d':  ['28d', '56d', '112d', '224d', '448d', '896d', '1792d', '3584d'],
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

// ─── Source tier map (strict cascade) ───────────────────────────────────

/** Ordered tier names, finest → coarsest, matching LADDERS iteration
 *  order. */
const TIER_NAMES = Object.keys(LADDERS);

/** For each target tier, the tier `T'` its cascade sources from — the
 *  largest `T'` with `bin(T') < bin(T)` AND `bin(T) % bin(T') == 0`.
 *  Bin-divisibility guarantees the target's floor-then-groupby rebin is
 *  exact — a source bin that doesn't divide the target's would silently
 *  smear source buckets across neighboring target bins (the
 *  silent-corruption bug the strict-cascade rewrite fixed on the Python
 *  side; see `specs/avail-v3-strict-cascade.md`).
 *
 *  `/1m` maps to `null` — it sources from the raw WAL (per-minute
 *  parquets under `gbfs/avail/agg=1m/cons=1m/`), not from any other
 *  tier. Note the current ladder yields these mappings:
 *    /2m → /1m    /3m → /1m    /5m → /1m
 *    /10m→ /5m    /15m→ /5m    /30m→ /15m
 *    /1h → /30m   /2h → /1h    /3h → /1h
 *    /6h → /3h    /12h→ /6h    /1d → /12h
 *    /3d → /1d    /7d → /1d
 *
 *  Note `/7d`'s source is `/1d`, not `/3d` (7d % 3d ≠ 0). Same reason
 *  `/2h` and `/5m` have no direct descendants in this ladder. */
const SOURCE_TIER_FOR: Record<string, string | null> = (() => {
	const out: Record<string, string | null> = {};
	for (let i = 0; i < TIER_NAMES.length; i++) {
		const t = TIER_NAMES[i]!;
		const targetBin = TIER_BIN_MIN[t]!;
		if (i === 0) { out[t] = null; continue; }
		let src: string | null = null;
		for (let j = i - 1; j >= 0; j--) {
			const cand = TIER_NAMES[j]!;
			const candBin = TIER_BIN_MIN[cand]!;
			if (candBin < targetBin && targetBin % candBin === 0) { src = cand; break; }
		}
		if (src === null) {
			throw new Error(`no bin-divisible source tier for ${t} in ladder`);
		}
		out[t] = src;
	}
	return out;
})();

/** Public accessor. Returns null for `/1m` (raw WAL source), else the
 *  strict-cascade source tier name. Throws for unknown tiers. */
export function sourceTierFor(tier: string): string | null {
	if (!(tier in SOURCE_TIER_FOR)) throw new Error(`unknown tier: ${tier}`);
	return SOURCE_TIER_FOR[tier]!;
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

/** HEAD-check N candidate keys in parallel. Returns the present subset
 *  paired with `size` (bytes), preserving order. Callers that only need
 *  the keys can `.map(x => x.key)`. */
async function existingKeysWithSize(r2: R2Bucket, keys: string[]): Promise<Array<{ key: string; size: number }>> {
	const heads = await Promise.all(keys.map((k) => r2.head(k)));
	const out: Array<{ key: string; size: number }> = [];
	for (let i = 0; i < keys.length; i++) {
		const h = heads[i];
		if (h !== null) out.push({ key: keys[i]!, size: h.size });
	}
	return out;
}

/** Sum of source bytes above which CFW writeShard exceeds the paid-tier
 *  30 s CPU cap. Under chunked streaming, memory isn't the bottleneck —
 *  hyparquet decode + histogram merge + re-encode is. Empirically a
 *  5.5 M-row `/1m@1d` write (from 24 MB of `/1m@3h` sources) takes
 *  ~28 s CPU — right at the cap. A single 43 MB `/1m@1d` source pushes
 *  a `/Nm@1d` write past 30 s.
 *
 *  NOTE this guard is largely redundant with the ladder's `N ≤ 960`
 *  cap, which already bounds ROWS per write (the real CPU/memory
 *  driver — the streaming reader holds ≤ 3 × 8 MB chunks per source
 *  regardless of file size). Bytes additionally vary with bin width
 *  (coarser bins → fatter histogram JSON: ~6 B/row at /1m vs ~9 at
 *  /2m) and with plan raggedness (`holeFillBytes` counts FULL source
 *  file sizes for clipped reads). At 30 MB the cap sat exactly at
 *  `/2m@1d`'s happy-path telescope (~30 MB) and permanently wedged it
 *  after the 2026-07-10 scars inflated the plan to ~54 MB. 64 MB
 *  clears every in-ladder rung (worst honest telescope ~30 MB;
 *  accounting-inflated ragged plans ~54 MB) while still bouncing
 *  genuinely oversized (off-ladder / misconfig) targets. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Pure-DAG cascade writer. For a target `(tier, shardDur, periodStart)`:
 *
 *   - `/1m@<smallest>` sources from raw WAL (per-minute JSON parquets).
 *     Bounded input: `smallest-rung` minutes × ~4 MB/min of JS heap.
 *   - Non-`/1m@<smallest>` sources from `sourceTierFor(tier)`'s outer
 *     expected shards intersecting `[effectiveStart, effectiveEnd)`.
 *     Bin-divisibility guaranteed by `SOURCE_TIER_FOR` construction —
 *     the target's floor-then-groupby rebin is exact.
 *   - Every larger rung consolidates the same tier's dust: a greedy
 *     largest-first tiling of the period from EXISTING finer same-tier
 *     shards, with residual holes filled from the tier's upstream
 *     source (raw WAL for `/1m`, `sourceTierFor` cover shards
 *     otherwise). See `writeSameTierCascade` for why a rigid
 *     prev-rung × k source set wedges.
 *
 *  All non-raw paths stream: `streamShardRows` × k → `kwayMerge` →
 *  `aggregateStream` → `clipDtRange` (overshoot-safe) → `writeShardStreaming`.
 *  Peak isolate memory is bounded to O(k × row_group_size × row_bytes)
 *  ≈ few MB regardless of shard size.
 *
 *  Uncovered ⇒ `no_inputs` with `inputsPresent < inputsExpected`;
 *  caller's `fullyCovered` gate keeps D1 unchanged, next `converge()`
 *  retries once source rungs fill in.
 *
 *  Under the ladder cap `N ≤ 960` (see `configs/pyramids/avail.yaml`),
 *  no single shard's output exceeds ~17s wall clock — safely under the
 *  CFW 30s CPU cap. Shards above `N=960` don't exist in the ladder;
 *  offline `ctbk pyramid-cascade` on `e` picks up any theoretical need. */
export async function writeShard(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	tier: string,
	shardDur: Duration,
	periodStart: Date,
	effectiveStart: Date,
	effectiveEnd: Date,
	expectedByTier: Map<string, ExpectedShard[]>,
): Promise<WriteResult> {
	const shardDurMin = durationToMin(shardDur);
	const key = shardKey(tier, shardDur, periodStart);
	if (await r2.head(key)) return { status: 'exists', key };

	const effStartMs = effectiveStart.getTime();
	const effEndMs = effectiveEnd.getTime();
	const ladder = LADDERS[tier];
	if (!ladder) throw new Error(`unknown tier: ${tier}`);
	const rungIdx = ladder.indexOf(shardDur);
	if (rungIdx < 0) throw new Error(`shardDur ${shardDur} not in ${tier} ladder`);

	if (rungIdx === 0) {
		// Smallest rung of the tier.
		if (tier === '1m') {
			return writeRawIngest(r2, luc, effStartMs, effEndMs, key);
		}
		return writeCrossTierSmallest(r2, luc, tier, shardDurMin,
			effStartMs, effEndMs, key, expectedByTier);
	}

	// Larger rung: consolidate the tier's dust (existing finer shards +
	// upstream hole-fill).
	return writeSameTierCascade(r2, luc, tier, shardDurMin,
		ladder.slice(0, rungIdx), effStartMs, effEndMs, key, expectedByTier);
}

/** Read + LUC-expand raw per-minute parquets over `[startMs, endMs)`.
 *  Buffers all rows (~1 MB per raw minute post-LUC) — callers cap the
 *  range (`MAX_RAW_FILL_MIN` for hole-fill; the smallest /1m rung for
 *  `writeRawIngest`). */
async function readRawRows(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	startMs: number,
	endMs: number,
): Promise<{ rows: AvailV3Row[]; present: number; expected: number }> {
	const expected = Math.floor((endMs - startMs) / 60_000);
	let present = 0;
	const rows: AvailV3Row[] = [];
	for (let ms = startMs; ms < endMs; ms += 60_000) {
		const raw = await readRawMinute(r2, new Date(ms));
		if (raw === null) continue;
		present++;
		rows.push(...transformMinuteRows(raw, luc));
	}
	return { rows, present, expected };
}

/** `/1m@<smallest>` from raw per-minute JSON parquets. Bounded to the
 *  smallest rung's minute count (5 min under the current ladder =
 *  ~19K rows × ~280 B ≈ 5 MB peak buffer). */
async function writeRawIngest(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	effStartMs: number,
	effEndMs: number,
	key: string,
): Promise<WriteResult> {
	const { rows, present, expected } = await readRawRows(r2, luc, effStartMs, effEndMs);
	if (rows.length === 0) {
		return { status: 'no_inputs', key, inputsPresent: present, inputsExpected: expected };
	}
	const { bytes, rows: written } = await writeShardRows(r2, key, rows);
	return { status: 'wrote', key, bytes, rows: written, inputsPresent: present, inputsExpected: expected };
}

/** Non-`/1m` smallest rung. Cross-tier cascade from
 *  `sourceTierFor(tier)`'s outer expected shards intersecting the
 *  target's eff range. Handles rebin (`kwayMerge` floors dt to
 *  target bin) and overshoot (`clipDtRange` drops rows outside
 *  `[effStart, effEnd)`). */
async function writeCrossTierSmallest(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	tier: string,
	shardDurMin: number,
	effStartMs: number,
	effEndMs: number,
	key: string,
	expectedByTier: Map<string, ExpectedShard[]>,
): Promise<WriteResult> {
	const srcTierName = sourceTierFor(tier);
	if (srcTierName === null) throw new Error(`unreachable: non-/1m tier ${tier} has no source tier`);
	const srcExpected = (expectedByTier.get(srcTierName) ?? [])
		.filter((e) => e.effectiveEnd.getTime() > effStartMs && e.effectiveStart.getTime() < effEndMs);
	const sourceKeys = srcExpected.map((e) => e.key);
	const inputsExpected = sourceKeys.length;
	if (inputsExpected === 0) {
		return { status: 'no_inputs', key, inputsPresent: 0, inputsExpected: 0 };
	}
	const targetBinMs = BigInt(TIER_BIN_MIN[tier]! * 60_000);
	return streamMerge(r2, luc, tier, shardDurMin, sourceKeys, targetBinMs,
		effStartMs, effEndMs, key);
}

/** Max tiles (existing-shard sources + holes) a single same-tier
 *  consolidation will attempt. Steady-state consolidations need ≤ ~12
 *  (one dust shard per ladder step, ×2 for the boundary walk); anything
 *  bigger means a degraded/holey period that the offline fsck on `e`
 *  should rebuild instead (unbounded RAM, fused stages). */
const MAX_TILES = 32;

/** Max raw-WAL minutes a `/1m` consolidation will buffer to fill holes.
 *  Raw rows are ~1 MB/min post-LUC (buffered + sorted before merge), so
 *  30 min ≈ 30 MB — safe in the 128 MB isolate. Steady-state holes are
 *  exactly one finest-rung width (5 min); the cap only matters after an
 *  outage, where anything beyond it defers to the offline fsck. */
const MAX_RAW_FILL_MIN = 30;

/** Anti-race damper for the currently-closing period: a WAL put can be
 *  seconds in flight, so a hole younger than this defers one tick.
 *  Beyond it, ship with whatever minutes exist — an absent minute is
 *  just absent (patchy raw data is an invariant), and a datum that
 *  lands late repairs built shards via the invalidation journal
 *  (`specs/shard-invalidation-adoption.md`) rather than a wait/skip
 *  heuristic. Same policy as the Lambda's `CRON_JITTER_GRACE_S`. */
const CRON_JITTER_GRACE_MS = 120_000;

/** Greedy largest-first tiling of `[effStartMs, effEndMs)` from EXISTING
 *  same-tier shards at rungs finer than the target. At each position,
 *  probe rungs largest-first (aligned + fitting) and take the first that
 *  exists; positions with no existing shard become holes (advanced at
 *  finest-rung granularity, coalesced).
 *
 *  Exported for tests; `probe` abstracts `r2.head(shardKey(...))`. */
export async function planDustTiling(
	finerRungs: readonly Duration[],
	effStartMs: number,
	effEndMs: number,
	probe: (rung: Duration, startMs: number) => Promise<{ size: number } | null>,
): Promise<{ tiles: Array<{ rung: Duration; startMs: number; endMs: number; size: number }>; holes: Array<[number, number]>; aborted: boolean }> {
	const rungMs = finerRungs.map((r) => durationToMin(r) * 60_000);
	const finestMs = rungMs[0]!;
	const tiles: Array<{ rung: Duration; startMs: number; endMs: number; size: number }> = [];
	const holes: Array<[number, number]> = [];
	let cur = effStartMs;
	while (cur < effEndMs) {
		if (tiles.length + holes.length > MAX_TILES) {
			return { tiles, holes, aborted: true };
		}
		let matched = false;
		for (let i = finerRungs.length - 1; i >= 0; i--) {
			const rMs = rungMs[i]!;
			if (cur % rMs !== 0) continue;
			if (cur + rMs > effEndMs) continue;
			const head = await probe(finerRungs[i]!, cur);
			if (head === null) continue;
			tiles.push({ rung: finerRungs[i]!, startMs: cur, endMs: cur + rMs, size: head.size });
			cur += rMs;
			matched = true;
			break;
		}
		if (!matched) {
			// Hole: advance to the next finest-rung boundary (or effEnd).
			const next = Math.min(effEndMs, (Math.floor(cur / finestMs) + 1) * finestMs);
			const last = holes[holes.length - 1];
			if (last && last[1] === cur) last[1] = next;
			else holes.push([cur, next]);
			cur = next;
		}
	}
	return { tiles, holes, aborted: false };
}

/** Same-tier consolidation: "produce the max-rung shard from the dust".
 *
 *  Sources = greedy largest-first tiling of the period from EXISTING
 *  finer same-tier shards, holes filled from the tier's upstream source
 *  (raw WAL for `/1m`, `sourceTierFor`'s cover shards for `/Nm`).
 *
 *  Why not prev-rung × k: the min-cover dust never materializes the
 *  LAST constituent of a closing rung — it closes and is superseded in
 *  the same tick (e.g. `5min@00:35` for `10min@00:30`, `30min@00:30`
 *  for `1h@00:00`), so it's never in any tick's missing list and never
 *  written. A rigid prev-rung × k source set therefore wedges with
 *  `no_inputs` at every consolidation boundary — the 2026-07-09 prod
 *  incident (every tier's dust column stuck from midnight on). In
 *  steady state the tiling leaves exactly ONE hole of finest-rung
 *  width at the period's tail; hole-fill closes it.
 *
 *  Same tier → same bin, so tiled sources merge with no rebin (the
 *  `targetBinMs` floor is an identity on already-aligned rows); hole
 *  fills from the source tier rebin exactly (bin-divisibility). */
async function writeSameTierCascade(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	tier: string,
	shardDurMin: number,
	finerRungs: readonly Duration[],
	effStartMs: number,
	effEndMs: number,
	key: string,
	expectedByTier: Map<string, ExpectedShard[]>,
): Promise<WriteResult> {
	let { tiles, holes } = await planDustTiling(
		finerRungs, effStartMs, effEndMs,
		(rung, startMs) => r2.head(shardKey(tier, rung, new Date(startMs))),
	);
	if (tiles.length + holes.length > MAX_TILES) {
		// Fragmented dust (outage/wedge scar): a tiling this shredded
		// costs more than it saves. Fall back to treating the WHOLE
		// period as one hole — pure upstream fill (fewer, larger
		// sources); the byte/row guards below still bound the work.
		// For /1m this defers to the raw cap (offline fsck territory
		// beyond MAX_RAW_FILL_MIN); for /Nm the source tier's cover is
		// exactly the right-sized read.
		tiles = [];
		holes = [[effStartMs, effEndMs]];
	}

	// Hole-fill sources. `/1m` reads raw WAL (bounded); `/Nm` reads the
	// source tier's current min-cover shards intersecting each hole,
	// clipped to the hole so they can't double-count rows the same-tier
	// tiles already cover.
	const holeMs = holes.reduce((a, [s, e]) => a + (e - s), 0);
	let inputsExpected = tiles.length;
	let inputsPresent = tiles.length;
	const holeIters: AsyncGenerator<AvailV3Row>[] = [];
	let holeFillBytes = 0;

	if (holeMs > 0) {
		if (tier === '1m') {
			const holeMin = holeMs / 60_000;
			if (holeMin > MAX_RAW_FILL_MIN) {
				return { status: 'no_inputs', key, inputsPresent, inputsExpected: inputsExpected + holes.length };
			}
			for (const [s, e] of holes) {
				const { rows, present, expected } = await readRawRows(r2, luc, s, e);
				if (present < expected && e > Date.now() - CRON_JITTER_GRACE_MS) {
					// Hole in the currently-closing period: the WAL put may
					// be in flight — retry on a later tick.
					inputsExpected += expected;
					inputsPresent += present;
					return { status: 'no_inputs', key, inputsPresent, inputsExpected };
				}
				// Past the grace window, build with what exists (prod: WAL
				// minute 14:58 on 2026-07-10 wedged `/1m@3h` + every tier
				// downstream under the old strict check). A late-landing
				// minute repairs via the invalidation journal. Count only
				// the minutes that exist so the rung ships + registers.
				inputsExpected += present;
				inputsPresent += present;
				if (rows.length > 0) {
					const sorted = sortRows(rows);
					holeIters.push((async function* () { for (const r of sorted) yield r; })());
				}
			}
		} else {
			const srcTierName = sourceTierFor(tier);
			if (srcTierName === null) throw new Error(`unreachable: non-/1m tier ${tier} has no source tier`);
			const srcExpected = expectedByTier.get(srcTierName) ?? [];
			for (const [s, e] of holes) {
				const covering = srcExpected.filter(
					(x) => x.effectiveEnd.getTime() > s && x.effectiveStart.getTime() < e);
				inputsExpected += Math.max(1, covering.length);
				if (covering.length === 0) {
					return { status: 'no_inputs', key, inputsPresent, inputsExpected };
				}
				const present = await existingKeysWithSize(r2, covering.map((x) => x.key));
				inputsPresent += present.length;
				if (present.length < covering.length) {
					return { status: 'no_inputs', key, inputsPresent, inputsExpected };
				}
				holeFillBytes += present.reduce((a, b) => a + b.size, 0);
				for (const p of present) {
					holeIters.push(clipDtRange(streamShardRows(r2, p.key), BigInt(s), BigInt(e)));
				}
			}
		}
	}

	if (tiles.length === 0 && holeIters.length === 0) {
		return { status: 'no_inputs', key, inputsPresent: 0, inputsExpected };
	}

	// OOM/CPU guards — same rationale as `streamMerge`.
	const tierBinMin = TIER_BIN_MIN[tier]!;
	const estimatedRows = lucCellCount(luc) * (shardDurMin / tierBinMin);
	if (estimatedRows > MAX_OUTPUT_ROWS) {
		return { status: 'too_large', key, inputsPresent, inputsExpected, estimatedRows };
	}
	const sourceBytes = tiles.reduce((a, t) => a + t.size, 0) + holeFillBytes;
	if (sourceBytes > MAX_SOURCE_BYTES) {
		return { status: 'too_large', key, inputsPresent, inputsExpected, estimatedRows: sourceBytes };
	}

	const iters = [
		...tiles.map((t) => streamShardRows(r2, shardKey(tier, t.rung, new Date(t.startMs)))),
		...holeIters,
	];
	// Floor to the tier bin: identity for same-tier tiles (already
	// aligned), exact rebin for cross-tier hole fills.
	const targetBinMs = BigInt(tierBinMin * 60_000);
	const merged = kwayMerge(iters, targetBinMs);
	const aggregated = aggregateStream(merged);
	const clipped = clipDtRange(aggregated, BigInt(effStartMs), BigInt(effEndMs));
	const { bytes, rows: written } = await writeShardStreaming(r2, key, clipped);
	if (written === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	return { status: 'wrote', key, bytes, rows: written, inputsPresent, inputsExpected };
}

/** Shared streaming-merge tail: HEAD-check sources, guard against
 *  runaway output/source sizes, run the pipeline. Returns `no_inputs`
 *  if any source key is missing on R2 (strict cascade — no partial
 *  writes). */
async function streamMerge(
	r2: R2Bucket,
	luc: import('./luc').LucIndex,
	tier: string,
	shardDurMin: number,
	sourceKeys: string[],
	targetBinMs: bigint,
	effStartMs: number,
	effEndMs: number,
	key: string,
): Promise<WriteResult> {
	const inputsExpected = sourceKeys.length;
	const presentWithSize = await existingKeysWithSize(r2, sourceKeys);
	const inputsPresent = presentWithSize.length;
	if (inputsPresent < inputsExpected) {
		return { status: 'no_inputs', key, inputsPresent, inputsExpected };
	}

	// OOM guard: estimate output rows. Under the N≤960 ladder cap this
	// never fires in practice, but belt-and-suspenders against a ladder
	// misconfig (a rung slipping through with N>MAX_OUTPUT_ROWS/3800).
	const tierBinMin = TIER_BIN_MIN[tier]!;
	const estimatedRows = lucCellCount(luc) * (shardDurMin / tierBinMin);
	if (estimatedRows > MAX_OUTPUT_ROWS) {
		return { status: 'too_large', key, inputsPresent, inputsExpected, estimatedRows };
	}
	// OOM guard: sum of source bytes. Kept as safety belt for
	// cross-tier-smallest sources which may overshoot the target period.
	const sourceBytes = presentWithSize.reduce((a, b) => a + b.size, 0);
	if (sourceBytes > MAX_SOURCE_BYTES) {
		return { status: 'too_large', key, inputsPresent, inputsExpected, estimatedRows: sourceBytes };
	}

	const iters = presentWithSize.map((p) => streamShardRows(r2, p.key));
	const merged = kwayMerge(iters, targetBinMs);
	const aggregated = aggregateStream(merged);
	const clipped = clipDtRange(aggregated, BigInt(effStartMs), BigInt(effEndMs));
	const { bytes, rows: written } = await writeShardStreaming(r2, key, clipped);
	if (written === 0) return { status: 'empty', key, inputsPresent, inputsExpected };
	return { status: 'wrote', key, bytes, rows: written, inputsPresent, inputsExpected };
}

/** Drop rows whose `dt` falls outside `[fromMs, toMs)`. Passthrough
 *  generator — see `writeShard`'s overshoot clip. */
async function* clipDtRange(
	rows: AsyncGenerator<AvailV3Row>,
	fromMs: bigint,
	toMs: bigint,
): AsyncGenerator<AvailV3Row> {
	for await (const row of rows) {
		if (row.dt >= fromMs && row.dt < toMs) yield row;
	}
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
	/** Emit `console.log` per phase (enumeration / per-writeShard). Off by
	 *  default because prod cron doesn't want per-tick spam; enable via
	 *  `/avail3?trace=1` for diagnostic runs. */
	trace?: boolean;
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

/** avail-v3 genesis: earliest 5-min-aligned UTC timestamp intersecting
 *  real raw poll data. First raw minute parquet on R2 is
 *  `gbfs/avail/agg=1m/cons=1m/2026-04-07/0116.parquet`; the containing
 *  `/1m@5min` shard covers `T01:15-T01:20` (partial: 4/5 raw minutes).
 *  Range floor for min-cover gap-discovery — pyrmts steps down rungs to
 *  cover `[genesis, now]` cleanly; anything before genesis is trivially
 *  `no_inputs` and shouldn't be listed.
 *
 *  Coarser tiers align at wider boundaries (`/2m@10min` at `:10,:20,...`,
 *  `/15m@1h` at `:00`, etc.), so their first fully-covered shard starts
 *  5-45 min after this timestamp — min-cover steps down naturally to
 *  cover the residual sub-range with smaller rungs, with any gap at
 *  the very start returning `no_inputs` benignly. */
const AVAIL_GENESIS = new Date('2026-04-07T01:15:00Z');

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
		{ name: '1m',  bin: '1min',  shards: ['5min', '10min', '30min', '1h', '3h', '6h', '12h'] },
		{ name: '2m',  bin: '2min',  shards: ['10min', '30min', '1h', '3h', '6h', '12h', '1d'] },
		{ name: '3m',  bin: '3min',  shards: ['15min', '30min', '1h', '3h', '6h', '12h', '1d', '2d'] },
		{ name: '5m',  bin: '5min',  shards: ['15min', '30min', '1h', '3h', '6h', '12h', '1d', '2d'] },
		{ name: '10m', bin: '10min', shards: ['30min', '1h', '3h', '6h', '12h', '1d', '2d', '4d'] },
		{ name: '15m', bin: '15min', shards: ['1h', '3h', '6h', '12h', '1d', '2d', '4d', '8d'] },
		{ name: '30m', bin: '30min', shards: ['2h', '6h', '12h', '1d', '2d', '4d', '8d', '16d'] },
		{ name: '1h',  bin: '1h',    shards: ['3h', '6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d'] },
		{ name: '2h',  bin: '2h',    shards: ['6h', '12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d'] },
		{ name: '3h',  bin: '3h',    shards: ['12h', '1d', '2d', '4d', '8d', '16d', '32d', '64d'] },
		{ name: '6h',  bin: '6h',    shards: ['1d', '2d', '4d', '8d', '16d', '32d', '64d', '128d'] },
		{ name: '12h', bin: '12h',   shards: ['2d', '4d', '8d', '16d', '32d', '64d', '128d', '256d'] },
		{ name: '1d',  bin: '1d',    shards: ['4d', '8d', '16d', '32d', '64d', '128d', '256d', '512d'] },
		{ name: '3d',  bin: '3d',    shards: ['12d', '24d', '48d', '96d', '192d', '384d', '768d', '1536d'] },
		{ name: '7d',  bin: '7d',    shards: ['28d', '56d', '112d', '224d', '448d', '896d', '1792d', '3584d'] },
	],
	geo: { cellCol: 's2_cell', resolutions: [15, 14, 13, 12, 11, 10] },
};

/** Dependency sort for missing shards under strict cascade. Non-/1m
 *  shards source from `sourceTierFor(tier)`, so their source-tier
 *  shards must materialize first — SOURCE TIER FIRST is the invariant.
 *
 *  Order:
 *    1. Tier ascending (finest first). Under `SOURCE_TIER_FOR`, the
 *       source tier is always finer-binned than the target — TIER_NAMES
 *       is ordered finest → coarsest, so ascending idx = source before
 *       consumer. (/1m first, /7d last.)
 *    2. Within a tier, shard_dur ascending, then period_start ascending
 *       — cosmetic within-tier ordering; no cross-shard dep within one
 *       tier under strict cascade. */
function sortMissing(a: ExpectedShard, b: ExpectedShard): number {
	const ta = TIER_NAMES.indexOf(a.tier);
	const tb = TIER_NAMES.indexOf(b.tier);
	if (ta !== tb) return ta - tb;
	const da = durationToMin(a.shardDur as Duration);
	const db = durationToMin(b.shardDur as Duration);
	if (da !== db) return da - db;
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
	const trace = opts.trace ?? false;
	const t0 = Date.now();
	const traceLog = (msg: string) => { if (trace) console.log(`[converge +${Date.now() - t0}ms] ${msg}`); };

	// Build Pyramid from YAML + R2 binding. `pyramidFromConfig` needs a
	// StorageBackend; gap-discovery only touches `pyramid.tiers` and
	// `pyramid.keyTemplate`, so the storage is unused here — same
	// `parquetBackend(r2Storage(r2))` the api worker uses keeps the
	// type happy without pulling in more machinery.
	traceLog('build pyramid');
	const pyramid = pyramidFromConfig(AVAIL_PYRAMID_CONFIG, parquetBackend(r2Storage(r2)));
	const shardIndex = new D1ShardIndex(db);

	// Diff: what does the min-cover ladder declare over [genesis, now],
	// minus what's already in D1?
	const range = { from: AVAIL_GENESIS, to: now };
	traceLog('listMissingShards start');
	let missing = await listMissingShards(pyramid, PYRAMID_NAME, shardIndex, range);
	traceLog(`listMissingShards done: ${missing.length} raw missing`);
	// Apply user filters.
	if (tierFilter) missing = missing.filter((m) => tierFilter.has(m.tier));
	if (shardDurFilter) missing = missing.filter((m) => shardDurFilter.has(m.shardDur));
	// Dependency-sort so finer rungs get written before their coarser
	// consumers (see `sortMissing`).
	missing.sort(sortMissing);
	const totalMissing = missing.length;
	traceLog(`filtered+sorted: ${totalMissing} shards to attempt`);

	// Enumerate the full outer expected set per tier — feeds strict
	// cascade in `writeShard`: for a target `T`, source picks come from
	// `sourceTierFor(T)`'s outer expected shards intersecting the target's
	// eff range. Same set the outer fill order materializes at the source
	// tier, so we source from tiles that will exist (matching Python's
	// `expected_by_tier` threading in `materialize.py:source_long_for_gap`).
	const expectedByTier: Map<string, ExpectedShard[]> = new Map();
	if (!dryRun) {
		traceLog('listExpectedShards start');
		const allExpected = listExpectedShards(pyramid, range);
		traceLog(`listExpectedShards done: ${allExpected.length} total expected`);
		for (const e of allExpected) {
			let bucket = expectedByTier.get(e.tier);
			if (!bucket) { bucket = []; expectedByTier.set(e.tier, bucket); }
			bucket.push(e);
		}
		const perTier = Array.from(expectedByTier.entries()).map(([t, es]) => `${t}=${es.length}`).join(' ');
		traceLog(`expectedByTier: ${perTier}`);
	}

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

		traceLog(`writeShard start: ${shard.key}`);
		const preWrite = Date.now();
		const r = await writeShard(
			r2, await getLuc(), shard.tier, shard.shardDur as Duration,
			shard.periodStart, shard.effectiveStart, shard.effectiveEnd,
			expectedByTier,
		);
		const writeMs = Date.now() - preWrite;
		traceLog(`writeShard done: ${shard.key} status=${r.status} in=${r.inputsPresent}/${r.inputsExpected} bytes=${r.bytes ?? 0} rows=${r.rows ?? 0} in ${writeMs}ms`);
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
