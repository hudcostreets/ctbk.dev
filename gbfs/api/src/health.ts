/**
 * `/api/health` — GBFS pipeline health snapshot.
 *
 * One round-trip back to the page, replacing dozens of client-side
 * `/api/files/list` enumerations. Reads R2 via the worker's binding;
 * each subsection lists exactly the prefix(es) it needs.
 *
 * See `specs/gbfs-health-page.md` for the surfaced shape.
 */

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

/** Per-(tier, shard_dur) status for a unified-shard-ladder pyramid
 *  (avail-v3, rides-v3). One row per declared ladder rung. */
export interface PyramidShardStatus {
	tier: string;
	shardDur: string;        // e.g. '5min', '1d', '4320d'
	shardCount: number;      // # shards recorded in ShardIndex
	earliestPeriodStart: string | null;   // ISO ms
	latestPeriodEnd: string | null;       // ISO ms
	watermarkEnd: string | null;          // pyramid_watermarks.latest_period_end
}

export interface PyramidStatus {
	name: string;            // 'avail' / 'rides' etc.
	tiers: Array<{
		tier: string;
		bin: string;
		shards: PyramidShardStatus[];     // one per declared rung
	}>;
}

export type PyramidsHealth = PyramidStatus[];

/** Recency of `s3://tripdata` — the upstream Citi Bike monthly publish.
 *  Sourced from `tripdata/latest.json` in R2, refreshed every `tripdata.yml`
 *  run (independent of whether new files were imported). */
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

/** Snapshot per-(tier, shard_dur) status for unified-shard-ladder
 *  pyramids. Reads D1 directly (`pyramid_shards` for counts/extents,
 *  `pyramid_watermarks` for watermarks). Tier declarations come from
 *  `avail_geo.ts`'s `TIERS`; tracks the same ladders the api worker
 *  serves queries from.
 *
 *  D1 column compatibility: pre-P3 the column is `cadence`; post-P3
 *  it's `shard_dur`. Probe schema once and substitute. */
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

	const PYRAMID = 'avail';
	const { TIERS } = await import('./avail_geo');
	const largestPerTier: Record<string, string> = Object.fromEntries(
		TIERS.map((t) => [t.name, t.shards[t.shards.length - 1]!])
	);

	// One query for all shards of this pyramid; one for watermarks.
	type ShardRow = { tier: string; sd: string; n: number; earliest: number; latest: number };
	type WmRow = { tier: string; sd: string; latest_period_end: number };
	const shardSql = `SELECT tier, ${shardCol} AS sd, COUNT(*) AS n, ` +
		`MIN(period_start) AS earliest, MAX(period_end) AS latest ` +
		`FROM pyramid_shards WHERE pyramid = ? GROUP BY tier, ${shardCol}`;
	const wmSql = `SELECT tier, ${shardCol} AS sd, latest_period_end ` +
		`FROM pyramid_watermarks WHERE pyramid = ?`;

	let shardRows: ShardRow[] = [];
	let wmRows: WmRow[] = [];
	try {
		const [s, w] = await Promise.all([
			db.prepare(shardSql).bind(PYRAMID).all<ShardRow>(),
			db.prepare(wmSql).bind(PYRAMID).all<WmRow>(),
		]);
		shardRows = s.results ?? [];
		wmRows = w.results ?? [];
	} catch {
		// D1 unavailable — return empty.
		return [];
	}

	// Translate legacy canonical sentinel rows: '' → tier's largest shard.
	const norm = (tier: string, sd: string): string =>
		sd === '' ? (largestPerTier[tier] ?? sd) : sd;

	const shardsByKey = new Map<string, ShardRow>();
	for (const r of shardRows) shardsByKey.set(`${r.tier}@${norm(r.tier, r.sd)}`, r);
	const wmByKey = new Map<string, WmRow>();
	for (const r of wmRows) wmByKey.set(`${r.tier}@${norm(r.tier, r.sd)}`, r);

	const isoMs = (ms: number | null): string | null =>
		ms === null || ms === undefined ? null : new Date(ms).toISOString();

	const tiers = TIERS.map((t) => ({
		tier: t.name,
		bin: String(t.bin),
		shards: t.shards.map((sd) => {
			const key = `${t.name}@${sd}`;
			const s = shardsByKey.get(key);
			const w = wmByKey.get(key);
			return {
				tier: t.name,
				shardDur: String(sd),
				shardCount: s ? s.n : 0,
				earliestPeriodStart: s ? isoMs(s.earliest) : null,
				latestPeriodEnd: s ? isoMs(s.latest) : null,
				watermarkEnd: w ? isoMs(w.latest_period_end) : null,
			};
		}),
	}));

	return [{ name: PYRAMID, tiers }];
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

export async function getHealthSnapshot(
	r2: HealthR2,
	db?: D1Database,
): Promise<HealthSnapshot> {
	const [feed, compactions, cascade, pyramids, tripdata] = await Promise.all([
		getFeedHealth(r2),
		getCompactionHealth(r2),
		getCascadeHealth(r2),
		db ? getPyramidsHealth(db) : Promise.resolve<PyramidsHealth>([]),
		getTripdataHealth(r2),
	]);
	return {
		generatedAt: Math.floor(Date.now() / 1000),
		feed,
		compactions,
		cascade,
		pyramids,
		tripdata,
	};
}
