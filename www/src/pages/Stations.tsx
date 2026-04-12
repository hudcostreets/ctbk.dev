import { FormControl, MenuItem, Select, SelectChangeEvent } from '@mui/material'
import { useUrlState, boolParam, floatParam, stringParam } from 'use-prms'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { StationSearch } from '../components/StationSearch'
import StationMap, {
  type Stations, type StationPairCounts, TILE_COLORS, resolveTileStyle,
} from '../components/StationMap'
import { useTheme } from '../contexts/ThemeContext'
import { useStationsKeyboardShortcuts } from '../hooks/useStationsKeyboardShortcuts'
import { useStationsOmnibarEndpoint } from '../hooks/useStationsOmnibarEndpoint'
import css from "../stations.module.css"

const MANIFEST_URL = '/assets/station-urls.json'
const BIRTHS_URL = '/assets/station-births.json'
const DEFAULT_CENTER: [number, number] = [40.758, -73.965]
const DEFAULT_ZOOM = 12
const DEFAULT_TILE_CODE = 'a'

/** Format YYYYMM to "MMM 'YY" */
function formatMonth(yyyymm: string): string {
  const year = yyyymm.substring(2, 4)
  const m = parseInt(yyyymm.substring(4))
  const monthName = new Date(2000, m - 1).toLocaleDateString('default', { month: 'short' })
  return `${monthName} '${year}`
}

type StationBirths = Record<string, string>
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

  const tileStyle = resolveTileStyle(tileCode, actualTheme)
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
        <StationMap
          stations={stations ?? {}}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          pairCounts={pairCounts}
          stationColors={stationColors}
          center={[lat, lng]}
          zoom={zoom}
          tileCode={tileCode}
          tileBase={tileBase}
          hoverToSelect
          onMove={(la, ln, z) => { setLat(la); setLng(ln); setZoom(z) }}
          onClick={() => setSelectedId(undefined)}
        />
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

