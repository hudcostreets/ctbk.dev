#!/usr/bin/env node
/**
 * Materialize DVX-tracked screenshots (`public/screenshots/*.{png,jpg}`)
 * from their `.dvc` pointers, fetching any missing/stale bytes from the
 * public S3 CA store — no dvc CLI needed (same pattern as
 * `gen-ymdgtb-index.js`). See `specs/www-screenshots-dvx.md`.
 *
 * Runs at predev/prebuild so `vite build` copies real PNGs into
 * `dist/screenshots/` — which is what makes
 * `https://ctbk.dev/screenshots/<name>` the stable human-readable URL
 * for each image (the README points there).
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import YAML from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dir = join(__dirname, '..', 'public/screenshots')

const S3_BASE = 'https://ctbk.s3.amazonaws.com/.dvc/files/md5'

const md5hex = (buf) => createHash('md5').update(buf).digest('hex')

const dvcs = readdirSync(dir).filter((f) => f.endsWith('.dvc'))
if (!dvcs.length) {
  console.error(`no .dvc pointers under ${dir}`)
  process.exit(1)
}

let fetched = 0
for (const f of dvcs) {
  const out = YAML.parse(readFileSync(join(dir, f), 'utf8')).outs[0]
  const dest = join(dir, out.path)
  if (existsSync(dest) && md5hex(readFileSync(dest)) === out.md5) continue
  const url = `${S3_BASE}/${out.md5.slice(0, 2)}/${out.md5.slice(2)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} (for ${out.path}): HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = md5hex(buf)
  if (got !== out.md5) throw new Error(`${out.path}: fetched md5 ${got} != ${out.md5}`)
  writeFileSync(dest, buf)
  fetched++
}
console.error(`screenshots: ${dvcs.length} tracked, ${fetched} fetched`)
