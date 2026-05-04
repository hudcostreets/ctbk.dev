/**
 * `ShardStore` — backend-agnostic key/value store interface for
 * multi-scale grid shards. See specs/avail-grid.md.
 *
 * Implementations:
 *   - `LocalStore` (`lib/storeLocal.ts`) — Node-only, reads/writes
 *     under a root dir; used by the CLI and any local-mirror workflow.
 *   - `R2Store` (TBD) — wraps R2Bucket (CFW) or S3 API (Node), each
 *     in its own file so CFW doesn't pull in Node deps.
 *
 * This file is CFW-importable (no Node imports).
 *
 * Keys are R2-style strings, e.g. `avail/agg=1m/cons=5m/dt=2026-05-04_1430.parquet`.
 */

export interface ShardStore {
    head(key: string): Promise<{ size: number } | null>;
    get(key: string): Promise<ArrayBuffer | null>;
    put(key: string, body: ArrayBuffer | Uint8Array): Promise<void>;
    list(prefix: string): AsyncIterable<{ key: string; size: number }>;
}
