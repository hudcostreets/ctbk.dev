import { useEffect, useMemo, useState } from 'react'
import { Circle, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useTheme } from '../contexts/ThemeContext'
import css from '../stations.module.css'

const { sqrt, max } = Math

export type StationValue = {
  name: string
  lat: number
  lng: number
  ends: number
}
export type Stations = Record<string, StationValue>
export type StationPairCounts = Record<string, Record<string, number>>

export type TileStyle = {
  name: string
  url: string
  attribution: string
}

export const TILE_STYLES: Record<string, TileStyle> = {
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

export type TileColors = { circle: string; selected: string; line: string; title: string }
export const TILE_COLORS: Record<string, TileColors> = {
  dark: { circle: 'orange', selected: 'yellow', line: 'red', title: 'white' },
  light: { circle: '#d35400', selected: '#c0392b', line: '#8e44ad', title: '#222' },
  osm: { circle: '#d35400', selected: '#c0392b', line: '#8e44ad', title: '#222' },
}

/** Resolve tile code (a/d/l/o or full names) to a style name, handling 'auto' mode. */
export function resolveTileStyle(tileCode: string | undefined, actualTheme: 'light' | 'dark'): string {
  const code = tileCode || 'a'
  if (code === 'a' || code === 'auto') return actualTheme === 'dark' ? 'dark' : 'light'
  if (code === 'd' || code === 'dark') return 'dark'
  if (code === 'l' || code === 'light') return 'light'
  if (code === 'o' || code === 'osm') return 'osm'
  return actualTheme === 'dark' ? 'dark' : 'light'
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
  hoverToSelect,
}: {
  stations: Stations
  selectedId?: string
  setSelectedId?: (id: string | undefined) => void
  pairCounts?: StationPairCounts | null
  colors: TileColors
  stationColors?: Record<string, string> | null
  hoverToSelect?: boolean
}) {
  const map = useMap()
  const zoom = map.getZoom()

  const selectedStation = selectedId ? stations[selectedId] : undefined
  const mPerPx = useMemo(() => getMetersPerPixel(map), [map, zoom])

  // Suppress the permanent selected-station tooltip while the cursor is over a
  // destination line — otherwise both tooltips pile up at the source station,
  // overlapping awkwardly.
  const [hoveringLine, setHoveringLine] = useState(false)

  const lines = useMemo(() => {
    if (!selectedStation || !selectedId || !pairCounts) return null
    if (!(selectedId in pairCounts)) return null
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
              eventHandlers={{
                mouseover: () => setHoveringLine(true),
                mouseout: () => setHoveringLine(false),
              }}
            >
              <Tooltip sticky>{src.name} → {dst.name}: {count}</Tooltip>
            </Polyline>
          )
        })}
      </Pane>
    )
  }, [selectedStation, selectedId, pairCounts, stations, mPerPx, zoom, colors])

  // Selected-station overlay: visual-only (pointer-events: none via `.selected`
  // CSS). Clicks pass through to the base Circle in the `circles` Pane below,
  // so the target Circle stays mounted between hover and click — avoiding the
  // unmount/remount race that caused clicks to fall through to the map.
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
          interactive={false}
        >
          {!hoveringLine && (
            <Tooltip className={css.tooltip} sticky permanent pane="selected">
              <p>{selectedStation.name}{selectedStation.ends > 0 ? `: ${selectedStation.ends.toLocaleString()}` : ''}</p>
            </Tooltip>
          )}
        </Circle>
      </Pane>
    )
  }, [selectedStation, selectedId, colors, hoveringLine])

  const circles = useMemo(() => {
    return (
      <Pane name="circles" className={css.circles}>
        {Object.entries(stations).map(([id, station]) => {
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
              eventHandlers={setSelectedId ? {
                click: () => setSelectedId(id),
                ...(hoverToSelect ? { mouseover: () => { if (id !== selectedId) setSelectedId(id) } } : {}),
              } : undefined}
            >
              <Tooltip className={css.tooltip} sticky>
                <p>{station.name}{station.ends > 0 ? `: ${station.ends.toLocaleString()}` : ''}</p>
              </Tooltip>
            </Circle>
          )
        })}
      </Pane>
    )
  }, [stations, selectedId, setSelectedId, colors, stationColors, hoverToSelect])

  return <>{selectedCircle}{lines}{circles}</>
}

/** Sync map view to URL state (or via callbacks). */
function MapEvents({
  onMove,
  onClick,
}: {
  onMove?: (lat: number, lng: number, zoom: number) => void
  onClick?: () => void
}) {
  const map = useMap()
  useEffect(() => {
    const moveHandler = onMove ? () => {
      const c = map.getCenter()
      onMove(Math.round(c.lat * 1000) / 1000, Math.round(c.lng * 1000) / 1000, map.getZoom())
    } : null
    if (moveHandler) map.on('moveend', moveHandler)
    if (onClick) map.on('click', onClick)
    return () => {
      if (moveHandler) map.off('moveend', moveHandler)
      if (onClick) map.off('click', onClick)
    }
  }, [map, onMove, onClick])
  return null
}

export interface StationMapProps {
  stations: Stations
  selectedId?: string
  setSelectedId?: (id: string | undefined) => void
  pairCounts?: StationPairCounts | null
  stationColors?: Record<string, string> | null

  center: [number, number]
  zoom: number
  tileCode?: string         // 'a' | 'd' | 'l' | 'o' (or full names)
  tileBase?: string         // optional: base URL for tile cache

  /** Notify parent of pan/zoom (use to sync URL). */
  onMove?: (lat: number, lng: number, zoom: number) => void
  /** Notify parent of map background click (use to clear selection). */
  onClick?: () => void

  scrollWheelZoom?: boolean
  hoverToSelect?: boolean   // if true, hover circles set selection (default false; mouse-friendly)
  className?: string
  style?: React.CSSProperties
  /** Optional overlay rendered top-right (e.g. for month label / context). */
  overlay?: React.ReactNode
}

export default function StationMap({
  stations,
  selectedId,
  setSelectedId,
  pairCounts,
  stationColors,
  center,
  zoom,
  tileCode,
  tileBase,
  onMove,
  onClick,
  scrollWheelZoom = true,
  hoverToSelect = false,
  className,
  style,
  overlay,
}: StationMapProps) {
  const { actualTheme } = useTheme()
  const tileStyle = resolveTileStyle(tileCode, actualTheme)
  const currentTile = TILE_STYLES[tileStyle]
  const tileUrl = tileBase ? `${tileBase}/{z}/{x}/{y}.png` : currentTile.url
  const colors = TILE_COLORS[tileStyle]

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
    <MapContainer
      center={center}
      zoom={zoom}
      className={className ?? css.homeMap}
      style={style}
      scrollWheelZoom={scrollWheelZoom}
    >
      <TileLayer
        key={tileBase || tileCode}
        attribution={tileBase ? '' : currentTile.attribution}
        url={tileUrl}
        eventHandlers={{
          load: () => {
            document.querySelector('.leaflet-container')?.setAttribute('data-tiles-loaded', 'true')
          },
        }}
      />
      <StationMarkers
        stations={stations}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        pairCounts={pairCounts}
        colors={colors}
        stationColors={stationColors}
        hoverToSelect={hoverToSelect}
      />
      {(onMove || onClick) && <MapEvents onMove={onMove} onClick={onClick} />}
    </MapContainer>
    {overlay && (
      <div style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.65)',
        color: 'white',
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 12,
        pointerEvents: 'none',
        backdropFilter: 'blur(4px)',
      }}>
        {overlay}
      </div>
    )}
    </div>
  )
}
