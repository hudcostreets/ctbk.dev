#!/usr/bin/env node
/**
 * Dump FE-style mixed-level S2 covers for benching `/api/rides-v3`.
 *
 * Mirrors `useRegionCoversV3` in `www/src/query/ridesV1.ts`:
 *   - Bucket all stations by region.
 *   - Map each station to its L15 S2 cell.
 *   - Run `minimalCover` with `allowSubtraction: true, coarsestLevel: 10`.
 *
 * Output: `tmp/region-covers-v3.json = { NYC: {include:[...], exclude:[...]}, ... }`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { s2Index, minimalCover } from '../www/node_modules/pyrmts-geo/dist/index.js'

const V3_FINEST_LEVEL = 15
const V3_COARSEST_LEVEL = 10

const stations = JSON.parse(readFileSync('tmp/stations-regional.json', 'utf8'))
const leafByStation = Object.values(stations).map((s) => ({
  region: s.region,
  cell: s2Index.latLngToCell(s.lat, s.lng, V3_FINEST_LEVEL),
}))
const system = Array.from(new Set(leafByStation.map((x) => x.cell)))

const out = {}
for (const r of ['NYC', 'JC', 'HOB']) {
  const include = Array.from(new Set(
    leafByStation.filter((x) => x.region === r).map((x) => x.cell),
  ))
  if (include.length === 0) { out[r] = { include: [], exclude: [] }; continue }
  out[r] = minimalCover(s2Index, include, system, {
    allowSubtraction: true,
    coarsestLevel: V3_COARSEST_LEVEL,
  })
  console.error(`${r}: include=${out[r].include.length} exclude=${out[r].exclude.length}`)
}
writeFileSync('tmp/region-covers-v3.json', JSON.stringify(out, null, 2))
console.error('wrote tmp/region-covers-v3.json')
