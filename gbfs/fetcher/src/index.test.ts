import { describe, expect, it } from 'vitest';
import { handle } from './index';

const upstream = async (url: string | URL | Request) =>
	new Response(`body of ${url}`, { status: 200, headers: { 'x-amz-cf-pop': 'IAD89-P1' } });

const call = (q: string) => handle(new Request(`https://fetch/${q}`), upstream as typeof fetch);

describe('ctbk-gbfs-fetch', () => {
	it('proxies an allowlisted URL, keeping upstream headers and adding the colo', async () => {
		const url = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json';
		const r = await call(`?url=${encodeURIComponent(url)}`);
		expect([r.status, await r.text(), r.headers.get('x-amz-cf-pop'), r.headers.get('x-fetch-colo')])
			.toEqual([200, `body of ${url}`, 'IAD89-P1', '-']);
	});
	it('rejects other hosts, non-https, and a missing url', async () => {
		const res = await Promise.all([
			call(`?url=${encodeURIComponent('https://example.com/x')}`),
			call(`?url=${encodeURIComponent('http://gbfs.lyft.com/x')}`),
			call(''),
		]);
		expect(res.map((r) => r.status)).toEqual([403, 403, 400]);
	});
});
