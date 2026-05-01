import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Box, CircularProgress, Typography } from '@mui/material'
import { useQueryClient } from '@tanstack/react-query'
import css from '../index.module.css'
import controlCss from '../controls.module.css'
import StationAvailabilityChart from '../components/StationAvailabilityChart'
import { RangeWidthControl } from '../components/RangeWidthControl'
import { BinSelect, BIN_PRESETS } from '../components/BinSelect'
import RidesTable from '../components/RidesTable'
import RollupTripsChart from '../components/RollupTripsChart'
import { TimeAgo } from '../components/TimeAgo'
import StationMap, { type Stations, type StationPairCounts } from '../components/StationMap'
import YmrgtbChart from '../chart/YmrgtbChart'
import { processData } from '../chart/ymrgtb-traces'
import { Checkbox } from '../components/Checkbox'
import { Checklist } from '../components/Checklist'
import { Radios } from '../components/Radios'
import { useSmartPolling } from '../hooks/useSmartPolling'
import { useStationTrips } from '../hooks/useStationTrips'
import {
  useStationInfo, useStationAvailability, stationsApi,
  type StationRangeResponse,
} from '../query/stations'
import { useRollupQuery, type Side } from '../query/rollups'
import {
  type DockingFilter, type StackBy, type YAxis,
  Regions, UserTypes, Genders, GenderQueryStrings,
  RideableTypes, RideableTypeChars,
  UserTypeDisplayNames, UserTypeQueryStrings,
  codeParam, codesParam,
} from '../data'
import { boolParam, intParam, numberArrayParam, stringParam, useUrlState } from 'use-prms'
import { bufferedBounds, formatTimeRange, roundDuration, timeRangeParam } from '../time-range'

const { API_BASE } = stationsApi
const MANIFEST_URL = '/assets/station-urls.json'

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

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS

/** Bin presets for the availability chart. Excludes very-fine sub-minute and
 *  very-coarse multi-month bins; both are noise for this UX. Sub-hour bins
 *  are present but disabled at runtime when range > 24h (see
 *  `availDisabledBins`) until the unified-API work lands. */
const AVAIL_BIN_PRESETS = BIN_PRESETS.filter(
  (p) => p.ms >= 60 * 1000 && p.ms <= MONTH_MS,
)

/** Bin sizes that should be disabled for the avail chart given current range.
 *  - sub-hour bins: only valid when range ≤ 24h (worker rejects bin < 3600
 *    on `/totals`; pending unified-API + /day raw to lift this).
 *  - bins ≥ range: would render < 2 points; disable.
 *  - bins that violate the current tier-floor (would request too many files)
 *    are still allowed but the worker handles them — we just trust the user.
 */
function availDisabledBins(rangeMs: number): ReadonlySet<number> {
  const out = new Set<number>()
  for (const p of AVAIL_BIN_PRESETS) {
    if (p.ms < HOUR_MS && rangeMs > DAY_MS) out.add(p.ms)
    if (p.ms >= rangeMs) out.add(p.ms)
  }
  return out
}

export default function StationDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [stations, setStations] = useState<Stations | null>(null)
  const [pairCounts, setPairCounts] = useState<StationPairCounts | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [mapMonth, setMapMonth] = useState<string | null>(null)

  // Availability time range (URL param `r`; minute-granularity codec, default Latest + 7d).
  const [range, setRange] = useUrlState('r', timeRangeParam(7 * 24 * 60 * 60 * 1000))
  // Availability bin width (URL param `b`; ms; 0 = Auto, mirrors `tripsBinMs`).
  const [binMs, setBinMs] = useUrlState('b', intParam(0))

  const { data: info } = useStationInfo(id)

  // Snapshot `Date.now()` once per range change — using it directly would
  // recompute `toS` every render in Latest mode, churning the query key.
  const rangeDuration = range.duration
  const rangeTimestampMs = range.timestamp?.getTime() ?? null
  const { fromS, toS } = useMemo(() => {
    const toMs = rangeTimestampMs ?? Date.now()
    const wantFrom = Math.floor((toMs - rangeDuration) / 1000)
    return {
      // Clip `from` at the genesis floor — there's no data before the scrape
      // start, so showing empty x-axis is wasted space.
      fromS: Math.max(GENESIS_S, wantFrom),
      toS: Math.floor(toMs / 1000),
    }
  }, [rangeDuration, rangeTimestampMs])

  // Fetch a quantum-rounded super-range of the visible window so drag-pan
  // within the buffer is instant (TSQ cache hit) and uPlot has data to
  // render in the edges as the user drags.
  //
  // Buffer factor: 0.5 for raw /range (≤24h) — generous, since we want
  // smooth drag-pan in minute-resolution data. 0.1 for binned /totals
  // (>24h) — the edge cache (60s TTL) handles refetches across drag, and
  // a generous buffer would tip us into reading more h1 daily shards than
  // the Worker can chew through in time. Default 7d view → ~7.7d buffered
  // (vs 14d w/ 0.5), keeps h1 file count under the cold-path budget.
  const [bufFromS, bufToS] = useMemo(() => {
    const visibleSpan = toS - fromS
    const factor = visibleSpan > 86400 ? 0.05 : 0.5
    const [f, t] = bufferedBounds(fromS, toS, factor)
    return [Math.max(GENESIS_S, f), t]
  }, [fromS, toS])

  // Smart availability hook: routes to `/range` (raw, ≤24h windows) or
  // `/totals?metric=all&bin=…` (binned, >24h windows) so the FE never asks
  // for more datapoints than the viewport can render.
  const [availViewportPx, setAvailViewportPx] = useState(() =>
    typeof window === 'undefined' ? 1000 : Math.max(400, Math.min(2000, window.innerWidth - 40))
  )
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        setAvailViewportPx(Math.max(400, Math.min(2000, window.innerWidth - 40)))
      }, 250)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [])
  const rangeQuery = useStationAvailability(
    id, info?.gbfs_station_id, bufFromS, bufToS, availViewportPx, info?.capacity ?? null,
    binMs > 0 ? Math.floor(binMs / 1000) : undefined,
  )
  const data = rangeQuery.data ?? null
  const error = rangeQuery.error ? String(rangeQuery.error) : null

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
  const [tripsDocking, setTripsDocking] = useUrlState('td', codeParam<DockingFilter>('both', [['both', 'b'], ['start', 's'], ['end', 'e']]))
  const [tripsControlsClosed, setTripsControlsClosed] = useUrlState('tcc', boolParam)

  // Feature flag for the multi-scale rollup backend (phase 1 — Worker endpoint
  // currently returns 404 for most stations since the R2 dataset hasn't been
  // built yet). Gate the new path with `?rollup=1`; default (flag off) keeps
  // the legacy `useStationTrips`-backed monthly chart.
  const [rollupEnabled] = useUrlState('rollup', boolParam)
  // Separate time range for the rollup trips chart (`?tr=...`), mirroring the
  // availability chart's `?r=...` codec but with a longer default (1 year) —
  // the trips endpoint covers years of data.
  const [tripsRange, setTripsRange] = useUrlState('tr', timeRangeParam(365 * 24 * 60 * 60 * 1000))
  // Bin size (ms). 0 = auto; any other value is explicit (matches BinSelect).
  const [tripsBinMs, setTripsBinMs] = useUrlState('tbin', intParam(0))
  // Rides-table pair filter: counterpart short_name. No UI yet — set manually
  // for testing (clicking a fan edge is a future iteration).
  const [ridesPair] = useUrlState('rt_pair', stringParam())

  // Compute unix-seconds range for the rides table, mirroring `tripsRange`.
  const tripsRangeDuration = tripsRange.duration
  const tripsRangeTimestampMs = tripsRange.timestamp?.getTime() ?? null
  const { ridesFromS, ridesToS } = useMemo(() => {
    const toMs = tripsRangeTimestampMs ?? Date.now()
    return {
      ridesFromS: Math.floor((toMs - tripsRangeDuration) / 1000),
      ridesToS: Math.floor(toMs / 1000),
    }
  }, [tripsRangeDuration, tripsRangeTimestampMs])

  // Translate `tripsDocking` (`both/start/end`) to the rides table's `side`.
  const ridesSide: 'start' | 'end' | undefined =
    tripsDocking === 'start' || tripsDocking === 'end' ? tripsDocking : undefined

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

  // Rollup path — only active when `?rollup=1`. Translates `tripsDocking`
  // (`both`/`start`/`end`) to the endpoint's `side` param (undefined for both).
  const rollupSide: Side | undefined =
    tripsDocking === 'start' || tripsDocking === 'end' ? tripsDocking : undefined
  // Map the existing `tripsStackBy` URL state onto the rollup endpoint's
  // `dims` query param. Returns one row per `(bin × dim)` instead of one
  // row per bin → enables stacked traces in `<RollupTripsChart>`.
  const rollupDims: string[] | undefined = (() => {
    switch (tripsStackBy) {
      case 'Docking': return ['side']
      case 'User Type': return ['user_type']
      case 'Gender': return ['gender']
      case 'Rideable Type': return ['rideable_type']
      default: return undefined
    }
  })()
  const rollupQuery = useRollupQuery({
    kind: 'trips',
    // `useRollupQuery` is internally-gated on `!!station || !!regions` — we
    // additionally gate on the feature flag by only reading the hook's result
    // when `rollupEnabled`.
    station: rollupEnabled ? info?.short_name : undefined,
    end: tripsRange.timestamp,
    duration: tripsRange.duration,
    binMs: tripsBinMs > 0 ? tripsBinMs : undefined,
    side: rollupSide,
    dims: rollupDims,
  })
  const rollupData = rollupQuery.data
  const rollupError = rollupQuery.error
    ? (rollupQuery.error instanceof Error ? rollupQuery.error.message : String(rollupQuery.error))
    : null
  // Worker returns 404 ("no data") until R2 parquet is populated. Distinguish
  // that from other errors so we can show a friendlier placeholder.
  const rollupNoData = rollupError?.startsWith('HTTP 404') ?? false

  // Smart polling: incremental refresh in Latest mode. In pinned mode
  // (`range.timestamp !== null`) the window is fixed, so polling is disabled.
  // Incremental rows are merged into the TSQ cache for the active query
  // (`['station-range', id, fromS, toS]`) so `useStationRange` consumers
  // see them without a full refetch.
  const isLatestMode = rangeTimestampMs === null
  // Live incremental refetch only fires in RAW mode (windows ≤ 24h). The
  // binned-mode path (`/totals?bin=…`) would need a different incremental
  // strategy (re-fold the latest bin) — out of scope; for windows > 24h
  // the user is in "history" mode and live refresh isn't meaningful.
  const queryKey = useMemo(
    () => ['station-avail', id, info?.gbfs_station_id, bufFromS, bufToS, 'raw'],
    [id, info?.gbfs_station_id, bufFromS, bufToS],
  )

  const refetchIncremental = useCallback(async () => {
    if (!id) return
    const prev = queryClient.getQueryData<StationRangeResponse>(queryKey)
    const lastPolled = prev?.last_polled_at
    if (!lastPolled) return
    const nowS = Math.floor(Date.now() / 1000)
    const res = await fetch(
      `${API_BASE}/api/stations/${encodeURIComponent(id)}/range` +
      `?from=${bufFromS}&to=${nowS}&since=${lastPolled}`
    )
    if (!res.ok) return
    const next = (await res.json()) as StationRangeResponse
    if (!next.rows.length) return
    queryClient.setQueryData<StationRangeResponse>(queryKey, (p) => p ? {
      ...p,
      rows: [...p.rows, ...next.rows],
      last_polled_at: next.last_polled_at ?? p.last_polled_at,
    } : next)
  }, [id, bufFromS, queryClient, queryKey])

  const lastModifiedDate = useMemo(
    () => (data?.last_polled_at ? new Date(data.last_polled_at * 1000) : null),
    [data?.last_polled_at],
  )

  // Polling only enabled in raw mode + Latest mode.
  const inRawMode = data?.useRaw === true
  useSmartPolling({
    lastModified: lastModifiedDate,
    refetch: refetchIncremental,
    enabled: !!id && !!data && isLatestMode && inRawMode,
    isLatestMode,
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

  const mapsUrl = info?.lat != null && info?.lon != null
    ? `https://www.google.com/maps?q=${info.lat},${info.lon}`
    : null

  return (
    <Box p={3} maxWidth={1200} mx="auto">
      <Typography variant="h5" gutterBottom>{title}</Typography>
      {(subtitleParts.length > 0 || mapsUrl) && (
        <Typography variant="body2" color="text.secondary" gutterBottom>
          {subtitleParts.join(' · ')}
          {mapsUrl && (
            <>
              {subtitleParts.length > 0 ? ' · ' : ''}
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
                Google Maps ↗
              </a>
            </>
          )}
        </Typography>
      )}

      <Typography variant="body2" color="text.secondary" gutterBottom>
        {data ? `${data.rows.length.toLocaleString()} snapshots · ` : ''}
        {formatTimeRange(range)}
        {data?.last_polled_at != null && (
          <>
            {' · '}
            <TimeAgo at={data.last_polled_at} prefix="updated" />
          </>
        )}
        {data && data.rows.length > 0 && fromS <= data.rows[0].ts + 0.05 * rangeDuration / 1000 && (
          <>
            {' · '}
            <span title="Scraping began on this date — no older data available">
              ⟵ start of data ({new Date(data.rows[0].ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})
            </span>
          </>
        )}
      </Typography>

      <Box my={1} display="flex" alignItems="center" gap={2} flexWrap="wrap">
        <RangeWidthControl value={range} onChange={setRange} />
        <BinSelect
          value={binMs > 0 ? binMs : undefined}
          onChange={(ms) => setBinMs(ms ?? 0)}
          presets={AVAIL_BIN_PRESETS}
          disabledMs={availDisabledBins(rangeDuration)}
          disabledTitle={'Sub-hour bins for ranges > 24h need the unified-API work (specs/avail-unified-api.md). Coming next.'}
        />
      </Box>

      {error && (
        <Typography color="error">Error: {error}</Typography>
      )}

      {!data && !error && (
        <Box display="flex" justifyContent="center" p={4}><CircularProgress /></Box>
      )}

      {data && data.rows.length > 0 && (
        <StationAvailabilityChart
          rows={data.rows}
          capacity={info?.capacity ?? null}
          visibleFromS={fromS}
          visibleToS={toS}
          binS={data.useRaw ? undefined : data.binS}
          onPan={(minS, maxS) => {
            const duration = roundDuration((maxS - minS) * 1000)
            const nowS = Date.now() / 1000
            // Snap to Latest when drag ends within 10 min of now (matches awair UX).
            const snapToLatest = maxS >= nowS - 10 * 60
            setRange({
              timestamp: snapToLatest ? null : new Date(maxS * 1000),
              duration,
            })
          }}
        />
      )}

      {data && data.rows.length === 0 && (
        <Typography>No data yet for today.</Typography>
      )}

      {/* OverviewAvailabilityChart was a separate "Mean bikes — daily bins"
        * plot showing the full station history. It's been folded into the
        * main chart's controls (Range + Bin selectors above) — pick e.g.
        * Range=1y, Bin=1d to reproduce that view. Removed 2026-05-01. */}

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

      {rollupEnabled && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="subtitle1" gutterBottom>
            Monthly trips <span style={{ fontSize: '0.75em', opacity: 0.6 }}>(rollup path)</span>
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1 }}>
            <RangeWidthControl value={tripsRange} onChange={setTripsRange} />
            <BinSelect
              value={tripsBinMs > 0 ? tripsBinMs : undefined}
              onChange={(ms) => setTripsBinMs(ms ?? 0)}
            />
            <Radios
              label="Include"
              options={[
                { label: 'Both', data: 'both' },
                { label: 'Starts', data: 'start' },
                { label: 'Ends', data: 'end' },
              ]}
              cb={setTripsDocking}
              choice={tripsDocking}
            />
          </Box>
          {rollupQuery.isPending && !rollupData && (
            <Typography variant="body2" sx={{ opacity: 0.65 }}>Loading rollup data…</Typography>
          )}
          {rollupNoData && (
            <Typography variant="body2" sx={{ opacity: 0.65 }}>
              No rollup data yet (backend in progress).
            </Typography>
          )}
          {rollupError && !rollupNoData && (
            <Typography color="error" variant="body2">Rollup error: {rollupError}</Typography>
          )}
          {rollupData && rollupData.rows.length > 0 && (
            <>
              <RollupTripsChart
                rows={rollupData.rows}
                binMs={rollupData.binMs}
                metric={tripsYAxis === 'Ride minutes' ? 'ride_minutes' : 'count'}
                height={500}
              />
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                tier: {rollupData.tier} · bin: {rollupData.binMs}ms · rows: {rollupData.rows.length.toLocaleString()}
              </Typography>
            </>
          )}
          {rollupData && rollupData.rows.length === 0 && !rollupQuery.isPending && (
            <Typography variant="body2" sx={{ opacity: 0.65 }}>No rows in window.</Typography>
          )}
          {info?.short_name && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" gutterBottom>
                Rides
                {ridesPair && (
                  <span style={{ fontSize: '0.75em', opacity: 0.7, marginLeft: 6 }}>
                    (paired with #{ridesPair})
                  </span>
                )}
              </Typography>
              <RidesTable
                station={info.short_name}
                counterpartStation={ridesPair}
                side={ridesSide}
                fromS={ridesFromS}
                toS={ridesToS}
              />
            </Box>
          )}
        </Box>
      )}

      {!rollupEnabled && processedTripsRows && processedTripsRows.length === 0 && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="subtitle1" gutterBottom>Monthly trips</Typography>
          <Typography variant="body2" sx={{ opacity: 0.65 }}>
            No monthly trip aggregations are indexed for this station yet.
          </Typography>
        </Box>
      )}

      {!rollupEnabled && processedTripsRows && processedTripsRows.length > 0 && (
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
              extraFilter: (r) => !r.Docking || tripsDocking === 'both' || r.Docking === tripsDocking,
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
              <Radios
                label="Include"
                options={[
                  { label: 'Both', data: 'both' },
                  { label: 'Starts', data: 'start' },
                  { label: 'Ends', data: 'end' },
                ]}
                cb={setTripsDocking}
                choice={tripsDocking}
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

/** Earliest UTC date for which any avail-agg shard exists (also the floor
 *  of any GBFS-availability query — older data simply doesn't exist). The
 *  compactor + backfill cover data from 2026-04-07 onward. */
const GENESIS_S = Math.floor(new Date('2026-04-07T00:00:00Z').getTime() / 1000)
