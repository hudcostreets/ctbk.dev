/**
 * Node-only `LocalStore` impl. Lives in a separate file from the
 * interface (`lib/store.ts`) so CFW workers can include the lib dir
 * without pulling in `node:fs` types.
 *
 * This file imports `node:fs/promises` and `node:path` and is excluded
 * from CFW workers' tsconfig "include" globs.
 */

import { mkdir, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { ShardStore } from './store.js';

export class LocalStore implements ShardStore {
    constructor(public readonly root: string) {}

    private resolve(key: string): string {
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
        const idx = prefix.lastIndexOf('/');
        const dirPart = idx >= 0 ? prefix.slice(0, idx) : '';
        const baseFilter = idx >= 0 ? prefix.slice(idx + 1) : prefix;
        const startDir = dirPart ? this.resolve(dirPart) : this.root;
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
