/**
 * Empty/full station bitmaps — the read side of `empty-v1p/` (see
 * `specs/avail-empty-bitmaps.md`). A dense `(plane, minute, station)` bit cube on
 * R2 as a sharded Zarr v3 array: one R2 object per (UTC day, 512-station shard),
 * keyed `empty-v1p/planes/c/0/<day_idx>/<shard>`; inside, 24 hourly inner chunks
 * `(4, 60, 64)` gzip'd independently, addressable via the shard's trailing index.
 * Four planes: `observed` (raw), `no_bikes` / `no_ebikes` / `full` (forward-filled).
 * Bits are packed along the station axis (station j → byte j>>3, bit 7-(j&7)).
 *
 * This is the TS port of `ctbk/gbfs_empty.py`'s reference reader (`query`), used by
 * `GET /api/empty`. The read (select columns → fetch shards → unpack) is identical
 * for K = 1 station, a small group, or all stations (the homepage). Reductions run
 * on top of that same read — `series` here (per-bucket condition counts over time);
 * `window` (per-station %, k-of-K) to follow.
 *
 * Fetch cost scales with (#days × #distinct-shards-touched), NOT #stations: one
 * station costs its whole 512-station shard. The station vocab is s2-ordered, so a
 * local group clusters into one shard. All-stations = all shards = ~5× a single.
 */

export const EMPTY_PLANES_PREFIX = 'empty-v1p/planes/c/0';
export const EMPTY_VOCAB_KEY = 'empty-v1/stations.json';
/** `EPOCH` in `gbfs_empty.py`: day index = days since this UTC date. */
export const EMPTY_EPOCH_MS = Date.parse('2026-04-01T00:00:00Z');

export const MINUTES_PER_DAY = 1440;
export const SHARD_STATIONS = 512;
export const SHARD_BYTES = SHARD_STATIONS / 8; // 64
export const CHUNK_MINUTES = 60;
export const CHUNKS_PER_SHARD = MINUTES_PER_DAY / CHUNK_MINUTES; // 24
/** Trailing shard index: (offset, nbytes) u64 LE per inner chunk, then crc32c u32. */
export const INDEX_LEN = CHUNKS_PER_SHARD * 16 + 4; // 388
export const CHUNK_BYTES = 4 * CHUNK_MINUTES * SHARD_BYTES; // 15360 (all 4 planes)

export const PLANES = ['observed', 'no_bikes', 'no_ebikes', 'full'] as const;
export type Plane = (typeof PLANES)[number];
export type CondPlane = 'no_bikes' | 'no_ebikes' | 'full';
export const COND_PLANES: CondPlane[] = ['no_bikes', 'no_ebikes', 'full'];

const MAX_U64 = (1n << 64n) - 1n;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Bin = 'minute' | 'hour' | 'day';
export const BIN_MINUTES: Record<Bin, number> = { minute: 1, hour: 60, day: MINUTES_PER_DAY };

// ─── Day / key math ─────────────────────────────────────────────────────────

export function isDay(s: string): boolean {
	return DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function dayIdx(day: string): number {
	return Math.round((Date.parse(`${day}T00:00:00Z`) - EMPTY_EPOCH_MS) / 86_400_000);
}

export function utcDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
	return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
}

/** Inclusive `[from, to]` UTC day strings. Throws on malformed / inverted / oversized. */
export function daysBetween(from: string, to: string, maxDays: number): string[] {
	if (!isDay(from) || !isDay(to)) throw new Error(`bad day: from=${from} to=${to}`);
	const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
	if (n < 1) throw new Error(`from > to: ${from} > ${to}`);
	if (n > maxDays) throw new Error(`range too large: ${n} days > ${maxDays}`);
	return Array.from({ length: n }, (_, i) => addDays(from, i));
}

export function shardKey(dIdx: number, shard: number): string {
	return `${EMPTY_PLANES_PREFIX}/${dIdx}/${shard}`;
}

// ─── Vocab ──────────────────────────────────────────────────────────────────

export interface Vocab {
	stations: string[];
	index: Map<string, number>;
}

export function makeVocab(stations: string[]): Vocab {
	const index = new Map<string, number>();
	stations.forEach((s, i) => index.set(s, i));
	return { stations, index };
}

// ─── Shard object decode ─────────────────────────────────────────────────────

/** Byte access to one R2 shard object; `null` from `tail`/`whole` ⇒ object absent. */
export interface ShardBytes {
	tail(n: number): Promise<Uint8Array | null>;
	range(off: number, n: number): Promise<Uint8Array>;
	whole(): Promise<Uint8Array | null>;
}

export type OpenShard = (key: string) => ShardBytes;

/** Parse a shard's trailing index into `[offset, nbytes]` per hour; offset -1 ⇒ empty chunk. */
export function parseIndex(tail: Uint8Array): Array<[number, number]> {
	const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	const out: Array<[number, number]> = [];
	for (let h = 0; h < CHUNKS_PER_SHARD; h++) {
		const off = dv.getBigUint64(h * 16, true);
		const n = dv.getBigUint64(h * 16 + 8, true);
		out.push([off === MAX_U64 ? -1 : Number(off), Number(n)]);
	}
	return out;
}

async function gunzip(buf: Uint8Array): Promise<Uint8Array> {
	const stream = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Lazily-loaded accessor over one shard object; `hour(h)` ⇒ decompressed `(4,60,64)` bytes or null. */
export class Shard {
	private idx: Array<[number, number]> | null | undefined;
	private buf?: Uint8Array | null;
	constructor(
		private acc: ShardBytes,
		private strategy: 'whole' | 'range' = 'whole',
	) {}

	private async load(): Promise<void> {
		if (this.strategy === 'whole') {
			this.buf = await this.acc.whole();
			this.idx = this.buf ? parseIndex(this.buf.subarray(this.buf.length - INDEX_LEN)) : null;
		} else {
			const t = await this.acc.tail(INDEX_LEN);
			this.idx = t ? parseIndex(t) : null;
		}
	}

	async hour(h: number): Promise<Uint8Array | null> {
		if (this.idx === undefined) await this.load();
		if (!this.idx) return null;
		const [off, n] = this.idx[h];
		if (off < 0) return null;
		const raw = this.strategy === 'whole' ? this.buf!.subarray(off, off + n) : await this.acc.range(off, n);
		return gunzip(raw);
	}
}

/** Bit at (plane p, minute m in 0..59, column c in 0..511) of a decompressed hour chunk. */
export function bitAt(chunk: Uint8Array, p: number, m: number, c: number): number {
	const byte = chunk[p * CHUNK_MINUTES * SHARD_BYTES + m * SHARD_BYTES + (c >> 3)];
	return (byte >> (7 - (c & 7))) & 1;
}

// ─── `series` reduction ──────────────────────────────────────────────────────

export interface SeriesOpts {
	from: string;
	to: string;
	/** Selected station uuids; empty/omitted ⇒ all stations (homepage). */
	stations?: string[];
	bin: Bin;
	strategy?: 'whole' | 'range';
	/** Concurrency for shard fetches. */
	workers?: number;
	maxDays?: number;
}

export interface SeriesResult {
	from: string;
	to: string;
	bin: Bin;
	binMinutes: number;
	/** Number of selected stations found in the vocab. */
	stations: number;
	/** Requested uuids absent from the vocab. */
	dropped: string[];
	shards: number[];
	/** Bucket start times, unix seconds UTC. */
	t: number[];
	/** Wall-clock minutes covered by each bucket (usually `binMinutes`). */
	minutes: number[];
	/** Station-minutes with the `observed` bit set (denominator). */
	observed: number[];
	/** Station-minutes in each condition (forward-filled), per plane. */
	no_bikes: number[];
	no_ebikes: number[];
	full: number[];
}

async function pool<T>(items: T[], workers: number, fn: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	const run = async (): Promise<void> => {
		while (i < items.length) {
			const item = items[i++];
			await fn(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(workers, items.length) }, run));
}

/**
 * Per-bucket condition counts over `[from, to]` (all hours, all days) for a station
 * selection. Streams shard objects and accumulates — never materializes the full
 * (stations × minutes) matrix — so all-stations over all history stays O(#buckets).
 * Numerators use the stored forward-filled condition planes; `observed` is the raw
 * per-minute observed count (the denominator).
 */
export async function readSeries(open: OpenShard, vocab: Vocab, opts: SeriesOpts): Promise<SeriesResult> {
	const { from, to, bin, strategy = 'whole', workers = 32, maxDays = 1500 } = opts;
	const days = daysBetween(from, to, maxDays);
	const fromIdx = dayIdx(from);
	const binMinutes = BIN_MINUTES[bin];

	// Resolve selected columns → group by shard.
	const requested = opts.stations && opts.stations.length ? opts.stations : vocab.stations;
	const explicit = !!(opts.stations && opts.stations.length);
	const dropped: string[] = [];
	const colsByShard = new Map<number, number[]>(); // shard → column-within-shard (0..511)
	let selected = 0;
	for (const s of requested) {
		const g = vocab.index.get(s);
		if (g === undefined) {
			if (explicit) dropped.push(s);
			continue;
		}
		selected++;
		const shard = Math.floor(g / SHARD_STATIONS);
		const arr = colsByShard.get(shard) ?? (colsByShard.set(shard, []), colsByShard.get(shard)!);
		arr.push(g % SHARD_STATIONS);
	}
	const shards = [...colsByShard.keys()].sort((a, b) => a - b);

	const totalMinutes = days.length * MINUTES_PER_DAY;
	const nBuckets = Math.ceil(totalMinutes / binMinutes);
	const observed = new Float64Array(nBuckets);
	const acc: Record<CondPlane, Float64Array> = {
		no_bikes: new Float64Array(nBuckets),
		no_ebikes: new Float64Array(nBuckets),
		full: new Float64Array(nBuckets),
	};
	const OBS = PLANES.indexOf('observed');
	const PIDX: Record<CondPlane, number> = {
		no_bikes: PLANES.indexOf('no_bikes'),
		no_ebikes: PLANES.indexOf('no_ebikes'),
		full: PLANES.indexOf('full'),
	};

	const tasks: Array<{ day: string; dOff: number; shard: number; cols: number[] }> = [];
	days.forEach((day, di) => {
		const dOff = (dayIdx(day) - fromIdx) * MINUTES_PER_DAY;
		for (const shard of shards) tasks.push({ day, dOff, shard, cols: colsByShard.get(shard)! });
	});

	await pool(tasks, workers, async ({ day, dOff, shard, cols }) => {
		const sh = new Shard(open(shardKey(dayIdx(day), shard)), strategy);
		for (let h = 0; h < CHUNKS_PER_SHARD; h++) {
			const chunk = await sh.hour(h);
			if (!chunk) continue;
			const hourBase = dOff + h * CHUNK_MINUTES;
			for (let m = 0; m < CHUNK_MINUTES; m++) {
				const b = Math.floor((hourBase + m) / binMinutes);
				let obs = 0;
				let nb = 0;
				let ne = 0;
				let fu = 0;
				for (const c of cols) {
					obs += bitAt(chunk, OBS, m, c);
					nb += bitAt(chunk, PIDX.no_bikes, m, c);
					ne += bitAt(chunk, PIDX.no_ebikes, m, c);
					fu += bitAt(chunk, PIDX.full, m, c);
				}
				observed[b] += obs;
				acc.no_bikes[b] += nb;
				acc.no_ebikes[b] += ne;
				acc.full[b] += fu;
			}
		}
	});

	// Bucket start times + wall-clock minutes per bucket.
	const t0 = Date.parse(`${from}T00:00:00Z`) / 1000;
	const t: number[] = new Array(nBuckets);
	const minutes: number[] = new Array(nBuckets);
	for (let b = 0; b < nBuckets; b++) {
		t[b] = t0 + b * binMinutes * 60;
		minutes[b] = Math.min(binMinutes, totalMinutes - b * binMinutes);
	}

	return {
		from,
		to,
		bin,
		binMinutes,
		stations: selected,
		dropped,
		shards,
		t,
		minutes,
		observed: Array.from(observed),
		no_bikes: Array.from(acc.no_bikes),
		no_ebikes: Array.from(acc.no_ebikes),
		full: Array.from(acc.full),
	};
}
