/**
 * `/api/health` — GBFS pipeline health snapshot.
 *
 * One round-trip back to the page, replacing dozens of client-side
 * `/api/files/list` enumerations. Reads R2 via the worker's binding;
 * each subsection lists exactly the prefix(es) it needs.
 *
 * See `specs/gbfs-health-page.md` for the surfaced shape.
 */
import { floorToSpan, listExpectedShards, parseDuration, type Pyramid, type Tier } from 'pyrmts';

interface R2Object {
	key: string;
	uploaded: Date;
}

interface R2ListResult {
	objects: R2Object[];
	delimitedPrefixes?: string[];
	truncated: boolean;
	cursor?: string;
}

/** Minimal R2 binding shape we need — keeps this module testable with
 *  any in-memory mock and avoids pulling in `@cloudflare/workers-types`. */
export interface HealthR2 {
	list(opts: {
		prefix?: string;
		delimiter?: string;
		cursor?: string;
		limit?: number;
	}): Promise<R2ListResult>;
	get(key: string): Promise<{ json<T = unknown>(): Promise<T> } | null>;
	put?(key: string, value: string): Promise<unknown>;
}

export interface FeedHealth {
	latestPoll: { key: string; date: string; time: string; uploadedAt: string } | null;
	todayCount: number;
	todayExpected: number;
	last7Days: Array<{ date: string; count: number; expected: number }>;
}

export interface CompactionHealth {
	daily: { latestDate: string | null; count: number };
	hourly: { latestKey: string | null; todayCount: number };
}

export interface CascadeCell {
	agg: string;
	cons: string;
	shardCount: number;
	latestKey: string | null;
	latestUploadedAt: string | null;
}

export interface CascadeHealth {
	cells: CascadeCell[];
	expectedCells: Array<{ agg: string; cons: string; deployed: boolean }>;
}

/** Per-rung slot in a tier's current min-cover of `[genesis, now)`. In
 *  equilibrium each tier's min-cover is mostly max-rung tiles filling the
 *  closed-history region `[genesis, floor(now, max_rung))`, plus a small
 *  "dust" of finer-rung tiles filling `[floor(now, max_rung), now)`. A rung
 *  entry counts how many shards the min-cover places at that rung and how
 *  many actually exist in the ShardIndex. */
export interface PyramidCoverRung {
	shardDur: string;
	role: 'max' | 'dust';
	expected: number;   // shards the min-cover requires at this rung
	present: number;    // of those, how many are in D1
	pending: number;    // missing but only just closed (within grace) — cron will land them
}

/** One min-cover slot, for the timeline-bar rendering. Slots are emitted
 *  per-shard (not coalesced) so tile boundaries are visible in the bar. */
export interface PyramidCoverSegment {
	start: string;      // ISO
	end: string;        // ISO (exclusive)
	shardDur: string;
	status: 'present' | 'pending' | 'missing';
	key?: string;       // R2 object key (present segments — /files click-through)
}

/** Per-tier min-cover status. `complete` iff no cover slot is MISSING
 *  (pending slots — just-closed, within the write-lag grace window —
 *  don't break completeness; they flap red otherwise on every rung
 *  boundary until the next cron tick writes them). */
export interface PyramidTierCoverStatus {
	tier: string;
	bin: string;
	maxRung: string;
	rungs: PyramidCoverRung[];               // ordered oldest → newest
	segments: PyramidCoverSegment[];         // ordered oldest → newest
	totalExpected: number;
	totalPresent: number;
	totalPending: number;
	complete: boolean;
	firstMissingPeriod: string | null;       // ISO of oldest MISSING cover shard, if any
	lastMaxBoundary: string;                 // ISO of floor(now, max_rung) — dust head
	dustAgeSec: number;                      // now - lastMaxBoundary, in seconds
	staleShardCount: number;                 // present shards NOT in current min-cover
}

/** Per-pyramid roll-up. `allComplete` iff every tier's min-cover is satisfied. */
export interface PyramidCoverStatus {
	name: string;            // 'avail' / 'rides' etc.
	genesis: string;         // ISO — cover computed over [genesis, now)
	now: string;             // ISO snapshot time
	tiers: PyramidTierCoverStatus[];
	totalMissing: number;    // sum of MISSING (not pending) across tiers
	totalPending: number;
	totalStale: number;      // sum of staleShardCount across tiers
	allComplete: boolean;
}

export type PyramidsHealth = PyramidCoverStatus[];

/** A cover slot whose period closed within this window and hasn't been
 *  written yet counts as `pending`, not `missing` — the /5m cron writes
 *  just-closed rungs within a tick or two. Without this grace, every rung
 *  boundary flaps the tier red for ~1-2 min. */
const PENDING_GRACE_MS = 10 * 60_000;

/** Recency of `s3://tripdata` — the upstream Citi Bike monthly publish.
 *  Sourced from `tripdata/latest.json` in R2, refreshed every `tripdata.yml`
 *  run (independent of whether new files were imported). */
/** Driver-written build-progress doc (`gbfs/build-progress/<pyramid>.json`,
 *  see `ctbk/pyramid_cascade/rebuild.py` `_Progress`). Loose typing on
 *  purpose — the FE renders what's present. */
export interface BuildLayer {
	tier: string;
	rung: string;
	scaffold: boolean;
	n: number;
	done?: number;
	wallS?: number;
	status?: Record<string, number>;
}

export interface BuildProgress {
	pyramid: string;
	driver: string;
	startedAt: string;
	updatedAt?: string;
	status: 'running' | 'done' | 'bounced';
	plan: { layers: number; invocations: number; scaffolds: number };
	byStatus: Record<string, number>;
	layers: BuildLayer[];
	currentLayer: BuildLayer | null;
}

export interface TripdataHealth {
	generatedAt: string | null;          // ISO-8601 from the refresher
	latestZip: string | null;            // e.g. "JC-202604-citibike-tripdata.zip"
	latestMonth: string | null;          // YYYYMM
	recentMonths: string[];              // last ~12 months found
	totalZips: number;
}

export interface HealthSnapshot {
	generatedAt: number;
	feed: FeedHealth;
	compactions: CompactionHealth;
	cascade: CascadeHealth;
	pyramids: PyramidsHealth;
	tripdata: TripdataHealth | null;
	builds?: BuildProgress[];
}

/** UTC-date + minute helpers — avoid Date methods that pull in locale. */
function utcDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}
function dateAtOffset(daysBack: number): string {
	const d = new Date(Date.now() - daysBack * 86400_000);
	return utcDate(d);
}
function minutesElapsedTodayUtc(): number {
	const now = new Date();
	return now.getUTCHours() * 60 + now.getUTCMinutes() + 1;
}

/** List all objects under `prefix` (no delimiter); follow cursors up to
 *  `maxPages` so a too-wide prefix doesn't wedge the worker. Returns
 *  `truncated: true` if the cap was hit. */
async function listAll(
	r2: HealthR2,
	prefix: string,
	maxPages = 5,
): Promise<{ objects: R2Object[]; truncated: boolean }> {
	const out: R2Object[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < maxPages; i++) {
		const result = await r2.list({ prefix, cursor, limit: 1000 });
		out.push(...result.objects);
		if (!result.truncated || !result.cursor) {
			return { objects: out, truncated: false };
		}
		cursor = result.cursor;
	}
	return { objects: out, truncated: true };
}

/** Like `listAll` but with delimiter='/' so the result groups by
 *  next-segment. Returns both top-level objects and the synthesized
 *  dir prefixes. R2's 1000-key page cap applies to *raw scan keys*
 *  (including those under delimitedPrefixes), so even short-level
 *  listings may need cursor-follow when subtrees are large. */
async function listAllDelimited(
	r2: HealthR2,
	prefix: string,
	maxPages = 50,
): Promise<{ objects: R2Object[]; delimitedPrefixes: string[]; truncated: boolean }> {
	const objects: R2Object[] = [];
	const delimitedPrefixes = new Set<string>();
	let cursor: string | undefined;
	for (let i = 0; i < maxPages; i++) {
		const result = await r2.list({ prefix, delimiter: '/', cursor, limit: 1000 });
		objects.push(...result.objects);
		(result.delimitedPrefixes ?? []).forEach((p) => delimitedPrefixes.add(p));
		if (!result.truncated || !result.cursor) {
			return { objects, delimitedPrefixes: [...delimitedPrefixes].sort(), truncated: false };
		}
		cursor = result.cursor;
	}
	return { objects, delimitedPrefixes: [...delimitedPrefixes].sort(), truncated: true };
}

export async function getFeedHealth(r2: HealthR2): Promise<FeedHealth> {
	const today = utcDate(new Date());
	// R2's list limit caps at 1000 raw scan keys per page (and wrangler-dev
	// caps lower); a full day has 1440 minute files, so listAll-paginate.
	const todayAll = await listAll(r2, `gbfs/status/${today}/`, 3);
	const todayCount = todayAll.objects.length;
	const todayExpected = minutesElapsedTodayUtc();

	let latestPoll: FeedHealth['latestPoll'] = null;
	if (todayCount > 0) {
		const sorted = [...todayAll.objects].sort((a, b) => a.key.localeCompare(b.key));
		const latest = sorted[sorted.length - 1];
		const m = latest.key.match(/gbfs\/status\/(\d{4}-\d{2}-\d{2})\/(\d{2}-\d{2})\.json$/);
		if (m) {
			latestPoll = {
				key: latest.key,
				date: m[1],
				time: m[2].replace('-', ':'),
				uploadedAt: latest.uploaded.toISOString(),
			};
		}
	}

	// Last 7 days (today + 6 prior). Parallel listing, each paginated.
	const dates: string[] = Array.from({ length: 7 }, (_, i) => dateAtOffset(i)).reverse();
	const counts = await Promise.all(
		dates.map(async (date) => {
			const r = await listAll(r2, `gbfs/status/${date}/`, 3);
			return { date, count: r.objects.length, expected: date === today ? todayExpected : 1440 };
		}),
	);

	return { latestPoll, todayCount, todayExpected, last7Days: counts };
}

export async function getCompactionHealth(r2: HealthR2): Promise<CompactionHealth> {
	// Daily: list `gbfs/status/` with delimiter so we only see top-level
	// objects (the `*.parquet` daily compactions) not the per-date dirs.
	// Cursor-follow required: the per-date dirs each contain 1440 minute
	// files, so the 1000-raw-key page cap kicks in after ~0.7 days.
	const dailyList = await listAllDelimited(r2, 'gbfs/status/', 100);
	const dailyParquets = dailyList.objects
		.filter((o) => /gbfs\/status\/\d{4}-\d{2}-\d{2}\.parquet$/.test(o.key))
		.map((o) => o.key.match(/(\d{4}-\d{2}-\d{2})\.parquet$/)![1])
		.sort();
	const daily = {
		latestDate: dailyParquets.length > 0 ? dailyParquets[dailyParquets.length - 1] : null,
		count: dailyParquets.length,
	};

	// Hourly h1 for today.
	const today = utcDate(new Date());
	const h1Today = await r2.list({ prefix: `gbfs/avail/h1/${today}/`, limit: 30 });
	const h1Sorted = [...h1Today.objects].sort((a, b) => a.key.localeCompare(b.key));
	const hourly = {
		latestKey: h1Sorted.length > 0 ? h1Sorted[h1Sorted.length - 1].key : null,
		todayCount: h1Today.objects.length,
	};

	return { daily, hourly };
}

/** Cells deployed by the cascade worker. Mirrors `gbfs/lib/cascade.ts`'s
 *  `CONS_LEVELS_BY_AGG` + `AGG_LEVELS` to avoid a circular import. */
const DEPLOYED_CELLS: Array<{ agg: string; cons: string }> = [
	// agg-self (cons == agg)
	{ agg: '1m', cons: '1m' },
	{ agg: '5m', cons: '5m' },
	{ agg: '15m', cons: '15m' },
	{ agg: '1h', cons: '1h' },
	{ agg: '1d', cons: '1d' },
	// cons-only @ agg=1m
	{ agg: '1m', cons: '5m' },
	{ agg: '1m', cons: '15m' },
	{ agg: '1m', cons: '1h' },
	// cons-only @ agg=5m
	{ agg: '5m', cons: '15m' },
	{ agg: '5m', cons: '1h' },
	{ agg: '5m', cons: '3h' },
	{ agg: '5m', cons: '8h' },
	{ agg: '5m', cons: '1d' },
	// cons-only @ agg=15m
	{ agg: '15m', cons: '1h' },
	{ agg: '15m', cons: '3h' },
	{ agg: '15m', cons: '8h' },
	{ agg: '15m', cons: '1d' },
	{ agg: '15m', cons: '3d' },
	// cons-only @ agg=1h
	{ agg: '1h', cons: '3h' },
	{ agg: '1h', cons: '8h' },
	{ agg: '1h', cons: '1d' },
	{ agg: '1h', cons: '3d' },
	// cons-only @ agg=1d
	{ agg: '1d', cons: '3d' },
];

/** Per `gbfs/grid.yaml` but not yet deployed. Worth surfacing so the
 *  health page shows "specced × built" deltas. */
const SPECCED_BUT_NOT_DEPLOYED: Array<{ agg: string; cons: string }> = [
	// agg=1m bigger cons (gha-runner per spec)
	{ agg: '1m', cons: '3h' },
	{ agg: '1m', cons: '8h' },
	{ agg: '1m', cons: '1d' },
	// agg=5m wide cons
	{ agg: '5m', cons: '5d' },
	// agg=15m wider cons
	{ agg: '15m', cons: '10d' },
	// agg=1h wider cons
	{ agg: '1h', cons: '1w' },
	{ agg: '1h', cons: '1mo' },
	{ agg: '1h', cons: '2mo' },
	// agg=1d wider cons
	{ agg: '1d', cons: '1w' },
	{ agg: '1d', cons: '1mo' },
	{ agg: '1d', cons: '3mo' },
	{ agg: '1d', cons: '1y' },
	{ agg: '1d', cons: '3y' },
];

async function probeCell(
	r2: HealthR2,
	agg: string,
	cons: string,
): Promise<CascadeCell> {
	const prefix = `gbfs/avail/agg=${agg}/cons=${cons}/`;
	const { objects, truncated } = await listAll(r2, prefix, 3);
	const sorted = [...objects].sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());
	const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
	return {
		agg,
		cons,
		shardCount: objects.length + (truncated ? 1 : 0), // approx-tag if capped
		latestKey: latest ? latest.key : null,
		latestUploadedAt: latest ? latest.uploaded.toISOString() : null,
	};
}

export async function getCascadeHealth(r2: HealthR2): Promise<CascadeHealth> {
	const cells = await Promise.all(DEPLOYED_CELLS.map((c) => probeCell(r2, c.agg, c.cons)));
	const expectedCells = [
		...DEPLOYED_CELLS.map((c) => ({ ...c, deployed: true })),
		...SPECCED_BUT_NOT_DEPLOYED.map((c) => ({ ...c, deployed: false })),
	];
	return { cells, expectedCells };
}

/** Python-side snake_case → camelCase mapping for the R2 JSON payload. */
interface RawTripdataSummary {
	generated_at: string;
	latest_zip: string | null;
	latest_month: string | null;
	recent_months: string[];
	total_zips: number;
}

/** Snapshot per-tier min-cover status for unified-shard-ladder pyramids.
 *  Reads `pyramid_shards` directly (all rows: `tier, shard_dur,
 *  period_start`), computes the expected min-cover for `[genesis, now)`
 *  from `avail_geo.ts`'s `TIERS`, and reports:
 *    - which cover slots are satisfied by present shards
 *    - the first missing period (if any)
 *    - `staleShardCount`: present shards NOT in the current min-cover
 *      (usually old max-rung tiles that got superseded — GC candidates)
 *
 *  D1 column compatibility: pre-P3 the column is `cadence`; post-P3 it's
 *  `shard_dur`. Probe schema once and substitute. */
export async function getPyramidsHealth(db: D1Database): Promise<PyramidsHealth> {
	// Probe which column name the D1 schema uses (P3 transition).
	let shardCol = 'shard_dur';
	try {
		const cols = await db.prepare("PRAGMA table_info(pyramid_shards)").all<{ name: string }>();
		const names = new Set((cols.results ?? []).map((r) => r.name));
		if (names.has('shard_dur')) shardCol = 'shard_dur';
		else if (names.has('cadence')) shardCol = 'cadence';
	} catch {
		// Fall through with default.
	}

	const { TIERS, AVAIL_GENESIS } = await import('./avail_geo');
	const out: PyramidsHealth = [];
	for (const [name, keyPrefix] of HEALTH_PYRAMIDS) {
		const cover = await pyramidCover(db, name, keyPrefix, shardCol, TIERS, AVAIL_GENESIS);
		if (cover) out.push(cover);
	}
	return out;
}

/** Registry pyramids surfaced on /health: (D1 `pyramid` name, R2 key
 *  prefix). v3 + v5 share the TIERS ladder (identical merged rung sets);
 *  dormant avail-v4 is intentionally omitted (superseded by v5). */
const HEALTH_PYRAMIDS: [name: string, keyPrefix: string][] = [
	['avail', 'avail-v3'],
	['avail-v5', 'avail-v5'],
];

/** Cover status for one registry pyramid. Null when D1 is unavailable
 *  or the pyramid has no rows yet (hidden rather than all-missing). */
async function pyramidCover(
	db: D1Database,
	PYRAMID: string,
	keyPrefix: string,
	shardCol: string,
	TIERS: Tier[],
	AVAIL_GENESIS: Date,
): Promise<PyramidCoverStatus | null> {
	const largestPerTier: Record<string, string> = Object.fromEntries(
		TIERS.map((t) => [t.name, t.shards[t.shards.length - 1]!])
	);

	// All shard rows for this pyramid. ~5-10k rows for avail-v3 today; well
	// within a single D1 query.
	type ShardRow = { tier: string; sd: string; period_start: number };
	const shardSql =
		`SELECT tier, ${shardCol} AS sd, period_start ` +
		`FROM pyramid_shards WHERE pyramid = ?`;

	let shardRows: ShardRow[] = [];
	try {
		const s = await db.prepare(shardSql).bind(PYRAMID).all<ShardRow>();
		shardRows = s.results ?? [];
	} catch {
		// D1 unavailable.
		return null;
	}
	if (shardRows.length === 0) return null;

	// Translate legacy canonical sentinel rows: '' → tier's largest shard.
	const norm = (tier: string, sd: string): string =>
		sd === '' ? (largestPerTier[tier] ?? sd) : sd;

	// Index: `tier\x00shardDur\x00periodStartMs` → present.
	const presentKey = (tier: string, sd: string, periodStartMs: number) =>
		`${tier}\x00${sd}\x00${periodStartMs}`;
	const present = new Set<string>();
	const presentByTier: Record<string, number> = {};
	for (const r of shardRows) {
		const sd = norm(r.tier, r.sd);
		present.add(presentKey(r.tier, sd, r.period_start));
		presentByTier[r.tier] = (presentByTier[r.tier] ?? 0) + 1;
	}

	// Min-cover of [genesis, now] per tier via pyrmts. `listExpectedShards`
	// returns max-rung tiles filling the closed-history region + dust rungs
	// for the trailing partial-max window. We infer `role` from the shardDur
	// (max iff === tier's largest rung).
	const now = new Date();
	// pyrmts's Pyramid requires more fields for full query use, but
	// listExpectedShards only reads `.tiers` and `.keyTemplate`. Cast the
	// stub to shut the compiler up.
	const pyramid = {
		tiers: TIERS,
		keyTemplate: `${keyPrefix}/{tier}/{shard}/{period}.parquet`,
	} as unknown as Pyramid;
	const expected = listExpectedShards(pyramid, { from: AVAIL_GENESIS, to: now });
	const expectedByTier = new Map<string, typeof expected>();
	for (const e of expected) {
		const list = expectedByTier.get(e.tier) ?? [];
		list.push(e);
		expectedByTier.set(e.tier, list);
	}

	const tiers: PyramidTierCoverStatus[] = [];
	let totalMissing = 0;
	let totalPending = 0;
	let totalStale = 0;

	for (const t of TIERS) {
		const maxRung = t.shards[t.shards.length - 1]!;
		const maxSpan = parseDuration(maxRung);
		const lastMaxBoundary = floorToSpan(now, maxSpan);
		const cover = expectedByTier.get(t.name) ?? [];

		// Aggregate by rung (preserving order of first appearance in cover).
		const rungOrder: string[] = [];
		const rungAgg: Record<string, { expected: number; present: number; pending: number; role: 'max' | 'dust' }> = {};
		const segments: PyramidCoverSegment[] = [];
		let firstMissingPeriod: string | null = null;
		let coverPresent = 0;
		let coverPending = 0;

		for (const slot of cover) {
			const role: 'max' | 'dust' = slot.shardDur === maxRung ? 'max' : 'dust';
			if (!(slot.shardDur in rungAgg)) {
				rungOrder.push(slot.shardDur);
				rungAgg[slot.shardDur] = { expected: 0, present: 0, pending: 0, role };
			}
			const agg = rungAgg[slot.shardDur]!;
			agg.expected += 1;
			const key = presentKey(t.name, slot.shardDur, slot.periodStart.getTime());
			let status: PyramidCoverSegment['status'];
			if (present.has(key)) {
				status = 'present';
				agg.present += 1;
				coverPresent += 1;
			} else if (slot.periodEnd.getTime() > now.getTime() - PENDING_GRACE_MS) {
				status = 'pending';
				agg.pending += 1;
				coverPending += 1;
			} else {
				status = 'missing';
				if (firstMissingPeriod === null) {
					firstMissingPeriod = slot.periodStart.toISOString();
				}
			}
			// Clip the head tile to genesis so the bar's x-domain is exact.
			const segStart = slot.effectiveStart > slot.periodStart ? slot.effectiveStart : slot.periodStart;
			segments.push({
				start: segStart.toISOString(),
				end: slot.periodEnd.toISOString(),
				shardDur: String(slot.shardDur),
				status,
				...(status === 'present' ? { key: slot.key } : {}),
			});
		}

		const rungs: PyramidCoverRung[] = rungOrder.map((sd) => ({
			shardDur: sd,
			role: rungAgg[sd]!.role,
			expected: rungAgg[sd]!.expected,
			present: rungAgg[sd]!.present,
			pending: rungAgg[sd]!.pending,
		}));
		const totalExpected = cover.length;
		const tierMissing = totalExpected - coverPresent - coverPending;
		const staleShardCount = Math.max(0, (presentByTier[t.name] ?? 0) - coverPresent);

		totalMissing += tierMissing;
		totalPending += coverPending;
		totalStale += staleShardCount;

		tiers.push({
			tier: t.name,
			bin: String(t.bin),
			maxRung,
			rungs,
			segments,
			totalExpected,
			totalPresent: coverPresent,
			totalPending: coverPending,
			complete: tierMissing === 0,
			firstMissingPeriod,
			lastMaxBoundary: lastMaxBoundary.toISOString(),
			dustAgeSec: Math.floor((now.getTime() - lastMaxBoundary.getTime()) / 1000),
			staleShardCount,
		});
	}

	return {
		name: PYRAMID,
		genesis: AVAIL_GENESIS.toISOString(),
		now: now.toISOString(),
		tiers,
		totalMissing,
		totalPending,
		totalStale,
		allComplete: totalMissing === 0,
	};
}

export async function getTripdataHealth(r2: HealthR2): Promise<TripdataHealth | null> {
	const obj = await r2.get('tripdata/latest.json');
	if (!obj) return null;
	const raw = await obj.json<RawTripdataSummary>();
	return {
		generatedAt: raw.generated_at ?? null,
		latestZip: raw.latest_zip ?? null,
		latestMonth: raw.latest_month ?? null,
		recentMonths: raw.recent_months ?? [],
		totalZips: raw.total_zips ?? 0,
	};
}

/** Recent driver build-progress docs (running builds first, then most
 *  recently updated; anything idle > 7 days is dropped). */
export async function getBuildsHealth(r2: HealthR2): Promise<BuildProgress[]> {
	const listing = await r2.list({ prefix: 'gbfs/build-progress/', limit: 20 });
	const out: BuildProgress[] = [];
	for (const o of listing.objects) {
		const obj = await r2.get(o.key);
		if (!obj) continue;
		try {
			const doc = await obj.json<BuildProgress>();
			const updated = Date.parse(doc.updatedAt ?? doc.startedAt ?? '');
			if (Number.isFinite(updated) && Date.now() - updated < 7 * 86_400_000) out.push(doc);
		} catch {
			// Malformed doc — skip.
		}
	}
	out.sort((a, b) =>
		Number(b.status === 'running') - Number(a.status === 'running')
		|| Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'));
	return out;
}

export async function getHealthSnapshot(
	r2: HealthR2,
	db?: D1Database,
): Promise<HealthSnapshot> {
	const [feed, compactions, cascade, pyramids, tripdata, builds] = await Promise.all([
		getFeedHealth(r2),
		getCompactionHealth(r2),
		getCascadeHealth(r2),
		db ? getPyramidsHealth(db) : Promise.resolve<PyramidsHealth>([]),
		getTripdataHealth(r2),
		getBuildsHealth(r2),
	]);
	return {
		generatedAt: Math.floor(Date.now() / 1000),
		feed,
		compactions,
		cascade,
		pyramids,
		tripdata,
		builds,
	};
}

/** Where the cron-refreshed snapshot lives on R2. The full snapshot takes
 *  ~7 s to compute (R2 listings across feed/compaction prefixes + the D1
 *  pyramid scan); serving it live made `/api/health` a 7-second XHR. The
 *  worker's minute cron recomputes into this key; the route serves the
 *  cached object (~100 ms) as long as it's fresh. */
export const HEALTH_SNAPSHOT_KEY = 'health/snapshot.json';

/** Serve-stale threshold: a snapshot older than this falls back to live
 *  compute (cron dead / first deploy). Comfortably above the 1-min cron
 *  cadence so a single missed tick doesn't blow the fast path. */
export const HEALTH_SNAPSHOT_MAX_AGE_S = 300;

/** Compute the snapshot and persist it to R2 (cron path). */
export async function computeAndStoreHealthSnapshot(
	r2: HealthR2,
	db?: D1Database,
): Promise<HealthSnapshot> {
	const snapshot = await getHealthSnapshot(r2, db);
	if (r2.put) await r2.put(HEALTH_SNAPSHOT_KEY, JSON.stringify(snapshot));
	return snapshot;
}

/** Read the cron-refreshed snapshot if it's fresh; null → caller computes
 *  live (and should persist the result for the next request). */
export async function readCachedHealthSnapshot(
	r2: HealthR2,
): Promise<HealthSnapshot | null> {
	const obj = await r2.get(HEALTH_SNAPSHOT_KEY);
	if (!obj) return null;
	const snapshot = await obj.json<HealthSnapshot>();
	const ageS = Math.floor(Date.now() / 1000) - (snapshot.generatedAt ?? 0);
	return ageS <= HEALTH_SNAPSHOT_MAX_AGE_S ? snapshot : null;
}
