/**
 * TSQ hooks for the GBFS station API.
 *
 * - `useStationInfo(id)`: one-shot `/info` fetch.
 * - `useStationRange(id, fromS, toS)`: time-windowed `/range?from=&to=` fetch
 *   with `keepPreviousData` so the chart stays visible during refetches
 *   (drag-pan commits, Latest snap-back, etc.). `fromS`/`toS` are the
 *   **buffered** bounds the caller wants cached; slice B will widen them so
 *   small drags hit the cache.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'

const API_BASE = 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

export interface StationInfo {
  short_name: string
  slug: string | null
  gbfs_station_id: string | null
  name: string | null
  lat: number | null
  lon: number | null
  capacity: number | null
  station_type: string | null
  first_seen: string | null
  last_seen: string | null
  in_gbfs: number
}

export interface AvailabilityRow {
  station_id: string
  ts: number
  polled_at: number
  num_bikes_available: number
  num_ebikes_available: number
  num_docks_available: number
  num_bikes_disabled: number
  num_docks_disabled: number
  is_installed: number
  is_renting: number
  is_returning: number
  last_reported: number
}

export interface StationRangeResponse {
  station_id: string
  from?: number
  to?: number
  date?: string
  rows: AvailabilityRow[]
  capacity: number | null
  last_polled_at: number | null
}

export function useStationInfo(id: string | undefined) {
  return useQuery<StationInfo | null>({
    queryKey: ['station-info', id],
    enabled: !!id,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/stations/${encodeURIComponent(id!)}/info`)
      if (!res.ok) return null
      return res.json()
    },
  })
}

export function useStationRange(
  id: string | undefined,
  fromS: number,
  toS: number,
) {
  return useQuery<StationRangeResponse>({
    queryKey: ['station-range', id, fromS, toS],
    enabled: !!id,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/stations/${encodeURIComponent(id!)}/range?from=${fromS}&to=${toS}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    placeholderData: keepPreviousData,
  })
}

/** One row of binned availability aggregation, returned by
 *  `/api/totals?kind=availability&bin=<seconds>&filter.station_id=<uuid>`. */
export interface AvailabilityOverviewRow {
  dt: number               // bin start, unix-s
  station_id: string
  sample_count: number     // total minutes-in-state behind the reducer
  mean?: number            // when agg=mean
  min?: number             // when agg=min
  max?: number             // when agg=max
  p05?: number; p25?: number; p50?: number; p75?: number; p95?: number
}

export interface AvailabilityOverviewResponse {
  kind: 'availability'
  metric: string
  scope: string
  tier: string
  rows: AvailabilityOverviewRow[]
}

/** Fetch binned availability aggregation for one station. `gbfsId` is the
 *  GBFS UUID (not slug or short_name). Returns `mean` per `binS`-sized bucket
 *  by default; pass `agg='p50'` etc. for percentile reducers. */
export function useAvailabilityOverview(
  gbfsId: string | undefined,
  fromS: number,
  toS: number,
  binS: number,
  metric: 'bikes' | 'ebikes' | 'docks' | 'disabled' | 'pending' = 'bikes',
  agg: 'mean' | 'min' | 'max' | 'p05' | 'p25' | 'p50' | 'p75' | 'p95' = 'mean',
) {
  return useQuery<AvailabilityOverviewResponse>({
    queryKey: ['availability-overview', gbfsId, fromS, toS, binS, metric, agg],
    enabled: !!gbfsId && fromS < toS && binS >= 3600,
    queryFn: async () => {
      const url = new URL(`${API_BASE}/api/totals`)
      url.searchParams.set('kind', 'availability')
      url.searchParams.set('metric', metric)
      url.searchParams.set('scope', 'stations')
      url.searchParams.set('from', String(fromS))
      url.searchParams.set('to', String(toS))
      url.searchParams.set('filter.station_id', gbfsId!)
      url.searchParams.set('agg', agg)
      url.searchParams.set('bin', String(binS))
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    placeholderData: keepPreviousData,
  })
}

export const stationsApi = { API_BASE }
