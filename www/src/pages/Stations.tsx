import { FormControl, MenuItem, Select, SelectChangeEvent } from '@mui/material'
import { useUrlState, boolParam, floatParam, stringParam } from 'use-prms'
import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Circle, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { Link } from 'react-router-dom'
import { StationSearch } from '../components/StationSearch'
import { useTheme } from '../contexts/ThemeContext'
import { useStationsKeyboardShortcuts } from '../hooks/useStationsKeyboardShortcuts'
import { useStationsOmnibarEndpoint } from '../hooks/useStationsOmnibarEndpoint'
import css from "../stations.module.css"

const MANIFEST_URL = '/assets/station-urls.json'
const BIRTHS_URL = '/assets/station-births.json'
const DEFAULT_CENTER: [number, number] = [40.758, -73.965]
const DEFAULT_ZOOM = 12

const { sqrt, max } = Math

// Tile layer styles
type TileStyle = {
  name: string
  url: string
  attribution: string
}

const TILE_STYLES: Record<string, TileStyle> = {
  dark: {
    name: 'Dark',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  },
  light: {
    name: 'Light',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  },
  osm: {
    name: 'OSM',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
}

const DEFAULT_TILE_CODE = 'a'

// Short codes for URL params
// 'a' = auto (follows theme), 'd'/'l' = explicit dark/light, 'o' = OSM
const TILE_SHORT_CODES: [string, string][] = [
  ['d', 'dark'],
  ['l', 'light'],
  ['o', 'osm'],
]

// Map codes to style names (includes full names for backwards compatibility)
const TILE_CODES: Record<string, string> = Object.fromEntries([
  ...TILE_SHORT_CODES,
  ...TILE_SHORT_CODES.map(([, name]) => [name, name]),  // Accept full names too
])

// Resolve tile code to style name, handling 'auto' mode
function resolveTileStyle(tileCode: string | undefined, actualTheme: 'light' | 'dark'): string {
  const code = tileCode || DEFAULT_TILE_CODE
  // 'a' = auto: follow theme
  if (code === 'a' || code === 'auto') {
    return actualTheme === 'dark' ? 'dark' : 'light'
  }
  return TILE_CODES[code] || TILE_CODES[DEFAULT_TILE_CODE] || 'dark'
}

// Colors based on tile style (light vs dark backgrounds)
type TileColors = { circle: string; selected: string; line: string; title: string }
const TILE_COLORS: Record<string, TileColors> = {
  dark: { circle: 'orange', selected: 'yellow', line: 'red', title: 'white' },
  light: { circle: '#d35400', selected: '#c0392b', line: '#8e44ad', title: '#222' },
  osm: { circle: '#d35400', selected: '#c0392b', line: '#8e44ad', title: '#222' },
}

/** Format YYYYMM to "MMM 'YY" */
function formatMonth(yyyymm: string): string {
  const year = yyyymm.substring(2, 4)
  const m = parseInt(yyyymm.substring(4))
  const monthName = new Date(2000, m - 1).toLocaleDateString('default', { month: 'short' })
  return `${monthName} '${year}`
}

type StationValue = {
  name: string
  lat: number
  lng: number
  ends: number
}
type Stations = Record<string, StationValue>
type StationBirths = Record<string, string>
type StationPairCounts = Record<string, Record<string, number>>
type Manifest = {
  stations: Record<string, string>
  pairs: Record<string, string>
  latestMonth: string
}

/** Parse YYMMDD birth date string to timestamp. */
function parseBirthDate(yymmdd: string): number {
  const yy = parseInt(yymmdd.substring(0, 2))
  const mm = parseInt(yymmdd.substring(2, 4)) - 1
  const dd = parseInt(yymmdd.substring(4, 6))
  return new Date(2000 + yy, mm, dd).getTime()
}

/** Map a normalized t ∈ [0,1] to an HSL color string, yellow (hue 60) → red (hue 0). */
function birthColor(t: number, lightness: number): string {
  const hue = 60 * (1 - t)
  return `hsl(${hue}, 100%, ${lightness}%)`
}

function getMetersPerPixel(map: L.Map): number {
  const center = map.getCenter()
  const metersPerDegree = 111320 * Math.cos(center.lat * Math.PI / 180)
  const bounds = map.getBounds()
  const degreesPerPixel = (bounds.getEast() - bounds.getWest()) / map.getSize().x
  return metersPerDegree * degreesPerPixel
}

function StationMarkers({
  stations,
  selectedId,
  setSelectedId,
  pairCounts,
  colors,
  stationColors,
}: {
  stations: Stations
  selectedId: string | undefined
  setSelectedId: (id: string | undefined) => void
  pairCounts: StationPairCounts | null
  colors: { circle: string; selected: string; line: string }
  stationColors?: Record<string, string> | null
}) {
  const map = useMap()
  const zoom = map.getZoom()

  const selectedStation = selectedId ? stations[selectedId] : undefined

  // Calculate meters per pixel based on zoom
  const mPerPx = useMemo(() => getMetersPerPixel(map), [map, zoom])

  // Render destination lines when a station is selected
  const lines = useMemo(() => {
    if (!selectedStation || !selectedId || !pairCounts) return null
    if (!(selectedId in pairCounts)) {
      console.log(`${selectedId} not found among ${Object.keys(pairCounts).length} stations`)
      return null
    }
    const counts = pairCounts[selectedId]
    const maxCount = max(...Object.values(counts))
    const src = selectedStation

    return (
      <Pane name="lines" className={css.lines}>
        {Object.entries(counts).map(([dstId, count]) => {
          const dst = stations[dstId]
          if (!dst) return null

          const weight = max(0.7, (count / maxCount) * sqrt(src.ends) / mPerPx)

          return (
            <Polyline
              key={`${selectedId}-${dstId}-${zoom}-${colors.line}`}
              positions={[[src.lat, src.lng], [dst.lat, dst.lng]]}
              color={colors.line}
              weight={weight}
              opacity={0.7}
            >
              <Tooltip sticky>
                {src.name} → {dst.name}: {count}
              </Tooltip>
            </Polyline>
          )
        })}
      </Pane>
    )
  }, [selectedStation, selectedId, pairCounts, stations, mPerPx, zoom, colors])

  // Render selected station on top
  const selectedCircle = useMemo(() => {
    if (!selectedStation || !selectedId) return null
    const radius = sqrt(selectedStation.ends)
    if (isNaN(radius)) return null

    return (
      <Pane name="selected" className={css.selected}>
        <Circle
          key={`${selectedId}-${colors.selected}`}
          center={{ lat: selectedStation.lat, lng: selectedStation.lng }}
          color={colors.selected}
          radius={radius}
          bubblingMouseEvents={false}
          eventHandlers={{
            click: () => setSelectedId(undefined),
          }}
        >
          <Tooltip className={css.tooltip} sticky permanent pane="selected">
            <p>{selectedStation.name}: {selectedStation.ends.toLocaleString()}</p>
          </Tooltip>
        </Circle>
      </Pane>
    )
  }, [selectedStation, selectedId, setSelectedId, colors])

  // Render station circles
  const circles = useMemo(() => {
    return (
      <Pane name="circles" className={css.circles}>
        {Object.entries(stations).map(([id, station]) => {
          if (id === selectedId) return null
          const radius = sqrt(station.ends)
          if (isNaN(radius)) return null

          const circleColor = stationColors?.[id] ?? colors.circle
          return (
            <Circle
              key={`${id}-${circleColor}`}
              center={{ lat: station.lat, lng: station.lng }}
              color={circleColor}
              radius={radius}
              bubblingMouseEvents={false}
              eventHandlers={{
                click: () => setSelectedId(id),
                mouseover: () => {
                  if (id !== selectedId) setSelectedId(id)
                },
              }}
            >
              <Tooltip className={css.tooltip} sticky>
                <p>{station.name}: {station.ends.toLocaleString()}</p>
              </Tooltip>
            </Circle>
          )
        })}
      </Pane>
    )
  }, [stations, selectedId, setSelectedId, colors, stationColors])

  return (
    <>
      {selectedCircle}
      {lines}
      {circles}
    </>
  )
}

export default function Stations() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [stations, setStations] = useState<Stations | null>(null)
  const [pairCounts, setPairCounts] = useState<StationPairCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [births, setBirths] = useState<StationBirths | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const monthSelectRef = useRef<HTMLSelectElement>(null)

  // URL parameters
  const [colorByAge, setColorByAge] = useUrlState('c', boolParam)
  const [lat, setLat] = useUrlState('lat', floatParam(DEFAULT_CENTER[0]))
  const [lng, setLng] = useUrlState('lng', floatParam(DEFAULT_CENTER[1]))
  const [zoom, setZoom] = useUrlState('z', floatParam(DEFAULT_ZOOM))
  const [selectedId, setSelectedId] = useUrlState('s', stringParam())
  const [month, setMonth] = useUrlState('m', stringParam())
  const [tileCode] = useUrlState('t', stringParam(DEFAULT_TILE_CODE))
  const [tileBase] = useUrlState('tileBase', stringParam())

  // Load manifest on mount
  useEffect(() => {
    fetch(MANIFEST_URL)
      .then(res => res.json())
      .then((m: Manifest) => {
        setManifest(m)
        // Set default month if not specified
        if (!month) setMonth(m.latestMonth)
      })
      .catch(err => setError(err.message))
  }, [])

  // Load births data on mount
  useEffect(() => {
    fetch(BIRTHS_URL)
      .then(res => res.json())
      .then((data: StationBirths) => setBirths(data))
      .catch(err => console.warn('Failed to load station births:', err))
  }, [])

  // Load station data when month changes
  useEffect(() => {
    if (!manifest || !month) return

    const stationsUrl = manifest.stations[month]
    const pairsUrl = manifest.pairs[month]

    if (!stationsUrl) {
      setError(`No data for month ${month}`)
      return
    }

    setLoading(true)
    Promise.all([
      fetch(stationsUrl).then(r => r.json()),
      pairsUrl ? fetch(pairsUrl).then(r => r.json()) : Promise.resolve(null),
    ])
      .then(([stationsData, pairsData]) => {
        setStations(stationsData)
        // Convert pair data indices to IDs
        if (pairsData) {
          const stationIds = Object.keys(stationsData)
          const idx2id: Record<string, string> = {}
          stationIds.forEach((id, idx) => { idx2id[idx.toString()] = id })

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
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [manifest, month])

  // Get sorted list of available months (newest first)
  const availableMonths = useMemo(() => {
    if (!manifest) return []
    return Object.keys(manifest.stations).sort().reverse()
  }, [manifest])

  const { toggleTheme, actualTheme } = useTheme()

  // Compute per-station colors when color-by-age is active
  const stationColors = useMemo(() => {
    if (!colorByAge || !births || !stations) return null
    const lightness = actualTheme === 'dark' ? 55 : 45
    const stationIds = Object.keys(stations)
    const timestamps: number[] = []
    for (const id of stationIds) {
      const b = births[id]
      if (b) timestamps.push(parseBirthDate(b))
    }
    if (timestamps.length === 0) return null
    const minT = Math.min(...timestamps)
    const maxT = Math.max(...timestamps)
    const range = maxT - minT || 1
    const colors: Record<string, string> = {}
    for (const id of stationIds) {
      const b = births[id]
      if (b) {
        const t = (parseBirthDate(b) - minT) / range
        colors[id] = birthColor(t, lightness)
      }
    }
    return colors
  }, [colorByAge, births, stations, actualTheme])

  // Keyboard shortcuts
  const openSearch = useCallback(() => setIsSearchOpen(true), [])
  const closeSearch = useCallback(() => setIsSearchOpen(false), [])
  useStationsKeyboardShortcuts({
    month,
    setMonth,
    availableMonths,
    setSelectedId,
    openSearch,
    toggleTheme,
    monthSelectRef,
    colorByAge,
    setColorByAge,
  })

  // Register omnibar endpoint for station search (uses already-loaded data)
  useStationsOmnibarEndpoint({
    stations: stations || {},
    onSelect: setSelectedId,
    enabled: !!stations,
  })

  const handleMonthChange = useCallback((e: SelectChangeEvent<string>) => {
    setMonth(e.target.value)
  }, [setMonth])

  // Map code to full style name (handles 'auto' mode by using actualTheme)
  const tileStyle = resolveTileStyle(tileCode, actualTheme)
  const currentTile = TILE_STYLES[tileStyle]
  const tileUrl = tileBase ? `${tileBase}/{z}/{x}/{y}.png` : currentTile.url
  const currentColors = TILE_COLORS[tileStyle]

  const subtitle = selectedId && stations?.[selectedId] ? stations[selectedId].name : null

  if (error) {
    return (
      <div className={css.container}>
        <main className={css.main}>
          <h1>Error: {error}</h1>
          <Link to="/">← Back to Home</Link>
        </main>
      </div>
    )
  }

  return (
    <div className={css.container}>
      <main className={css.main}>
        <MapContainer
          center={[lat, lng]}
          zoom={zoom}
          className={css.homeMap}
          scrollWheelZoom
        >
          <TileLayer
            key={tileBase || tileCode}
            attribution={tileBase ? '' : currentTile.attribution}
            url={tileUrl}
            eventHandlers={{
              load: () => {
                document.querySelector('.leaflet-container')?.setAttribute('data-tiles-loaded', 'true')
              },
              tileerror: tileBase ? ((e: { tile: HTMLImageElement }) => {
                console.error(`[tileBase] Missing cached tile: ${e.tile.src}`)
              }) : undefined,
            }}
          />
          {stations && (
            <StationMarkers
              stations={stations}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              pairCounts={pairCounts}
              colors={currentColors}
              stationColors={stationColors}
            />
          )}
          <MapEvents setLat={setLat} setLng={setLng} setZoom={setZoom} setSelectedId={setSelectedId} />
        </MapContainer>
        {loading && <div className={css.loading}>Loading...</div>}
        {colorByAge && births && <ColorLegend births={births} actualTheme={actualTheme} />}
        {stations && (
          <StationSearch
            isOpen={isSearchOpen}
            onClose={closeSearch}
            stations={stations}
            onSelect={setSelectedId}
          />
        )}
        <div className={css.titleContainer} style={{ color: currentColors.title }}>
          <div className={css.title}>
            <Link to="/" className={css.homeLink}>Citi Bike</Link> rides by station,{' '}
            {month && availableMonths.length > 0 ? (
              <FormControl variant="standard" className={css.monthSelect}>
                <Select
                  inputRef={monthSelectRef}
                  value={month}
                  onChange={handleMonthChange}
                  disableUnderline
                  MenuProps={{
                    PaperProps: {
                      style: { maxHeight: 300 },
                    },
                  }}
                >
                  {availableMonths.map(m => (
                    <MenuItem key={m} value={m}>{formatMonth(m)}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : (
              month ? formatMonth(month) : '...'
            )}
          </div>
          {subtitle && <div className={css.subtitle}>{subtitle}</div>}
        </div>
      </main>
    </div>
  )
}

function ColorLegend({ births, actualTheme }: { births: StationBirths; actualTheme: 'light' | 'dark' }) {
  const { minDate, maxDate, lightness } = useMemo(() => {
    const timestamps = Object.values(births).map(parseBirthDate)
    const lightness = actualTheme === 'dark' ? 55 : 45
    return {
      minDate: new Date(Math.min(...timestamps)),
      maxDate: new Date(Math.max(...timestamps)),
      lightness,
    }
  }, [births, actualTheme])

  const gradient = `linear-gradient(to right, ${birthColor(0, lightness)}, ${birthColor(0.5, lightness)}, ${birthColor(1, lightness)})`

  const fmt = (d: Date) => d.toLocaleDateString('default', { month: 'short', year: 'numeric' })

  return (
    <div className={css.legend}>
      <div className={css.legendBar} style={{ background: gradient }} />
      <div className={css.legendLabels}>
        <span>{fmt(minDate)}</span>
        <span>Station birth date</span>
        <span>{fmt(maxDate)}</span>
      </div>
    </div>
  )
}

// Component to sync map position to URL and handle map clicks
function MapEvents({
  setLat,
  setLng,
  setZoom,
  setSelectedId,
}: {
  setLat: (v: number) => void
  setLng: (v: number) => void
  setZoom: (v: number) => void
  setSelectedId: (v: string | undefined) => void
}) {
  const map = useMap()

  useEffect(() => {
    const moveHandler = () => {
      const center = map.getCenter()
      setLat(Math.round(center.lat * 1000) / 1000)
      setLng(Math.round(center.lng * 1000) / 1000)
      setZoom(map.getZoom())
    }
    const clickHandler = () => {
      setSelectedId(undefined)
    }
    map.on('moveend', moveHandler)
    map.on('click', clickHandler)
    return () => {
      map.off('moveend', moveHandler)
      map.off('click', clickHandler)
    }
  }, [map, setLat, setLng, setZoom, setSelectedId])

  return null
}
