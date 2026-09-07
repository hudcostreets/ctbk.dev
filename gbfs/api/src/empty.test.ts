import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	addDays,
	CHUNK_MINUTES,
	CHUNKS_PER_SHARD,
	daysBetween,
	dayIdx,
	INDEX_LEN,
	makeVocab,
	PLANES,
	readSeries,
	SHARD_BYTES,
	shardKey,
	type OpenShard,
	type Plane,
	type ShardBytes,
} from './empty';

// ─── Fixture: build one shard object in the Zarr v3 sharding format ───────────
// Concatenated gzip'd hourly inner chunks `(4, 60, 64)` (plane-major), then a
// trailing index of (offset, nbytes) u64 LE per hour + a 4-byte crc32c (ignored
// on read, so left zero here). Matches `ctbk/gbfs_empty.py`'s writer.

interface Bit {
	plane: Plane;
	minute: number; // 0..1439
	col: number; // 0..511
}

function buildShard(bits: Bit[]): Uint8Array {
	const byHour = new Map<number, Uint8Array>();
	for (const { plane, minute, col } of bits) {
		const h = Math.floor(minute / CHUNK_MINUTES);
		const m = minute % CHUNK_MINUTES;
		const chunk = byHour.get(h) ?? byHour.set(h, new Uint8Array(4 * CHUNK_MINUTES * SHARD_BYTES)).get(h)!;
		const p = PLANES.indexOf(plane);
		chunk[p * CHUNK_MINUTES * SHARD_BYTES + m * SHARD_BYTES + (col >> 3)] |= 1 << (7 - (col & 7));
	}
	const parts: Uint8Array[] = [];
	const index = new DataView(new ArrayBuffer(INDEX_LEN));
	let off = 0;
	for (let h = 0; h < CHUNKS_PER_SHARD; h++) {
		const raw = byHour.get(h);
		if (!raw) {
			index.setBigUint64(h * 16, (1n << 64n) - 1n, true); // empty-chunk sentinel
			index.setBigUint64(h * 16 + 8, (1n << 64n) - 1n, true);
			continue;
		}
		const gz = new Uint8Array(gzipSync(raw));
		parts.push(gz);
		index.setBigUint64(h * 16, BigInt(off), true);
		index.setBigUint64(h * 16 + 8, BigInt(gz.length), true);
		off += gz.length;
	}
	const body = new Uint8Array(off);
	let p = 0;
	for (const part of parts) {
		body.set(part, p);
		p += part.length;
	}
	const out = new Uint8Array(off + INDEX_LEN);
	out.set(body, 0);
	out.set(new Uint8Array(index.buffer), off);
	return out;
}

function memStore(objects: Record<string, Uint8Array>): OpenShard {
	return (key: string): ShardBytes => {
		const buf = objects[key] ?? null;
		return {
			async tail(n) {
				return buf ? buf.subarray(buf.length - n) : null;
			},
			async range(o, n) {
				return buf!.subarray(o, o + n);
			},
			async whole() {
				return buf;
			},
		};
	};
}

describe('daysBetween / dayIdx', () => {
	it('day index counts UTC days since 2026-04-01', () => {
		expect(dayIdx('2026-04-01')).toBe(0);
		expect(dayIdx('2026-04-10')).toBe(9);
		expect(dayIdx('2026-05-01')).toBe(30);
	});
	it('daysBetween is inclusive and bounded', () => {
		expect(daysBetween('2026-04-10', '2026-04-12', 1500)).toEqual(['2026-04-10', '2026-04-11', '2026-04-12']);
		expect(() => daysBetween('2026-04-10', '2026-04-09', 1500)).toThrow('from > to');
		expect(() => daysBetween('2026-04-10', '2026-05-01', 5)).toThrow('range too large');
	});
});

describe('readSeries', () => {
	const vocab = makeVocab(['a', 'b', 'c']); // cols 0, 1, 2 in shard 0
	const day = '2026-04-10';
	// observed for all three at minutes 0, 30, 60; a empty@0, b empty@30, c full@60.
	const shard = buildShard([
		{ plane: 'observed', minute: 0, col: 0 },
		{ plane: 'observed', minute: 0, col: 1 },
		{ plane: 'observed', minute: 0, col: 2 },
		{ plane: 'observed', minute: 30, col: 0 },
		{ plane: 'observed', minute: 30, col: 1 },
		{ plane: 'observed', minute: 30, col: 2 },
		{ plane: 'observed', minute: 60, col: 0 },
		{ plane: 'observed', minute: 60, col: 1 },
		{ plane: 'observed', minute: 60, col: 2 },
		{ plane: 'no_bikes', minute: 0, col: 0 },
		{ plane: 'no_bikes', minute: 30, col: 1 },
		{ plane: 'full', minute: 60, col: 2 },
	]);
	const open = memStore({ [shardKey(dayIdx(day), 0)]: shard });

	it('counts station-minutes per hour bucket for the full selection', async () => {
		const r = await readSeries(open, vocab, { from: day, to: day, bin: 'hour', stations: ['a', 'b', 'c'] });
		expect(r.stations).toBe(3);
		expect(r.dropped).toEqual([]);
		expect(r.shards).toEqual([0]);
		expect(r.t.length).toBe(24);
		expect(r.observed[0]).toBe(6); // 3@min0 + 3@min30
		expect(r.observed[1]).toBe(3); // 3@min60
		expect(r.observed.slice(2).every((x) => x === 0)).toBe(true);
		expect(r.no_bikes[0]).toBe(2); // a@0 + b@30
		expect(r.no_bikes[1]).toBe(0);
		expect(r.full[0]).toBe(0);
		expect(r.full[1]).toBe(1); // c@60
		expect(r.no_ebikes.every((x) => x === 0)).toBe(true);
	});

	it('minute bin resolves each event to its minute', async () => {
		const r = await readSeries(open, vocab, { from: day, to: day, bin: 'minute' });
		expect(r.t.length).toBe(1440);
		expect(r.observed[0]).toBe(3);
		expect(r.observed[30]).toBe(3);
		expect(r.observed[60]).toBe(3);
		expect(r.no_bikes[0]).toBe(1);
		expect(r.no_bikes[30]).toBe(1);
		expect(r.full[60]).toBe(1);
		expect(r.t[0]).toBe(Date.parse('2026-04-10T00:00:00Z') / 1000);
		expect(r.t[1]).toBe(Date.parse('2026-04-10T00:01:00Z') / 1000);
	});

	it('day bin totals the whole day', async () => {
		const r = await readSeries(open, vocab, { from: day, to: day, bin: 'day' });
		expect(r.t).toEqual([Date.parse('2026-04-10T00:00:00Z') / 1000]);
		expect(r.minutes).toEqual([1440]);
		expect(r.observed).toEqual([9]);
		expect(r.no_bikes).toEqual([2]);
		expect(r.no_ebikes).toEqual([0]);
		expect(r.full).toEqual([1]);
	});

	it('all-stations (no selection) equals the full explicit selection', async () => {
		const r = await readSeries(open, vocab, { from: day, to: day, bin: 'day' });
		expect(r.stations).toBe(3);
		expect(r.observed).toEqual([9]);
	});

	it('a single station reads only its column', async () => {
		const r = await readSeries(open, vocab, { from: day, to: day, bin: 'day', stations: ['a'] });
		expect(r.stations).toBe(1);
		expect(r.observed).toEqual([3]); // a observed @ 0, 30, 60
		expect(r.no_bikes).toEqual([1]); // a empty @ 0
		expect(r.full).toEqual([0]);
	});

	it('reports unknown requested stations as dropped', async () => {
		const r = await readSeries(open, vocab, { from: day, to: day, bin: 'day', stations: ['a', 'zzz'] });
		expect(r.stations).toBe(1);
		expect(r.dropped).toEqual(['zzz']);
		expect(r.observed).toEqual([3]);
	});

	it('treats an absent day/shard object as all-zero (no data)', async () => {
		const empty = addDays(day, 1); // 2026-04-11, no object
		const r = await readSeries(open, vocab, { from: empty, to: empty, bin: 'day' });
		expect(r.observed).toEqual([0]);
		expect(r.no_bikes).toEqual([0]);
		expect(r.full).toEqual([0]);
	});

	it('range strategy matches whole strategy', async () => {
		const w = await readSeries(open, vocab, { from: day, to: day, bin: 'hour', strategy: 'whole' });
		const rg = await readSeries(open, vocab, { from: day, to: day, bin: 'hour', strategy: 'range' });
		expect(rg.observed).toEqual(w.observed);
		expect(rg.no_bikes).toEqual(w.no_bikes);
		expect(rg.full).toEqual(w.full);
	});
});
