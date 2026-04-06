#!/usr/bin/env node
/**
 * Generate a manifest of station data URLs from DVC files.
 * Outputs to public/assets/station-urls.json
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import YAML from 'yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const S3_BASE = 'https://ctbk.s3.amazonaws.com/.dvc/files/md5'

function dvcUrl(md5) {
  return `${S3_BASE}/${md5.substring(0, 2)}/${md5.substring(2)}`
}

function loadMd5(dvcPath) {
  const content = readFileSync(dvcPath, 'utf8')
  const spec = YAML.parse(content)
  return spec.outs[0].md5
}

const aggregatedDir = join(repoRoot, 's3/ctbk/aggregated')
const months = readdirSync(aggregatedDir)
  .filter(d => /^20\d{4}$/.test(d))
  .sort()

const stationsUrls = {}
const pairsUrls = {}

for (const month of months) {
  const stationsDvc = join(aggregatedDir, month, 'stations.json.dvc')
  const pairsDvc = join(aggregatedDir, month, 'se_c.json.dvc')

  try {
    stationsUrls[month] = dvcUrl(loadMd5(stationsDvc))
  } catch (e) {
    // Skip months without stations data
  }

  try {
    pairsUrls[month] = dvcUrl(loadMd5(pairsDvc))
  } catch (e) {
    // Skip months without pairs data
  }
}

const manifest = {
  stations: stationsUrls,
  pairs: pairsUrls,
  latestMonth: months[months.length - 1],
}

const outPath = join(__dirname, '..', 'public/assets/station-urls.json')
writeFileSync(outPath, JSON.stringify(manifest, null, 2))
console.log(`Wrote ${Object.keys(stationsUrls).length} station URLs to ${outPath}`)
console.log(`Latest month: ${manifest.latestMonth}`)
