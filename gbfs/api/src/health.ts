/**
 * `/api/health` — GBFS pipeline health snapshot.
 *
 * One round-trip back to the page, replacing dozens of client-side
 * `/api/files/list` enumerations. Reads R2 via the worker's binding;
 * each subsection lists exactly the prefix(es) it needs.
 *
 * See `specs/gbfs-health-page.md` for the surfaced shape.
 */
import type { Pyramid, Storage, Tier } from 'pyrmts';
import {
	computeAndStoreSnapshot,
	getBuildsHealth as cfwGetBuildsHealth,
	pyramidCover as cfwPyramidCover,
	readCachedSnapshot,
	type BuildProgress,
	type PyramidCoverStatus,
} from 'pyrmts-cfw';

interface R2Object {
	key: string;
	uploaded: Date;
	size?: number;
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

/** Feed-staleness drift: how far the feed's own `last_updated` lagged our
 *  poll wall-clock, for the latest poll plus a rolling 24h series (older
 *  history is derivable from the daily compaction parquets, which carry
 *  `ts` + `polled_at` per row). */
export interface FeedDrift {
	/** `polled_at - ts` of the latest WAL record, seconds. */
	latestS: number;
	/** Feed `last_updated` (epoch s) of the latest WAL record. */
	ts: number;
	/** Poll wall-clock (epoch s) of the latest WAL record. */
	polledAt: number;
	/** `[polled_at epoch s, drift s]` points, ≤24h old, oldest first. */
	series: Array<[number, number]>;
}

export interface FeedHealth {
	latestPoll: { key: string; date: string; time: string; uploadedAt: string } | null;
	drift: FeedDrift | null;
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

// Pyramid-cover + build-progress health types and logic moved upstream
// (ops-adoption phase 4: pyrmts `specs/pyrmts-ops-adoption.md`) —
// re-exported so consumers (Health.tsx via the snapshot shape, alerts)
// keep importing from here.
export type {
	BuildLayer,
	BuildProgress,
	PyramidCoverRung,
	PyramidCoverSegment,
	PyramidCoverStatus,
	PyramidTierCoverStatus,
} from 'pyrmts-cfw';

export type PyramidsHealth = PyramidCoverStatus[];

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
	/** The pyramid `/api/avail-v3` serves when no `?pyramid=` is given —
	 *  the FE renders it full-size and collapses the rest. */
	defaultPyramid?: string;
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

	const drift = latestPoll ? await getFeedDrift(r2, latestPoll.key) : null;

	return { latestPoll, drift, todayCount, todayExpected, last7Days: counts };
}

const FEED_DRIFT_KEY = 'health/feed-drift.json';
const FEED_DRIFT_WINDOW_S = 24 * 3600;

/** Read the latest WAL record's `{ts, polled_at}`, fold the point into the
 *  rolling 24h series doc, and return both. Append is keyed on `polled_at`
 *  so re-computes (cron + on-demand snapshot refreshes) are idempotent; a
 *  concurrent lost-update just drops one point, which the next poll re-adds. */
async function getFeedDrift(r2: HealthR2, latestKey: string): Promise<FeedDrift | null> {
	const obj = await r2.get(latestKey);
	if (!obj) return null;
	const rec = await obj.json<{ ts?: number; polled_at?: number }>();
	if (typeof rec.ts !== 'number' || typeof rec.polled_at !== 'number') return null;
	const latestS = rec.polled_at - rec.ts;

	const prev = await r2.get(FEED_DRIFT_KEY);
	let series: Array<[number, number]> = prev
		? await prev.json<Array<[number, number]>>()
		: [];
	const cutoff = rec.polled_at - FEED_DRIFT_WINDOW_S;
	series = series.filter(([t]) => t >= cutoff);
	if (!series.length || series[series.length - 1][0] < rec.polled_at) {
		series.push([rec.polled_at, latestS]);
		if (r2.put) await r2.put(FEED_DRIFT_KEY, JSON.stringify(series));
	}

	return { latestS, ts: rec.ts, polledAt: rec.polled_at, series };
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
export async function getPyramidsHealth(db: D1Database, r2?: HealthR2): Promise<PyramidsHealth> {
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
	const { V5_TIERS, RIDES_GENESIS } = await import('./rides_v1');
	const out: PyramidsHealth = [];
	for (const { name, keyPrefix, rides } of HEALTH_PYRAMIDS) {
		const cover = await pyramidCover(
			db, name, keyPrefix, shardCol,
			rides ? V5_TIERS : TIERS, rides ? RIDES_GENESIS : AVAIL_GENESIS,
		);
		if (!cover) continue;
		if (r2) await annotateSegmentBytes(r2, keyPrefix, cover);
		out.push(cover);
	}
	return out;
}

/** Attach R2 object sizes to present cover segments (tooltip fodder on
 *  the /health timeline bars): one paginated LIST per pyramid prefix,
 *  joined by key. Best-effort — a LIST failure leaves segments bare. */
async function annotateSegmentBytes(
	r2: HealthR2,
	keyPrefix: string,
	cover: PyramidCoverStatus,
): Promise<void> {
	try {
		const { objects } = await listAll(r2, `${keyPrefix}/`, 10);
		const sizes = new Map(objects.map((o) => [o.key, o.size]));
		for (const t of cover.tiers) {
			for (const s of t.segments) {
				if (s.key !== undefined) {
					const size = sizes.get(s.key);
					if (size !== undefined) (s as { bytes?: number }).bytes = size;
				}
			}
		}
	} catch {
		// Sizes are decoration; never fail the snapshot over them.
	}
}

/** Registry pyramids surfaced on /health: (D1 `pyramid` name, R2 key
 *  prefix). avail v3/v5/v6 share the TIERS ladder; rides-v5 pyramids
 *  carry their own ladder + genesis (`rides: true`). Dormant avail-v4 is
 *  intentionally omitted (superseded by v5). */
const HEALTH_PYRAMIDS: { name: string; keyPrefix: string; rides?: boolean }[] = [
	{ name: 'avail', keyPrefix: 'avail-v3' },
	{ name: 'avail-v5', keyPrefix: 'avail-v5' },
	{ name: 'avail-v6', keyPrefix: 'avail-v6' },
	{ name: 'rides-v5-start', keyPrefix: 'rides-v5/start', rides: true },
	{ name: 'rides-v5-end', keyPrefix: 'rides-v5/end', rides: true },
];

/** Cover status for one registry pyramid — `pyrmts-cfw`'s
 *  `pyramidCover` with ctbk's key template + genesis threading. */
async function pyramidCover(
	db: D1Database,
	PYRAMID: string,
	keyPrefix: string,
	shardCol: string,
	TIERS: Tier[],
	AVAIL_GENESIS: Date,
): Promise<PyramidCoverStatus | null> {
	const pyramid = {
		tiers: TIERS,
		keyTemplate: `${keyPrefix}/{tier}/{shard}/{period}.parquet`,
	} as unknown as Pyramid;
	return cfwPyramidCover(db, pyramid, { name: PYRAMID, genesis: AVAIL_GENESIS, shardCol });
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

/** `pyrmts.Storage` view of a `HealthR2` binding — enough surface for
 *  `pyrmts-cfw`'s JSON-doc helpers (get/put/list; the byte payloads are
 *  all JSON, so the encode round-trip through `json()` is lossless).
 *  `head`/`getRange` are unused by those helpers. */
function healthR2Storage(r2: HealthR2): Storage {
	return {
		async get(key) {
			const obj = await r2.get(key);
			if (!obj) return null;
			return new TextEncoder().encode(JSON.stringify(await obj.json()));
		},
		async put(key, bytes) {
			if (r2.put) await r2.put(key, new TextDecoder().decode(bytes));
		},
		async *list(prefix) {
			let cursor: string | undefined;
			do {
				const page = await r2.list({ prefix, cursor, limit: 1000 });
				for (const o of page.objects) yield o.key;
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		},
		head() { throw new Error('healthR2Storage: head unsupported'); },
		getRange() { throw new Error('healthR2Storage: getRange unsupported'); },
	};
}

/** Recent driver build-progress docs — `pyrmts-cfw`'s `getBuildsHealth`
 *  over the ctbk progress prefix. */
export async function getBuildsHealth(r2: HealthR2): Promise<BuildProgress[]> {
	return cfwGetBuildsHealth(healthR2Storage(r2), { prefix: 'gbfs/build-progress/' });
}

export async function getHealthSnapshot(
	r2: HealthR2,
	db?: D1Database,
): Promise<HealthSnapshot> {
	const [feed, compactions, cascade, pyramids, tripdata, builds] = await Promise.all([
		getFeedHealth(r2),
		getCompactionHealth(r2),
		getCascadeHealth(r2),
		db ? getPyramidsHealth(db, r2) : Promise.resolve<PyramidsHealth>([]),
		getTripdataHealth(r2),
		getBuildsHealth(r2),
	]);
	const { DEFAULT_PYRAMID } = await import('./avail_geo');
	return {
		generatedAt: Math.floor(Date.now() / 1000),
		feed,
		compactions,
		cascade,
		pyramids,
		defaultPyramid: DEFAULT_PYRAMID,
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

/** Compute the snapshot and persist it to R2 (cron path) — `pyrmts-cfw`'s
 *  snapshot-cache pattern. */
export async function computeAndStoreHealthSnapshot(
	r2: HealthR2,
	db?: D1Database,
): Promise<HealthSnapshot> {
	return computeAndStoreSnapshot(
		healthR2Storage(r2), HEALTH_SNAPSHOT_KEY, () => getHealthSnapshot(r2, db));
}

/** Read the cron-refreshed snapshot if it's fresh; null → caller computes
 *  live (and should persist the result for the next request). */
export async function readCachedHealthSnapshot(
	r2: HealthR2,
): Promise<HealthSnapshot | null> {
	return readCachedSnapshot<HealthSnapshot>(
		healthR2Storage(r2), HEALTH_SNAPSHOT_KEY, HEALTH_SNAPSHOT_MAX_AGE_S);
}
