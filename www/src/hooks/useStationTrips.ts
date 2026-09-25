/**
 * Loads per-station monthly trip data from the `rides` pyramid: two
 * `/api/rides?cells=<LUC>` monthly queries (one per anchor → `Docking`),
 * reshaped to `StationTripsRow[]`. (The legacy static-`ymdgtb_cd.json` source
 * was removed once rides-v5 became the default — Phase E.)
 */
import { useEffect, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.hccs-ctbk.workers.dev'
const STATION_LUC_URL = '/assets/station-luc.json'
// Rides history starts 2013-06; ~14y × 12mo ≈ 170 monthly bins.
const V5_FROM = '2013-06-01T00:00:00Z'
const V5_BIN_BUDGET = 200

export interface StationTripsRow {
  Year: number
  Month: number
  Docking: 'start' | 'end'
  Gender: number
  'User Type': 'Annual' | 'Daily'
  'Rideable Type': string
  Count: number
  Duration: number
}

// Module-level cache — same station page across navigations hits this.
const rowsCache = new Map<string, Promise<StationTripsRow[]>>()

// ─── rides-v5 source ───────────────────────────────────────────────────

interface LucDenorm {
  by_short_name: Record<string, { lat: number; lng: number; cell: string; level: number }>
}
let lucPromise: Promise<LucDenorm> | null = null
function loadLuc(): Promise<LucDenorm> {
  if (!lucPromise) {
    lucPromise = fetch(STATION_LUC_URL).then((r) => {
      if (!r.ok) throw new Error(`station-luc.json: HTTP ${r.status}`)
      return r.json() as Promise<LucDenorm>
    })
  }
  return lucPromise
}

interface RidesV5Record {
  dt: number
  gender: string
  user_type: string
  bike_type: string
  count: number
  duration: number
}

// Reverse the build-side value remaps so both sources feed the chart
// identically (`ctbk/stations/trips_jsons.py` renamed Subscriber→Annual,
// Customer→Daily; genders are 0/1/2 in the legacy JSONs).
const GENDER_CODE: Record<string, number> = { unknown: 0, male: 1, female: 2 }
const USER_TYPE_NAME: Record<string, StationTripsRow['User Type']> = {
  Subscriber: 'Annual', Customer: 'Daily',
  Annual: 'Annual', Daily: 'Daily',
}

async function fetchV5Rows(shortName: string): Promise<StationTripsRow[]> {
  const luc = await loadLuc()
  const entry = luc.by_short_name[shortName]
  if (!entry) {
    console.warn(`useStationTrips[v5]: no LUC entry for short_name=${shortName}`)
    return []
  }
  // bbox is a required coarse filter on the endpoint; a small box around
  // the station suffices (the `cells=` predicate does the real work).
  const bbox = [entry.lat - 0.02, entry.lng - 0.02, entry.lat + 0.02, entry.lng + 0.02].join(',')
  // `to` quantized to next-month-start (matches `defaultTo()` in
  // `query/ridesV1.ts`): a ms-fresh `to` makes every request URL unique,
  // defeating the worker's CF edge cache entirely. Monthly bins make
  // anything finer meaningless anyway.
  const now = new Date()
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
  const rows = await Promise.all((['start', 'end'] as const).map(async (anchor) => {
    const url = new URL(`${API_BASE}/api/rides`)
    url.searchParams.set('anchor', anchor)
    url.searchParams.set('cells', entry.cell)
    url.searchParams.set('bbox', bbox)
    url.searchParams.set('from', V5_FROM)
    url.searchParams.set('to', to)
    url.searchParams.set('bin_budget', String(V5_BIN_BUDGET))
    const res = await fetch(url.toString())
    if (!res.ok) throw new Error(`rides [${anchor}]: HTTP ${res.status}`)
    const data = await res.json() as { records: RidesV5Record[] }
    return data.records.map((r): StationTripsRow => {
      const d = new Date(r.dt)
      return {
        Year: d.getUTCFullYear(),
        Month: d.getUTCMonth() + 1,
        Docking: anchor,
        Gender: GENDER_CODE[r.gender] ?? 0,
        'User Type': USER_TYPE_NAME[r.user_type] ?? 'Daily',
        'Rideable Type': r.bike_type,
        Count: r.count,
        Duration: r.duration,
      }
    })
  }))
  return rows.flat()
}

/** Fetch per-station trip rows from the `rides` pyramid (`/api/rides` by
 *  LUC cell). Returns null while loading, [] if no data, rows[] when ready. */
export function useStationTrips(shortName: string | null | undefined): {
  rows: StationTripsRow[] | null
  error: string | null
} {
  const [rows, setRows] = useState<StationTripsRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!shortName) { setRows(null); setError(null); return }
    let cancelled = false
    setRows(null)
    setError(null)

    const existing = rowsCache.get(shortName)
    const promise: Promise<StationTripsRow[]> = existing ?? fetchV5Rows(shortName)
    if (!existing) rowsCache.set(shortName, promise)

    promise
      .then((r) => { if (!cancelled) setRows(r) })
      .catch((e) => { if (!cancelled) setError(String(e)) })

    return () => { cancelled = true }
  }, [shortName])

  return { rows, error }
}
