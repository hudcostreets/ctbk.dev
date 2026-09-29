/**
 * A `VITE_API_BASE` of `http://localhost:<port>` (a local `wrangler dev`) only
 * resolves on the dev machine itself. When the page is opened from another
 * device (e.g. a phone at `m3.rbw.sh:3476`), point it at the same host the page
 * was served from instead.
 */
export function localToPageHost(base: string): string {
  if (typeof window === 'undefined') return base
  const url = new URL(base)
  const page = window.location.hostname
  const loopback = ['localhost', '127.0.0.1', '[::1]']
  if (!loopback.includes(url.hostname) || loopback.includes(page)) return base
  url.hostname = page
  return url.toString().replace(/\/$/, '')
}
