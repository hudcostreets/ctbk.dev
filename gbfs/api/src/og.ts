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

function card(station: StationRow, series: { points: SparkPoint[]; from: Date; to: Date } | null): El {
	const meta: string[] = [`#${station.short_name}`];
	if (station.capacity) meta.push(`${station.capacity} docks`);
	if (station.station_type) meta.push(station.station_type);
	if (station.first_seen) meta.push(`since ${station.first_seen.slice(0, 4)}`);

	const children: El[] = [
		// Header row: station name + brand
		el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }, [
			el('div', { display: 'flex', flexDirection: 'column', maxWidth: 900 }, [
				el('div', { fontSize: 58, fontWeight: 600, color: FG, lineHeight: 1.1 }, station.name),
				el('div', { fontSize: 27, color: DIM, marginTop: 14 }, meta.join(' · ')),
			]),
			el('div', { fontSize: 34, color: ACCENT, fontWeight: 600 }, 'ctbk.dev'),
		]),
	];

	if (series && series.points.length > 1) {
		const max = Math.max(1, ...series.points.map((p) => p.bikes ?? 0));
		const H = 320;
		const bars = series.points.map((p) => {
			const h = p.bikes === null ? 0 : Math.max(2, Math.round((p.bikes / max) * H));
			return el('div', {
				flexGrow: 1,
				height: h,
				background: p.bikes === null ? '#333' : BIKES,
				marginRight: 1,
			});
		});
		children.push(
			el('div', { display: 'flex', flexDirection: 'column', marginTop: 40 }, [
				el('div', {
					display: 'flex', alignItems: 'flex-end', height: H,
					background: '#1e2127', borderRadius: 8, padding: 12,
				}, bars),
				el('div', { display: 'flex', justifyContent: 'space-between', marginTop: 12 }, [
					el('div', { fontSize: 22, color: DIM }, 'bikes available — last 7 days, hourly mean'),
					el('div', { fontSize: 22, color: DIM },
						`${series.from.toISOString().slice(5, 10)} → ${series.to.toISOString().slice(5, 10)}`),
				]),
			]),
		);
	} else {
		children.push(el('div', { fontSize: 26, color: DIM, marginTop: 60 },
			'live availability + trip history'));
	}

	return el('div', {
		width: 1200, height: 630, display: 'flex', flexDirection: 'column',
		background: BG, padding: 52, fontFamily: 'Inter',
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
	let series: Awaited<ReturnType<typeof availSeries>> = null;
	if (cell) {
		try {
			series = await availSeries(r2, db, cell);
		} catch {
			// Sparkline is decoration — render the card without it rather
			// than failing the share preview.
			series = null;
		}
	}

	await wasmReady();
	const svg = await satori(card(station, series) as never, {
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
