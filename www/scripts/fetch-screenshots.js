#!/usr/bin/env node
/**
 * Materialize screenshots (`public/screenshots/*.{png,jpg}`) from their
 * HR S3 home (`s3://ctbk/screenshots/`; see
 * `specs/www-screenshots-s3-hr.md`): download the `.deps.json` manifest,
 * then each image whose local copy is missing or md5-stale.
 *
 * Runs at predev/prebuild so `vite build` copies real PNGs into
 * `dist/screenshots/` — which is what makes
 * `https://ctbk.dev/screenshots/<name>` the stable site-served URL for
 * each image (the README points there). Override the source with
 * `SCREENSHOTS_BASE` (e.g. a dev prefix written via
 * `push-screenshots.py -o`).
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dir = join(__dirname, '..', 'public/screenshots')

const BASE = process.env.SCREENSHOTS_BASE ?? 'https://ctbk.s3.amazonaws.com/screenshots'

const md5hex = (buf) => createHash('md5').update(buf).digest('hex')

const manifestUrl = `${BASE}/.deps.json`
const res = await fetch(manifestUrl)
if (!res.ok) throw new Error(`${manifestUrl}: HTTP ${res.status}`)
const { images } = await res.json()
const names = Object.keys(images)
if (!names.length) throw new Error(`${manifestUrl}: empty image manifest`)

let fetched = 0
for (const name of names) {
  const { md5 } = images[name]
  const dest = join(dir, name)
  if (existsSync(dest) && md5hex(readFileSync(dest)) === md5) continue
  const url = `${BASE}/${name}`
  const imgRes = await fetch(url)
  if (!imgRes.ok) throw new Error(`${url}: HTTP ${imgRes.status}`)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  const got = md5hex(buf)
  if (got !== md5) throw new Error(`${name}: fetched md5 ${got} != ${md5}`)
  writeFileSync(dest, buf)
  fetched++
}
console.error(`screenshots: ${names.length} in manifest, ${fetched} fetched`)
