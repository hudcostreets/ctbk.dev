/**
 * Loads per-station monthly trip data (`ymdgtb_cd.json`) from the
 * public DVX cache in S3. Uses the build-time-generated
 * `ymdgtb-index.json` to resolve short_name → content-addressed URL.
 */
import { useEffect, useState } from 'react'

const INDEX_URL = '/ymdgtb-index.json'
const S3_BASE = 'https://ctbk.s3.amazonaws.com/.dvc/files/md5'

export interface TripsIndex {
  dir_md5: string
  files: Record<string, string>  // short_name -> md5
}

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

function trips_url(md5: string): string {
  return `${S3_BASE}/${md5.slice(0, 2)}/${md5.slice(2)}`
}

// Module-level caches — same station page across navigations hits these.
let indexPromise: Promise<TripsIndex> | null = null
const rowsCache = new Map<string, Promise<StationTripsRow[]>>()

function loadIndex(): Promise<TripsIndex> {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL).then((r) => {
      if (!r.ok) throw new Error(`ymdgtb-index.json: HTTP ${r.status}`)
      return r.json() as Promise<TripsIndex>
    })
  }
  return indexPromise
}

/** Fetch per-station trip rows. Returns null while loading, [] if no data, rows[] when ready. */
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
    const promise: Promise<StationTripsRow[]> = existing ?? (async () => {
      const index = await loadIndex()
      const md5 = index.files[shortName]
      if (!md5) return []
      const res = await fetch(trips_url(md5))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<StationTripsRow[]>
    })()

    if (!existing) rowsCache.set(shortName, promise)

    promise
      .then((r) => { if (!cancelled) setRows(r) })
      .catch((e) => { if (!cancelled) setError(String(e)) })

    return () => { cancelled = true }
  }, [shortName])

  return { rows, error }
}
