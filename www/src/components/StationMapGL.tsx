/**
 * GPU station map (deck.gl over a MapLibre raster basemap) — Stage 1 of the
 * migration off react-leaflet SVG (see `specs/unified-page-architecture.md`
 * "Rendering architecture"). Renders all ~2,700 stations as ONE instanced
 * `ScatterplotLayer` with GPU picking, fed by the same `stationColors` the
 * flow lens produces — so recolor is a GPU attribute update (`updateTriggers`),
 * not a re-mount of thousands of SVG nodes.
 *
 * The basemap + deck overlay + camera live in `GLMap` (shared with
 * `/timelapse`); this component owns the station layers (lens-colored dots,
 * pin rings, arc fan) and the hover drawer. Selection gestures are the shared
 * `lib/mapSelection` model (as on `/timelapse`): tap selects one, tap on
 * empty map clears, long-press enters multi-select, long-press- or
 * shift-drag box-selects, shift/⌘-click toggles; each emits a `SelAction`
 * for the caller to reduce. Picking is GPU-based (`pickObject`), so the old
 * invisible hit-circle hack is gone. Hover (drawer + `onHoverStation`) only
 * on hover-capable pointers. Stage 3 adds the `ArcLayer` flow fan (`arcs`).
 *
 * The default map on `/stations` (`?gl=0` → Leaflet `StationMap`) and on the
 * Home embed.
 */
import { ArcLayer, ScatterplotLayer } from '@deck.gl/layers'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ARC_SRC_FRAC, arcAlpha, arcWidthPx, lensZoomScale, type FlowArc } from './flowLens'
import GLMap from './GLMap'
import { useTheme } from '../contexts/ThemeContext'
import { stationsInRect, useSelectionGestures, type SelAction } from '../lib/mapSelection'
import { useCanHover } from '../lib/useMediaQuery'
import css from '../stations.module.css'
import type { Stations, StationPairCounts } from './stationMapCommon'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { MapboxOverlay } from '@deck.gl/mapbox'
import type { Map as MaplibreMapInstance } from 'maplibre-gl'

const { max, round, sqrt } = Math

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

type StationDatum = {
  id: string
  name: string
  ends: number
  position: [number, number]
  color: RGBA
  /** Lens radius (px, base zoom) when the radius channel is on. */
  r?: number
}

/** Lens circles' outline: a thin contrasting edge so overlapping circles
 *  stay distinct (dark edge on the dark basemap, light on the light one). */
const LENS_EDGE_DARK: RGBA = [0, 0, 0, 170]
const LENS_EDGE_LIGHT: RGBA = [255, 255, 255, 210]
/** Neutral arc hue per theme: light arcs on the dark basemap, dark on light. */
const ARC_RGB_DARK: [number, number, number] = [255, 255, 255]
const ARC_RGB_LIGHT: [number, number, number] = [40, 40, 48]

export interface StationMapGLProps {
  stations: Stations
  pinnedIds?: readonly string[]
  /** Selection gestures (tap / long-press / rectangle), for the caller to
   *  reduce (`useSelection().apply`). */
  onSelAction?: (a: SelAction) => void
  /** Multi-select mode is on (hover-drawer hint only). */
  multi?: boolean
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
  /** Top-right caption (non-interactive). */
  overlay?: ReactNode
  /** Extra chrome rendered over the map (outside the gesture surface). */
  children?: ReactNode
  /** Wrapper class (sizing); default `/stations`' full-height map. */
  className?: string
}

export default function StationMapGL({
  stations,
  pinnedIds,
  onSelAction,
  multi = false,
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
  overlay,
  children,
  className,
}: StationMapGLProps) {
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'

  const canHover = useCanHover()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const [map, setMap] = useState<MaplibreMapInstance | null>(null)

  const defaultColor: RGBA = dark ? [230, 126, 34, 180] : [211, 84, 0, 170]

  // Live zoom (¼-level steps) for the lens's zoom-aware pixel radii; the
  // `zoom` prop is only the initial / URL-rounded camera.
  const [liveZoom, setLiveZoom] = useState(zoom)
  useEffect(() => {
    if (!map) return
    const on = () => setLiveZoom(round(map.getZoom() * 4) / 4)
    on()
    map.on('zoom', on)
    return () => { map.off('zoom', on) }
  }, [map])

  const data = useMemo<StationDatum[]>(() => {
    const out: StationDatum[] = []
    for (const [id, s] of Object.entries(stations)) {
      if (typeof s.lat !== 'number' || typeof s.lng !== 'number') continue
      const hex = stationColors?.[id]
      const color: RGBA = hex ? [...hexToRgb(hex), 210] : defaultColor
      out.push({ id, name: s.name, ends: s.ends, position: [s.lng, s.lat], color, r: stationRadii?.[id] })
    }
    // Radius lens: draw big circles first, small ones over them (so the
    // tail stays visible inside heavy destinations' disks).
    if (stationRadii) out.sort((a, b) => (b.r ?? 0) - (a.r ?? 0))
    return out
  }, [stations, stationColors, stationRadii, dark])

  // `[lng, lat]` pairs, `data`-indexed, for rectangle hit-testing.
  const positions = useMemo(() => {
    const out = new Float64Array(data.length * 2)
    data.forEach((d, i) => { out[2 * i] = d.position[0]; out[2 * i + 1] = d.position[1] })
    return out
  }, [data])

  const dragRect = useSelectionGestures(map, {
    pickAt: (at, touch) => {
      const o = overlayRef.current
      if (!o) return null
      const info = o.pickObject({ x: at.x, y: at.y, radius: touch ? 12 : 3, layerIds: ['stations'] })
      return (info?.object as StationDatum | undefined)?.id ?? null
    },
    pickRect: (r) => {
      if (!map) return []
      const project = (lng: number, lat: number): [number, number] => {
        const p = map.project([lng, lat])
        return [p.x, p.y]
      }
      return stationsInRect(positions, project, r).map((i) => data[i].id)
    },
    apply: (a) => onSelAction?.(a),
  }, !!onSelAction)

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
  // Uniform zoom multiplier on the lens radii: a layer prop, so zooming
  // never re-runs `getRadius`.
  const radiusScale = stationRadii ? lensZoomScale(liveZoom) : 1
  const lensEdge = dark ? LENS_EDGE_DARK : LENS_EDGE_LIGHT

  // Arc fan: under the station dots, non-pickable (pure decoration, like the
  // Leaflet fan's `interactive={false}` edges). Flow is carried by **width**
  // (linear in trips, `arcWidthPx`) in one neutral hue per theme, opacity
  // rising mildly with flow (`arcAlpha`). Each arc fades in from origin to
  // destination (riding direction), so direction reads without arrowheads and
  // the origin doesn't pile up into a blob. `arcs` is sorted light→heavy, so
  // heavy arcs draw on top. Tilted so arcs curve visibly at pitch 0.
  const arcMax = arcs?.length ? arcs[arcs.length - 1].count : 1
  const arcRgb = dark ? ARC_RGB_DARK : ARC_RGB_LIGHT
  const arcLayer = arcs?.length ? new ArcLayer<FlowArc>({
    id: 'flow-arcs',
    data: arcs as FlowArc[],
    getSourcePosition: (d) => d.source,
    getTargetPosition: (d) => d.target,
    getSourceColor: (d) => [...arcRgb, round(arcAlpha(d.count, arcMax) * ARC_SRC_FRAC)],
    getTargetColor: (d) => [...arcRgb, arcAlpha(d.count, arcMax)],
    getWidth: (d) => arcWidthPx(d.count, arcMax),
    widthUnits: 'pixels',
    getHeight: 0.35,
    getTilt: ARC_TILT,
    pickable: false,
    updateTriggers: { getSourceColor: [dark, arcMax], getTargetColor: [dark, arcMax], getWidth: arcMax },
  }) : null

  const layers: Layer[] = [
    ...(arcLayer ? [arcLayer] : []),
    new ScatterplotLayer<StationDatum>({
      id: 'stations',
      data,
      getPosition: (d) => d.position,
      getRadius: (d) => (stationRadii ? (d.r ?? 8) : sqrt(max(d.ends, 1))),
      radiusUnits,
      radiusScale,
      // The lens's own px range (incl. the no-trip dots) wins over the
      // default floor; otherwise meters, floored at 3px.
      radiusMinPixels: stationRadii ? 1 : 3,
      radiusMaxPixels: 40,
      getFillColor: (d) => d.color,
      // Ring mark: the ring is the station color. Radius lens: a thin
      // contrasting edge on connected (> dot-size) circles only.
      getLineColor: (d) => (ring ? d.color : lensEdge),
      filled: !ring,
      stroked: ring || !!stationRadii,
      lineWidthUnits: 'pixels',
      getLineWidth: (d) => (ring ? 1.5 : stationRadii && (d.r ?? 0) > 2 ? 0.75 : 0),
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 90],
      onHover: canHover ? (info: PickingInfo<StationDatum>) => {
        const id = info.object?.id ?? null
        setHoveredId(id)
        onHoverStation?.(id)
        if (id) setSelectedId?.(id)
      } : undefined,
      updateTriggers: {
        getFillColor: colorTrigger,
        getLineColor: `${colorTrigger}:${ring}`,
        getLineWidth: `${radiusTrigger}:${ring}`,
        getRadius: radiusTrigger,
      },
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

  return (
    <GLMap
      layers={layers}
      center={center}
      zoom={zoom}
      onMove={onMove}
      onOverlay={(o, m) => { overlayRef.current = o; setMap(m) }}
      cursor={hoveredId ? 'pointer' : 'grab'}
      className={className ?? css.homeMap}
    >
      {overlay && (
        <div style={{
          position: 'absolute', top: 8, right: 8, zIndex: 1000,
          background: 'rgba(0,0,0,0.65)', color: 'white', padding: '4px 10px',
          borderRadius: 4, fontSize: 12, backdropFilter: 'blur(4px)',
        }}>
          {overlay}
        </div>
      )}
      {dragRect && (
        <div className={css.dragRect} style={{
          left: dragRect.x0, top: dragRect.y0, width: dragRect.x1 - dragRect.x0, height: dragRect.y1 - dragRect.y0,
        }} />
      )}
      {hovered && !dragRect && (
        <div className={css.hoverDrawer}>
          <span className={css.hoverDrawerName}>{hovered.name}</span>
          {hovered.ends > 0 && (
            <span className={css.hoverDrawerStat}>{hovered.ends.toLocaleString()} rides</span>
          )}
          {hoveredFlow > 0 && (
            <span className={css.hoverDrawerFlow}>{hoveredFlow.toLocaleString()} from selection</span>
          )}
          <span className={css.hoverDrawerHint}>
            {multi ? 'click to toggle' : pinSet.has(hoveredId!) ? 'shift/⌘-click to remove' : 'click to select · shift/⌘-click to add'}
          </span>
        </div>
      )}
      {children}
    </GLMap>
  )
}
