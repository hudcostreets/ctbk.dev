import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Circle, CircleMarker, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useTheme } from '../contexts/ThemeContext'
import css from '../stations.module.css'
import StationInfoDrawer from './StationInfoDrawer'
import type { TimeRange } from '../time-range'
import { TILE_COLORS, TILE_STYLES, resolveTileStyle, type Stations, type TileColors, type StationPairCounts } from './stationMapCommon'
import StationPies from './StationPies'

const { sqrt, max } = Math

export * from './stationMapCommon'

function getMetersPerPixel(map: L.Map): number {
  const center = map.getCenter()
  const metersPerDegree = 111320 * Math.cos(center.lat * Math.PI / 180)
  const bounds = map.getBounds()
  const degreesPerPixel = (bounds.getEast() - bounds.getWest()) / map.getSize().x
  return metersPerDegree * degreesPerPixel
}

/** Ring color for multi-select (`pinnedIds`) stations — matches neither
 *  theme's hover-selected color, readable on light + dark tiles. */
const MULTI_PIN_COLOR = '#e91e63'

function StationMarkers({
  stations,
  selectedId,
  setSelectedId,
  pinnedId,
  onPin,
  pinnedIds,
  onTogglePin,
  onMarkerHover,
  pairCounts,
  colors,
  stationColors,
  stationRadii,
  lensActive,
  showLines,
  hoverToSelect,
  setHoveredId,
}: {
  stations: Stations
  selectedId?: string
  setSelectedId?: (id: string | undefined) => void
  pinnedId?: string
  onPin?: (id: string | undefined) => void
  pinnedIds?: readonly string[]
  onTogglePin?: (id: string, additive: boolean) => void
  onMarkerHover?: (id: string) => void
  pairCounts?: StationPairCounts | null
  colors: TileColors
  stationColors?: Record<string, string> | null
  stationRadii?: Record<string, number> | null
  lensActive?: boolean
  showLines?: boolean
  hoverToSelect?: boolean
  setHoveredId: Dispatch<SetStateAction<string | null>>
}) {
  const map = useMap()
  const zoom = map.getZoom()

  const selectedStation = selectedId ? stations[selectedId] : undefined
  const mPerPx = useMemo(() => getMetersPerPixel(map), [map, zoom])

  // Latest-value refs for everything the circle event handlers read. The
  // circles pane must be STABLE across selection changes: with `selectedId`
  // (or changing callback identities) in its memo deps, every hover-select
  // remounted all ~2,700 leaflet circles — the fresh layer under the
  // stationary cursor re-fired `mouseover`, scheduling another select →
  // re-render → remount → … a churn loop that strobed the fan and destroyed
  // mousedown targets mid-gesture (clicks silently dropped).
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const setSelectedIdRef = useRef(setSelectedId)
  setSelectedIdRef.current = setSelectedId
  const onPinRef = useRef(onPin)
  onPinRef.current = onPin
  const onTogglePinRef = useRef(onTogglePin)
  onTogglePinRef.current = onTogglePin
  const onMarkerHoverRef = useRef(onMarkerHover)
  onMarkerHoverRef.current = onMarkerHover

  // Hover-prefetch: fire `onMarkerHover(id)` 80 ms after the cursor settles on
  // a circle, cancelling if the cursor leaves first. Quick mouse-passes don't
  // trigger requests; deliberate hovers warm the cache for an imminent click.
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hover-select settle: `hoverToSelect` waits 150 ms before committing the
  // selection (and thus redrawing the destination-line fan) — sweeping the
  // cursor across a dense area no longer strobes a fan per station crossed.
  const selectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    if (selectTimerRef.current) clearTimeout(selectTimerRef.current)
  }, [])
  const scheduleHoverPrefetch = (id: string) => {
    if (!onMarkerHoverRef.current) return
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => onMarkerHoverRef.current?.(id), 80)
  }
  const cancelHoverPrefetch = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }
  const scheduleHoverSelect = (id: string) => {
    if (selectTimerRef.current) clearTimeout(selectTimerRef.current)
    selectTimerRef.current = setTimeout(() => setSelectedIdRef.current?.(id), 150)
  }
  const cancelHoverSelect = () => {
    if (selectTimerRef.current) {
      clearTimeout(selectTimerRef.current)
      selectTimerRef.current = null
    }
  }

  // Pinned == the currently-selected station is the click-pinned one (bolder
  // ring). Hover is pure inspection: circle handlers set `hoveredId` (owned by
  // `StationMap`, which renders the single hover drawer), never the selection
  // — that's click-driven or the `hoverToSelect` settle timer. `setHoveredId`
  // is a stable state setter, so it's fine in the circle handlers without
  // being in any memo deps (see the churn-loop note above).
  const isPinned = !!pinnedId && pinnedId === selectedId

  // Visible circles stay area-proportional to `sqrt(ends)` — no floor —
  // so the volume-ranking of stations reads at a glance. To keep small
  // stations clickable, render an invisible co-located circle with a
  // larger radius (≥ HIT_RADIUS_PX) carrying the eventHandlers + tooltip.
  // At zoom 12 in NYC (~5m/px), 6px = 30m hit radius, plenty for the
  // dense Manhattan grid without overlapping neighbors much.
  const HIT_RADIUS_PX = 6
  const hitRadius = HIT_RADIUS_PX * mPerPx

  const lines = useMemo(() => {
    if (!showLines) return null
    if (!selectedStation || !selectedId || !pairCounts) return null
    if (!(selectedId in pairCounts)) return null
    const counts = pairCounts[selectedId]
    const maxCount = max(...Object.values(counts))
    const src = selectedStation
    // When the flow lens is active (destinations already carry the flow signal
    // via color/radius), the fan is redundant clutter — keep it as a faint
    // hint of direction, well under the dots.
    const lineOpacity = lensActive ? 0.12 : 0.4

    return (
      <Pane name="lines" className={css.lines}>
        {Object.entries(counts).map(([dstId, count]) => {
          const dst = stations[dstId]
          if (!dst) return null
          const weight = max(0.7, (count / maxCount) * sqrt(src.ends) / mPerPx)
          return (
            // Edges are pure decoration: `interactive={false}` so they never
            // intercept a hover/click aimed at a station underneath (the old
            // flicker + the reason for the removed edge-click-forwarding), and
            // the `.lines` pane sits below `.circles`. The destination's own
            // station tooltip covers the "→ dst: count" info on hover.
            <Polyline
              key={`${selectedId}-${dstId}-${zoom}-${colors.line}`}
              positions={[[src.lat, src.lng], [dst.lat, dst.lng]]}
              color={colors.line}
              weight={weight}
              opacity={lineOpacity}
              interactive={false}
            />
          )
        })}
      </Pane>
    )
  }, [selectedStation, selectedId, pairCounts, stations, mPerPx, zoom, colors, lensActive, showLines])

  // Selected-station overlay: visual-only (pointer-events: none via `.selected`
  // CSS). Clicks pass through to the base Circle in the `circles` Pane below,
  // so the target Circle stays mounted between hover and click — avoiding the
  // unmount/remount race that caused clicks to fall through to the map.
  const selectedCircle = useMemo(() => {
    if (!selectedStation || !selectedId) return null
    const dataRadius = sqrt(selectedStation.ends)
    if (isNaN(dataRadius)) return null
    return (
      <Pane name="selected" className={css.selected}>
        {/* No tooltip: the hovered/selected station's name + counts show in
            the single hover drawer (rendered by `StationMap`), so map labels
            never stack or collide. */}
        <Circle
          key={`${selectedId}-${colors.selected}-${isPinned ? 'pin' : 'hov'}`}
          center={{ lat: selectedStation.lat, lng: selectedStation.lng }}
          color={colors.selected}
          radius={dataRadius}
          weight={isPinned ? 4 : 3}
          interactive={false}
        />
      </Pane>
    )
  }, [selectedStation, selectedId, colors, isPinned])

  const circles = useMemo(() => {
    return (
      <Pane name="circles" className={css.circles}>
        {Object.entries(stations).flatMap(([id, station]) => {
          const dataRadius = sqrt(station.ends)
          if (isNaN(dataRadius)) return []
          const circleColor = stationColors?.[id] ?? colors.circle
          // Radius: the lens' per-station pixel radius (× m/px) when the radius
          // channel is on for this station, else the data-proportional radius.
          const lensRadiusPx = stationRadii?.[id]
          const radius = lensRadiusPx != null ? lensRadiusPx * mPerPx : dataRadius
          // Visible circle: area-proportional, non-interactive (clicks pass
          // through to the invisible hit-test circle below).
          const visible = (
            <Circle
              key={`${id}-vis-${circleColor}-${lensRadiusPx ?? 'd'}`}
              center={{ lat: station.lat, lng: station.lng }}
              color={circleColor}
              radius={radius}
              interactive={false}
            />
          )
          // Hit-test circle: invisible (fillOpacity 0, weight 0), but with
          // a clickable radius of at least HIT_RADIUS_PX. Carries the
          // eventHandlers + tooltip.
          // Handlers read live values via refs so this pane never needs to
          // remount on selection changes (see the churn-loop note above).
          const eventHandlers: Record<string, (e: L.LeafletMouseEvent) => void> = {
            // Multi-select mode (`onTogglePin`): a plain click selects just
            // this station; meta/ctrl-click adds/removes it from the set
            // (`additive`). Hover still drives the transient selection.
            click: (e) => {
              const additive = !!(e.originalEvent?.metaKey || e.originalEvent?.ctrlKey)
              const toggle = onTogglePinRef.current
              if (toggle) toggle(id, additive)
              else (onPinRef.current ?? setSelectedIdRef.current)?.(id)
            },
            mouseover: () => {
              setHoveredId(id)
              if (hoverToSelect && id !== selectedIdRef.current) scheduleHoverSelect(id)
              scheduleHoverPrefetch(id)
            },
            mouseout: () => {
              setHoveredId((cur) => (cur === id ? null : cur))
              cancelHoverPrefetch()
              cancelHoverSelect()
            },
          }
          // No per-circle tooltip: a single `hoverTooltip` layer (below),
          // driven by `hoveredId`, renders exactly one tooltip for whatever
          // station the cursor is over — so hovering never stacks tooltips.
          const hit = (
            <Circle
              key={`${id}-hit`}
              center={{ lat: station.lat, lng: station.lng }}
              radius={max(hitRadius, dataRadius)}
              fillOpacity={0}
              weight={0}
              bubblingMouseEvents={false}
              eventHandlers={eventHandlers}
            />
          )
          return [visible, hit]
        })}
      </Pane>
    )
  }, [stations, colors, stationColors, stationRadii, mPerPx, hoverToSelect, hitRadius])

  // Source markers: one per selected (`pinnedIds`) station. Sits above
  // everything so the *selected* stations are unmistakable — a white halo
  // under a bold pink ring (reads on both light and dark tiles, and distinct
  // from the flow-lens ramp, whose hot end is also red). Which station each is
  // shows in the hover drawer + the lens legend, so no on-map label here.
  // Non-interactive; clicks pass through to the hit circles (toggle off).
  const multiPinRings = useMemo(() => {
    if (!pinnedIds || pinnedIds.length === 0) return null
    return (
      <Pane name="multi-pins" className={css.selected}>
        {pinnedIds.map((id) => {
          const st = stations[id]
          if (!st) return null
          const dataRadius = sqrt(st.ends)
          const radius = max(isNaN(dataRadius) ? 0 : dataRadius, hitRadius)
          const center = { lat: st.lat, lng: st.lng }
          return [
            <Circle
              key={`pin-halo-${id}`}
              center={center}
              color="#fff"
              fill={false}
              radius={radius + 2.5 * mPerPx}
              weight={6}
              interactive={false}
            />,
            <Circle
              key={`pin-${id}`}
              center={center}
              color={MULTI_PIN_COLOR}
              fillColor={MULTI_PIN_COLOR}
              fillOpacity={0.3}
              radius={radius}
              weight={3}
              interactive={false}
            />,
          ]
        })}
      </Pane>
    )
  }, [pinnedIds, stations, hitRadius, mPerPx])

  return <>{selectedCircle}{lines}{circles}{multiPinRings}</>
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

/** Tell Leaflet when the map's container changes size (e.g. user drags the
 *  resize handle on station detail). Without this, tiles only render up to the
 *  size at mount; the new area paints as empty white. */
function MapResizeObserver() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(container)
    return () => ro.disconnect()
  }, [map])
  return null
}

export interface StationMapProps {
  stations: Stations
  selectedId?: string
  setSelectedId?: (id: string | undefined) => void
  /** Opt-in: id of the "pinned" (click-selected) station. When set, its
   *  tooltip renders bold to distinguish from a transient hover. */
  pinnedId?: string
  /** Opt-in click handler. When provided, circle clicks + polyline
   *  clicks call this (with the source id for lines). Parent is
   *  expected to toggle / update `pinnedId`. If omitted, clicks
   *  fall back to `setSelectedId`. */
  onPin?: (id: string | undefined) => void
  /** Multi-select mode: ids in the current selection set, rendered with a
   *  ring overlay. When `onTogglePin` is provided, circle clicks toggle
   *  membership instead of the `onPin`/`setSelectedId` behavior. */
  pinnedIds?: readonly string[]
  /** Multi-select toggle. `additive` (meta/ctrl-click) adds/removes the
   *  station from the set; a plain click should replace the set with it. */
  onTogglePin?: (id: string, additive: boolean) => void
  /** Fired ~80ms after the cursor settles on a circle. Use to warm
   *  caches for an imminent click (e.g. prefetch the station-detail
   *  data the click will navigate to). */
  onMarkerHover?: (id: string) => void
  pairCounts?: StationPairCounts | null
  /** Per-station fill color override (e.g. flow lens / color-by-age). */
  stationColors?: Record<string, string> | null
  /** Per-station radius override, in pixels (flow-lens radius channel).
   *  Scaled to meters internally; stations absent from the map keep their
   *  data-proportional radius. */
  stationRadii?: Record<string, number> | null
  /** When true, the destination-line fan fades right back (the lens channels
   *  already carry the flow signal). Independent of `stationColors` so a plain
   *  color-by-age recolor doesn't dim the fan. */
  lensActive?: boolean
  /** Draw the destination-line fan for the selected station. Off by default:
   *  it's heavy (hundreds of SVG polylines re-rendered on hover) and, at low
   *  opacity, stacks into a red blob near the origin. */
  showLines?: boolean

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

  /** "You are here" marker: a fixed-size ring at the page's station, drawn
   *  regardless of whether it's in `stations` (a retired station isn't in
   *  the current month's ride circles). `label` → a permanent tooltip, for
   *  when no selected-circle tooltip names the station. */
  focus?: { lat: number; lng: number; label?: string }

  /** POC: render per-station pies (starts vs ends) instead of solid fill.
   *  Lazy per-station fetch via `useRollupQuery`. Strictly opt-in. */
  pies?: boolean
  pieRange?: TimeRange
}

export default function StationMap({
  stations,
  selectedId,
  setSelectedId,
  pinnedId,
  onPin,
  pinnedIds,
  onTogglePin,
  onMarkerHover,
  pairCounts,
  stationColors,
  stationRadii,
  lensActive,
  showLines,
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
  pies,
  pieRange,
  focus,
}: StationMapProps) {
  const { actualTheme } = useTheme()
  const tileStyle = resolveTileStyle(tileCode, actualTheme)
  const currentTile = TILE_STYLES[tileStyle]
  const tileUrl = tileBase ? `${tileBase}/{z}/{x}/{y}.png` : currentTile.url
  const colors = TILE_COLORS[tileStyle]

  // Single hover drawer (below): whatever station the cursor is over. Owned
  // here (not in `StationMarkers`) so it renders as one HTML overlay outside
  // the Leaflet panes — replacing the per-station map tooltips that stacked
  // and collided when a hover landed near a selected station.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // Source set driving the flow lens (multi-select set, else the single pin).
  const sourceIds = pinnedIds?.length ? pinnedIds : (pinnedId ? [pinnedId] : [])

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
        pinnedId={pinnedId}
        onPin={onPin}
        pinnedIds={pinnedIds}
        onTogglePin={onTogglePin}
        onMarkerHover={onMarkerHover}
        pairCounts={pairCounts}
        colors={colors}
        stationColors={stationColors}
        stationRadii={stationRadii}
        lensActive={lensActive}
        showLines={showLines}
        hoverToSelect={hoverToSelect}
        setHoveredId={setHoveredId}
      />
      {focus && (
        <Pane name="focus" className={css.focus}>
          <CircleMarker
            key={`${focus.lat},${focus.lng}-${colors.selected}`}
            center={[focus.lat, focus.lng]}
            radius={11}
            pathOptions={{ color: colors.selected, weight: 3, fillColor: colors.selected, fillOpacity: 0.3, dashArray: '4 3' }}
            interactive={false}
          >
            {focus.label && (
              <Tooltip className={css.tooltip} permanent direction="top" offset={[0, -12]} pane="focus">
                <p>{focus.label}</p>
              </Tooltip>
            )}
          </CircleMarker>
        </Pane>
      )}
      {pies && pieRange && (
        <StationPies stations={stations} pieRange={pieRange} />
      )}
      {(onMove || onClick) && <MapEvents onMove={onMove} onClick={onClick} />}
      <MapResizeObserver />
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
      <StationInfoDrawer stations={stations} sourceIds={sourceIds} hoveredId={hoveredId} pairCounts={pairCounts} />
    </div>
  )
}
