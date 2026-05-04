import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAggBucketMin, validateGrid, type GridSpec } from '../../lib/grid.js';
import { loadGrid } from './loadGrid.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_GRID = join(here, '../../grid.yaml');

describe('parseAggBucketMin', () => {
    test('minutes', () => expect(parseAggBucketMin('5m')).toBe(5));
    test('hours', () => expect(parseAggBucketMin('1h')).toBe(60));
    test('hours: 3h', () => expect(parseAggBucketMin('3h')).toBe(180));
    test('days', () => expect(parseAggBucketMin('1d')).toBe(1440));
    test('throws on unknown', () => expect(() => parseAggBucketMin('1y')).toThrow());
});

describe('loadGrid + validate (real gbfs/grid.yaml)', () => {
    test('loads and validates without error', async () => {
        const grid = await loadGrid(REPO_GRID);
        expect(grid.agg_self.map((l) => l.agg)).toEqual(['5m', '15m', '1h', '1d']);
        expect(Object.keys(grid.cons).sort()).toEqual(['15m', '1d', '1h', '1m', '5m']);
    });

    test('agg=1m chain stops at 1h cfw / 3h+ goes to gha', async () => {
        const grid = await loadGrid(REPO_GRID);
        const cons1m = grid.cons['1m'];
        const byCons = new Map(cons1m.map((l) => [l.cons, l]));
        expect(byCons.get('5m')!.runner).toBe('cfw');
        expect(byCons.get('1h')!.runner).toBe('cfw');
        expect(byCons.get('3h')!.runner).toBe('gha');
        expect(byCons.get('8h')!.runner).toBe('gha');
        expect(byCons.get('1d')!.runner).toBe('gha');
    });

    test('every cons.from_cons resolves to either the agg name or a previous cons in the chain', async () => {
        const grid = await loadGrid(REPO_GRID);
        for (const [agg, chain] of Object.entries(grid.cons)) {
            const seen = new Set<string>([agg]);
            for (const level of chain) {
                expect(seen.has(level.from_cons), `${agg}: ${level.cons} reads from unknown ${level.from_cons}`).toBe(true);
                seen.add(level.cons);
            }
        }
    });
});

describe('validateGrid (synthetic)', () => {
    test('rejects agg_self with wrong from_agg chain', () => {
        const bad: GridSpec = {
            agg_self: [
                { agg: '5m',  bucket_min: 5,  from_agg: '1m', from_count: 1, runner: 'cfw' },
                { agg: '15m', bucket_min: 15, from_agg: '1m', from_count: 3, runner: 'cfw' }, // wrong: should be 5m
            ],
            cons: {},
        };
        expect(() => validateGrid(bad)).toThrow(/reads from 1m but previous level was 5m/);
    });

    test('rejects agg_self with wrong bucket_min math (level ≥ 1)', () => {
        const bad: GridSpec = {
            agg_self: [
                { agg: '5m',  bucket_min: 5,  from_agg: '1m', from_count: 1, runner: 'cfw' },
                { agg: '15m', bucket_min: 14, from_agg: '5m', from_count: 3, runner: 'cfw' }, // 3*5=15, not 14
            ],
            cons: {},
        };
        expect(() => validateGrid(bad)).toThrow(/bucket_min=14/);
    });

    test('rejects first agg_self level with from_count != 1', () => {
        const bad: GridSpec = {
            agg_self: [
                { agg: '5m', bucket_min: 5, from_agg: '1m', from_count: 5, runner: 'cfw' }, // first level must have from_count=1
            ],
            cons: {},
        };
        expect(() => validateGrid(bad)).toThrow(/first level.*from_count=5/);
    });

    test('rejects cons with from_cons not in chain', () => {
        const bad: GridSpec = {
            agg_self: [],
            cons: {
                '1m': [
                    { cons: '5m',  bucket_min: 5,  from_cons: '1m', from_count: 5, runner: 'cfw' },
                    { cons: '15m', bucket_min: 15, from_cons: '7m', from_count: 5, runner: 'cfw' }, // 7m not in chain
                ],
            },
        };
        expect(() => validateGrid(bad)).toThrow(/from_cons=7m not found in chain/);
    });

    test('accepts cons that skips back to a non-immediate ancestor (e.g. 8h from 1h skipping 3h)', () => {
        const ok: GridSpec = {
            agg_self: [],
            cons: {
                '1m': [
                    { cons: '1h', bucket_min: 60,  from_cons: '1m', from_count: 60, runner: 'cfw' },
                    { cons: '3h', bucket_min: 180, from_cons: '1h', from_count: 3,  runner: 'cfw' },
                    { cons: '8h', bucket_min: 480, from_cons: '1h', from_count: 8,  runner: 'cfw' }, // skips 3h
                ],
            },
        };
        expect(() => validateGrid(ok)).not.toThrow();
    });

    test('accepts calendar cons (1mo, 1y, 3y) without bucket_min math check', () => {
        const ok: GridSpec = {
            agg_self: [],
            cons: {
                '1d': [
                    { cons: '1w',  bucket_min: 10080,   from_cons: '1d', from_count: 7, runner: 'cfw' },
                    { cons: '1mo', bucket_min: 43200,   from_cons: '1w', from_count: 4, runner: 'cfw' },
                    { cons: '1y',  bucket_min: 525600,  from_cons: '1mo', from_count: 12, runner: 'cfw' },
                    { cons: '3y',  bucket_min: 1576800, from_cons: '1y',  from_count: 3, runner: 'cfw' },
                ],
            },
        };
        // Should not throw despite 1y/12 ≠ 1mo bucket_min, etc.
        expect(() => validateGrid(ok)).not.toThrow();
    });
});
