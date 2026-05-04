/**
 * Grid spec types + validator. See specs/avail-grid.md and gbfs/grid.yaml.
 *
 * The grid is two related tables:
 *   - `agg_self`: monoid-merged single-row-per-station shards at each
 *     agg level (5m@5m, 15m@15m, 1h@1h, 1d@1d).
 *   - `cons[<agg>]`: cons-only roll-ups within an agg series — each
 *     level concatenates `from_count` shards of the next-finer cons.
 *
 * Calendar cons (1mo, 2mo, 3mo, 1y, 3y) have approximate `bucket_min`
 * because months/years aren't uniform. Period encoding handles these
 * via the calendar (see lib/period.ts).
 *
 * This module is CFW-importable: no Node builtins, no external deps.
 * YAML loading lives in `gbfs/cli/src/loadGrid.ts`. CFW bundles the
 * grid as a TS const generated from the YAML at build time.
 */

export type Runner = 'cfw' | 'gha';

export interface AggLevel {
    agg: string;        // '5m', '15m', '1h', '1d'
    bucket_min: number; // bucket size in minutes (approx for calendar levels)
    from_agg: string;   // input agg level
    from_count: number; // number of input shards
    runner: Runner;
}

export interface ConsLevel {
    cons: string;       // '5m', '15m', '1h', '1d', '1w', '1mo', ...
    bucket_min: number; // bucket size in minutes (approx for calendar levels)
    from_cons: string;  // input cons level (next-finer in same agg series)
    from_count: number; // number of input shards
    runner: Runner;
}

export interface GridSpec {
    /** Agg-self levels (one row per station per bucket). */
    agg_self: AggLevel[];
    /** Cons-only levels per agg series. Map key is the agg name. */
    cons: Record<string, ConsLevel[]>;
}

/** Cons names whose bucket size doesn't uniformly map to minutes
 *  (calendar-aware). Validation skips the bucket_min check for these. */
const CALENDAR_CONS = new Set(['1mo', '2mo', '3mo', '1y', '3y']);

export function validateGrid(grid: GridSpec): GridSpec {
    if (!grid.agg_self || !Array.isArray(grid.agg_self)) {
        throw new Error('grid: missing or non-array `agg_self`');
    }
    if (!grid.cons || typeof grid.cons !== 'object') {
        throw new Error('grid: missing or non-object `cons`');
    }

    // agg_self chain. The first level (e.g. 5m@5m) is built from one
    // cons shard at the previous agg whose own size == output bucket
    // (e.g. 1m@5m), so the prev×from_count math doesn't apply — we
    // only check from_agg matches expectations and from_count==1.
    // Subsequent levels chain off the previous agg-self normally.
    let prevAgg: AggLevel | null = null;
    for (const [i, level] of grid.agg_self.entries()) {
        if (!level.agg || !level.from_agg || !level.bucket_min || !level.from_count) {
            throw new Error(`grid.agg_self: malformed level ${JSON.stringify(level)}`);
        }
        if (prevAgg && level.from_agg !== prevAgg.agg) {
            throw new Error(`grid.agg_self: ${level.agg} reads from ${level.from_agg} but previous level was ${prevAgg.agg}`);
        }
        if (i === 0) {
            if (level.from_count !== 1) {
                throw new Error(`grid.agg_self ${level.agg} (first level): from_count=${level.from_count} but should be 1 (single cons shard at ${level.from_agg}@${level.agg})`);
            }
        } else if (!CALENDAR_CONS.has(level.agg)) {
            const expected = level.from_count * prevAgg!.bucket_min;
            if (level.bucket_min !== expected) {
                throw new Error(`grid.agg_self ${level.agg}: bucket_min=${level.bucket_min} but from_count(${level.from_count}) × prev.bucket_min(${prevAgg!.bucket_min}) = ${expected}`);
            }
        }
        prevAgg = level;
    }

    // cons: each level's `from_cons` must resolve to either the agg name
    // (for the chain root) or a prior cons in the chain. `bucket_min`
    // must equal `from_count × from_cons.bucket_min` for non-calendar
    // levels. Note: from_cons is *not* required to be the immediate
    // previous cons — when a SUF doesn't divide cleanly (e.g. 8h from 3h
    // is non-integer), levels skip back to a divisible ancestor.
    for (const [agg, levels] of Object.entries(grid.cons)) {
        const aggBucketMin = parseAggBucketMin(agg);
        const ancestorBucketMin = new Map<string, number>([[agg, aggBucketMin]]);
        for (const level of levels) {
            if (!level.cons || !level.from_cons || !level.bucket_min || !level.from_count) {
                throw new Error(`grid.cons[${agg}]: malformed level ${JSON.stringify(level)}`);
            }
            const fromBucketMin = ancestorBucketMin.get(level.from_cons);
            if (fromBucketMin === undefined) {
                throw new Error(`grid.cons[${agg}] ${level.cons}: from_cons=${level.from_cons} not found in chain (must be the agg name or a prior cons)`);
            }
            if (!CALENDAR_CONS.has(level.cons) && !CALENDAR_CONS.has(level.from_cons)) {
                const expected = level.from_count * fromBucketMin;
                if (level.bucket_min !== expected) {
                    throw new Error(`grid.cons[${agg}] ${level.cons}: bucket_min=${level.bucket_min} but from_count(${level.from_count}) × ${level.from_cons}.bucket_min(${fromBucketMin}) = ${expected}`);
                }
            }
            ancestorBucketMin.set(level.cons, level.bucket_min);
        }
    }

    return grid;
}

/** Convert an agg name (e.g. '1m', '5m', '1h', '1d') to its bucket-min size. */
export function parseAggBucketMin(agg: string): number {
    const m = /^(\d+)(m|h|d)$/.exec(agg);
    if (!m) throw new Error(`unknown agg name: ${agg}`);
    const n = parseInt(m[1], 10);
    switch (m[2]) {
        case 'm': return n;
        case 'h': return n * 60;
        case 'd': return n * 60 * 24;
        default: throw new Error(`unknown agg name: ${agg}`);
    }
}
