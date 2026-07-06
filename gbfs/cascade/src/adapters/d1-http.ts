/**
 * `D1Database`-shaped shim over Cloudflare's D1 HTTP API. Node-side
 * counterpart to CFW's native D1 binding — same `prepare/bind/run/
 * first/all/batch` surface pyrmts-cfw's `D1ShardIndex` uses, different
 * transport.
 *
 * D1 API endpoint:
 *   POST /accounts/{account}/d1/database/{db}/query
 *   headers: Authorization: Bearer {token}, Content-Type: application/json
 *   body: { sql: string, params?: unknown[] }
 *   → { result: [ { results: Row[], meta: {...} } ], success: bool, errors: [...] }
 *
 * Env:
 *  - `CLOUDFLARE_ACCOUNT_ID`
 *  - `CLOUDFLARE_API_TOKEN`
 *  - `D1_DATABASE_ID` (default: `ctbk-gbfs`'s ID from wrangler.toml)
 */

const DEFAULT_DB_ID = 'd5746734-70ba-46aa-8780-be09e4837f0b';

interface D1QueryResult<T> {
	results: T[];
	meta: {
		changes: number;
		last_row_id: number;
		[k: string]: unknown;
	};
	success: boolean;
}

interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = unknown>(colName?: string): Promise<T | null>;
	run<T = unknown>(): Promise<D1QueryResult<T>>;
	all<T = unknown>(): Promise<D1QueryResult<T>>;
}

export interface D1Like {
	prepare(sql: string): D1PreparedStatement;
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1QueryResult<T>[]>;
}

class HttpPreparedStatement implements D1PreparedStatement {
	constructor(
		private readonly db: HttpD1,
		private readonly sql: string,
		private readonly params: unknown[] = [],
	) {}

	bind(...values: unknown[]): D1PreparedStatement {
		return new HttpPreparedStatement(this.db, this.sql, [...this.params, ...values]);
	}

	async first<T>(colName?: string): Promise<T | null> {
		const r = await this.db._query<T>(this.sql, this.params);
		const first = r.results[0];
		if (first == null) return null;
		if (colName !== undefined) return (first as Record<string, unknown>)[colName] as T;
		return first;
	}

	async run<T>(): Promise<D1QueryResult<T>> {
		return this.db._query<T>(this.sql, this.params);
	}

	async all<T>(): Promise<D1QueryResult<T>> {
		return this.db._query<T>(this.sql, this.params);
	}
}

export class HttpD1 implements D1Like {
	private readonly url: string;
	private readonly token: string;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		const accountId = env.CLOUDFLARE_ACCOUNT_ID;
		const token = env.CLOUDFLARE_API_TOKEN;
		const dbId = env.D1_DATABASE_ID ?? DEFAULT_DB_ID;
		if (!accountId || !token) {
			throw new Error('d1-http: missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
		}
		this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;
		this.token = token;
	}

	prepare(sql: string): D1PreparedStatement {
		return new HttpPreparedStatement(this, sql, []);
	}

	async batch<T>(statements: D1PreparedStatement[]): Promise<D1QueryResult<T>[]> {
		// Trivial impl: run each statement sequentially. D1's real batch
		// API takes multiple SQLs in one request; we don't rely on
		// transactionality inside pyrmts-cfw so serial is fine.
		const out: D1QueryResult<T>[] = [];
		for (const s of statements) {
			out.push(await s.run<T>());
		}
		return out;
	}

	async _query<T>(sql: string, params: unknown[]): Promise<D1QueryResult<T>> {
		const resp = await fetch(this.url, {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${this.token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ sql, params }),
		});
		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`d1 http ${resp.status}: ${text.slice(0, 500)}`);
		}
		const body = await resp.json() as {
			success: boolean;
			result: D1QueryResult<T>[];
			errors?: Array<{ code: number; message: string }>;
		};
		if (!body.success) {
			const msg = body.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? 'unknown';
			throw new Error(`d1 query failed: ${msg}`);
		}
		// D1 HTTP API wraps each query's result in `result[]`. For a
		// single-query request we want the first (and only) entry.
		return body.result[0] ?? { results: [], meta: { changes: 0, last_row_id: 0 }, success: true };
	}
}
