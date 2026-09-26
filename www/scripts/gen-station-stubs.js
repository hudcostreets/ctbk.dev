#!/usr/bin/env node
/**
 * Emit per-station HTML stubs (`dist/s/<slug>.html`) after `vite build`.
 *
 * GH Pages serves the SPA via a `404.html` fallback, so `/s/<slug>` deep
 * links return HTTP 404 with the generic homepage og meta — link-preview
 * crawlers (Slack, Twitter, iMessage) don't run JS and some reject 404s
 * outright. Each stub is a copy of the built `index.html` with the
 * `<title>` + og meta swapped for the station (og:image → the worker's
 * dynamic `/og/s/<slug>.png` renderer), served with a real 200. Browsers
 * load the same SPA bundles (asset URLs are absolute), so UX is unchanged.
 *
 * Station list comes from the API worker's `/api/stations/slugs` (D1
 * `stations` rows with a slug — ~2k). Failure is fatal: a deploy without
 * stubs would silently regress share previews.
 *
 * Flat `<slug>.html`, not `<slug>/index.html`: Workers Assets serves the
 * former at `/s/<slug>` directly, where the latter 307s to `/s/<slug>/` —
 * and that redirect percent-encodes a slug's `+` (`/s/a%2Bb/`).
 *
 * A station's earlier slugs (`aliases`, space-separated) get stubs too,
 * so old shared links still preview; their `og:url` is the current slug,
 * and the SPA redirects there on load.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')

const API_BASE = process.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.hccs-ctbk.workers.dev'
const SITE = 'https://ctbk.dev'

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const setMeta = (html, property, content) => {
  const re = new RegExp(`(<meta property="${property}" content=")[^"]*(")`)
  if (!re.test(html)) throw new Error(`index.html missing <meta property="${property}">`)
  return html.replace(re, `$1${escapeHtml(content)}$2`)
}

const res = await fetch(`${API_BASE}/api/stations/slugs`)
if (!res.ok) throw new Error(`${API_BASE}/api/stations/slugs: HTTP ${res.status}`)
const { stations } = await res.json()
if (!stations?.length) throw new Error('no slugged stations returned')

const template = readFileSync(join(distDir, 'index.html'), 'utf8')
const stubDir = join(distDir, 's')
mkdirSync(stubDir, { recursive: true })
if (!/<title>/.test(template)) throw new Error('dist/index.html missing <title>')

let stubs = 0
for (const { slug, aliases, name, capacity, station_type, first_seen, last_seen, in_gbfs } of stations) {
  const title = `${name} — Citi Bike station | ctbk.dev`
  const bits = []
  if (capacity) bits.push(`${capacity}-dock`)
  if (station_type) bits.push(station_type)
  const kind = bits.length ? `${bits.join(' ')} Citi Bike station` : 'Citi Bike station'
  // `in_gbfs`/`last_seen` absent from an older API = treat as active.
  const retired = in_gbfs === 0 && last_seen
  const since = first_seen
    ? retired ? `, ${first_seen.slice(0, 4)}–${last_seen.slice(0, 4)}` : `, in service since ${first_seen.slice(0, 4)}`
    : ''
  const desc = retired
    ? `${name}: retired ${kind}${since} — ride history on ctbk.dev.`
    : `${name}: ${kind}${since} — live availability + ride history on ctbk.dev.`
  let html = template.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
  html = setMeta(html, 'og:title', title)
  html = setMeta(html, 'og:description', desc)
  html = setMeta(html, 'og:image', `${API_BASE}/og/s/${slug}.png`)
  html = setMeta(html, 'og:url', `${SITE}/s/${slug}`)
  // Dimension hints let crawlers reserve layout before fetching the image.
  html = html.replace(
    /(<meta property="og:image"[^>]*\/>)/,
    `$1\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />`,
  )
  for (const s of [slug, ...(aliases ? aliases.split(' ') : [])]) {
    writeFileSync(join(stubDir, `${s}.html`), html)
    stubs++
  }
}
console.error(`wrote ${stubs} station stubs (${stations.length} stations) under dist/s/`)
