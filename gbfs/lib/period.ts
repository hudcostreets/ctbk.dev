/**
 * Period encoding / decoding for grid shard keys.
 *
 *   `avail/agg=<A>/cons=<C>/dt=<period>.parquet`
 *
 * The period segment encodes the bucket-start in a cons-specific format
 * (see specs/avail-grid.md). This module converts between bucket-start
 * (in minutes since unix epoch) and the period string.
 *
 * Calendar levels (1mo, 2mo, 3mo, 1y, 3y) require a UTC date with
 * variable bucket sizes; these are deferred to a follow-up implementation.
 * v1 covers integer-minute cons sizes only.
 *
 * 1w uses ISO 8601 week format (`YYYY-W##`) — fixed 7-day buckets, but
 * the period encoding is calendar-aware (Mondays at 00:00 UTC).
 */

export interface PeriodSpec {
    /** Format `bucketStartMin` as the period segment for this cons. */
    format(bucketStartMin: number): string;
    /** Parse a period segment back to `bucketStartMin` for this cons. */
    parse(period: string): number;
    /** Round any minute down to the start of its bucket at this cons size. */
    align(min: number): number;
}

function pad2(n: number): string { return n.toString().padStart(2, '0'); }
function pad4(n: number): string { return n.toString().padStart(4, '0'); }

/** Sub-day periods: `YYYY-MM-DD_HHMM`. */
const SUB_DAY: PeriodSpec = {
    format(min: number): string {
        const d = new Date(min * 60_000);
        return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}_${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
    },
    parse(period: string): number {
        const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/.exec(period);
        if (!m) throw new Error(`bad sub-day period: ${period}`);
        return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60_000);
    },
    align(min: number): number { return min; }, // overridden per-cons below
};

/** Hour-aligned periods (1h, 3h, 8h): `YYYY-MM-DD_HH`. */
function hourAligned(bucketHours: number): PeriodSpec {
    return {
        format(min: number): string {
            const d = new Date(min * 60_000);
            return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}_${pad2(d.getUTCHours())}`;
        },
        parse(period: string): number {
            const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})$/.exec(period);
            if (!m) throw new Error(`bad hour period: ${period}`);
            return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) / 60_000);
        },
        align(min: number): number {
            const stride = bucketHours * 60;
            return min - (min % stride);
        },
    };
}

/** Day-aligned periods (1d, 3d): `YYYY-MM-DD`. */
function dayAligned(bucketDays: number): PeriodSpec {
    return {
        format(min: number): string {
            const d = new Date(min * 60_000);
            return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
        },
        parse(period: string): number {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
            if (!m) throw new Error(`bad day period: ${period}`);
            return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 60_000);
        },
        align(min: number): number {
            const stride = bucketDays * 1440;
            // For 3d-aligned buckets: anchor at the unix epoch (1970-01-01),
            // which is a Thursday — fine; the alignment is what matters,
            // not which day-of-week a bucket happens to start on.
            return min - (min % stride);
        },
    };
}

/** ISO-8601 week (1w): `YYYY-Www`. ISO weeks are Monday-anchored; week 01
 *  contains the first Thursday of the year (equivalently, contains Jan 4). */
const ISO_WEEK: PeriodSpec = {
    format(min: number): string {
        const d = new Date(min * 60_000);
        // Canonical ISO-week algorithm:
        // 1. Take the Thursday of this week (ISO week-year follows Thursday).
        // 2. weekNum = ceil(((thursday - jan1_of_thursday_year) / 86400 + 1) / 7).
        const dayNum = d.getUTCDay() || 7; // Sun=0 → 7; Mon=1..Sat=6
        const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        thu.setUTCDate(thu.getUTCDate() + 4 - dayNum);
        const yearStart = Date.UTC(thu.getUTCFullYear(), 0, 1);
        const week = Math.ceil(((thu.getTime() - yearStart) / 86_400_000 + 1) / 7);
        return `${pad4(thu.getUTCFullYear())}-W${pad2(week)}`;
    },
    parse(period: string): number {
        const m = /^(\d{4})-W(\d{2})$/.exec(period);
        if (!m) throw new Error(`bad ISO week period: ${period}`);
        const year = +m[1];
        const week = +m[2];
        // Jan 4 is always in week 1. Find Monday of week 1, then add (week-1)*7 days.
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const jan4Dow = jan4.getUTCDay() || 7;
        const monday = new Date(jan4);
        monday.setUTCDate(jan4.getUTCDate() + 1 - jan4Dow + (week - 1) * 7);
        return Math.floor(monday.getTime() / 60_000);
    },
    align(min: number): number {
        // Monday 00:00 UTC of the ISO week containing this minute.
        const d = new Date(min * 60_000);
        const dayNum = d.getUTCDay() || 7;
        const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        mon.setUTCDate(mon.getUTCDate() + 1 - dayNum);
        return Math.floor(mon.getTime() / 60_000);
    },
};

/** Calendar cons (1mo, 1y, 3y, ...) — variable bucket size. v1 stub. */
const CALENDAR_NOT_IMPL: PeriodSpec = {
    format() { throw new Error('calendar period encoding not implemented (1mo/1y/3y) — v1 deferred'); },
    parse() { throw new Error('calendar period encoding not implemented (1mo/1y/3y) — v1 deferred'); },
    align() { throw new Error('calendar period encoding not implemented (1mo/1y/3y) — v1 deferred'); },
};

const SPECS: Record<string, PeriodSpec> = {
    '1m':  { ...SUB_DAY, align: (min) => min },
    '5m':  { ...SUB_DAY, align: (min) => min - (min % 5) },
    '15m': { ...SUB_DAY, align: (min) => min - (min % 15) },
    '1h':  hourAligned(1),
    '3h':  hourAligned(3),
    '8h':  hourAligned(8),
    '1d':  dayAligned(1),
    '3d':  dayAligned(3),
    '5d':  dayAligned(5),
    '10d': dayAligned(10),
    '1w':  ISO_WEEK,
    '1mo': CALENDAR_NOT_IMPL,
    '2mo': CALENDAR_NOT_IMPL,
    '3mo': CALENDAR_NOT_IMPL,
    '1y':  CALENDAR_NOT_IMPL,
    '3y':  CALENDAR_NOT_IMPL,
};

export function periodFor(cons: string, bucketStartMin: number): string {
    const spec = SPECS[cons];
    if (!spec) throw new Error(`unknown cons: ${cons}`);
    return spec.format(bucketStartMin);
}

export function bucketStartMin(cons: string, period: string): number {
    const spec = SPECS[cons];
    if (!spec) throw new Error(`unknown cons: ${cons}`);
    return spec.parse(period);
}

export function alignToBucket(cons: string, min: number): number {
    const spec = SPECS[cons];
    if (!spec) throw new Error(`unknown cons: ${cons}`);
    return spec.align(min);
}

/** True if a cons name is supported by the period encoder for v1
 *  (i.e., not calendar-deferred). */
export function isSupportedCons(cons: string): boolean {
    const spec = SPECS[cons];
    if (!spec) return false;
    try { spec.format(0); return true; } catch { return false; }
}

