/**
 * `ensureCell` — the unified cascade driver.
 *
 * Replaces the bespoke `attemptCons` / `attemptAgg` from the legacy
 * `gbfs/cascade/`. Same logic, generalized over the full grid (any agg,
 * any cons) and any `ShardStore` backend.
 *
 * Inputs are derived from the grid spec's `from_cons` / `from_agg` +
 * `from_count` fields. The output is a single parquet shard at the cell's
 * R2 key. Idempotent: re-runs are no-ops when the output already exists,
 * and produce byte-identical bytes on re-build (deterministic merge +
 * fixed parquet config).
 *
 * See specs/avail-grid.md.
 */

import type { GridSpec } from './grid.js';
import { periodFor, bucketStartMin } from './period.js';
import type { ShardStore } from './store.js';
import { aggMergeRows, rowsToCols } from './cascade.js';
import { AVAIL_1M_ROW_GROUP_SIZE, type ColumnSource } from './avail-monoid.js';

/** Parquet I/O is injected so this module stays free of `hyparquet*`
 *  bare imports — those deps live in each consumer's package.json
 *  (gbfs/cli/, gbfs/cascade/, gbfs/loader/). The CLI and the CFW
 *  workers each construct a `ParquetIO` from their installed copies. */
export interface ParquetIO {
    read(buf: ArrayBuffer): Promise<Record<string, unknown>[]>;
    write(cols: ColumnSource[], rowGroupSize: number): Uint8Array;
}

export type EnsureStatus =
    | 'wrote'
    | 'exists'
    | 'barrier_missing'  // last input shard not yet present
    | 'no_inputs'        // none of the input shards exist (loader gap)
    | 'empty';           // inputs read but produced 0 rows

export interface EnsureResult {
    status: EnsureStatus;
    bytes?: number;
    rows?: number;
    inputs?: number;
    /** Cells the driver attempted to read inputs from. Populated even on
     *  short-circuit returns so callers can inspect what the driver tried. */
    inputKeys?: string[];
    /** The output cell's R2 key (always set). */
    outputKey: string;
}

export interface EnsureOpts {
    dryRun?: boolean;
}

/** Build the R2 key for a (agg, cons, period) cell. */
export function cellKey(agg: string, cons: string, period: string): string {
    return `avail/agg=${agg}/cons=${cons}/dt=${period}.parquet`;
}

/** Resolve input cell keys for one (agg, cons, period) cell, using the
 *  grid spec to find the cons-only or agg-self build relation.
 *
 *  - Cons-only (cons != agg): inputs are `from_count` shards of agg's
 *    `from_cons` level, evenly striding across the bucket window.
 *  - Agg-self (cons == agg): inputs are `from_count` shards of
 *    `from_agg`@`from_cons` (the previous agg's cons matching this agg's
 *    bucket size). For the first agg-self level (e.g. 5m@5m), from_count=1
 *    and the input is a single 1m@5m cons shard.
 */
export function inputCellsFor(
    grid: GridSpec,
    agg: string,
    cons: string,
    period: string,
): { keys: string[]; level: { from: string; from_cons?: string; from_count: number; bucket_min: number } } {
    if (agg === cons) {
        // Agg-self.
        const level = grid.agg_self.find((l) => l.agg === agg);
        if (!level) throw new Error(`no agg_self level for agg=${agg}`);
        const bs = bucketStartMin(cons, period);
        const stride = level.bucket_min / level.from_count;
        if (!Number.isInteger(stride)) {
            throw new Error(`agg_self ${agg}: bucket_min ${level.bucket_min} not divisible by from_count ${level.from_count}`);
        }
        // Each input is a `from_agg`@`agg`-sized cons shard. For first
        // level (5m@5m), from_count=1 and we read one 1m@5m. For 15m@15m,
        // from_count=3 and we read three 5m@5m at 5-min stride.
        const fromCons = level.from_count === 1 ? agg : level.from_agg; // 5m@5m: input is 1m@5m; 15m@15m: input is 5m@5m (cons name same as agg name for higher agg-selfs)
        const fromAgg = level.from_agg;
        const keys = Array.from({ length: level.from_count }, (_, i) =>
            cellKey(fromAgg, fromCons, periodFor(fromCons, bs + i * stride)),
        );
        return { keys, level: { from: fromAgg, from_cons: fromCons, from_count: level.from_count, bucket_min: level.bucket_min } };
    }
    // Cons-only.
    const aggChain = grid.cons[agg];
    if (!aggChain) throw new Error(`no cons chain for agg=${agg}`);
    const level = aggChain.find((l) => l.cons === cons);
    if (!level) throw new Error(`no cons=${cons} level in agg=${agg} chain`);
    const bs = bucketStartMin(cons, period);
    const stride = level.bucket_min / level.from_count;
    if (!Number.isInteger(stride)) {
        throw new Error(`cons ${agg}@${cons}: bucket_min ${level.bucket_min} not divisible by from_count ${level.from_count}`);
    }
    const keys = Array.from({ length: level.from_count }, (_, i) =>
        cellKey(agg, level.from_cons, periodFor(level.from_cons, bs + i * stride)),
    );
    return { keys, level: { from: agg, from_cons: level.from_cons, from_count: level.from_count, bucket_min: level.bucket_min } };
}

async function readShardRows(
    store: ShardStore,
    parquet: ParquetIO,
    keys: string[],
): Promise<{ rows: Record<string, unknown>[]; present: number }> {
    const buffers = await Promise.all(keys.map((k) => store.get(k)));
    const present = buffers.filter((b): b is ArrayBuffer => b !== null);
    if (present.length === 0) return { rows: [], present: 0 };
    const rows: Record<string, unknown>[] = [];
    for (const buf of present) {
        const fileRows = await parquet.read(buf);
        rows.push(...fileRows);
    }
    return { rows, present: present.length };
}

/** Ensure a single (agg, cons, period) cell exists. */
export async function ensureCell(
    store: ShardStore,
    parquet: ParquetIO,
    grid: GridSpec,
    agg: string,
    cons: string,
    period: string,
    opts: EnsureOpts = {},
): Promise<EnsureResult> {
    const outputKey = cellKey(agg, cons, period);
    if (await store.head(outputKey)) {
        return { status: 'exists', outputKey };
    }
    const { keys: inputKeys } = inputCellsFor(grid, agg, cons, period);

    // Barrier: the LAST input must exist. Same semantic as the legacy
    // cascade — the last input being present implies the earlier ones
    // had time to land too.
    const lastInputHead = await store.head(inputKeys[inputKeys.length - 1]);
    if (!lastInputHead) {
        return { status: 'barrier_missing', outputKey, inputKeys };
    }

    const { rows, present } = await readShardRows(store, parquet, inputKeys);
    if (present === 0) {
        return { status: 'no_inputs', outputKey, inputKeys };
    }

    const cols = agg === cons
        ? aggMergeRows(rows, bucketStartMin(cons, period))
        : rowsToCols(rows);
    if (cols[0].data.length === 0) {
        return { status: 'empty', outputKey, inputKeys };
    }

    if (opts.dryRun) {
        return { status: 'wrote', outputKey, inputKeys, rows: cols[0].data.length, inputs: present };
    }

    const out = parquet.write(cols, AVAIL_1M_ROW_GROUP_SIZE);
    await store.put(outputKey, out);
    return {
        status: 'wrote',
        outputKey,
        inputKeys,
        bytes: out.byteLength,
        rows: cols[0].data.length,
        inputs: present,
    };
}
