import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Box, CircularProgress, Typography } from '@mui/material'
import StationAvailabilityChart from '../components/StationAvailabilityChart'
import StationMap, { type Stations, type StationPairCounts } from '../components/StationMap'
import StationTripsChart, { type TripsRow } from '../components/StationTripsChart'
import { useSmartPolling } from '../hooks/useSmartPolling'

const API_BASE = 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'
const MANIFEST_URL = '/assets/station-urls.json'

interface Row {
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

interface ApiResponse {
  station_id: string
  date: string
  rows: Row[]
  capacity: number | null
  last_polled_at: number | null
}

interface StationInfo {
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

interface Manifest {
  stations: Record<string, string>
  pairs: Record<string, string>
  latestMonth: string
}

/** Format YYYYMM → "MMM 'YY" (matches Stations.tsx) */
function formatMonth(yyyymm: string): string {
  const yr = yyyymm.substring(2, 4)
  const m = parseInt(yyyymm.substring(4))
  const monthName = new Date(2000, m - 1).toLocaleDateString('default', { month: 'short' })
  return `${monthName} '${yr}`
}

export default function StationDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [info, setInfo] = useState<StationInfo | null>(null)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stations, setStations] = useState<Stations | null>(null)
  const [pairCounts, setPairCounts] = useState<StationPairCounts | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [mapMonth, setMapMonth] = useState<string | null>(null)
  const [tripsRows, setTripsRows] = useState<TripsRow[] | null>(null)

  useEffect(() => {
    if (!id) return
    setData(null)
    setInfo(null)
    setError(null)

    fetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/info`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => {})

    fetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/today`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<ApiResponse>
      })
      .then(setData)
      .catch((e) => setError(String(e)))

    fetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/trips`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => setTripsRows(d.rows ?? []))
      .catch(() => setTripsRows([]))
  }, [id])

  // Smart polling: append new `today` rows synced to the GBFS poll cadence.
  // Uses `polled_at` as the mtime. Incremental fetch via `?since=<polled_at>`.
  const dataRef = useRef<ApiResponse | null>(null)
  useEffect(() => { dataRef.current = data }, [data])

  const refetchIncremental = useCallback(async () => {
    if (!id) return
    const lastPolled = dataRef.current?.last_polled_at
    if (!lastPolled) return
    const res = await fetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/today?since=${lastPolled}`)
    if (!res.ok) return
    const next = (await res.json()) as ApiResponse
    if (!next.rows.length) return
    setData((prev) => prev ? {
      ...prev,
      rows: [...prev.rows, ...next.rows],
      last_polled_at: next.last_polled_at ?? prev.last_polled_at,
    } : next)
  }, [id])

  const lastModifiedDate = useMemo(
    () => (data?.last_polled_at ? new Date(data.last_polled_at * 1000) : null),
    [data?.last_polled_at],
  )

  useSmartPolling({
    lastModified: lastModifiedDate,
    refetch: refetchIncremental,
    enabled: !!id && !!data,
    isLatestMode: true,  // /today is always "latest"; historical views aren't implemented yet
  })

  // Load manifest once; default mapMonth to latestMonth
  useEffect(() => {
    fetch(MANIFEST_URL)
      .then((r) => r.json())
      .then((m: Manifest) => {
        setManifest(m)
        setMapMonth((cur) => cur ?? m.latestMonth)
      })
      .catch((err) => console.warn('Failed to load manifest:', err))
  }, [])

  // (Re)load stations + pair data when mapMonth changes
  useEffect(() => {
    if (!manifest || !mapMonth) return
    const stationsUrl = manifest.stations[mapMonth]
    const pairsUrl = manifest.pairs[mapMonth]
    if (!stationsUrl) return
    setStations(null)
    setPairCounts(null)
    Promise.all([
      fetch(stationsUrl).then((r) => r.json()),
      pairsUrl ? fetch(pairsUrl).then((r) => r.json()) : Promise.resolve(null),
    ])
      .then(([stationsData, pairsData]) => {
        setStations(stationsData)
        if (pairsData) {
          // Pairs use index keys; convert to ID keys
          const stationIds = Object.keys(stationsData)
          const idx2id: Record<string, string> = {}
          stationIds.forEach((sid, idx) => { idx2id[idx.toString()] = sid })
          const converted: StationPairCounts = {}
          for (const [srcIdx, dsts] of Object.entries(pairsData as Record<string, Record<string, number>>)) {
            const srcId = idx2id[srcIdx]
            if (!srcId) continue
            converted[srcId] = {}
            for (const [dstIdx, count] of Object.entries(dsts)) {
              const dstId = idx2id[dstIdx]
              if (dstId) converted[srcId][dstId] = count
            }
          }
          setPairCounts(converted)
        }
      })
      .catch((err) => console.warn('Failed to load month data:', err))
  }, [manifest, mapMonth])

  // Sorted list of available months (newest first)
  const availableMonths = useMemo(() => {
    if (!manifest) return []
    return Object.keys(manifest.stations).sort().reverse()
  }, [manifest])

  // Set document title
  useEffect(() => {
    const name = info?.name ?? id
    document.title = name ? `${name} — ctbk.dev` : 'ctbk.dev'
    return () => { document.title = 'ctbk.dev - Citi Bike Dashboard' }
  }, [info?.name, id])

  // Redirect to canonical /s/<slug> URL if we landed on a non-canonical form
  // (covers: old /stations/:id route, UUID, short_name, or stale slug)
  useEffect(() => {
    if (!info?.slug || !id) return
    const onLegacyRoute = window.location.pathname.startsWith('/stations/')
    if (id !== info.slug || onLegacyRoute) {
      navigate(`/s/${info.slug}${window.location.search}${window.location.hash}`, { replace: true })
    }
  }, [info?.slug, id, navigate])

  if (!id) return <Box p={4}><Typography>No station ID in URL</Typography></Box>

  const title = info?.name ?? `Station ${id}`
  const subtitleParts: string[] = []
  if (info?.short_name) subtitleParts.push(`#${info.short_name}`)
  if (info?.capacity != null) subtitleParts.push(`${info.capacity} docks`)
  if (info?.station_type) subtitleParts.push(info.station_type)
  if (info?.first_seen) subtitleParts.push(`since ${info.first_seen}`)

  // Use station-history-sourced lat/lon for the map (so the marker matches the
  // pair-data dataset). Fall back to GBFS info if not yet loaded.
  const mapStations = stations ?? {}
  const mapShortName = info?.short_name
  const mapCenter: [number, number] | null =
    mapShortName && mapStations[mapShortName]
      ? [mapStations[mapShortName].lat, mapStations[mapShortName].lng]
      : info?.lat != null && info?.lon != null
        ? [info.lat, info.lon]
        : null

  return (
    <Box p={3} maxWidth={1200} mx="auto">
      <Typography variant="h5" gutterBottom>{title}</Typography>
      {subtitleParts.length > 0 && (
        <Typography variant="body2" color="text.secondary" gutterBottom>
          {subtitleParts.join(' · ')}
        </Typography>
      )}
      {info?.lat != null && info?.lon != null && (
        <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
          {info.lat.toFixed(5)}, {info.lon.toFixed(5)}
        </Typography>
      )}

      <Typography variant="body2" color="text.secondary" gutterBottom>
        {data ? `Today (${data.date}): ${data.rows.length} snapshots` : ''}
      </Typography>

      {error && (
        <Typography color="error">Error: {error}</Typography>
      )}

      {!data && !error && (
        <Box display="flex" justifyContent="center" p={4}><CircularProgress /></Box>
      )}

      {data && data.rows.length > 0 && (
        <StationAvailabilityChart rows={data.rows} capacity={info?.capacity ?? null} />
      )}

      {data && data.rows.length === 0 && (
        <Typography>No data yet for today.</Typography>
      )}

      {mapCenter && mapShortName && (
        <>
          <Box sx={{ height: 400, width: '100%', mt: 3, borderRadius: 1, overflow: 'hidden' }}>
            <StationMap
              stations={mapStations}
              selectedId={mapShortName}
              pairCounts={pairCounts}
              center={mapCenter}
              zoom={15}
              scrollWheelZoom={false}
              style={{ height: '100%', width: '100%' }}
              overlay={
                availableMonths.length > 0 && mapMonth ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, pointerEvents: 'auto' }}>
                    Citi Bike rides,{' '}
                    <select
                      value={mapMonth}
                      onChange={(e) => setMapMonth(e.target.value)}
                      style={{
                        background: 'transparent',
                        color: 'white',
                        border: '1px solid rgba(255,255,255,0.3)',
                        borderRadius: 3,
                        padding: '0 4px',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {availableMonths.map((m) => (
                        <option key={m} value={m} style={{ color: 'black' }}>{formatMonth(m)}</option>
                      ))}
                    </select>
                  </span>
                ) : null
              }
            />
          </Box>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            <a href={`/stations?lat=${mapCenter[0].toFixed(4)}&lng=${mapCenter[1].toFixed(4)}&z=16&s=${mapShortName}`}>
              view on full map →
            </a>
          </Typography>
        </>
      )}

      {tripsRows && tripsRows.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="subtitle1" gutterBottom>Monthly trips</Typography>
          <StationTripsChart rows={tripsRows} />
        </Box>
      )}
    </Box>
  )
}
