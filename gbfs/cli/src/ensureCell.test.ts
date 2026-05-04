import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { LocalStore } from '../../lib/storeLocal.js';
import { cellKey, ensureCell, inputCellsFor } from '../../lib/ensureCell.js';
import { buildMinuteShard } from '../../lib/avail-monoid.js';
import { loadGrid } from './loadGrid.js';
import { nodeParquetIO } from './parquetIO.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_GRID = join(here, '../../grid.yaml');

const station = (id: string, vals: Record<string, number> = {}) => ({
    station_id: id,
    num_bikes_available: 0,
    num_ebikes_available: 0,
    num_docks_available: 0,
    num_bikes_disabled: 0,
    num_docks_disabled: 0,
    is_installed: 1,
    is_renting: 1,
    is_returning: 1,
    last_reported: 1700000000,
    ...vals,
});

function build1mShard(polled_at_s: number, stations: ReturnType<typeof station>[]): Uint8Array {
    const cols = buildMinuteShard({ ts: polled_at_s, polled_at: polled_at_s, stations });
    const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize: 600 });
    return new Uint8Array(buf);
}

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('cellKey', () => {
    test('hive-style with dt= period segment', () => {
        expect(cellKey('1m', '5m', '2026-05-04_1430')).toBe(
            'avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet',
        );
    });
    test('day period for 1d', () => {
        expect(cellKey('5m', '1d', '2026-05-04')).toBe(
            'avail/agg=5m/cons=1d/dt=2026-05-04.parquet',
        );
    });
    test('ISO week for 1w', () => {
        expect(cellKey('1d', '1w', '2026-W19')).toBe(
            'avail/agg=1d/cons=1w/dt=2026-W19.parquet',
        );
    });
});

describe('inputCellsFor', () => {
    test('cons-only 5m@1m: 5 inputs of 1m@1m at 1-min stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '1m', '5m', '2026-05-04_1430');
        expect(keys).toEqual([
            'avail/agg=1m/cons=1m/dt=2026-05-04_1430.parquet',
            'avail/agg=1m/cons=1m/dt=2026-05-04_1431.parquet',
            'avail/agg=1m/cons=1m/dt=2026-05-04_1432.parquet',
            'avail/agg=1m/cons=1m/dt=2026-05-04_1433.parquet',
            'avail/agg=1m/cons=1m/dt=2026-05-04_1434.parquet',
        ]);
    });

    test('cons-only 15m@1m: 3 inputs of 5m@1m at 5-min stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '1m', '15m', '2026-05-04_1430');
        expect(keys).toEqual([
            'avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1435.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1440.parquet',
        ]);
    });

    test('cons-only 1d@5m: 3 inputs of 8h@5m at 8-hr stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '5m', '1d', '2026-05-04');
        expect(keys).toEqual([
            'avail/agg=5m/cons=8h/dt=2026-05-04_00.parquet',
            'avail/agg=5m/cons=8h/dt=2026-05-04_08.parquet',
            'avail/agg=5m/cons=8h/dt=2026-05-04_16.parquet',
        ]);
    });

    test('cons-only 1w@1d: 7 inputs of 1d@1d at 1d stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '1d', '1w', '2026-W19');
        // 2026-W19 is the week of 2026-05-04 (Mon).
        expect(keys).toEqual([
            'avail/agg=1d/cons=1d/dt=2026-05-04.parquet',
            'avail/agg=1d/cons=1d/dt=2026-05-05.parquet',
            'avail/agg=1d/cons=1d/dt=2026-05-06.parquet',
            'avail/agg=1d/cons=1d/dt=2026-05-07.parquet',
            'avail/agg=1d/cons=1d/dt=2026-05-08.parquet',
            'avail/agg=1d/cons=1d/dt=2026-05-09.parquet',
            'avail/agg=1d/cons=1d/dt=2026-05-10.parquet',
        ]);
    });

    test('agg-self 5m@5m: 1 input of 1m@5m', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '5m', '5m', '2026-05-04_1430');
        expect(keys).toEqual([
            'avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet',
        ]);
    });

    test('agg-self 15m@15m: 3 inputs of 5m@5m at 5-min stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '15m', '15m', '2026-05-04_1430');
        expect(keys).toEqual([
            'avail/agg=5m/cons=5m/dt=2026-05-04_1430.parquet',
            'avail/agg=5m/cons=5m/dt=2026-05-04_1435.parquet',
            'avail/agg=5m/cons=5m/dt=2026-05-04_1440.parquet',
        ]);
    });

    test('agg-self 1h@1h: 4 inputs of 15m@15m at 15-min stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '1h', '1h', '2026-05-04_14');
        expect(keys).toEqual([
            'avail/agg=15m/cons=15m/dt=2026-05-04_1400.parquet',
            'avail/agg=15m/cons=15m/dt=2026-05-04_1415.parquet',
            'avail/agg=15m/cons=15m/dt=2026-05-04_1430.parquet',
            'avail/agg=15m/cons=15m/dt=2026-05-04_1445.parquet',
        ]);
    });

    test('agg-self 1d@1d: 24 inputs of 1h@1h at hourly stride', async () => {
        const grid = await loadGrid(REPO_GRID);
        const { keys } = inputCellsFor(grid, '1d', '1d', '2026-05-04');
        expect(keys).toHaveLength(24);
        expect(keys[0]).toBe('avail/agg=1h/cons=1h/dt=2026-05-04_00.parquet');
        expect(keys[23]).toBe('avail/agg=1h/cons=1h/dt=2026-05-04_23.parquet');
    });
});

describe('ensureCell (integration: real grid + LocalStore + parquet round-trip)', () => {
    let root: string;
    let store: LocalStore;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'ensure-cell-'));
        store = new LocalStore(root);
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    test('5m@1m: writes a 5m cons shard from 5 1m@1m inputs', async () => {
        const grid = await loadGrid(REPO_GRID);
        const baseMin = Math.floor(Date.UTC(2026, 4, 4, 14, 30) / 60_000); // 2026-05-04 14:30 UTC
        // Stage 5 1m@1m inputs.
        for (let i = 0; i < 5; i++) {
            const minute = baseMin + i;
            const polled = minute * 60;
            const buf = build1mShard(polled, [
                station('A', { num_bikes_available: i + 1 }),
                station('B', { num_bikes_available: i + 2 }),
            ]);
            await store.put(`avail/agg=1m/cons=1m/dt=${formatMin(minute)}.parquet`, buf);
        }

        const r = await ensureCell(store, nodeParquetIO, grid, '1m', '5m', '2026-05-04_1430');
        expect(r.status).toBe('wrote');
        expect(r.rows).toBe(10); // 2 stations × 5 minutes
        expect(r.inputs).toBe(5);
        expect(r.outputKey).toBe('avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet');

        // Verify shard contents.
        const buf = await store.get(r.outputKey);
        expect(buf).not.toBeNull();
        const file = { byteLength: buf!.byteLength, slice: (s: number, e?: number) => buf!.slice(s, e) };
        const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
        expect(rows).toHaveLength(10);
        // Sorted by (station_id, dt): A first, then B.
        expect(rows.slice(0, 5).every((r) => r.station_id === 'A')).toBe(true);
        expect(rows.slice(5).every((r) => r.station_id === 'B')).toBe(true);
        expect(rows.slice(0, 5).map((r) => r.bikes_sum)).toEqual([1, 2, 3, 4, 5]);
        expect(rows.slice(5).map((r) => r.bikes_sum)).toEqual([2, 3, 4, 5, 6]);
    });

    test('5m@5m (agg-self): 1 row per station with sum across the 5-min bucket', async () => {
        const grid = await loadGrid(REPO_GRID);
        // Stage the 5m@1m cons shard (the agg-self input).
        const baseMin = Math.floor(Date.UTC(2026, 4, 4, 14, 30) / 60_000);
        // Build a 5-minute cons shard manually via ensureCell off the 1m's first.
        for (let i = 0; i < 5; i++) {
            const minute = baseMin + i;
            await store.put(
                `avail/agg=1m/cons=1m/dt=${formatMin(minute)}.parquet`,
                build1mShard(minute * 60, [station('A', { num_bikes_available: i + 1 })]),
            );
        }
        const consResult = await ensureCell(store, nodeParquetIO, grid, '1m', '5m', '2026-05-04_1430');
        expect(consResult.status).toBe('wrote');

        // Now ensureCell the 5m@5m agg-self.
        const r = await ensureCell(store, nodeParquetIO, grid, '5m', '5m', '2026-05-04_1430');
        expect(r.status).toBe('wrote');
        expect(r.rows).toBe(1);
        expect(r.outputKey).toBe('avail/agg=5m/cons=5m/dt=2026-05-04_1430.parquet');

        const buf = await store.get(r.outputKey);
        const file = { byteLength: buf!.byteLength, slice: (s: number, e?: number) => buf!.slice(s, e) };
        const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0].station_id).toBe('A');
        // Σ bikes_sum over 1..5 = 15; n = 5; Σ sum_sq over 1²..5² = 55.
        expect(rows[0].bikes_n).toBe(5);
        expect(rows[0].bikes_sum).toBe(15);
        expect(rows[0].bikes_sum_sq).toBe(55);
    });

    test('idempotent: second ensureCell on same cell returns "exists"', async () => {
        const grid = await loadGrid(REPO_GRID);
        const baseMin = Math.floor(Date.UTC(2026, 4, 4, 14, 30) / 60_000);
        for (let i = 0; i < 5; i++) {
            await store.put(
                `avail/agg=1m/cons=1m/dt=${formatMin(baseMin + i)}.parquet`,
                build1mShard((baseMin + i) * 60, [station('A')]),
            );
        }
        const first = await ensureCell(store, nodeParquetIO, grid, '1m', '5m', '2026-05-04_1430');
        expect(first.status).toBe('wrote');
        const second = await ensureCell(store, nodeParquetIO, grid, '1m', '5m', '2026-05-04_1430');
        expect(second.status).toBe('exists');
    });

    test('barrier_missing: last input absent → no write, no input read', async () => {
        const grid = await loadGrid(REPO_GRID);
        const baseMin = Math.floor(Date.UTC(2026, 4, 4, 14, 30) / 60_000);
        // Stage only the FIRST 4 of 5 inputs.
        for (let i = 0; i < 4; i++) {
            await store.put(
                `avail/agg=1m/cons=1m/dt=${formatMin(baseMin + i)}.parquet`,
                build1mShard((baseMin + i) * 60, [station('A')]),
            );
        }
        const r = await ensureCell(store, nodeParquetIO, grid, '1m', '5m', '2026-05-04_1430');
        expect(r.status).toBe('barrier_missing');
        expect(await store.head('avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet')).toBeNull();
    });

    test('dryRun: reports "wrote" + row count but does not write to store', async () => {
        const grid = await loadGrid(REPO_GRID);
        const baseMin = Math.floor(Date.UTC(2026, 4, 4, 14, 30) / 60_000);
        for (let i = 0; i < 5; i++) {
            await store.put(
                `avail/agg=1m/cons=1m/dt=${formatMin(baseMin + i)}.parquet`,
                build1mShard((baseMin + i) * 60, [station('A')]),
            );
        }
        const r = await ensureCell(store, nodeParquetIO, grid, '1m', '5m', '2026-05-04_1430', { dryRun: true });
        expect(r.status).toBe('wrote');
        expect(r.rows).toBe(5);
        expect(await store.head('avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet')).toBeNull();
    });
});

function formatMin(minSinceEpoch: number): string {
    const d = new Date(minSinceEpoch * 60_000);
    const Y = d.getUTCFullYear().toString().padStart(4, '0');
    const M = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const D = d.getUTCDate().toString().padStart(2, '0');
    const h = d.getUTCHours().toString().padStart(2, '0');
    const m = d.getUTCMinutes().toString().padStart(2, '0');
    return `${Y}-${M}-${D}_${h}${m}`;
}
