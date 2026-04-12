import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Box, CircularProgress, Typography } from '@mui/material'
import StationAvailabilityChart from '../components/StationAvailabilityChart'

const API_BASE = 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

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
}

interface StationInfo {
  short_name: string
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

export default function StationDetail() {
  const { id } = useParams<{ id: string }>()
  const [info, setInfo] = useState<StationInfo | null>(null)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [id])

  if (!id) return <Box p={4}><Typography>No station ID in URL</Typography></Box>

  const title = info?.name ?? `Station ${id}`
  const subtitleParts: string[] = []
  if (info?.short_name) subtitleParts.push(`#${info.short_name}`)
  if (info?.capacity != null) subtitleParts.push(`${info.capacity} docks`)
  if (info?.station_type) subtitleParts.push(info.station_type)
  if (info?.first_seen) subtitleParts.push(`since ${info.first_seen}`)

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
          {' · '}
          <a href={`/stations?ll=${info.lat.toFixed(3)}_${info.lon.toFixed(3)}_16&s=${info.short_name}`}>
            view on map
          </a>
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
    </Box>
  )
}
