/**
 * `/api/tl` — timelapse frames (`specs/timelapse-map.md` "Serving: chunked
 * frames") from the time-first `rides-tl-{start,end}` pyramids: same tier
 * ladder as `rides/`, `cell` the only dim (`s:` leaves + `c:` rollups, no S2
 * vocab), `count` the only metric, rows sorted `dt,cell` so a run of frames
 * is a contiguous byte range and `dt` row-group stats prune everything else.
 *
 *   GET /api/tl?anchor=start|end&bin=<tier>&chunk=<k>[&raw=1]
 *
 * Frames are numbered in units of `bin` from an origin at or before genesis
 * (2013-06-01, local wall-clock as UTC): the origin is genesis floored to the
 * `K·bin` grid, so chunk `k` = frames `[k·K, (k+1)·K)` sits exactly on the
 * pyramid's own shard grid (fixed spans align to the unix epoch, months to
 * year 0) — a `1d` chunk (K=32) is one `1d@32d` shard, a `1h` chunk (K=48)
 * one `1h@2d`, a `1mo` chunk (K=24) one `1mo@2y`. For hour-multiples and
 * `1d` the origin IS genesis. The FE mirrors `TL_K` (`timelapseFrames.ts`).
 *
 * Shards are resolved from the pyramid's `manifest.jsonl` (latest
 * `written_at` per `(tier, shard_dur, period_start)`; R2 keeps superseded
 * hashed copies), not the D1 registry: `rides-tl` isn't registered there and
 * with `rg_size 32768` its footers are 2–10 KB, so the footer path is one
 * 64 KB range read — no D1 round trip, no `rg_manifest` fill, and no footer
 * guard (that exists for 7 MB rides footers). Where the requested tier has
 * no shard (the min-cover's tip: a `1d` tier is absent for the last days of
 * an open month, which `6h@8d` / `3h@4d` / `1h@2d` carry), finer tiers whose
 * bin divides `bin` fill in and re-aggregate at pivot; what nothing covers
 * is reported as `gaps` with `partial: true`.
 *
 * Response: a dense frame-major block, `counts[f * S + s]`, `ids` sorted;
 * `unmapped[f]` = per-frame totals of rows keyed to no station (the
 * builder's fallback cells).
 */
import { parquetMetadataAsync, parquetReadObjects, type FileMetaData } from 'hyparquet';
import { nominalMs, type Storage } from 'pyrmts';
import { loadCanonMapWith, type CanonMap, type LeafMode } from './canon';
import { pruneRgRuns, storageBuffer } from './rg_manifest';

export const TL_GENESIS_MS = Date.UTC(2013, 5, 1);
export const TL_ANCHORS = ['start', 'end'] as const;
export type TlAnchor = typeof TL_ANCHORS[number];
/** Served tiers: the `rides-tl` ladder below `2mo` (`configs/pyramids/rides-tl-*.yaml`). */
export const TL_BINS = ['1h', '3h', '6h', '12h', '1d', '3d', '7d', '14d', '1mo'] as const;
export type TlBin = typeof TL_BINS[number];
type FixedBin = Exclude<TlBin, '1mo'>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FIXED_MS: Record<FixedBin, number> = {
	'1h': HOUR_MS, '3h': 3 * HOUR_MS, '6h': 6 * HOUR_MS, '12h': 12 * HOUR_MS,
	'1d': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS, '14d': 14 * DAY_MS,
};
/** Frames per chunk. `1h` → 2 days; every other tier's `K·bin` is one of its
 *  shard rungs (`3h`→4d, `6h`→8d, `12h`→16d, `1d`→32d, `3d`→96d, `7d`→224d,
 *  `14d`→448d, `1mo`→2y). */
export const TL_K: Record<TlBin, number> = {
	'1h': 48, '3h': 32, '6h': 32, '12h': 32, '1d': 32, '3d': 32, '7d': 32, '14d': 32, '1mo': 24,
};
const TL_COLUMNS = ['cell', 'dt', 'count_n'];
const MANIFEST_TTL_MS = 60_000;
const FOOTER_CACHE_MAX = 256;
/** Chunks ending this long before now (and fully served by the requested
 *  tier) are immutable. Mirrors `/api/rides`' past-window slack. */
const CLOSED_SLACK_MS = 300_000;

// ─── Frame grid ──────────────────────────────────────────────────────────

const monthIdx = (ms: number): number => {
	const d = new Date(ms);
	return d.getUTCFullYear() * 12 + d.getUTCMonth();
};
const monthMs = (idx: number): number => Date.UTC(Math.floor(idx / 12), ((idx % 12) + 12) % 12);

/** Frame 0's start: genesis floored to the `K·bin` grid (see module doc). */
export function originMs(bin: TlBin): number {
	const K = TL_K[bin];
	if (bin === '1mo') return monthMs(Math.floor(monthIdx(TL_GENESIS_MS) / K) * K);
	const grid = K * FIXED_MS[bin];
	return Math.floor(TL_GENESIS_MS / grid) * grid;
}

/** Frame index containing `ms`. */
export function frameOf(bin: TlBin, ms: number): number {
	if (bin === '1mo') return monthIdx(ms) - monthIdx(originMs(bin));
	return Math.floor((ms - originMs(bin)) / FIXED_MS[bin]);
}

/** Start of frame `i`. */
export function frameStartMs(bin: TlBin, i: number): number {
	if (bin === '1mo') return monthMs(monthIdx(originMs(bin)) + i);
	return originMs(bin) + i * FIXED_MS[bin];
}

/** `[t0, t1)` of chunk `k` (frames `[k·K, (k+1)·K)`). */
export function chunkRange(bin: TlBin, k: number): [number, number] {
	const K = TL_K[bin];
	return [frameStartMs(bin, k * K), frameStartMs(bin, (k + 1) * K)];
}

/** Tiers finer than `bin` whose bins nest inside its frames, coarsest
 *  first: fixed tiers dividing a fixed `bin` (both epoch-aligned, so
 *  divisibility ⇒ nesting); for `1mo`, the tiers dividing a day (month
 *  boundaries are whole days; `3d`/`7d`/`14d` straddle them). */
export function finerTiers(bin: TlBin): FixedBin[] {
	const unit = bin === '1mo' ? DAY_MS : FIXED_MS[bin];
	return (Object.keys(FIXED_MS) as FixedBin[])
		.filter((t) => t !== bin && FIXED_MS[t] <= unit && unit % FIXED_MS[t] === 0)
		.sort((a, b) => FIXED_MS[b] - FIXED_MS[a]);
}

// ─── Manifest ────────────────────────────────────────────────────────────

export interface TlShard {
	tier: string;
	shard_dur: string;
	period_start: number;
	period_end: number;
	key: string;
	written_at: number;
	bytes: number;
}

const toMs = (v: unknown): number => typeof v === 'number' ? v : Date.parse(String(v));

/** Parse `manifest.jsonl` (one shard per line; `written_at`/periods as ms
 *  or ISO strings) and keep the latest `written_at` per `(tier, shard_dur,
 *  period_start)` slot. */
export function latestShards(text: string): TlShard[] {
	const bySlot = new Map<string, TlShard>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const r = JSON.parse(line) as Record<string, unknown>;
		const s: TlShard = {
			tier: String(r.tier),
			shard_dur: String(r.shard_dur),
			period_start: toMs(r.period_start),
			period_end: toMs(r.period_end),
			key: String(r.key),
			written_at: toMs(r.written_at),
			bytes: Number(r.bytes ?? 0),
		};
		const slot = `${s.tier}/${s.shard_dur}/${s.period_start}`;
		const prev = bySlot.get(slot);
		if (!prev || s.written_at > prev.written_at) bySlot.set(slot, s);
	}
	return [...bySlot.values()].sort((a, b) =>
		a.tier.localeCompare(b.tier) || a.period_start - b.period_start || nominalMs(a.shard_dur) - nominalMs(b.shard_dur) || a.key.localeCompare(b.key));
}

// ─── Cover plan ──────────────────────────────────────────────────────────

export interface TlRead {
	shard: TlShard;
	/** `[from, to)` ms — the shard's period clipped to what it serves. */
	from: number;
	to: number;
}

export interface TlPlan {
	reads: TlRead[];
	/** `[from, to)` ms nothing covers. */
	gaps: [number, number][];
}

/** Cover `[t0, t1)`: the requested tier first (largest rung first, so a
 *  chunk is as few reads as the min-cover allows), then each finer tier
 *  over what's still uncovered. A shard serves only the sub-ranges it is
 *  chosen for, so overlapping rungs never double-count. */
export function planCover(shards: readonly TlShard[], bin: TlBin, t0: number, t1: number): TlPlan {
	let need: [number, number][] = [[t0, t1]];
	const reads: TlRead[] = [];
	for (const tier of [bin, ...finerTiers(bin)]) {
		if (!need.length) break;
		const cands = shards
			.filter((s) => s.tier === tier && s.period_end > t0 && s.period_start < t1)
			.sort((a, b) => nominalMs(b.shard_dur) - nominalMs(a.shard_dur) || a.period_start - b.period_start || b.written_at - a.written_at);
		for (const shard of cands) {
			const next: [number, number][] = [];
			for (const [a, b] of need) {
				const from = Math.max(a, shard.period_start);
				const to = Math.min(b, shard.period_end);
				if (from >= to) {
					next.push([a, b]);
					continue;
				}
				reads.push({ shard, from, to });
				if (a < from) next.push([a, from]);
				if (to < b) next.push([to, b]);
			}
			need = next;
		}
	}
	reads.sort((a, b) => a.from - b.from || a.to - b.to);
	need.sort((a, b) => a[0] - b[0]);
	return { reads, gaps: need };
}

// ─── Pivot ───────────────────────────────────────────────────────────────

export interface TlRow {
	cell: string;
	/** Bin start, local-as-UTC ms. */
	dt: number;
	count: number;
}

export interface TlBlock {
	/** Station ids with ≥1 count in the chunk, sorted. */
	ids: string[];
	/** `K × ids.length`, frame-major. */
	counts: number[];
	/** Per-frame totals of rows keyed to no station. */
	unmapped: number[];
}

/** Station id for a `cell`, or `null` for an unmapped cell, or `undefined`
 *  for a row to skip (counted elsewhere).
 *
 *  `canonicalized` says whether the pyramid holds materialized `c:` rows
 *  (`pyrmts-engine canonicalize` ran): then canonical mode is `canon.ts`'s —
 *  `c:` rows as-is, merged members' `s:` leaves skipped. Before that pass
 *  (`TL_CANONICALIZED` unset) only raw `s:` leaves exist, and canonical mode
 *  folds each merged member into its canonical id via the same id-map. Raw
 *  mode is always the `s:` leaves alone. */
export function resolveCell(cell: string, canon: CanonMap | null, mode: LeafMode, canonicalized: boolean): string | null | undefined {
	if (cell.startsWith('c:')) return mode === 'raw' ? undefined : cell.slice(2);
	if (!cell.startsWith('s:')) return null;
	if (mode === 'raw') return cell.slice(2);
	const c = canon?.toCanon.get(cell);
	if (c === undefined) return cell.slice(2);
	return canonicalized ? undefined : c.slice(2);
}

/** Pivot rows into chunk `k`'s frame-major block. Rows outside the chunk
 *  are ignored; a finer tier's rows floor into the requested bin's frames
 *  and sum (exact: `count` is a sum monoid). */
export function pivotFrames(
	rows: Iterable<TlRow>,
	bin: TlBin,
	k: number,
	canon: CanonMap | null,
	mode: LeafMode,
	canonicalized: boolean,
): TlBlock {
	const K = TL_K[bin];
	const f0 = k * K;
	const perId = new Map<string, number[]>();
	const unmapped = new Array<number>(K).fill(0);
	for (const { cell, dt, count } of rows) {
		const f = frameOf(bin, dt) - f0;
		if (f < 0 || f >= K || !(count > 0)) continue;
		const id = resolveCell(cell, canon, mode, canonicalized);
		if (id === undefined) continue;
		if (id === null) {
			unmapped[f] += count;
			continue;
		}
		let arr = perId.get(id);
		if (!arr) {
			arr = new Array<number>(K).fill(0);
			perId.set(id, arr);
		}
		arr[f] += count;
	}
	const ids = [...perId.keys()].sort();
	const S = ids.length;
	const counts = new Array<number>(K * S).fill(0);
	ids.forEach((id, s) => {
		const arr = perId.get(id)!;
		for (let f = 0; f < K; f++) counts[f * S + s] = arr[f];
	});
	return { ids, counts, unmapped };
}

/** Frame sub-ranges `[f0, f1)` of chunk `k` the plan's reads cover, merged
 *  and sorted (the response's `covered`). */
export function coveredFrames(plan: TlPlan, bin: TlBin, k: number): [number, number][] {
	const K = TL_K[bin];
	const base = k * K;
	const spans = plan.reads
		.map((r): [number, number] => [
			Math.max(0, frameOf(bin, r.from) - base),
			Math.min(K, frameOf(bin, r.to - 1) + 1 - base),
		])
		.filter(([a, b]) => a < b)
		.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const [a, b] of spans) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

// ─── Fetch ───────────────────────────────────────────────────────────────

const manifestCache = new Map<string, { ts: number; value: Promise<TlShard[]> }>();

function loadManifest(storage: Storage, prefix: string, anchor: TlAnchor, now: number): Promise<TlShard[]> {
	const key = `${prefix}/${anchor}/manifest.jsonl`;
	const hit = manifestCache.get(key);
	if (hit && now - hit.ts < MANIFEST_TTL_MS) return hit.value;
	const value = (async () => {
		const bytes = await storage.get(key);
		if (bytes === null) throw new TlNotFound(`${key} not found`);
		return latestShards(new TextDecoder().decode(bytes));
	})();
	manifestCache.set(key, { ts: now, value });
	value.catch(() => manifestCache.delete(key));
	return value;
}

export class TlNotFound extends Error {}

/** Parsed footers (+ file size), per key. Shards are content-hashed
 *  (immutable per key), so entries never go stale; bounded FIFO. */
const footerCache = new Map<string, Promise<{ metadata: FileMetaData; size: number }>>();

function loadFooter(storage: Storage, shard: TlShard): Promise<{ metadata: FileMetaData; size: number }> {
	const hit = footerCache.get(shard.key);
	if (hit) return hit;
	const value = (async () => {
		const size = shard.bytes > 0 ? shard.bytes : (await storage.head(shard.key))?.size;
		if (size === undefined) throw new TlNotFound(`${shard.key} not found`);
		const metadata = await parquetMetadataAsync(storageBuffer(storage, shard.key, size), { initialFetchSize: 64 * 1024 });
		return { metadata, size };
	})();
	if (footerCache.size >= FOOTER_CACHE_MAX) footerCache.delete(footerCache.keys().next().value!);
	footerCache.set(shard.key, value);
	value.catch(() => footerCache.delete(shard.key));
	return value;
}

const dtMs = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'bigint' ? Number(v) : Number(v);

/** One read: prune the shard's row groups to `[from, to)` by `dt` stats,
 *  decode the projected columns of the matched runs, drop rows outside the
 *  range (a run's edge RGs straddle it). */
export async function readShardRows(storage: Storage, read: TlRead): Promise<TlRow[]> {
	const { metadata, size } = await loadFooter(storage, read.shard);
	const runs = pruneRgRuns(metadata, { cellCol: 'cell', tokens: [], fromMs: read.from, toMs: read.to });
	if (runs.length === 0) return [];
	const file = storageBuffer(storage, read.shard.key, size);
	const perRun = await Promise.all(runs.map(({ rowStart, rowEnd }) => parquetReadObjects({
		file, metadata, rowStart, rowEnd, columns: TL_COLUMNS, maxOverfetchRatio: 0.25,
	})));
	const out: TlRow[] = [];
	for (const rows of perRun) {
		for (const r of rows) {
			const dt = dtMs(r.dt);
			if (dt < read.from || dt >= read.to) continue;
			out.push({ cell: r.cell as string, dt, count: Number(r.count_n) });
		}
	}
	return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────

export interface TlConfig {
	/** R2 key prefix of the pyramids (`{prefix}/{anchor}/…`). */
	prefix: string;
	/** Whether the pyramids hold materialized `c:` rollups (see `resolveCell`). */
	canonicalized: boolean;
}

function errorResponse(status: number, message: string, cors: string | null): Response {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	return new Response(JSON.stringify({ error: message }), { status, headers });
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

export async function serveTl(
	storage: Storage,
	request: Request,
	corsOrigin: string,
	cfg: TlConfig,
	now: () => number = Date.now,
): Promise<Response> {
	const cors = corsOrigin || null;
	const url = new URL(request.url);
	const anchorRaw = url.searchParams.get('anchor') ?? 'start';
	if (!TL_ANCHORS.includes(anchorRaw as TlAnchor)) {
		return errorResponse(400, `bad anchor '${anchorRaw}'; one of ${TL_ANCHORS.join('|')}`, cors);
	}
	const anchor = anchorRaw as TlAnchor;
	const binRaw = url.searchParams.get('bin') ?? '1d';
	if (!TL_BINS.includes(binRaw as TlBin)) {
		return errorResponse(400, `bad bin '${binRaw}'; one of ${TL_BINS.join('|')}`, cors);
	}
	const bin = binRaw as TlBin;
	const chunkRaw = url.searchParams.get('chunk');
	if (chunkRaw === null || !/^\d+$/.test(chunkRaw)) {
		return errorResponse(400, `chunk query param required (non-negative integer); got '${chunkRaw}'`, cors);
	}
	const k = Number(chunkRaw);
	const rawParam = url.searchParams.get('raw');
	if (rawParam !== null && rawParam !== '0' && rawParam !== '1') {
		return errorResponse(400, `bad raw '${rawParam}'; expected 0|1`, cors);
	}
	const mode: LeafMode = rawParam === '1' ? 'raw' : 'canonical';
	const K = TL_K[bin];
	const [t0, t1] = chunkRange(bin, k);
	const t = now();

	let shards: TlShard[];
	try {
		shards = await loadManifest(storage, cfg.prefix, anchor, t);
	} catch (err) {
		if (err instanceof TlNotFound) return errorResponse(404, err.message, cors);
		throw err;
	}
	const plan = planCover(shards, bin, t0, t1);
	const canon = mode === 'canonical'
		? await loadCanonMapWith(async (key) => {
			const bytes = await storage.get(key);
			if (bytes === null) throw new Error(`${key} not found`);
			return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
		})
		: null;
	const perRead = await Promise.all(plan.reads.map((r) => readShardRows(storage, r)));
	const block = pivotFrames(perRead.flat(), bin, k, canon, mode, cfg.canonicalized);
	const partial = plan.gaps.length > 0;
	const closed = !partial && plan.reads.every((r) => r.shard.tier === bin) && t1 <= t - CLOSED_SLACK_MS;

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Cache-Control': closed ? 'public, max-age=86400, immutable' : 'public, max-age=3600',
	};
	if (cors) headers['Access-Control-Allow-Origin'] = cors;
	return new Response(JSON.stringify({
		anchor,
		bin,
		chunk: k,
		k: K,
		t0: iso(t0),
		t1: iso(t1),
		ids: block.ids,
		counts: block.counts,
		unmapped: block.unmapped,
		partial,
		covered: coveredFrames(plan, bin, k),
		plan: {
			reads: plan.reads.map((r) => ({ tier: r.shard.tier, shard: r.shard.shard_dur, key: r.shard.key, from: iso(r.from), to: iso(r.to) })),
			gaps: plan.gaps.map(([a, b]) => [iso(a), iso(b)]),
		},
	}), { headers });
}
