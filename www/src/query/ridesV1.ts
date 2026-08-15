/**
 * TSQ hook for `/api/rides-v1` — pyrmts-geo rides pyramid.
 *
 * Two modes:
 * - `regions` omitted → one system-wide query (bbox = NYC+JC+HOB+buffer).
 *   Every output row gets `Region: 'NYC'` as a stub (region-stack-by /
 *   region-filter are no-ops). For "I just want totals" use cases.
 * - `regions: ['NYC', 'JC', 'HOB']` (or any subset) → N parallel queries,
 *   each with `cells=<region's h3 r9 covering>` so the pyramid sums only
 *   that region's cells. Output rows carry the matching `Region`, so
 *   downstream `buildTraces` can stack/filter by region naturally.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { minimalCover, s2Index, type SpatialSet } from 'pyrmts-geo'
import type { ProcessedRow } from '../chart/ymrgtb-traces'
import type { Region } from '../data'

/** bbox covering NYC + JC + HOB + a generous buffer. */
export const SYSTEM_BBOX = '40.5,-74.2,41.0,-73.7' as const

/** Earliest tripdata month — Citi Bike launched mid-2013. */
const DATA_START_ISO = '2013-06-01T00:00:00Z'

export type Anchor = 'start' | 'end'
export type Pyramid = 'v3' | 'v5'

/** Which CFW worker to hit. `prod` = `ctbk-gbfs-api`, `dev` =
 *  `ctbk-gbfs-api-dev`. Use `dev` for iterating on backend changes
 *  (set up via `[env.dev]` in `gbfs/api/wrangler.toml`). Routed only for
 *  rides hits — avail, station, totals stay on prod. */
export type ApiTarget = 'prod' | 'dev'
const API_BASE_BY_TARGET: Record<ApiTarget, string> = {
  prod: 'https://ctbk-gbfs-api.ryan-0dc.workers.dev',
  dev: 'https://ctbk-gbfs-api-dev.ryan-0dc.workers.dev',
}

interface RidesV1Row {
  dt: number             // unix ms (bucket start)
  gender: string         // 'unknown' | 'male' | 'female'
  user_type: string      // 'Subscriber' | 'Customer'
  bike_type: string      // 'classic_bike' | 'electric_bike' | 'docked_bike'
  count: number
  duration: number       // seconds
  [k: string]: number | string | undefined
}

interface RidesV1Response {
  records: RidesV1Row[]
  reducer: string
  anchor: Anchor
  plan: {
    outputTier: string
    outputBin: string
    outputRes: number
    outputCells: string[]
  }
}

type RegionCovers = Record<Region, SpatialSet<string>>

/** Stations static asset shape (written by `ctbk stations-regional`). */
type Station = { lat: number; lng: number; region: Region; name?: string }
type StationsRegional = Record<string, Station>

/** S2 levels materialized in the v3 pyramid (see `specs/done/rides-pyramid-v3.md`).
 *  `finestLevel` = where stations get cell-ified before minimalCover compacts.
 *  `coarsestLevel` = highest the cover is allowed to roll up to (= shallowest
 *  materialized level — going coarser would have no shard to query). */
const V3_FINEST_LEVEL = 15
const V3_COARSEST_LEVEL = 10

/** Citi Bike's `user_type` → ctbk's `User Type`. */
const USER_TYPE_MAP: Record<string, 'Annual' | 'Daily'> = {
  Subscriber: 'Annual',
  Customer: 'Daily',
}

/** API gender string → ctbk's Gender int (matches static JSON's `Gender` column). */
const GENDER_MAP: Record<string, number> = {
  unknown: 0,
  male: 1,
  female: 2,
}

/** Compute v3 region covers via `s2Index.minimalCover`. For each region R:
 *  - include = stations in R (mapped to leaf cells at `V3_FINEST_LEVEL`)
 *  - system  = ALL stations (across all regions) at the same level
 *  - cover   = minimalCover(...) — mixed-resolution + lineage-disjoint, with
 *              `coarsestLevel = V3_COARSEST_LEVEL` (= shallowest materialized
 *              level in the pyramid). Returned as `{ include, exclude }` per
 *              region; the v3 endpoint accepts both via `cells=` + `cells.exclude=`. */
export function useRegionCoversV3(enabled: boolean = true): UseQueryResult<RegionCovers> {
  return useQuery<RegionCovers>({
    queryKey: ['region-covers', 's2', V3_FINEST_LEVEL, V3_COARSEST_LEVEL],
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch('/assets/stations-regional.json')
      if (!res.ok) throw new Error(`stations-regional: HTTP ${res.status}`)
      const stations = (await res.json()) as StationsRegional
      const leafByStation = Object.values(stations).map((s) => ({
        region: s.region,
        cell: s2Index.latLngToCell(s.lat, s.lng, V3_FINEST_LEVEL),
      }))
      const system = Array.from(new Set(leafByStation.map((x) => x.cell)))
      const out: RegionCovers = {
        NYC: { include: [], exclude: [] },
        JC:  { include: [], exclude: [] },
        HOB: { include: [], exclude: [] },
      } as RegionCovers
      for (const r of Object.keys(out) as Region[]) {
        const include = Array.from(new Set(
          leafByStation.filter((x) => x.region === r).map((x) => x.cell),
        ))
        if (include.length === 0) continue
        out[r] = minimalCover(s2Index, include, system, {
          allowSubtraction: true,
          coarsestLevel: V3_COARSEST_LEVEL,
        })
      }
      return out
    },
  })
}

interface UseRidesV1Args {
  /** Inclusive start; defaults to data start (2013-06). */
  from?: Date
  /** Exclusive end; defaults to "now + 1mo" so the current incomplete month
   *  is included. */
  to?: Date
  anchor?: Anchor
  /** If provided, fan out one query per region (each filtered to that
   *  region's cell cover). Output rows tagged with `Region`. If omitted,
   *  a single system-wide query runs and every row is tagged `'NYC'`. */
  regions?: readonly Region[]
  /** Pyramid variant to query — selects between `/api/rides-v5` (prod)
   *  and `/api/rides-v3` (rollback). Default `'v5'`. */
  pyramid?: Pyramid
  /** Which worker URL to hit. Default `'prod'`. `'dev'` points at the
   *  `ctbk-gbfs-api-dev` sibling worker for backend iteration without
   *  touching prod. Use via `?api=dev` URL param on `/v2`. */
  api?: ApiTarget
}

export function useRidesV1({
  from,
  to,
  anchor = 'start',
  regions,
  pyramid = 'v5',
  api = 'prod',
}: UseRidesV1Args = {}): UseQueryResult<ProcessedRow[]> {
  const apiBase = API_BASE_BY_TARGET[api]
  const fromIso = (from ?? new Date(DATA_START_ISO)).toISOString()
  const toIso = (to ?? defaultTo()).toISOString()
  // Region covers: live minimalCover (mixed res + exclude) computed from
  // stations-regional.json at FE startup, cached by TSQ. v5 sends the
  // same raw-S2 covers; the worker translates them to the station
  // vocabulary (`v5UserCover`).
  const minCovers = useRegionCoversV3()

  const coversByRegion = minCovers.data
  const enabled = !regions || !!coversByRegion

  // Single TSQ query, region calls fanned out via Promise.all (parallel)
  // — total wall time = slowest region. Cold ~5-9s (worker still has to
  // fetch 14 shards × 3 regions = 42 R2 GETs), warm via edge cache <100ms.
  // Sharding consolidation upstream (1mo tier → single `all` shard) is the
  // real perf lever; tracked separately.
  return useQuery<ProcessedRow[]>({
    queryKey: ['rides', api, pyramid, anchor, fromIso, toIso, regions?.join(',') ?? '__system__'],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      type Spec = { region: Region | null; include: string[] | null; exclude: string[] }
      const specs: Spec[] = !regions
        ? [{ region: null, include: null, exclude: [] }]
        : regions.map((r) => {
          const cov = coversByRegion![r]
          return { region: r, include: cov.include, exclude: cov.exclude }
        })
      const perRegion = await Promise.all(specs.map(async ({ region, include, exclude }) => {
        const url = new URL(`${apiBase}/api/rides-${pyramid}`)
        const sp = url.searchParams
        sp.set('anchor', anchor)
        sp.set('from', fromIso)
        sp.set('to', toIso)
        sp.set('bbox', SYSTEM_BBOX)
        sp.set('reducer', 'sum')
        if (pyramid === 'v5') {
          // v5 has no calendar tiers; the worker rebins the 1d tier to
          // exact calendar months at serve time (`specs/rides-v5.md`).
          sp.set('bin', '1mo')
        } else {
          sp.set('bin_budget', '200')
        }
        sp.set('cell_budget', '16')
        if (include) sp.set('cells', include.join(','))
        if (exclude.length) sp.set('cells.exclude', exclude.join(','))
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`/api/rides-${pyramid}: HTTP ${res.status}`)
        const body = (await res.json()) as RidesV1Response
        const regionTag: Region = region ?? 'NYC'
        return body.records.map((row) => apiRowToProcessed(row, regionTag))
      }))
      return perRegion.flat()
    },
  })
}

function defaultTo(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

function apiRowToProcessed(row: RidesV1Row, region: Region): ProcessedRow {
  const d = new Date(row.dt)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const m = `${year}-${String(month).padStart(2, '0')}`
  const userType = USER_TYPE_MAP[row.user_type] ?? 'Annual'
  const genderInt = GENDER_MAP[row.gender] ?? 0
  const rideableRaw = row.bike_type
  return {
    Year: year,
    Month: month,
    Count: row.count,
    Duration: row.duration,
    Region: region,
    'User Type': userType,
    Gender: genderInt,
    'Rideable Type': rideableRaw,
    m,
    Rides: row.count,
    'Ride minutes': row.duration / 60,
    GenderStr: genderInt === 1 ? 'Men' : genderInt === 2 ? 'Women' : 'Unknown',
    RideableTypeStr:
      rideableRaw === 'classic_bike' || rideableRaw === 'docked_bike' ? 'Classic'
      : rideableRaw === 'electric_bike' ? 'Electric'
      : 'Unknown',
  }
}
