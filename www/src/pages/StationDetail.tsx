import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Box, CircularProgress, Typography } from '@mui/material'
import css from '../index.module.css'
import controlCss from '../controls.module.css'
import StationAvailabilityChart from '../components/StationAvailabilityChart'
import { RangeWidthControl } from '../components/RangeWidthControl'
import StationMap, { type Stations, type StationPairCounts } from '../components/StationMap'
import YmrgtbChart from '../chart/YmrgtbChart'
import { processData } from '../chart/ymrgtb-traces'
import { Checkbox } from '../components/Checkbox'
import { Checklist } from '../components/Checklist'
import { Radios } from '../components/Radios'
import { useStationTrips } from '../hooks/useStationTrips'
import {
  type Docking, type StackBy, type YAxis,
  Dockings,
  Regions, UserTypes, Genders, GenderQueryStrings,
  RideableTypes, RideableTypeChars,
  UserTypeDisplayNames, UserTypeQueryStrings,
  codeParam, codesParam,
} from '../data'
import { boolParam, numberArrayParam, useUrlState } from 'use-prms'
import { formatTimeRange, timeRangeParam } from '../time-range'

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
  from?: number       // unix seconds (range mode)
  to?: number         // unix seconds (range mode)
  date?: string       // YYYY-MM-DD (single-day mode; legacy /today response)
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

  // Availability time range (URL param `r`; minute-granularity codec, default Latest + 1d).
  const [range, setRange] = useUrlState('r', timeRangeParam())

  useEffect(() => {
    if (!id) return
    setInfo(null)
    fetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/info`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => {})
  }, [id])

  // Use primitive deps — `useUrlState` returns a fresh `TimeRange` object each
  // render, which would retrigger this effect on every React render cycle.
  const rangeDuration = range.duration
  const rangeTimestampMs = range.timestamp?.getTime() ?? null
  useEffect(() => {
    if (!id) return
    setData(null)
    setError(null)
    const toMs = rangeTimestampMs ?? Date.now()
    const fromMs = toMs - rangeDuration
    const fromS = Math.floor(fromMs / 1000)
    const toS = Math.floor(toMs / 1000)
    fetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/range?from=${fromS}&to=${toS}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<ApiResponse>
      })
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [id, rangeDuration, rangeTimestampMs])

  // Load monthly trip history from the public DVX cache
  const { rows: tripsRows } = useStationTrips(info?.short_name)

  // Trips-chart controls (per-page URL params)
  const [tripsYAxis, setTripsYAxis] = useUrlState('ty', codeParam<YAxis>('Rides', [['Rides', 'r'], ['Ride minutes', 'm']]))
  const [tripsStackBy, setTripsStackBy] = useUrlState('ts', codeParam<StackBy>('Docking', [
    ['None', 'n'], ['Docking', 'd'], ['User Type', 'u'], ['Gender', 'g'], ['Rideable Type', 'b'],
  ]))
  const [tripsStackPercent, setTripsStackPercent] = useUrlState('tpct', boolParam)
  const [tripsUserTypes, setTripsUserTypes] = useUrlState('tu', codesParam(UserTypes, UserTypeQueryStrings))
  const [tripsGenders, setTripsGenders] = useUrlState('tg', codesParam(Genders, GenderQueryStrings))
  const [tripsRideableTypes, setTripsRideableTypes] = useUrlState('trt', codesParam(RideableTypes, RideableTypeChars))
  const [tripsRollingAvgs, setTripsRollingAvgs] = useUrlState('tavg', numberArrayParam([12]))
  const [tripsDockings, setTripsDockings] = useUrlState('td', codesParam<Docking>(Dockings, [['start', 's'], ['end', 'e']]))
  const [tripsControlsClosed, setTripsControlsClosed] = useUrlState('tcc', boolParam)

  // Preprocess rows for the shared `buildTraces` logic.
  // The per-station JSON has no Region column — default to NYC for all rows
  // (each station is in one region; cross-region filtering is a no-op here).
  const processedTripsRows = useMemo(() => {
    if (!tripsRows) return null
    return processData(tripsRows.map((r) => ({
      Year: r.Year, Month: r.Month, Count: r.Count, Duration: r.Duration,
      Region: 'NYC' as const,
      'User Type': r['User Type'],
      Gender: r.Gender,
      'Rideable Type': r['Rideable Type'],
      Docking: r.Docking,
    })))
  }, [tripsRows])

  // Smart polling temporarily disabled while migrating from /today to /range
  // (slice 4 of multi-scale work). Re-enable for Latest mode once the range
  // endpoint supports `?since=<polled_at>` — tracked in
  // `specs/multi-scale-ts-library.md`.

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
  // (covers: old /stations/:id route, UUID, short_name, or stale slug).
  // Guard against firing with stale info from the previous station — when the
  // id changes we null out info first, but React runs effects together and
  // this effect's `info` snapshot may still be the previous station's until
  // the next render. So verify info identifies the current URL id.
  useEffect(() => {
    if (!info?.slug || !id) return
    const matchesCurrentId =
      info.slug === id || info.short_name === id || info.gbfs_station_id === id
    if (!matchesCurrentId) return
    const onLegacyRoute = window.location.pathname.startsWith('/stations/')
    if (id !== info.slug || onLegacyRoute) {
      navigate(`/s/${info.slug}${window.location.search}${window.location.hash}`, { replace: true })
    }
  }, [info, id, navigate])

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
        {data ? `${data.rows.length.toLocaleString()} snapshots · ` : ''}
        {formatTimeRange(range)}
      </Typography>

      <Box my={1}>
        <RangeWidthControl value={range} onChange={setRange} />
      </Box>

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
              setSelectedId={(sid) => { if (sid && sid !== mapShortName) navigate(`/s/${sid}`) }}
              pairCounts={pairCounts}
              center={mapCenter}
              zoom={15}
              scrollWheelZoom
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

      {processedTripsRows && processedTripsRows.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="subtitle1" gutterBottom>Monthly trips</Typography>
          <YmrgtbChart
            rows={processedTripsRows}
            style={{ width: '100%', height: 500 }}
            config={{
              yAxis: tripsYAxis,
              stackBy: tripsStackBy,
              stackPercents: tripsStackPercent,
              regions: Regions,  // per-station files collapse region; filter is no-op
              userTypes: tripsUserTypes,
              genders: tripsGenders,
              rideableTypes: tripsRideableTypes,
              start: '2013-06',
              end: '2099-01',
              rollingAvgs: tripsRollingAvgs,
              extraFilter: (r) => !r.Docking || tripsDockings.includes(r.Docking),
            }}
          />
          <details
            className={css.controls}
            open={!tripsControlsClosed}
            onToggle={(e) => setTripsControlsClosed(!(e.target as HTMLDetailsElement).open)}
          >
            <summary style={{ paddingLeft: '1em' }}><span className={css.settingsGear}>⚙</span>️</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', paddingLeft: '1em' }}>
              <Radios
                label="Stack by"
                options={[
                  { label: 'None', data: 'None' },
                  { label: 'Docking', data: 'Docking' },
                  { label: 'User Type', data: 'User Type' },
                  { label: 'Bike Type', data: 'Rideable Type' },
                  { label: 'Gender', data: 'Gender' },
                ]}
                cb={setTripsStackBy}
                choice={tripsStackBy}
              />
              <Radios
                label="Y Axis"
                options={[
                  { label: 'Rides', data: 'Rides' },
                  { label: 'Minutes', data: 'Ride minutes' },
                ]}
                cb={setTripsYAxis}
                choice={tripsYAxis}
              />
              <div className={controlCss.control}>
                <Checkbox
                  label="12mo avg"
                  checked={tripsRollingAvgs.includes(12)}
                  cb={(v) => setTripsRollingAvgs(v ? [12] : [])}
                />
                <Checkbox
                  label="Stack %"
                  checked={tripsStackPercent}
                  cb={setTripsStackPercent}
                />
              </div>
              <Checklist
                label="Include"
                data={Dockings.map((d) => ({
                  name: d, label: d === 'start' ? 'Starts' : 'Ends', data: d,
                  checked: tripsDockings.includes(d),
                }))}
                cb={setTripsDockings}
              />
              <Checklist
                label="User Type"
                data={UserTypes.map((ut) => ({
                  name: ut, label: UserTypeDisplayNames[ut], data: ut,
                  checked: tripsUserTypes.includes(ut),
                }))}
                cb={setTripsUserTypes}
              />
              <Checklist
                label="Bike Type"
                data={RideableTypes.map((rt) => ({
                  name: rt, label: rt, data: rt,
                  checked: tripsRideableTypes.includes(rt),
                }))}
                cb={setTripsRideableTypes}
              />
              <Checklist
                label="Gender"
                data={Genders.map((g) => ({
                  name: g, label: g, data: g,
                  checked: tripsGenders.includes(g),
                }))}
                cb={setTripsGenders}
              />
            </div>
          </details>
        </Box>
      )}
    </Box>
  )
}
