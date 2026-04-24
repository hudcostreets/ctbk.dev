/**
 * TSQ hook for the paginated raw-rides table per station
 * (`GET ${API_BASE}/api/rides`; see `specs/multiscale-timeseries-backend.md`
 * § "Paginated raw-rides table per station").
 *
 * Scaffolding only — the Worker endpoint doesn't exist yet. When absent the
 * hook returns `status: 'coming-soon'` so the UI can render a placeholder
 * instead of an error.
 *
 * - `placeholderData: keepPreviousData` so pagination / sort changes don't
 *   flicker the visible table.
 * - Query key includes every request param so each page / sort / range is
 *   cached independently.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { stationsApi } from './stations'

export type Side = 'start' | 'end'
export type SortDir = 'asc' | 'desc'

/** Columns available for sorting. Keep in sync with the Worker contract. */
export const SORTABLE_COLUMNS = [
  'dt',
  'side',
  'counterpart_short_name',
  'gender',
  'user_type',
  'rideable_type',
  'duration_s',
] as const
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number]

export interface RideRow {
  /** Unix seconds. */
  dt: number
  side: Side
  counterpart_short_name: string
  gender: number
  user_type: string
  rideable_type: string
  duration_s: number
}

export interface RidesTableResponse {
  rows: RideRow[]
  totalRows: number
  /** 0-indexed page actually served (may differ from request if clamped). */
  page: number
  pageSize: number
}

/** Result when the endpoint returns 404 — placeholder for "not deployed yet". */
export interface ComingSoonResponse {
  status: 'coming-soon'
}

export type RidesTableQueryResult = RidesTableResponse | ComingSoonResponse

export function isComingSoon(r: RidesTableQueryResult | undefined): r is ComingSoonResponse {
  return !!r && (r as ComingSoonResponse).status === 'coming-soon'
}

export interface UseRidesTableParams {
  station: string
  counterpartStation?: string
  side?: Side
  /** Visible range start (unix seconds). */
  fromS: number
  /** Visible range end (unix seconds). */
  toS: number
  /** 0-indexed page. */
  page: number
  pageSize: number
  sortBy?: SortableColumn
  sortDir?: SortDir
}

export function useRidesTable(
  params: UseRidesTableParams,
): UseQueryResult<RidesTableQueryResult> {
  const {
    station, counterpartStation, side,
    fromS, toS, page, pageSize, sortBy, sortDir,
  } = params

  const enabled = !!station && pageSize > 0 && page >= 0 && toS > fromS

  return useQuery<RidesTableQueryResult>({
    queryKey: [
      'rides-table',
      station,
      counterpartStation ?? null,
      side ?? null,
      fromS, toS,
      page, pageSize,
      sortBy ?? null, sortDir ?? null,
    ],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const url = new URL(`${stationsApi.API_BASE}/api/rides`)
      const sp = url.searchParams
      sp.set('station', station)
      if (counterpartStation) sp.set('counterpart', counterpartStation)
      if (side) sp.set('side', side)
      sp.set('from', String(fromS))
      sp.set('to', String(toS))
      sp.set('page', String(page))
      sp.set('pageSize', String(pageSize))
      if (sortBy) sp.set('sortBy', sortBy)
      if (sortDir) sp.set('sortDir', sortDir)
      const res = await fetch(url.toString())
      if (res.status === 404) {
        return { status: 'coming-soon' }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<RidesTableResponse>
    },
  })
}
