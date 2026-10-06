/**
 * `ctbk-gbfs-fetch`: fetch an allowlisted GBFS URL from a US-placed
 * isolate (`[placement] region`) and hand back the upstream response, plus
 * `x-fetch-placement` (Cloudflare's execution placement) and `x-fetch-colo`
 * (request colo, when supplied) so callers can diagnose routing. Called over
 * a service binding: `env.FETCH.fetch('https://fetch/?url=<encoded>')`.
 */

export const ALLOWED_HOSTS = new Set(['gbfs.lyft.com', 'gbfs.citibikenyc.com']);

export async function handle(request: Request, upstream: typeof fetch = fetch): Promise<Response> {
	const target = new URL(request.url).searchParams.get('url');
	if (!target) return new Response('missing `url`\n', { status: 400 });
	let u: URL;
	try {
		u = new URL(target);
	} catch {
		return new Response('bad `url`\n', { status: 400 });
	}
	if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
		return new Response(`host not allowed: ${u.hostname}\n`, { status: 403 });
	}
	const resp = await upstream(u.toString());
	const headers = new Headers(resp.headers);
	const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo;
	headers.set('x-fetch-colo', colo ?? '-');
	headers.set('x-fetch-placement', request.headers.get('cf-placement') ?? '-');
	return new Response(resp.body, { status: resp.status, headers });
}

export default {
	fetch: (request: Request) => handle(request),
} satisfies ExportedHandler;
