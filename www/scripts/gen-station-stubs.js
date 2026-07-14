#!/usr/bin/env node
/**
 * Emit per-station HTML stubs (`dist/s/<slug>/index.html`) after `vite build`.
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
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'dist')

const API_BASE = process.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'
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
if (!/<title>/.test(template)) throw new Error('dist/index.html missing <title>')

for (const { slug, name, capacity, station_type, first_seen } of stations) {
  const title = `${name} — Citi Bike station | ctbk.dev`
  const bits = []
  if (capacity) bits.push(`${capacity}-dock`)
  if (station_type) bits.push(station_type)
  const kind = bits.length ? `${bits.join(' ')} Citi Bike station` : 'Citi Bike station'
  const since = first_seen ? `, in service since ${first_seen.slice(0, 4)}` : ''
  const desc = `${name}: ${kind}${since} — live availability + ride history on ctbk.dev.`
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
  const dir = join(distDir, 's', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}
console.error(`wrote ${stations.length} station stubs under dist/s/`)
