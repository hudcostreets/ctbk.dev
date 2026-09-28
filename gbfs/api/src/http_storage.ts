/**
 * Read-only pyrmts `Storage` over a public HTTP base (`data.ctbk.dev`):
 * `head` = HEAD (`Content-Length`), `getRange` = `Range:` GET (206), `get` =
 * GET. Lets `wrangler dev` serve `/api/tl` without the R2 binding (whose
 * local simulator is empty) — `TL_HTTP_BASE` in `index.ts`. Writes and
 * listing aren't supported.
 */
import { NotSupported, type Storage } from 'pyrmts';

export function httpStorage(base: string): Storage {
	const url = (key: string) => `${base.replace(/\/+$/, '')}/${key}`;
	return {
		async head(key) {
			const res = await fetch(url(key), { method: 'HEAD' });
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`HEAD ${key}: HTTP ${res.status}`);
			const size = Number(res.headers.get('content-length'));
			if (!Number.isFinite(size)) throw new Error(`HEAD ${key}: no Content-Length`);
			const etag = res.headers.get('etag') ?? undefined;
			return { size, etag };
		},
		async getRange(key, start, end) {
			const res = await fetch(url(key), { headers: { Range: `bytes=${start}-${end - 1}` } });
			if (res.status !== 206) throw new Error(`GET ${key} [${start}, ${end}): HTTP ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		},
		async get(key) {
			const res = await fetch(url(key));
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`GET ${key}: HTTP ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		},
		async put() {
			throw new NotSupported('httpStorage is read-only');
		},
		async *list() {
			throw new NotSupported('httpStorage cannot list');
		},
	};
}
