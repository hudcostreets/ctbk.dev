/**
 * Cascade compactor helpers — key derivation, timing math, and column
 * concat for the avail-perf-pass multi-scale grid.
 *
 * Each cons level rolls up the next-finer cons of the same agg level
 * by simple row-concatenation (since agg=1m means rows are already at
 * 1-minute granularity; concatenation is the monoid for the cons axis).
 *
 * See specs/avail-perf-pass.md.
 */

import { AVAIL_METRICS, type ColumnSource } from './avail-monoid';

export interface CascadeLevel {
	cons: string;     // '5m', '15m', '1h', ...
	bucketMin: number; // size of bucket in minutes
	fromCons: string;  // input cons level (next-finer)
	fromCount: number; // number of input shards per bucket
}

/** Cons-only cascade levels for each agg, in finest-to-coarsest order.
 *  Each level is built from `fromCount` shards of the next-finer cons
 *  in the same agg series, keeping per-bucket input read size bounded.
 *
 *  Skipping 1w/1mo/3mo/1y for v1 — those have variable bucket sizes
 *  (months) or different period encodings (ISO week) that need separate
 *  period helpers. Add later when the planner needs them.
 *
 *  Build relations (per agg):
 *    1m → 5m → 15m → 1h
 *    5m → 15m → 1h → 3h, 8h → 1d
 *    15m → 1h → 3h, 8h → 1d
 *    1h → 1d
 *
 *  agg=1m caps at 1h: a 3h@1m would be ~433K rows / ~30MB read-and-sort
 *  in CFW heap, which 1101s (memory exceeded). Coarse-window queries
 *  (>1h) should use agg=5m or coarser anyway — that's the point of the
 *  multi-scale grid.
 *
 *  8h doesn't divide cleanly from 3h (8/3 not integer); both 8h and 1d
 *  reach back to 1h. 1d is reached via 8h (3 × 8h = 1d) for fewer
 *  inputs than 24 × 1h. */
export const CONS_LEVELS_BY_AGG: Record<string, CascadeLevel[]> = {
	'1m': [
		{ cons: '5m',  bucketMin: 5,    fromCons: '1m',  fromCount: 5  },
		{ cons: '15m', bucketMin: 15,   fromCons: '5m',  fromCount: 3  },
		{ cons: '1h',  bucketMin: 60,   fromCons: '15m', fromCount: 4  },
	],
	'5m': [
		{ cons: '15m', bucketMin: 15,   fromCons: '5m',  fromCount: 3  },
		{ cons: '1h',  bucketMin: 60,   fromCons: '15m', fromCount: 4  },
		{ cons: '3h',  bucketMin: 180,  fromCons: '1h',  fromCount: 3  },
		{ cons: '8h',  bucketMin: 480,  fromCons: '1h',  fromCount: 8  },
		{ cons: '1d',  bucketMin: 1440, fromCons: '8h',  fromCount: 3  },
	],
	'15m': [
		{ cons: '1h',  bucketMin: 60,   fromCons: '15m', fromCount: 4  },
		{ cons: '3h',  bucketMin: 180,  fromCons: '1h',  fromCount: 3  },
		{ cons: '8h',  bucketMin: 480,  fromCons: '1h',  fromCount: 8  },
		{ cons: '1d',  bucketMin: 1440, fromCons: '8h',  fromCount: 3  },
	],
	'1h': [
		{ cons: '1d',  bucketMin: 1440, fromCons: '1h',  fromCount: 24 },
	],
};

/** @deprecated use CONS_LEVELS_BY_AGG['1m'] */
export const CONS_LEVELS_AT_1M = CONS_LEVELS_BY_AGG['1m'];

/** Agg-self cascade: the {agg}@{agg} shard at each level is one row per
 *  station per bucket, monoid-merged from the next-finer agg's outputs.
 *  Each row's `n`/`sum`/`sum_sq` is the sum of the input rows for that
 *  station, so a query at bin=B picks agg=B and decodes 2407 rows per
 *  bucket — vs. agg=1m at the same B which would decode B/1m × 2407.
 *
 *  Build relations:
 *    5m@5m  ← 1 × 5m@1m  (5 rows/station → 1 row/station, sum across)
 *    15m@15m ← 3 × 5m@5m
 *    1h@1h  ← 4 × 15m@15m
 *    1d@1d  ← 24 × 1h@1h
 *  All inputs are small (<10MB total decompressed) so each level fits
 *  comfortably in CFW heap. */
export interface AggLevel {
	agg: string;        // '5m', '15m', '1h', '1d'
	bucketMin: number;  // bucket size in minutes
	fromAgg: string;    // input agg level
	fromCons: string;   // input cons level
	fromCount: number;  // number of input shards
}

export const AGG_LEVELS: AggLevel[] = [
	{ agg: '5m',  bucketMin: 5,    fromAgg: '1m',  fromCons: '5m',  fromCount: 1  },
	{ agg: '15m', bucketMin: 15,   fromAgg: '5m',  fromCons: '5m',  fromCount: 3  },
	{ agg: '1h',  bucketMin: 60,   fromAgg: '15m', fromCons: '15m', fromCount: 4  },
	{ agg: '1d',  bucketMin: 1440, fromAgg: '1h',  fromCons: '1h',  fromCount: 24 },
];

function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

/** Format a minute-bucket-start as the period segment of a cascade key.
 *  Period encoding from specs/avail-perf-pass.md § "R2 key layout":
 *    1m, 5m, 15m → <date>/<HHMM>
 *    1h          → <date>/<HH>
 *    1d          → <date>
 *  (1w/1mo/etc. defer to a later phase.) */
export function consPeriod(cons: string, bucketStartMin: number): string {
	const d = new Date(bucketStartMin * 60 * 1000);
	const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
	const HH = pad2(d.getUTCHours());
	const MM = pad2(d.getUTCMinutes());
	switch (cons) {
		case '1m': case '5m': case '15m':       return `${date}/${HH}${MM}`;
		case '1h': case '3h':  case '8h':       return `${date}/${HH}`;
		case '1d':                              return date;
		default: throw new Error(`unsupported cons period encoding: ${cons}`);
	}
}

/** R2 key for an avail shard. */
export function consKey(agg: string, cons: string, bucketStartMin: number): string {
	return `avail/agg=${agg}/cons=${cons}/${consPeriod(cons, bucketStartMin)}.parquet`;
}

/** Same shard, prefixed with `gbfs/`. Target of the r2-layout migration
 *  (`specs/r2-layout.md`). During the dual-write window writers `put`
 *  to BOTH `consKey(...)` and `gbfsKey(consKey(...))`; readers stay on
 *  the old key until cut over. */
export function gbfsKey(oldKey: string): string {
	return `gbfs/${oldKey}`;
}

/** At cascade tick T (wall-clock minute), return the bucket-start for
 *  the cons level whose bucket is "safe to cons now" — i.e., its barrier
 *  (1m@1m at the bucket's exclusive-end minute) is reliably present.
 *  Returns null if no boundary for this level qualifies at this tick.
 *
 *  Why the shift: the cron worker writes JSON at minute X:00, the loader
 *  reads + writes 1m@1m by ~X:00.5s. Cron tick at X:00:00 races with the
 *  loader for minute X — the 1m@1m for minute X is NOT yet present at
 *  the cron tick that fires at X:00. Wait one full minute: by tick X+1,
 *  1m@1m for minute X is reliably present.
 *
 *  Concretely, at cascade tick T we trust 1m@1m up to minute T-1 (i.e.,
 *  the loader had >= 1 minute since the writer fired). The latest
 *  bucket whose barrier we trust ends at minute T-1. So bucket
 *  [T-1-B, T-1) is the candidate; check bucketMin alignment on T-1. */
export function bucketJustClosed(level: CascadeLevel, tickMin: number): number | null {
	const bucketEnd = tickMin - 1;        // last reliably-present 1m@1m minute
	if (bucketEnd < level.bucketMin) return null;
	if (bucketEnd % level.bucketMin !== 0) return null;
	return bucketEnd - level.bucketMin;
}

/** All per-bucket input keys for a cons attempt, in chronological order. */
export function inputKeysForBucket(
	agg: string,
	level: CascadeLevel,
	bucketStartMin: number,
): string[] {
	const stride = level.bucketMin / level.fromCount;
	if (!Number.isInteger(stride)) {
		throw new Error(`bucketMin ${level.bucketMin} not divisible by fromCount ${level.fromCount}`);
	}
	return Array.from({ length: level.fromCount }, (_, i) =>
		consKey(agg, level.fromCons, bucketStartMin + i * stride),
	);
}

/** Same as `bucketJustClosed` but for an `AggLevel` (the alignment math
 *  is identical; both share the 1-minute slack convention). */
export function aggBucketJustClosed(level: AggLevel, tickMin: number): number | null {
	const bucketEnd = tickMin - 1;
	if (bucketEnd < level.bucketMin) return null;
	if (bucketEnd % level.bucketMin !== 0) return null;
	return bucketEnd - level.bucketMin;
}

/** Per-bucket input keys for an agg-self attempt. */
export function aggInputKeysForBucket(level: AggLevel, bucketStartMin: number): string[] {
	const stride = level.bucketMin / level.fromCount;
	if (!Number.isInteger(stride)) {
		throw new Error(`bucketMin ${level.bucketMin} not divisible by fromCount ${level.fromCount}`);
	}
	return Array.from({ length: level.fromCount }, (_, i) =>
		consKey(level.fromAgg, level.fromCons, bucketStartMin + i * stride),
	);
}

/** Monoid-merge rows for an agg-self bucket: group by station_id, sum
 *  n/sum/sum_sq across all rows for each station, output 1 row per
 *  station with dt=bucketStartSec. Rows from the input shards may have
 *  any agg level — we just sum their sketch fields. */
export function aggMergeRows(
	rows: Record<string, unknown>[],
	bucketStartMin: number,
): ColumnSource[] {
	const dt = BigInt(bucketStartMin * 60);
	interface Acc { n: number[]; sum: number[]; sum_sq: number[] }
	const byStation = new Map<string, Record<string, { n: number; sum: number; sum_sq: number }>>();
	for (const r of rows) {
		const sid = r.station_id as string;
		let acc = byStation.get(sid);
		if (!acc) {
			acc = {};
			for (const m of AVAIL_METRICS) acc[m.name] = { n: 0, sum: 0, sum_sq: 0 };
			byStation.set(sid, acc);
		}
		for (const m of AVAIL_METRICS) {
			acc[m.name].n      += (r[`${m.name}_n`]      as number) ?? 0;
			acc[m.name].sum    += (r[`${m.name}_sum`]    as number) ?? 0;
			acc[m.name].sum_sq += (r[`${m.name}_sum_sq`] as number) ?? 0;
		}
	}
	const stationIds = [...byStation.keys()].sort();
	const n = stationIds.length;
	const dts = new Array<bigint>(n).fill(dt);
	const perMetric: Record<string, Acc> = {};
	for (const m of AVAIL_METRICS) {
		perMetric[m.name] = { n: new Array(n), sum: new Array(n), sum_sq: new Array(n) };
	}
	for (let i = 0; i < n; i++) {
		const sid = stationIds[i];
		const acc = byStation.get(sid)!;
		for (const m of AVAIL_METRICS) {
			perMetric[m.name].n[i]      = acc[m.name].n;
			perMetric[m.name].sum[i]    = acc[m.name].sum;
			perMetric[m.name].sum_sq[i] = acc[m.name].sum_sq;
		}
	}
	const cols: ColumnSource[] = [
		{ name: 'station_id', data: stationIds, type: 'STRING' },
		{ name: 'dt',         data: dts,        type: 'INT64'  },
	];
	for (const m of AVAIL_METRICS) {
		cols.push({ name: `${m.name}_n`,      data: perMetric[m.name].n,      type: 'INT32'  });
		cols.push({ name: `${m.name}_sum`,    data: perMetric[m.name].sum,    type: 'DOUBLE' });
		cols.push({ name: `${m.name}_sum_sq`, data: perMetric[m.name].sum_sq, type: 'DOUBLE' });
	}
	return cols;
}

/** Concatenate per-shard rows (objects from `parquetReadObjects`) into a
 *  single sorted column-set. Sort is by (station_id ASC, dt ASC) so that
 *  parquet's row-group min/max stats on station_id remain useful for
 *  pruning. Empty rows array → empty cols. */
export function rowsToCols(rows: Record<string, unknown>[]): ColumnSource[] {
	rows.sort((a, b) => {
		const sa = a.station_id as string;
		const sb = b.station_id as string;
		if (sa < sb) return -1;
		if (sa > sb) return 1;
		const da = a.dt as bigint;
		const db = b.dt as bigint;
		return da < db ? -1 : da > db ? 1 : 0;
	});
	const n = rows.length;
	const stationIds = new Array<string>(n);
	const dts = new Array<bigint>(n);
	const perMetric: Record<string, { n: number[]; sum: number[]; sum_sq: number[] }> = {};
	for (const m of AVAIL_METRICS) {
		perMetric[m.name] = { n: new Array(n), sum: new Array(n), sum_sq: new Array(n) };
	}
	for (let i = 0; i < n; i++) {
		const r = rows[i];
		stationIds[i] = r.station_id as string;
		dts[i] = r.dt as bigint;
		for (const m of AVAIL_METRICS) {
			perMetric[m.name].n[i]      = (r[`${m.name}_n`]      as number) ?? 0;
			perMetric[m.name].sum[i]    = (r[`${m.name}_sum`]    as number) ?? 0;
			perMetric[m.name].sum_sq[i] = (r[`${m.name}_sum_sq`] as number) ?? 0;
		}
	}
	const cols: ColumnSource[] = [
		{ name: 'station_id', data: stationIds, type: 'STRING' },
		{ name: 'dt',         data: dts,        type: 'INT64'  },
	];
	for (const m of AVAIL_METRICS) {
		cols.push({ name: `${m.name}_n`,      data: perMetric[m.name].n,      type: 'INT32'  });
		cols.push({ name: `${m.name}_sum`,    data: perMetric[m.name].sum,    type: 'DOUBLE' });
		cols.push({ name: `${m.name}_sum_sq`, data: perMetric[m.name].sum_sq, type: 'DOUBLE' });
	}
	return cols;
}
