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
import { stationsApi } from './stations'
import type { ProcessedRow } from '../chart/ymrgtb-traces'
import type { Region } from '../data'

/** bbox covering NYC + JC + HOB + a generous buffer. */
export const SYSTEM_BBOX = '40.5,-74.2,41.0,-73.7' as const

/** Earliest tripdata month — Citi Bike launched mid-2013. */
const DATA_START_ISO = '2013-06-01T00:00:00Z'

export type Anchor = 'start' | 'end'

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

type RegionCells = Record<Region, string[]>

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

const REGION_CELLS_URL = '/assets/region-cells.json'

/** TSQ-cached fetch of the static region → h3-r9-cells lookup. */
function useRegionCells(): UseQueryResult<RegionCells> {
  return useQuery<RegionCells>({
    queryKey: ['region-cells'],
    staleTime: Infinity,        // immutable static asset
    queryFn: async () => {
      const res = await fetch(REGION_CELLS_URL)
      if (!res.ok) throw new Error(`region-cells: HTTP ${res.status}`)
      return res.json()
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
   *  region's h3 cells). Output rows tagged with `Region`. If omitted,
   *  a single system-wide query runs and every row is tagged `'NYC'`. */
  regions?: readonly Region[]
}

export function useRidesV1({
  from,
  to,
  anchor = 'start',
  regions,
}: UseRidesV1Args = {}): UseQueryResult<ProcessedRow[]> {
  const fromIso = (from ?? new Date(DATA_START_ISO)).toISOString()
  const toIso = (to ?? defaultTo()).toISOString()
  const regionCells = useRegionCells()

  // Block until region-cells loads when regions are requested.
  const cellsByRegion = regionCells.data
  const enabled = !regions || !!cellsByRegion

  // Single TSQ query, region calls fanned out via Promise.all (parallel)
  // — total wall time = slowest region. Cold ~5-9s (worker still has to
  // fetch 14 shards × 3 regions = 42 R2 GETs), warm via edge cache <100ms.
  // Sharding consolidation upstream (1mo tier → single `all` shard) is the
  // real perf lever; tracked separately.
  return useQuery<ProcessedRow[]>({
    queryKey: ['rides-v1', anchor, fromIso, toIso, regions?.join(',') ?? '__system__'],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const specs = !regions
        ? [{ region: null as Region | null, cells: null as string[] | null }]
        : regions.map((r) => ({ region: r, cells: cellsByRegion![r] }))
      const perRegion = await Promise.all(specs.map(async ({ region, cells }) => {
        const url = new URL(`${stationsApi.API_BASE}/api/rides-v1`)
        const sp = url.searchParams
        sp.set('anchor', anchor)
        sp.set('from', fromIso)
        sp.set('to', toIso)
        sp.set('bbox', SYSTEM_BBOX)
        sp.set('reducer', 'sum')
        sp.set('bin_budget', '200')
        sp.set('cell_budget', '16')
        if (cells) sp.set('cells', cells.join(','))
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`/api/rides-v1: HTTP ${res.status}`)
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
