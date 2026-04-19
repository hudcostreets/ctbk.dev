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

export const stationsApi = { API_BASE }
