/**
 * The GL map shell: a MapLibre `<Map>` (raster basemap) with a deck.gl
 * `MapboxOverlay` on top, camera state in/out via `center`/`zoom`/`onMove`,
 * and a `ready` hook that hands the caller the underlying maplibre instance.
 *
 * Factored out of `StationMapGL` (`specs/timelapse-map.md` "Rendering") so
 * that `/stations` and `/timelapse` share one basemap/overlay/camera setup
 * while each owns its own deck layers and chrome. Deliberately minimal:
 * layers, cursor and any overlays are the caller's; this only owns the map.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Map as MaplibreMap, useControl, useMap, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { Layer } from '@deck.gl/core'
import type { Map as MaplibreMapInstance, StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useTheme } from '../contexts/ThemeContext'

const { round } = Math

/**
 * Raster basemap style (Stadia tiles — the same ones the react-leaflet map
 * uses, so they're already allowlisted for this origin). Deliberately raster,
 * not a CARTO vector style: under Vite the maplibre vector-tile worker wasn't
 * running (style + TileJSON + sprite load 200, but zero .mvt tiles ever
 * requested → black map). Raster tiles decode on the main thread, so they
 * render regardless. Revisit CARTO vector once the worker is sorted.
 */
export function rasterStyle(dark: boolean, tileBase?: string): StyleSpecification {
  const url = tileBase
    ? `${tileBase}/{z}/{x}/{y}.png`
    : dark
      ? 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png'
      : 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}.png'
  return {
    version: 8,
    sources: { base: { type: 'raster', tiles: [url], tileSize: 256 } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  }
}

/** deck.gl layers as a MapLibre control, updated in place each render. */
function DeckOverlay({ layers, onAfterRender, onOverlay }: {
  layers: Layer[]
  onAfterRender?: () => void
  onOverlay?: (o: MapboxOverlay, map: MaplibreMapInstance) => void
}) {
  // Overlaid (not interleaved): deck renders in its own canvas ABOVE maplibre's
  // basemap canvas. Interleaved mode (deck drawing into maplibre's GL context)
  // left the basemap unpainted here — tiles fetched 200 but never composited.
  // Overlaid is exactly the stacking we want (marks over basemap) anyway.
  const overlay = useControl(() => new MapboxOverlay({ interleaved: false, layers }))
  // deck calls `props.onAfterRender` unconditionally: an explicit
  // `undefined` would replace its no-op default and throw on every draw.
  overlay.setProps(onAfterRender ? { layers, onAfterRender } : { layers })
  const onOverlayRef = useRef(onOverlay)
  onOverlayRef.current = onOverlay
  const { current: mapRef } = useMap()
  useEffect(() => { if (mapRef) onOverlayRef.current?.(overlay, mapRef.getMap()) }, [overlay, mapRef])
  return null
}

export interface GLMapProps {
  /** deck.gl layers, re-applied every render (deck diffs them). */
  layers: Layer[]
  /** `[lat, lng]` (Leaflet order, as the `ll` URL param stores it). */
  center: [number, number]
  zoom: number
  /** Camera changes, rounded to 3 decimals / integer zoom (URL-friendly). */
  onMove?: (lat: number, lng: number, zoom: number) => void
  /** Any click on the map (deck picks fire alongside it; see `StationMapGL`
   *  for the "just picked" guard). */
  onClick?: (e: MapLayerMouseEvent) => void
  /** Called once with the maplibre instance after `load`. */
  onReady?: (map: MaplibreMapInstance) => void
  cursor?: string
  /** Movie mode (`specs/timelapse-map.md`): keep the basemap's drawing buffer
   *  so a screenshot right after render isn't black. Off by default (a
   *  buffer copy per frame). */
  preserveDrawingBuffer?: boolean
  /** Pan/zoom/rotate enabled (default). Movie mode fixes the camera. */
  interactive?: boolean
  /** After every deck redraw (movie mode's "frame rendered" signal). */
  onAfterRender?: () => void
  /** Local raster tile cache root (`{tileBase}/{z}/{x}/{y}.png`), as in
   *  `StationMap` (`specs/done/deterministic-screenshots.md`). */
  tileBase?: string
  /** `position: relative` wrapper class (sizing is the caller's). */
  className?: string
  /** Rendered inside the wrapper, above the map (overlays, drawers, chrome). */
  children?: ReactNode
  /** Wrapper element ref (e.g. for capture-phase mouse listeners). */
  containerRef?: React.RefObject<HTMLDivElement>
  /** Called once with the deck overlay (imperative `pickObject`) and the
   *  maplibre instance, as soon as they exist: unlike `onReady`, without
   *  waiting for `load` (which waits on basemap tiles). */
  onOverlay?: (overlay: MapboxOverlay, map: MaplibreMapInstance) => void
}

export default function GLMap({
  layers,
  center,
  zoom,
  onMove,
  onClick,
  onReady,
  cursor = 'grab',
  preserveDrawingBuffer = false,
  interactive = true,
  onAfterRender,
  tileBase,
  className,
  children,
  containerRef,
  onOverlay,
}: GLMapProps) {
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'
  const mapStyle = useMemo(() => rasterStyle(dark, tileBase), [dark, tileBase])
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const observerRef = useRef<ResizeObserver | null>(null)
  useEffect(() => () => observerRef.current?.disconnect(), [])

  return (
    <div ref={containerRef} style={{ position: 'relative' }} className={className}>
      <MaplibreMap
        initialViewState={{ longitude: center[1], latitude: center[0], zoom }}
        mapStyle={mapStyle}
        attributionControl={false}
        cursor={cursor}
        interactive={interactive}
        canvasContextAttributes={{ preserveDrawingBuffer }}
        onMove={(e) => onMove?.(round(e.viewState.latitude * 1000) / 1000, round(e.viewState.longitude * 1000) / 1000, round(e.viewState.zoom))}
        onClick={onClick}
        // maplibre renders black until it's resized to the settled flex/100vh
        // container size; resize on load + keep in sync with a ResizeObserver.
        onLoad={(e) => {
          const m = e.target
          m.resize()
          observerRef.current?.disconnect()
          observerRef.current = new ResizeObserver(() => m.resize())
          observerRef.current.observe(m.getContainer())
          onReadyRef.current?.(m)
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <DeckOverlay layers={layers} onAfterRender={onAfterRender} onOverlay={onOverlay} />
      </MaplibreMap>
      {children}
    </div>
  )
}
