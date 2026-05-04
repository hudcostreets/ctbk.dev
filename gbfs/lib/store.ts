/**
 * `ShardStore` — backend-agnostic key/value store interface for
 * multi-scale grid shards. See specs/avail-grid.md.
 *
 * Implementations:
 *   - `R2Store` — wraps R2Bucket (CFW) or S3 API (Node); see store-r2.ts
 *   - `LocalStore` — reads/writes under a root dir; see below
 *
 * Keys are R2-style strings, e.g. `avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet`.
 * `LocalStore` maps `<key>` → `<root>/<key>` directly so a directory
 * tree under `r2/ctbk/` mirrors what's in R2.
 */

import { mkdir, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export interface ShardStore {
    head(key: string): Promise<{ size: number } | null>;
    get(key: string): Promise<ArrayBuffer | null>;
    put(key: string, body: ArrayBuffer | Uint8Array): Promise<void>;
    list(prefix: string): AsyncIterable<{ key: string; size: number }>;
}

export class LocalStore implements ShardStore {
    constructor(public readonly root: string) {}

    private resolve(key: string): string {
        // Keys may include `/` and `=`; both are valid filesystem chars on
        // unix. Reject backslashes and absolute paths defensively.
        if (key.startsWith('/') || key.includes('\\') || key.includes('..')) {
            throw new Error(`invalid key: ${key}`);
        }
        return join(this.root, key);
    }

    async head(key: string): Promise<{ size: number } | null> {
        try {
            const s = await stat(this.resolve(key));
            return s.isFile() ? { size: s.size } : null;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
    }

    async get(key: string): Promise<ArrayBuffer | null> {
        try {
            const buf = await readFile(this.resolve(key));
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
        }
    }

    async put(key: string, body: ArrayBuffer | Uint8Array): Promise<void> {
        const path = this.resolve(key);
        await mkdir(dirname(path), { recursive: true });
        const buf = body instanceof Uint8Array ? body : new Uint8Array(body);
        await writeFile(path, buf);
    }

    async *list(prefix: string): AsyncIterable<{ key: string; size: number }> {
        // Walk the deepest directory implied by `prefix` (everything up to
        // the last `/`), then filter by remaining basename prefix.
        const idx = prefix.lastIndexOf('/');
        const dirPart = idx >= 0 ? prefix.slice(0, idx) : '';
        const baseFilter = idx >= 0 ? prefix.slice(idx + 1) : prefix;
        const startDir = dirPart ? this.resolve(dirPart) : this.root;
        // Descend into startDir; emit any file whose key starts with `prefix`.
        const stack: string[] = [];
        try {
            const entries = await readdir(startDir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory()) {
                    stack.push(join(startDir, e.name));
                } else if (e.isFile() && (baseFilter === '' || e.name.startsWith(baseFilter))) {
                    const full = join(startDir, e.name);
                    const s = await stat(full);
                    yield { key: relative(this.root, full).split(sep).join('/'), size: s.size };
                }
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw err;
        }
        while (stack.length) {
            const dir = stack.pop()!;
            const entries = await readdir(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = join(dir, e.name);
                if (e.isDirectory()) {
                    stack.push(full);
                } else if (e.isFile()) {
                    const s = await stat(full);
                    yield { key: relative(this.root, full).split(sep).join('/'), size: s.size };
                }
            }
        }
    }
}
