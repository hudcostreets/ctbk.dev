/**
 * GPU station map (deck.gl over a MapLibre raster basemap) — Stage 1 of the
 * migration off react-leaflet SVG (see `specs/unified-page-architecture.md`
 * "Rendering architecture"). Renders all ~2,700 stations as ONE instanced
 * `ScatterplotLayer` with GPU picking, fed by the same `stationColors` the
 * flow lens produces — so recolor is a GPU attribute update (`updateTriggers`),
 * not a re-mount of thousands of SVG nodes.
 *
 * MapLibre owns the map + camera (root `<Map>`); deck.gl is layered on via a
 * `MapboxOverlay` control (overlaid, in its own canvas above the basemap — see
 * `DeckOverlay`). Picking is GPU-based (`pickable`), so the old invisible
 * hit-circle hack is gone. Stage 3 adds the `ArcLayer` flow fan (`arcs`).
 *
 * Opt-in via `?gl=1` on `/stations` while it reaches parity with `StationMap`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Map as MaplibreMap, useControl, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { ArcLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { Map as MaplibreMapInstance, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useTheme } from '../contexts/ThemeContext'
import css from '../stations.module.css'
import type { Stations, StationPairCounts } from './StationMap'
import { rampRgb, type FlowArc } from './flowLens'

const { round, sqrt, max } = Math

type RGBA = [number, number, number, number]

/** Arc tilt (degrees): rotates each arc's plane off vertical so it reads as a
 *  curve from straight above (a 0-tilt arc is a straight line at pitch 0). */
const ARC_TILT = 90

/** Parse `#rrggbb` → `[r,g,b]`. Falls back to mid-grey on anything unexpected. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [136, 136, 136]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Raster basemap style (Stadia tiles — the same ones the react-leaflet map
 * uses, so they're already allowlisted for this origin). Deliberately raster,
 * not a CARTO vector style: under Vite the maplibre vector-tile worker wasn't
 * running (style + TileJSON + sprite load 200, but zero .mvt tiles ever
 * requested → black map). Raster tiles decode on the main thread, so they
 * render regardless. Revisit CARTO vector once the worker is sorted.
 */
function rasterStyle(dark: boolean): StyleSpecification {
  const url = dark
    ? 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png'
    : 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png'
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [url], tileSize: 256 } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  }
}

type StationDatum = {
  id: string
  name: string
  ends: number
  position: [number, number]
  color: RGBA
}

/** deck.gl layers as a MapLibre control, updated in place each render. */
function DeckOverlay({ layers }: { layers: Layer[] }) {
  // Overlaid (not interleaved): deck renders in its own canvas ABOVE maplibre's
  // basemap canvas. Interleaved mode (deck drawing into maplibre's GL context)
  // left the basemap unpainted here — tiles fetched 200 but never composited.
  // Overlaid is exactly the stacking we want (marks over basemap) anyway.
  const overlay = useControl(() => new MapboxOverlay({ interleaved: false, layers }))
  overlay.setProps({ layers })
  return null
}

export interface StationMapGLProps {
  stations: Stations
  selectedId?: string
  pinnedIds?: readonly string[]
  /** Multi-select toggle: `additive` (meta/ctrl-click) adds/removes; a plain
   *  click replaces the set with this station. */
  onTogglePin?: (id: string, additive: boolean) => void
  /** Replace the selection set with these ids (rectangle/region select). */
  onSelectSet?: (ids: string[], additive: boolean) => void
  pairCounts?: StationPairCounts | null
  /** Per-station fill color (hex) from the flow lens / color-by-age. */
  stationColors?: Record<string, string> | null
  /** Per-station radius override in pixels (flow-lens radius channel). */
  stationRadii?: Record<string, number> | null
  /** Mark style: solid `fill` (default) or hollow `ring`. */
  mark?: 'fill' | 'ring'
  /** Flow-arc fan (Stage 3): one `ArcLayer` arc per directed pair between the
   *  lens source set and other stations (`flowArcs`). Null/empty = no fan. */
  arcs?: readonly FlowArc[] | null
  /** Transient hover selection (drives the title-bar subtitle link). */
  setSelectedId?: (id: string | undefined) => void
  /** Hovered station id → parent, for the live hover-preview lens. */
  onHoverStation?: (id: string | null) => void
  center: [number, number]
  zoom: number
  onMove?: (lat: number, lng: number, zoom: number) => void
  onClick?: () => void
  overlay?: ReactNode
}

export default function StationMapGL({
  stations,
  pinnedIds,
  onTogglePin,
  onSelectSet,
  pairCounts,
  stationColors,
  stationRadii,
  mark = 'fill',
  arcs,
  setSelectedId,
  onHoverStation,
  center,
  zoom,
  onMove,
  onClick,
  overlay,
}: StationMapGLProps) {
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'
  const mapStyle = useMemo(() => rasterStyle(dark), [dark])

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // Read by the click handler: hover fires before click at the same point, so
  // this reliably says which station (if any) is under the cursor at click.
  const hoveredIdRef = useRef<string | null>(null)
  // Set when a station's layer onClick fires, so the map's empty-space click
  // handler knows not to clear the selection for that same click.
  const justPickedRef = useRef(0)
  const mapRef = useRef<MaplibreMapInstance | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Rectangle-select drag box (container-relative px), or null when inactive.
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // Latest values for the (once-attached) box-select listeners.
  const stationsRef = useRef(stations)
  stationsRef.current = stations
  const onSelectSetRef = useRef(onSelectSet)
  onSelectSetRef.current = onSelectSet

  // Rectangle select: shift-drag a box → select every station inside it.
  // Capture-phase mousedown so we can suppress maplibre's pan before it starts
  // (and toggle `dragPan` off for the gesture). Corners are unprojected to a
  // lng/lat bbox; meta/ctrl adds to the set instead of replacing.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let start: { x: number; y: number } | null = null
    const rel = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onDown = (e: MouseEvent) => {
      if (!e.shiftKey || e.button !== 0 || !mapRef.current) return
      e.preventDefault()
      e.stopPropagation()
      start = rel(e)
      setBox({ x0: start.x, y0: start.y, x1: start.x, y1: start.y })
      mapRef.current.dragPan.disable()
    }
    const onMove = (e: MouseEvent) => {
      if (!start) return
      const p = rel(e)
      setBox({ x0: start.x, y0: start.y, x1: p.x, y1: p.y })
    }
    const onUp = (e: MouseEvent) => {
      if (!start) return
      const map = mapRef.current
      const p = rel(e)
      const [x0, y0] = [start.x, start.y]
      start = null
      setBox(null)
      if (!map) return
      map.dragPan.enable()
      if (Math.abs(p.x - x0) < 3 || Math.abs(p.y - y0) < 3) return
      const a = map.unproject([Math.min(x0, p.x), Math.min(y0, p.y)])
      const b = map.unproject([Math.max(x0, p.x), Math.max(y0, p.y)])
      const [latMin, latMax] = [Math.min(a.lat, b.lat), Math.max(a.lat, b.lat)]
      const [lngMin, lngMax] = [Math.min(a.lng, b.lng), Math.max(a.lng, b.lng)]
      const ids = Object.entries(stationsRef.current)
        .filter(([, s]) => s.lat >= latMin && s.lat <= latMax && s.lng >= lngMin && s.lng <= lngMax)
        .map(([id]) => id)
      if (ids.length) onSelectSetRef.current?.(ids, e.metaKey || e.ctrlKey)
    }
    el.addEventListener('mousedown', onDown, true)
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    return () => {
      el.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
    }
  }, [])

  const defaultColor: RGBA = dark ? [230, 126, 34, 180] : [211, 84, 0, 170]

  const data = useMemo<StationDatum[]>(() => {
    const out: StationDatum[] = []
    for (const [id, s] of Object.entries(stations)) {
      if (typeof s.lat !== 'number' || typeof s.lng !== 'number') continue
      const hex = stationColors?.[id]
      const color: RGBA = hex ? [...hexToRgb(hex), 210] : defaultColor
      out.push({ id, name: s.name, ends: s.ends, position: [s.lng, s.lat], color })
    }
    return out
  }, [stations, stationColors, dark])

  // Changes whenever any fill could change → deck re-runs ONLY getFillColor
  // (re-uploads that one attribute buffer), never geometry.
  const colorTrigger = useMemo(
    () => `${dark}:${stationColors ? JSON.stringify(Object.entries(stationColors).slice(0, 3)) + Object.keys(stationColors).length : 'none'}`,
    [stationColors, dark],
  )

  const pinSet = useMemo(() => new Set(pinnedIds ?? []), [pinnedIds])
  const pinData = useMemo<StationDatum[]>(() => data.filter((d) => pinSet.has(d.id)), [data, pinSet])

  const ring = mark === 'ring'
  // Radius channel: lens pixel-radii when present, else data-proportional
  // meters (radiusUnits is per-layer, so the whole layer switches units).
  const radiusUnits = stationRadii ? 'pixels' : 'meters'
  const radiusTrigger = stationRadii ? `px:${Object.keys(stationRadii).length}` : 'm'

  // Arc fan: under the station dots, non-pickable (pure decoration, like the
  // Leaflet fan's `interactive={false}` edges). Each arc runs origin →
  // destination in riding direction and fades in along its length (faint at
  // the origin, full ramp color at the destination), so direction reads
  // without arrowheads and the origin doesn't pile up into a solid blob.
  // Width + color both by rank/volume; tilted so arcs curve visibly even in
  // the top-down (pitch 0) view.
  const arcMax = arcs?.length ? arcs[arcs.length - 1].count : 1
  const arcLayer = arcs?.length ? new ArcLayer<FlowArc>({
    id: 'flow-arcs',
    data: arcs as FlowArc[],
    getSourcePosition: (d) => d.source,
    getTargetPosition: (d) => d.target,
    getSourceColor: (d) => [...rampRgb(d.t), 40],
    getTargetColor: (d) => [...rampRgb(d.t), 230],
    getWidth: (d) => 1 + 5 * sqrt(d.count / arcMax),
    widthUnits: 'pixels',
    getHeight: 0.35,
    getTilt: ARC_TILT,
    pickable: false,
  }) : null

  const layers: Layer[] = [
    ...(arcLayer ? [arcLayer] : []),
    new ScatterplotLayer<StationDatum>({
      id: 'stations',
      data,
      getPosition: (d) => d.position,
      getRadius: (d) => (stationRadii ? (stationRadii[d.id] ?? 8) : sqrt(max(d.ends, 1))),
      radiusUnits,
      radiusMinPixels: 3,
      radiusMaxPixels: 40,
      getFillColor: (d) => d.color,
      getLineColor: (d) => d.color,
      filled: !ring,
      stroked: ring,
      lineWidthUnits: 'pixels',
      getLineWidth: ring ? 1.5 : 0,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
      onHover: (info: PickingInfo<StationDatum>) => {
        const id = info.object?.id ?? null
        hoveredIdRef.current = id
        setHoveredId(id)
        onHoverStation?.(id)
        if (id) setSelectedId?.(id)
      },
      onClick: (info, e) => {
        if (!info.object) return
        justPickedRef.current = Date.now()
        const oe = (e as { srcEvent?: MouseEvent }).srcEvent
        onTogglePin?.(info.object.id, !!(oe?.metaKey || oe?.ctrlKey))
      },
      updateTriggers: { getFillColor: colorTrigger, getLineColor: colorTrigger, getRadius: radiusTrigger },
    }),
    new ScatterplotLayer<StationDatum>({
      id: 'pins-halo',
      data: pinData,
      getPosition: (d) => d.position,
      getRadius: (d) => sqrt(max(d.ends, 1)),
      radiusUnits: 'meters',
      radiusMinPixels: 8,
      radiusMaxPixels: 46,
      filled: false,
      stroked: true,
      getLineColor: [255, 255, 255, 230],
      lineWidthMinPixels: 5,
      pickable: false,
    }),
    new ScatterplotLayer<StationDatum>({
      id: 'pins',
      data: pinData,
      getPosition: (d) => d.position,
      getRadius: (d) => sqrt(max(d.ends, 1)),
      radiusUnits: 'meters',
      radiusMinPixels: 8,
      radiusMaxPixels: 46,
      filled: false,
      stroked: true,
      getLineColor: [233, 30, 99, 255],
      lineWidthMinPixels: 3,
      pickable: false,
    }),
  ]

  const hovered = hoveredId ? stations[hoveredId] : null
  const sourceIds = pinnedIds && pinnedIds.length ? pinnedIds : []
  const hoveredFlow = hovered && hoveredId && pairCounts && !pinSet.has(hoveredId)
    ? sourceIds.reduce((sum, src) => sum + (pairCounts[src]?.[hoveredId] ?? 0), 0)
    : 0

  // Empty-space click → clear, UNLESS a station's layer onClick just fired for
  // this same click (deck picks fire alongside maplibre's click).
  const handleClick = (_e: MapLayerMouseEvent) => {
    if (Date.now() - justPickedRef.current < 150) return
    onClick?.()
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }} className={css.homeMap}>
      <MaplibreMap
        initialViewState={{ longitude: center[1], latitude: center[0], zoom }}
        mapStyle={mapStyle}
        attributionControl={false}
        cursor={hoveredId ? 'pointer' : 'grab'}
        onMove={(e) => onMove?.(round(e.viewState.latitude * 1000) / 1000, round(e.viewState.longitude * 1000) / 1000, round(e.viewState.zoom))}
        onClick={handleClick}
        // maplibre renders black until (a) it's resized to the settled flex/100vh
        // container size, and (b) a reflow flushes the WebGL canvas to the
        // compositor (Chrome doesn't paint it otherwise in this layout). Resize
        // + keep-in-sync ResizeObserver, then a one-frame opacity toggle to
        // force the composite. Without this the basemap stays black until the
        // first user interaction.
        onLoad={(e) => {
          const m = e.target
          mapRef.current = m
          m.resize()
          new ResizeObserver(() => m.resize()).observe(m.getContainer())
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <DeckOverlay layers={layers} />
      </MaplibreMap>
      {overlay && (
        <div style={{
          position: 'absolute', top: 8, right: 8, zIndex: 1000,
          background: 'rgba(0,0,0,0.65)', color: 'white', padding: '4px 10px',
          borderRadius: 4, fontSize: 12, pointerEvents: 'none', backdropFilter: 'blur(4px)',
        }}>
          {overlay}
        </div>
      )}
      {box && (
        <div style={{
          position: 'absolute',
          left: Math.min(box.x0, box.x1),
          top: Math.min(box.y0, box.y1),
          width: Math.abs(box.x1 - box.x0),
          height: Math.abs(box.y1 - box.y0),
          border: '1.5px solid #e91e63',
          background: 'rgba(233,30,99,0.12)',
          zIndex: 1000,
          pointerEvents: 'none',
        }} />
      )}
      {hovered && (
        <div className={css.hoverDrawer}>
          <span className={css.hoverDrawerName}>{hovered.name}</span>
          {hovered.ends > 0 && (
            <span className={css.hoverDrawerStat}>{hovered.ends.toLocaleString()} rides</span>
          )}
          {hoveredFlow > 0 && (
            <span className={css.hoverDrawerFlow}>{hoveredFlow.toLocaleString()} from selection</span>
          )}
        </div>
      )}
    </div>
  )
}
