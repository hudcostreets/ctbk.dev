/**
 * Dynamic og:image renderer — `/og/s/<slug>.png`.
 *
 * Per-station 1200×630 share cards: station header + a 7-day hourly
 * availability sparkline read live from avail-v3. Rendered with satori
 * (HTML/CSS-subset → SVG) + resvg-wasm (SVG → PNG) — the vercel/og
 * stack, both Workers-compatible. Edge-cached 1d by the route wrapper
 * in `index.ts`, so render cost (~200-500 ms incl. the avail read) is
 * paid ~once/day/station-shared.
 *
 * Referenced from per-station HTML stubs' `og:image` meta (build-time
 * generation in www — see task #153 phase 2). Crawlers fetch this URL
 * directly at share time.
 */
// `satori/standalone` + explicit yoga init: the default `satori` entry
// embeds yoga wasm as base64 and compiles it at runtime, which Workers
// forbids ("Wasm code generation disallowed by embedder"). Importing
// the wasm modules through wrangler's CompiledWasm rule gives
// precompiled `WebAssembly.Module`s, which both inits accept.
// `assets/yoga.wasm` is copied from satori's own `satori/yoga.wasm`
// export (version-matched to its yoga-layout dep) — recopy on satori
// bumps.
import satori, { init as initSatori } from 'satori/standalone';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import yogaWasm from './assets/yoga.wasm';
import resvgWasm from './assets/resvg.wasm';
import interSemiBold from './assets/Inter-SemiBold.ttf';
import { serveAvailV3 } from './avail_geo';

// Both wasm modules must init exactly once per isolate.
let _wasmReady: Promise<void> | null = null;
function wasmReady(): Promise<void> {
	if (_wasmReady === null) {
		_wasmReady = (async () => {
			await initSatori(yogaWasm as unknown as WebAssembly.Module);
			await initWasm(resvgWasm as unknown as WebAssembly.Module);
		})();
	}
	return _wasmReady;
}

// ─── Station + LUC lookups ──────────────────────────────────────────

interface StationRow {
	short_name: string;
	gbfs_station_id: string;
	name: string;
	capacity: number | null;
	station_type: string | null;
	first_seen: string | null;
	slug: string | null;
}

async function stationBySlug(db: D1Database, slug: string): Promise<StationRow | null> {
	for (const col of ['slug', 'short_name', 'gbfs_station_id'] as const) {
		const row = await db.prepare(`SELECT * FROM stations WHERE ${col} = ?`)
			.bind(slug).first<StationRow>();
		if (row) return row;
	}
	return null;
}

/** Station-LUC denorm (same file the FE + cascade worker read). Cached
 *  per isolate — ~2.5k entries, refreshed rarely. */
const STATION_LUC_KEY = 'gbfs/station-luc.json';
interface LucFile {
	by_short_name: Record<string, { cell: string }>;
}
let _luc: LucFile | null = null;
async function lucCellFor(r2: R2Bucket, shortName: string): Promise<string | null> {
	if (_luc === null) {
		const obj = await r2.get(STATION_LUC_KEY);
		if (!obj) return null;
		_luc = await obj.json<LucFile>();
	}
	return _luc.by_short_name[shortName]?.cell ?? null;
}

// ─── Monthly trips (per-station ymdgtb JSON on S3, via md5 index) ───

/** Same data path the FE's `useStationTrips` uses: `ymdgtb-index.json`
 *  maps short_name → md5 of a per-station trips JSON on the ctbk S3
 *  bucket. Index cached per isolate (regenerates monthly). */
const TRIPS_INDEX_URL = 'https://ctbk.dev/ymdgtb-index.json';
const TRIPS_S3_BASE = 'https://ctbk.s3.amazonaws.com/.dvc/files/md5';
let _tripsIndex: { files: Record<string, string> } | null = null;

interface TripsSummary {
	/** (ym, rides) pairs, chronological — start-side counts. */
	months: Array<[string, number]>;
	total: number;
	lastYm: string;
	lastCount: number;
}

async function tripsSummary(shortName: string): Promise<TripsSummary | null> {
	if (_tripsIndex === null) {
		const r = await fetch(TRIPS_INDEX_URL);
		if (!r.ok) return null;
		_tripsIndex = await r.json();
	}
	const md5 = _tripsIndex!.files[shortName];
	if (!md5) return null;
	const r = await fetch(`${TRIPS_S3_BASE}/${md5.slice(0, 2)}/${md5.slice(2)}`);
	if (!r.ok) return null;
	const rows = await r.json() as Array<{ Year: number; Month: number; Docking: string; Count: number }>;
	const byYm = new Map<string, number>();
	for (const row of rows) {
		if (row.Docking !== 'start') continue;
		const ym = `${row.Year}${String(row.Month).padStart(2, '0')}`;
		byYm.set(ym, (byYm.get(ym) ?? 0) + row.Count);
	}
	if (byYm.size === 0) return null;
	const months = [...byYm.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
	const total = months.reduce((a, [, n]) => a + n, 0);
	const [lastYm, lastCount] = months[months.length - 1]!;
	return { months, total, lastYm, lastCount };
}

// ─── 30d availability summary (single hist-reducer query) ──────────

interface AvailSummary { avgBikes: number; pctEmpty: number }

/** Merge one 30d `reducer=hist` query's per-bin histograms → mean bikes
 *  + fraction of observed minutes at 0 bikes. Month-scale stats suit a
 *  share card that group chats will display statically for days —
 *  unlike a "latest" point value with a ~1min real TTL. */
async function availSummary(
	r2: R2Bucket,
	db: D1Database,
	cell: string,
): Promise<AvailSummary | null> {
	const to = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
	const from = new Date(to.getTime() - 30 * 86_400_000);
	const url = `https://internal/api/avail-v3?cells=${cell}` +
		`&from=${from.toISOString()}&to=${to.toISOString()}&bin_budget=5&reducer=hist`;
	const resp = await serveAvailV3(r2, db, new Request(url), '*');
	if (!resp.ok) return null;
	const data = await resp.json() as { records: Array<Record<string, unknown>> };
	const merged = new Map<number, number>();
	for (const r of data.records ?? []) {
		const raw = r.bikes;
		const h = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!h || typeof h !== 'object') continue;
		for (const [k, v] of Object.entries(h as Record<string, number>)) {
			merged.set(Number(k), (merged.get(Number(k)) ?? 0) + v);
		}
	}
	let total = 0, sum = 0;
	for (const [value, n] of merged) { total += n; sum += value * n; }
	if (total === 0) return null;
	return { avgBikes: sum / total, pctEmpty: (merged.get(0) ?? 0) / total };
}

// ─── Availability series (via the avail-v3 route, hourly, 7d) ──────

interface SparkPoint { bikes: number | null; docks: number | null }

async function availSeries(
	r2: R2Bucket,
	db: D1Database,
	cell: string,
): Promise<{ points: SparkPoint[]; from: Date; to: Date } | null> {
	const to = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
	const from = new Date(to.getTime() - 7 * 86400_000);
	// Reuse the full avail-v3 serving path (inventory planner, LUC cell
	// query) by synthesizing an internal request — one code path to trust.
	const url = `https://internal/api/avail-v3?cells=${cell}` +
		`&from=${from.toISOString()}&to=${to.toISOString()}&bin_budget=168&reducer=mean`;
	const resp = await serveAvailV3(r2, db, new Request(url), '*');
	if (!resp.ok) return null;
	const data = await resp.json() as { records: Array<Record<string, number>> };
	if (!data.records?.length) return null;
	const points = data.records.map((r) => ({
		bikes: typeof r.bikes === 'number' ? r.bikes : null,
		docks: typeof r.docks === 'number' ? r.docks : null,
	}));
	return { points, from, to };
}

// ─── Card layout (satori element tree, no JSX) ──────────────────────

type El = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown): El =>
	({ type, props: { style, ...(children !== undefined ? { children } : {}) } });

const BG = '#16181d';
const FG = '#e8eaed';
const DIM = '#9aa0a6';
const BIKES = '#3b82f6';   // matches the chart's classic-bikes blue
const ACCENT = '#4ade80';

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
	'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtYm = (ym: string) => `${MONTH_ABBR[parseInt(ym.slice(4), 10)]} '${ym.slice(2, 4)}`;
const fmtN = (n: number) =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n.toLocaleString('en-US');

function statRow(label: string, value: string, color = FG): El {
	return el('div', { display: 'flex', flexDirection: 'column', flexGrow: 1 }, [
		el('div', { fontSize: 38, fontWeight: 600, color }, value),
		el('div', { fontSize: 20, color: DIM, marginTop: 2 }, label),
	]);
}

function card(
	station: StationRow,
	series: { points: SparkPoint[]; from: Date; to: Date } | null,
	trips: TripsSummary | null,
	summary: AvailSummary | null,
): El {
	const meta: string[] = [`#${station.short_name}`];
	if (station.capacity) meta.push(`${station.capacity} docks`);
	if (station.station_type) meta.push(station.station_type);
	if (station.first_seen) meta.push(`since ${station.first_seen.slice(0, 4)}`);

	const children: El[] = [
		el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }, [
			el('div', { display: 'flex', flexDirection: 'column', maxWidth: 890 }, [
				el('div', { fontSize: 50, fontWeight: 600, color: FG, lineHeight: 1.1 }, station.name),
				el('div', { fontSize: 23, color: DIM, marginTop: 8 }, meta.join(' · ')),
			]),
			el('div', { fontSize: 32, color: ACCENT, fontWeight: 600 }, 'ctbk.dev'),
		]),
	];

	// Stats band: month-scale summaries — stable enough for a share card
	// that group chats will display statically for days (vs a "latest"
	// point value with a ~1min real TTL).
	const stats: El[] = [];
	if (summary) {
		stats.push(statRow('avg bikes available, last 30d', String(Math.round(summary.avgBikes)), BIKES));
		stats.push(statRow('of the time no bikes, last 30d', `${(100 * summary.pctEmpty).toFixed(0)}%`, '#e0a252'));
	}
	if (trips) {
		stats.push(statRow('rides, all-time', fmtN(trips.total), ACCENT));
		stats.push(statRow(`rides in ${fmtYm(trips.lastYm)}`, fmtN(trips.lastCount)));
	}
	if (stats.length) {
		children.push(el('div', {
			display: 'flex', marginTop: 24, paddingTop: 22,
			borderTop: '2px solid #2a2e36',
		}, stats));
	}

	// 7d availability sparkline, full width.
	if (series && series.points.length > 1) {
		const SPARK_H = 140;
		const max = Math.max(1, ...series.points.map((p) => p.bikes ?? 0));
		const bars = series.points.map((p) => {
			const h = p.bikes === null ? 0 : Math.max(2, Math.round((p.bikes / max) * SPARK_H));
			return el('div', { flexGrow: 1, height: h, background: p.bikes === null ? '#333' : BIKES, marginRight: 1 });
		});
		children.push(
			el('div', { display: 'flex', flexDirection: 'column', marginTop: 22 }, [
				el('div', {
					display: 'flex', alignItems: 'flex-end', height: SPARK_H,
					background: '#1e2127', borderRadius: 8, padding: 8,
				}, bars),
				el('div', { fontSize: 19, color: DIM, marginTop: 6 },
					'bikes available — last 7 days, hourly mean'),
			]),
		);
	}

	// Bottom band: whole-history monthly rides.
	if (trips && trips.months.length > 1) {
		const TRIPS_H = 80;
		const maxM = Math.max(1, ...trips.months.map(([, n]) => n));
		const bars = trips.months.map(([, n]) =>
			el('div', {
				flexGrow: 1,
				height: Math.max(2, Math.round((n / maxM) * TRIPS_H)),
				background: ACCENT, opacity: 0.85, marginRight: 1,
			}));
		children.push(
			el('div', { display: 'flex', flexDirection: 'column', marginTop: 20 }, [
				el('div', { display: 'flex', alignItems: 'flex-end', height: TRIPS_H }, bars),
				el('div', { display: 'flex', justifyContent: 'space-between', marginTop: 6 }, [
					el('div', { fontSize: 19, color: DIM },
						`rides per month, ${fmtYm(trips.months[0]![0])} → ${fmtYm(trips.lastYm)}`),
					el('div', { fontSize: 19, color: DIM }, `peak ${fmtN(maxM)}/mo`),
				]),
			]),
		);
	}

	return el('div', {
		width: 1200, height: 630, display: 'flex', flexDirection: 'column',
		background: BG, padding: 44, fontFamily: 'Inter',
	}, children);
}

// ─── Entry point ────────────────────────────────────────────────────

export async function serveStationOg(
	r2: R2Bucket,
	db: D1Database,
	slug: string,
): Promise<Response> {
	const station = await stationBySlug(db, slug);
	if (!station) return new Response(`station not found: ${slug}\n`, { status: 404 });

	const cell = await lucCellFor(r2, station.short_name);
	// Both panels are decoration — render the card without either rather
	// than failing the share preview.
	const [series, trips, summary] = await Promise.all([
		cell ? availSeries(r2, db, cell).catch(() => null) : Promise.resolve(null),
		tripsSummary(station.short_name).catch(() => null),
		cell ? availSummary(r2, db, cell).catch(() => null) : Promise.resolve(null),
	]);

	await wasmReady();
	const svg = await satori(card(station, series, trips, summary) as never, {
		width: 1200,
		height: 630,
		fonts: [{
			name: 'Inter',
			data: interSemiBold as unknown as ArrayBuffer,
			weight: 600,
			style: 'normal',
		}],
	});
	const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
	return new Response(png as unknown as BodyInit, {
		headers: { 'Content-Type': 'image/png' },
	});
}
