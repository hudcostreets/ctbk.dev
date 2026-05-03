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

/** Cons-only cascade for agg=1m. Each level is built from the next-finer
 *  cons of the same agg, keeping per-bucket input read size bounded. */
export const CONS_LEVELS_AT_1M: CascadeLevel[] = [
	{ cons: '5m',  bucketMin: 5,  fromCons: '1m', fromCount: 5 },
	{ cons: '15m', bucketMin: 15, fromCons: '5m', fromCount: 3 },
	{ cons: '1h',  bucketMin: 60, fromCons: '15m', fromCount: 4 },
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
		case '1m': case '5m': case '15m': return `${date}/${HH}${MM}`;
		case '1h':                        return `${date}/${HH}`;
		case '1d':                        return date;
		default: throw new Error(`unsupported cons period encoding: ${cons}`);
	}
}

/** R2 key for an avail shard. */
export function consKey(agg: string, cons: string, bucketStartMin: number): string {
	return `avail/agg=${agg}/cons=${cons}/${consPeriod(cons, bucketStartMin)}.parquet`;
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
