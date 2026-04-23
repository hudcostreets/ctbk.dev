#!/usr/bin/env node
/**
 * Generate ymdgtb-index.json: { dir_md5, files: { short_name: md5 } }
 * for per-station monthly trip JSONs served from the DVX S3 cache.
 *
 * Reads s3/ctbk/stations/ymdgtb.dvc → gets the .dir md5 → fetches the
 * .dir file from S3 → pivots into { basename (no .json): md5 }.
 *
 * Writes to www/public/ymdgtb-index.json.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import YAML from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const S3_BASE = 'https://ctbk.s3.amazonaws.com/.dvc/files/md5'

const dvcPath = join(repoRoot, 's3/ctbk/stations/ymdgtb.dvc')
const outPath = join(__dirname, '..', 'public/ymdgtb-index.json')

// Graceful fallback for environments that lack the repo's `s3/` tree
// (e.g. the screenshots Docker image, whose build context is `www/`):
// if the `.dvc` file isn't reachable, trust a pre-generated index if
// one exists. The host-side step runs before Docker and produces it.
if (!existsSync(dvcPath)) {
  if (existsSync(outPath)) {
    console.log(`Skipping ymdgtb-index regeneration: ${dvcPath} not found, using existing ${outPath}`)
    process.exit(0)
  }
  console.error(`Can't generate ymdgtb-index: neither ${dvcPath} nor ${outPath} exists`)
  process.exit(1)
}

// Optional alias enrichment: many stations have historical ID aliases that
// all map to the same canonical record in the trips aggregation (e.g.
// HB106 ↔ HB609 for "River St & Newark St"). `station-id-map.json` holds
// the alias → canonical mapping; we mirror the canonical's md5 under every
// alias in the index so client lookups by either form succeed.
const idMapPath = join(repoRoot, 's3/ctbk/stations/station-id-map.json')
const idMap = existsSync(idMapPath)
  ? JSON.parse(readFileSync(idMapPath, 'utf8'))
  : null
if (!idMap) console.warn(`Alias enrichment skipped: ${idMapPath} not found`)

const spec = YAML.parse(readFileSync(dvcPath, 'utf8'))
// `md5` field ends in `.dir` for directory outputs; the S3 object also has
// that suffix. Keep the suffix in the URL; strip it for the clean dir_md5.
const dirMd5Suffixed = spec.outs[0].md5  // e.g. "4e913e21…ef a05f.dir"
const dirMd5 = dirMd5Suffixed.replace(/\.dir$/, '')

const dirUrl = `${S3_BASE}/${dirMd5.substring(0, 2)}/${dirMd5.substring(2)}.dir`
console.log(`Fetching ${dirUrl}`)

const res = await fetch(dirUrl)
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`)
  process.exit(1)
}
const entries = await res.json()

const files = {}
for (const { md5, relpath } of entries) {
  const m = relpath.match(/^(.+)\.json$/)
  if (!m) {
    console.warn(`Skipping non-.json entry: ${relpath}`)
    continue
  }
  files[m[1]] = md5
}

const canonicalCount = Object.keys(files).length
let aliasesAdded = 0
if (idMap) {
  for (const [alias, canonical] of Object.entries(idMap)) {
    if (alias === canonical) continue
    if (files[alias]) continue  // already a direct entry; don't overwrite
    if (files[canonical]) {
      files[alias] = files[canonical]
      aliasesAdded++
    }
  }
}

const manifest = { dir_md5: dirMd5, files }
writeFileSync(outPath, JSON.stringify(manifest))

const size = Buffer.byteLength(JSON.stringify(manifest))
console.log(
  `Wrote ${outPath}: ${canonicalCount} canonical + ${aliasesAdded} aliases = ${Object.keys(files).length} entries, ${(size / 1024).toFixed(1)} KB`,
)
