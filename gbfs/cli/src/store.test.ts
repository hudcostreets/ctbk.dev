import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../../lib/storeLocal.js';

describe('LocalStore', () => {
    let root: string;
    let store: LocalStore;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'store-test-'));
        store = new LocalStore(root);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    test('put + head + get round-trip', async () => {
        const body = new Uint8Array([1, 2, 3, 4, 5]);
        await store.put('avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet', body);

        const headed = await store.head('avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet');
        expect(headed).toEqual({ size: 5 });

        const got = await store.get('avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet');
        expect(got).not.toBeNull();
        expect(new Uint8Array(got!)).toEqual(body);
    });

    test('head on missing key returns null', async () => {
        expect(await store.head('does/not/exist')).toBeNull();
    });

    test('get on missing key returns null', async () => {
        expect(await store.get('does/not/exist')).toBeNull();
    });

    test('put creates intermediate dirs', async () => {
        await store.put('a/b/c/d/e/f.parquet', new Uint8Array([0]));
        const headed = await store.head('a/b/c/d/e/f.parquet');
        expect(headed).toEqual({ size: 1 });
    });

    test('list yields all matching keys recursively, in any order', async () => {
        const body = new Uint8Array([0]);
        await store.put('avail/agg=1m/cons=5m/dt=2026-05-04_1400.parquet', body);
        await store.put('avail/agg=1m/cons=5m/dt=2026-05-04_1405.parquet', body);
        await store.put('avail/agg=1m/cons=5m/dt=2026-05-04_1410.parquet', body);
        await store.put('avail/agg=1m/cons=15m/dt=2026-05-04_1400.parquet', body);
        await store.put('avail/agg=5m/cons=5m/dt=2026-05-04_1400.parquet', body);

        const keys: string[] = [];
        for await (const e of store.list('avail/agg=1m/cons=5m/')) keys.push(e.key);
        keys.sort();
        expect(keys).toEqual([
            'avail/agg=1m/cons=5m/dt=2026-05-04_1400.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1405.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1410.parquet',
        ]);

        // Wider prefix picks up the cons=15m sibling.
        const widerKeys: string[] = [];
        for await (const e of store.list('avail/agg=1m/')) widerKeys.push(e.key);
        widerKeys.sort();
        expect(widerKeys).toEqual([
            'avail/agg=1m/cons=15m/dt=2026-05-04_1400.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1400.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1405.parquet',
            'avail/agg=1m/cons=5m/dt=2026-05-04_1410.parquet',
        ]);
    });

    test('list with partial-basename prefix filters at the leaf', async () => {
        const body = new Uint8Array([0]);
        await store.put('avail/agg=1m/cons=5m/dt=2026-05-04_1400.parquet', body);
        await store.put('avail/agg=1m/cons=5m/dt=2026-05-05_1400.parquet', body);

        const keys: string[] = [];
        for await (const e of store.list('avail/agg=1m/cons=5m/dt=2026-05-04')) keys.push(e.key);
        expect(keys).toEqual(['avail/agg=1m/cons=5m/dt=2026-05-04_1400.parquet']);
    });

    test('list on missing prefix yields nothing', async () => {
        const keys: string[] = [];
        for await (const e of store.list('does/not/exist/')) keys.push(e.key);
        expect(keys).toEqual([]);
    });

    test('rejects keys with absolute paths or `..`', async () => {
        await expect(store.put('/etc/passwd', new Uint8Array([0]))).rejects.toThrow(/invalid key/);
        await expect(store.put('a/../../escape', new Uint8Array([0]))).rejects.toThrow(/invalid key/);
    });

    test('overwrites existing keys', async () => {
        await store.put('k', new Uint8Array([1, 2, 3]));
        await store.put('k', new Uint8Array([9, 9]));
        const got = await store.get('k');
        expect(new Uint8Array(got!)).toEqual(new Uint8Array([9, 9]));
    });
});
