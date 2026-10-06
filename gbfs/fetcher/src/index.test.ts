import { describe, expect, it } from 'vitest';
import { handle } from './index';

const upstream = async (url: string | URL | Request) =>
	new Response(`body of ${url}`, { status: 200, headers: { 'x-amz-cf-pop': 'IAD89-P1' } });

const call = (q: string) => handle(new Request(`https://fetch/${q}`), upstream as typeof fetch);

describe('ctbk-gbfs-fetch', () => {
	it('proxies an allowlisted URL, keeping upstream headers and adding the colo', async () => {
		const url = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json';
		const r = await call(`?url=${encodeURIComponent(url)}`);
		expect([r.status, await r.text(), r.headers.get('x-amz-cf-pop'), r.headers.get('x-fetch-colo'), r.headers.get('x-fetch-placement')])
			.toEqual([200, `body of ${url}`, 'IAD89-P1', '-', '-']);
	});
	it('reports execution placement separately from the request colo', async () => {
		const request = new Request('https://fetch/?url=https%3A%2F%2Fgbfs.lyft.com%2Fgbfs%2F2.3%2Fbkn%2Fen%2Fstation_status.json', {
			headers: { 'cf-placement': 'remote-IAD' },
		});
		Object.defineProperty(request, 'cf', { value: { colo: 'TPE' } });
		const response = await handle(request, upstream as typeof fetch);
		expect({
			placement: response.headers.get('x-fetch-placement'),
			colo: response.headers.get('x-fetch-colo'),
		}).toEqual({ placement: 'remote-IAD', colo: 'TPE' });
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
