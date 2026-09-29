import { FormControl, MenuItem, Select, SelectChangeEvent } from '@mui/material'
import { useUrlState, boolParam, cleanUrl, codeParam, llzParam, stringParam } from 'use-prms'
import type { LLZ, Param } from 'use-prms'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SpeedDial, useHotkeysContext } from 'use-kbd'
import {
  type Stations, type StationPairCounts, TILE_COLORS, resolveTileStyle,
} from '../components/stationMapCommon'
import { flowArcs, flowLens, type LensChannel, type FlowDirection } from '../components/flowLens'
import FlowLensLegend from '../components/FlowLensLegend'
import StationRidesPanel from '../components/StationRidesPanel'
import { RangeWidthControl } from '../components/RangeWidthControl'
import { useTheme } from '../contexts/ThemeContext'
import { useStationsKeyboardShortcuts } from '../hooks/useStationsKeyboardShortcuts'
import { useStationsOmnibarEndpoint } from '../hooks/useStationsOmnibarEndpoint'
import { selParam, useSelection, type SelAction } from '../lib/mapSelection'
import { useCanHover, useWide } from '../lib/useMediaQuery'
import { useTotalsQuery, type Side } from '../query/rollups'
import { timeRangeParam } from '../time-range'
import css from "../stations.module.css"

const DAY_MS = 24 * 60 * 60 * 1000
/** Default time window for the API-backed circles + `?pies=1` overlay: last
 *  30 days, so we don't run per-station queries against decades of data by
 *  default. Both modes share the `?pr=` URL state. */
const DEFAULT_PIES_DURATION = 30 * DAY_MS

/** URL codec for the side filter. Encoded as `s`/`e`/`b` to match other
 *  one-char URL params; decoded as `'start'`/`'end'`/`'both'`. Default `both`. */
const sideParam: Param<'start' | 'end' | 'both'> = {
  encode: (v) => (v === 'both' ? undefined : v === 'start' ? 's' : 'e'),
  decode: (raw) => (raw === 's' ? 'start' : raw === 'e' ? 'end' : 'both'),
}

/** Map renderers, each lazy so only the one in use is fetched (deck.gl +
 *  MapLibre for the default GL map, leaflet for `?gl=0`). */
const StationMapGL = lazy(() => import('../components/StationMapGL'))
const StationMap = lazy(() => import('../components/StationMap'))

/** `?gl=`: the GL map (deck.gl + MapLibre) is the default; `?gl=0` falls back
 *  to the Leaflet `StationMap`. Old `?gl=1` (and bare `?gl`) links still
 *  decode to GL. */
const glParam: Param<boolean> = {
  encode: (v) => (v ? undefined : '0'),
  decode: (raw) => raw !== '0' && raw !== 'false',
}

/** URL codec for the flow-lens channel (`?lens=`): `cr` (size + color,
 *  default), `c` (color only), `r` (size only), or `n` (off). The lens only
 *  activates once a source set is selected (`?sel=`), so the default stays
 *  invisible until then. */
const lensParam: Param<LensChannel> = {
  encode: (v) => (v === 'cr' ? undefined : v),
  decode: (raw) => (raw === 'c' || raw === 'r' || raw === 'n' ? raw : 'cr'),
}

const MANIFEST_URL = '/assets/station-urls.json'
const BIRTHS_URL = '/assets/station-births.json'
const DEFAULT_LLZ: LLZ = { lat: 40.758, lng: -73.965, zoom: 12 }
const DEFAULT_TILE_CODE = 'a'

/** `latLngDecimals: 3` matches the `Math.round(...*1000)/1000` rounding the
 *  Leaflet `onMove` handler historically applied to lat/lng. */
const viewParam = llzParam({ default: DEFAULT_LLZ, latLngDecimals: 3 })

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

/** URL codec for the `m` param: stored internally as `YYYYMM`, encoded as `YYMM`
 * (matches `MonthRangePicker`'s 2-digit year format elsewhere in the app).
 * Decodes legacy 6-char `YYYYMM` values for back-compat. */
const monthParam: Param<string | undefined> = {
  encode: (v) => (v ? v.slice(2) : undefined),
  decode: (raw) => {
    if (!raw) return undefined
    if (raw.length === 6) return raw
    return `20${raw}`
  },
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
  const monthSelectRef = useRef<HTMLSelectElement>(null)

  // URL parameters
  const [colorByAge, setColorByAge] = useUrlState('c', boolParam)
  const [view, setView] = useUrlState('ll', viewParam)
  const [selectedId, setSelectedId] = useUrlState('s', stringParam())
  const [month, setMonth] = useUrlState('m', monthParam)
  const [tileCode] = useUrlState('t', stringParam(DEFAULT_TILE_CODE))
  const [tileBase] = useUrlState('tileBase', stringParam())
  // POC: render each station as a starts-vs-ends pie. Strictly opt-in.
  const [pies] = useUrlState('pies', boolParam)
  const [pieRange, setPieRange] = useUrlState('pr', timeRangeParam(DEFAULT_PIES_DURATION))
  // Phase-1 of `specs/map-modes-and-ranges.md` — opt-in API-backed circle
  // counts (instead of monthly static `stations[ym].json`). When `?api=1`,
  // station counts come from `/api/totals?kind=trips&scope=stations` over the
  // window in `?pr=` (re-uses the pies range). `?side=s|e|b` filters to
  // start- or end-side trips only (default both).
  const [api] = useUrlState('api', boolParam)
  const [side, setSide] = useUrlState('side', sideParam)
  // Multi-select station set: click circles to toggle membership; the rides
  // panel below the map plots the set's starts/ends via `/api/rides`.
  // `push: true` → each selection edit is its own history entry, so browser
  // back/forward is the selection undo/redo buffer. Hover (`s`) stays on the
  // default replaceState, so sweeping the map never spams history.
  const [sel, setSel] = useUrlState('sel', selParam, { push: true })
  // Flow-lens channel(s) for the selected source set (color / radius / both).
  const [lens] = useUrlState('lens', lensParam)
  // Flow direction: `out` = where riders from the set go; `in` = where they
  // come from. `fan` toggles the (heavy) destination-line overlay, off by
  // default — the lens carries the flow signal and the fan stacks into a red
  // blob near the origin + costs a lot of SVG on hover.
  const [dir, setDir] = useUrlState('dir', codeParam<FlowDirection>('out', [['out', 'o'], ['in', 'i']]))
  const [fan] = useUrlState('fan', boolParam)
  const [gl] = useUrlState('gl', glParam)
  // Mark style on the GL map: solid `fill` (default) or hollow `ring`.
  const [mark] = useUrlState('mark', codeParam<'fill' | 'ring'>('fill', [['fill', 'f'], ['ring', 'r']]))
  // Live hover-preview: on the GL map, hovering a station (when nothing is
  // pinned) previews the lens for it — recoloring every station by that
  // station's flow. Cheap on the GPU; gated to `gl` (would thrash the SVG map)
  // and to hover-capable pointers (a tap is a selection, not a preview).
  const canHover = useCanHover()
  const [hoverPreviewId, setHoverPreviewId] = useState<string | null>(null)
  // Phones (`!wide`): title + lens legend fold into one compact header strip
  // (legend expands on tap), and the rides panel collapses to a bar (as on
  // `/timelapse`). `panelH` lifts the SpeedDial clear of the rides panel.
  const wide = useWide()
  const [legendOpen, setLegendOpen] = useState(false)
  const [panelH, setPanelH] = useState(0)
  // Selection (`lib/mapSelection`, shared with `/timelapse`): tap selects one,
  // tap on empty map / Esc clears, long-press enters multi-select (taps
  // toggle; Done / Clear), long-press- or shift-drag box-selects,
  // shift/⌘-click toggles. Each edit is a history entry (`push` above).
  const { multi, apply: applySel } = useSelection(sel, setSel)
  const onSelAction = useCallback((a: SelAction) => {
    // An empty-map tap that clears the set also drops the hover subtitle.
    if (a.t === 'tap' && a.id === null && !a.toggle && !multi) setSelectedId(undefined)
    applySel(a)
  }, [applySel, multi, setSelectedId])
  // Leaflet map: plain click = tap, meta/ctrl-click = toggle.
  const selectStation = useCallback(
    (id: string, additive: boolean) => onSelAction({ t: 'tap', id, toggle: additive }),
    [onSelAction],
  )

  // One-time legacy URL migration: ?lat=&lng=&z= → ?ll=lat+lng+zoom.
  // Each migrate callback reassembles the full `LLZ` from current URL
  // params (idempotent — running 1–3x produces the same `ll`). Drop the
  // old keys after.
  useEffect(() => {
    const migrate = () => {
      const sp = new URLSearchParams(window.location.search)
      return {
        ll: {
          lat: sp.has('lat') ? parseFloat(sp.get('lat')!) : DEFAULT_LLZ.lat,
          lng: sp.has('lng') ? parseFloat(sp.get('lng')!) : DEFAULT_LLZ.lng,
          zoom: sp.has('z') ? parseFloat(sp.get('z')!) : DEFAULT_LLZ.zoom,
        },
      }
    }
    cleanUrl({ ll: viewParam }, { deprecated: { lat: migrate, lng: migrate, z: migrate } })
  }, [])

  // Load manifest on mount
  useEffect(() => {
    fetch(MANIFEST_URL)
      .then(res => res.json())
      .then((m: Manifest) => setManifest(m))
      .catch(err => setError(err.message))
  }, [])

  // Effective month for rendering/data-fetching: URL value if set, else the
  // manifest's latest month. URL param stays absent when showing latest.
  const effectiveMonth = month ?? manifest?.latestMonth

  // Wrapped setter: write `undefined` when the new value is the latest month,
  // so the URL stays clean for the default view.
  const latestMonth = manifest?.latestMonth
  const setMonthSmart = useCallback((v: string | undefined) => {
    setMonth(!v || v === latestMonth ? undefined : v)
  }, [setMonth, latestMonth])

  // Load births data on mount
  useEffect(() => {
    fetch(BIRTHS_URL)
      .then(res => res.json())
      .then((data: StationBirths) => setBirths(data))
      .catch(err => console.warn('Failed to load station births:', err))
  }, [])

  // Load station data when effective month changes
  useEffect(() => {
    if (!manifest || !effectiveMonth) return

    const stationsUrl = manifest.stations[effectiveMonth]
    const pairsUrl = manifest.pairs[effectiveMonth]

    if (!stationsUrl) {
      setError(`No data for month ${effectiveMonth}`)
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
  }, [manifest, effectiveMonth])

  // API-backed counts (Phase 1). When `?api=1`, fetch
  // `/api/totals?kind=trips&scope=stations` over the active range and use
  // those counts in place of the monthly-static `stations[ym].json` `ends`.
  // `dims` is omitted (no `side` breakdown needed; the side filter is handled
  // server-side via `filter.side`).
  const apiTotals = useTotalsQuery({
    kind: 'trips',
    scope: 'stations',
    end: pieRange.timestamp,
    duration: pieRange.duration,
    filterSide: side === 'both' ? undefined : side as Side,
  })
  const apiCountByShortName = useMemo(() => {
    if (!api) return null
    const rows = apiTotals.data?.rows
    if (!rows) return null
    const m = new Map<string, number>()
    for (const row of rows) {
      const sn = row.short_name
      if (typeof sn !== 'string') continue
      const c = typeof row.count === 'number' ? row.count : 0
      m.set(sn, (m.get(sn) ?? 0) + c)
    }
    return m
  }, [api, apiTotals.data])

  // Stations object passed into the map: when `?api=1`, override `.ends` with
  // the API count for each station (or 0 if the API didn't return that station).
  const effectiveStations: Stations | null = useMemo(() => {
    if (!stations) return null
    if (!api || !apiCountByShortName) return stations
    const out: Stations = {}
    for (const [id, st] of Object.entries(stations)) {
      out[id] = { ...st, ends: apiCountByShortName.get(id) ?? 0 }
    }
    return out
  }, [stations, api, apiCountByShortName])

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

  // Flow lens: when a source set is selected (`?sel=`), restyle every other
  // station by the set's outbound flow. Computed over `effectiveStations` so
  // it covers exactly what the map renders. Takes precedence over color-by-age
  // for the color channel; also drives the radius channel when `?lens=` asks.
  // Lens source: the pinned set, or (GL only, nothing pinned) the hovered
  // station for a live preview.
  const lensSourceIds = sel.length ? sel : (gl && canHover && hoverPreviewId ? [hoverPreviewId] : [])
  const flowStyle = useMemo(
    () => (lensSourceIds.length && effectiveStations
      ? flowLens(effectiveStations, pairCounts, lensSourceIds, lens, dir)
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lensSourceIds.join(','), effectiveStations, pairCounts, lens, dir],
  )
  // GL arc fan (Stage 3): same `pairCounts` + source set + direction as the
  // lens; opt-in via `?fan=1`, like the Leaflet fan.
  const arcs = useMemo(
    () => (gl && fan && effectiveStations ? flowArcs(effectiveStations, pairCounts, lensSourceIds, dir) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gl, fan, lensSourceIds.join(','), effectiveStations, pairCounts, dir],
  )
  const effectiveColors = flowStyle?.colors ?? stationColors
  const effectiveRadii = flowStyle?.radii ?? null

  // Keyboard shortcuts
  const { openOmnibar } = useHotkeysContext()
  useStationsKeyboardShortcuts({
    month: effectiveMonth,
    setMonth: setMonthSmart,
    availableMonths,
    setSelectedId,
    clearSelection: () => applySel({ t: 'clear' }),
    openSearch: openOmnibar,
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
    setMonthSmart(e.target.value)
  }, [setMonthSmart])

  const tileStyle = resolveTileStyle(tileCode, actualTheme)
  const currentColors = TILE_COLORS[tileStyle]

  const subtitle = selectedId && stations?.[selectedId] ? stations[selectedId].name : null

  const lensLegend = (compact: boolean) => flowStyle && (
    <FlowLensLegend
      sourceNames={lensSourceIds.map((id) => stations?.[id]?.name ?? id)}
      channel={lens}
      direction={dir}
      onToggleDirection={() => setDir(dir === 'out' ? 'in' : 'out')}
      total={flowStyle.total}
      topCount={flowStyle.topCount}
      arcMax={arcs?.length ? arcs[arcs.length - 1].count : null}
      compact={compact}
      open={legendOpen}
      onToggleOpen={() => setLegendOpen(!legendOpen)}
    />
  )

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
        <Suspense fallback={<div className={css.homeMap} />}>
        {gl ? (
          <StationMapGL
            stations={effectiveStations ?? {}}
            pinnedIds={sel}
            onSelAction={onSelAction}
            multi={multi}
            pairCounts={pairCounts}
            stationColors={effectiveColors}
            stationRadii={effectiveRadii}
            mark={mark}
            arcs={arcs}
            setSelectedId={setSelectedId}
            onHoverStation={setHoverPreviewId}
            center={[view.lat, view.lng]}
            zoom={view.zoom}
            onMove={(la, ln, z) => setView({ lat: la, lng: ln, zoom: z })}
          />
        ) : (
        <StationMap
          stations={effectiveStations ?? {}}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          pinnedIds={sel}
          onTogglePin={selectStation}
          pairCounts={pairCounts}
          stationColors={effectiveColors}
          stationRadii={effectiveRadii}
          lensActive={!!flowStyle}
          showLines={fan}
          center={[view.lat, view.lng]}
          zoom={view.zoom}
          tileCode={tileCode}
          tileBase={tileBase}
          hoverToSelect
          onMove={(la, ln, z) => setView({ lat: la, lng: ln, zoom: z })}
          onClick={() => onSelAction({ t: 'tap', id: null, toggle: false })}
          pies={pies}
          pieRange={pies ? pieRange : undefined}
        />
        )}
        </Suspense>
        {(loading || (api && apiTotals.isPending && !apiTotals.data)) && (
          <div className={css.loading}>Loading...</div>
        )}
        {flowStyle && wide && lensLegend(false)}
        {colorByAge && births && !flowStyle && <ColorLegend births={births} actualTheme={actualTheme} />}
        {(pies || api) && (
          <div className={css.piesControl}>
            <RangeWidthControl value={pieRange} onChange={setPieRange} />
            {api && (
              <FormControl variant="standard" size="small">
                <Select
                  value={side}
                  onChange={(e) => setSide(e.target.value as 'start' | 'end' | 'both')}
                  disableUnderline
                >
                  <MenuItem value="both">starts + ends</MenuItem>
                  <MenuItem value="start">starts</MenuItem>
                  <MenuItem value="end">ends</MenuItem>
                </Select>
              </FormControl>
            )}
            {pies && (
              <span className={css.piesLegend}>
                <span className={css.piesSwatch} style={{ background: '#3498db' }} />
                starts
                <span className={css.piesSwatch} style={{ background: '#e67e22' }} />
                ends
              </span>
            )}
          </div>
        )}
        <div className={wide ? css.titleContainer : css.phoneHeader} style={wide ? { color: currentColors.title } : undefined} data-testid="stations-header">
          <div className={css.title}>
            <Link to="/" className={css.homeLink}>Citi Bike</Link> rides by station,{' '}
            {effectiveMonth && availableMonths.length > 0 ? (
              <FormControl variant="standard" className={css.monthSelect}>
                <Select
                  inputRef={monthSelectRef}
                  value={effectiveMonth}
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
              effectiveMonth ? formatMonth(effectiveMonth) : '...'
            )}
          </div>
          {subtitle && selectedId && (
            <Link to={`/s/${selectedId}`} className={css.subtitle} title="View station details">
              {subtitle}
            </Link>
          )}
          {!wide && lensLegend(true)}
        </div>
      </main>
      {sel.length > 0 && stations && (
        <StationRidesPanel
          shortNames={sel}
          stations={stations}
          onRemove={(id) => applySel({ t: 'remove', id })}
          onClear={() => applySel({ t: 'clear' })}
          multi={multi}
          onDone={() => applySel({ t: 'done' })}
          compact={!wide}
          onHeight={setPanelH}
        />
      )}
      {stations && (
        <SpeedDial
          ariaLabel="Search stations"
          position={sel.length > 0 && panelH ? { bottom: panelH + 12, right: wide ? 20 : 12 } : undefined}
        />
      )}
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

