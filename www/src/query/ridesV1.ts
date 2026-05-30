/**
 * TSQ hook for `/api/rides-v1` — pyrmts-geo rides pyramid.
 *
 * Phase 1a: system-wide bbox, sum reducer, no region split. Returns rows
 * pre-shaped as `ProcessedRow[]` so `buildTraces` consumes them directly.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { stationsApi } from './stations'
import type { ProcessedRow } from '../chart/ymrgtb-traces'

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
  // start_h3_cell / end_h3_cell may linger on rollup rows; ignored.
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

interface UseRidesV1Args {
  /** Inclusive start; defaults to data start (2013-06). */
  from?: Date
  /** Exclusive end; defaults to "now + 1mo" so the current incomplete month
   *  is included. */
  to?: Date
  anchor?: Anchor
}

export function useRidesV1({
  from,
  to,
  anchor = 'start',
}: UseRidesV1Args = {}): UseQueryResult<ProcessedRow[]> {
  const fromIso = (from ?? new Date(DATA_START_ISO)).toISOString()
  // `to` exclusive — default to first-of-next-month from "now" so the
  // partial current month lands in the response.
  const toIso = (to ?? defaultTo()).toISOString()

  return useQuery<ProcessedRow[]>({
    queryKey: ['rides-v1', anchor, fromIso, toIso],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const url = new URL(`${stationsApi.API_BASE}/api/rides-v1`)
      const sp = url.searchParams
      sp.set('anchor', anchor)
      sp.set('from', fromIso)
      sp.set('to', toIso)
      sp.set('bbox', SYSTEM_BBOX)
      sp.set('reducer', 'sum')
      // Force coarsest cell res — system-wide rollup, cells get summed.
      sp.set('cell_budget', '16')
      // Tight bin_budget keeps the planner at the `1mo` tier across the full
      // 12-year history. Default (1024) lets it pick `7d` which 503s on
      // post-2020 dense shards (CFW CPU budget).
      sp.set('bin_budget', '200')
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`/api/rides-v1: HTTP ${res.status}`)
      const body = (await res.json()) as RidesV1Response
      return body.records.map(apiRowToProcessed)
    },
  })
}

function defaultTo(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

/** API row → `ProcessedRow` (same shape `buildTraces` expects from the
 *  static `ymrgtb_cd.json` path). Region is stubbed to `'NYC'` for phase
 *  1a — the picker/stack-by is hidden on `/v2`; phase 1b wires per-region
 *  queries. */
function apiRowToProcessed(row: RidesV1Row): ProcessedRow {
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
    Region: 'NYC',
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
