/**
 * Per-station "trips starts vs ends" pie overlays for the /stations map.
 *
 * Strictly behind the `?pies=1` URL flag (POC). ONE `useTotalsQuery` call
 * fetches `(short_name, side) → count` rows for every visible station with
 * `ends > MIN_ENDS_FOR_PIE`. Replaces the previous per-station fan-out
 * (which fired O(visible-stations) parallel requests and crushed the connection
 * pool).
 *
 * Caching: the query key is keyed on the *quantized* `(from, to)` plus the
 * sorted set of visible station IDs, so panning the map (without changing
 * the visible-station set) is a TSQ cache hit. Adding/removing stations on
 * pan is a fresh fetch — typically warm in the Worker shard cache.
 *
 * Defensive: a station with no rows in the response renders nothing (the
 * underlying `<Circle>` fill peeks through).
 */
import { useEffect, useMemo, useState } from 'react'
import { Marker, Pane, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useTotalsQuery } from '../query/rollups'
import type { Stations } from './StationMap'
import type { TimeRange } from '../time-range'

const { sqrt, cos, sin, PI, max } = Math

/** Don't fire a query for stations smaller than this — otherwise we'd
 *  request thousands of stations whose pies are 1-3 pixels anyway. */
export const MIN_ENDS_FOR_PIE = 100

interface PieColors {
  start: string
  end: string
}

const DEFAULT_PIE_COLORS: PieColors = {
  start: '#3498db',  // blue
  end: '#e67e22',    // orange (matches existing circle.circle on dark)
}

/** Compute SVG path-data string for one slice of a pie centered at (cx,cy)
 *  with radius r, starting at `startAngle` and sweeping `sweepAngle` radians.
 *  Angles measured clockwise from 12 o'clock. */
function slicePath(
  cx: number, cy: number, r: number,
  startAngle: number, sweepAngle: number,
): string {
  if (sweepAngle <= 0) return ''
  // Full-circle case (single slice covers entire pie): SVG arcs can't draw
  // a 360° arc with a single A command, so emit two semicircles via M/A/A/Z.
  if (sweepAngle >= 2 * PI - 1e-6) {
    return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`
  }
  const x1 = cx + r * sin(startAngle)
  const y1 = cy - r * cos(startAngle)
  const end = startAngle + sweepAngle
  const x2 = cx + r * sin(end)
  const y2 = cy - r * cos(end)
  const largeArc = sweepAngle > PI ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`
}

/** Build a Leaflet `divIcon` containing a 2-slice pie SVG. */
function buildPieIcon(
  diameterPx: number,
  startCount: number,
  endCount: number,
  colors: PieColors,
): L.DivIcon {
  const r = diameterPx / 2
  const total = startCount + endCount
  const startSweep = total > 0 ? (startCount / total) * 2 * PI : 0
  const endSweep = total > 0 ? (endCount / total) * 2 * PI : 0
  const startD = slicePath(r, r, r, 0, startSweep)
  const endD = slicePath(r, r, r, startSweep, endSweep)
  const html = `<svg width="${diameterPx}" height="${diameterPx}" viewBox="0 0 ${diameterPx} ${diameterPx}" style="display:block;pointer-events:none;overflow:visible">` +
    (startD ? `<path d="${startD}" fill="${colors.start}"/>` : '') +
    (endD   ? `<path d="${endD}" fill="${colors.end}"/>` : '') +
    `</svg>`
  return L.divIcon({
    html,
    className: 'station-pie-icon',  // strip default leaflet-div-icon white box
    iconSize: [diameterPx, diameterPx],
    iconAnchor: [r, r],
  })
}

export interface StationPiesProps {
  stations: Stations
  pieRange: TimeRange
  /** Optional override for slice colors. */
  colors?: PieColors
}

/** Renders pie overlays for stations currently visible in the map AND with
 *  `ends > MIN_ENDS_FOR_PIE`. Re-evaluates the visible set on `moveend` /
 *  `zoomend`. ONE Worker fetch covers the whole visible set. */
export default function StationPies({
  stations, pieRange, colors = DEFAULT_PIE_COLORS,
}: StationPiesProps) {
  const map = useMap()
  // Re-render on pan/zoom so visible-set + per-pixel scale update.
  const [, bumpVersion] = useState(0)
  useEffect(() => {
    const handler = () => bumpVersion(v => v + 1)
    map.on('moveend', handler)
    map.on('zoomend', handler)
    return () => {
      map.off('moveend', handler)
      map.off('zoomend', handler)
    }
  }, [map])

  const bounds = map.getBounds()
  const mPerPx = useMemo(() => {
    const center = map.getCenter()
    const metersPerDegree = 111320 * cos(center.lat * PI / 180)
    const degreesPerPixel = (bounds.getEast() - bounds.getWest()) / map.getSize().x
    return metersPerDegree * degreesPerPixel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, map.getZoom(), bounds.getNorth(), bounds.getSouth(), bounds.getEast(), bounds.getWest()])

  const visible = useMemo(() => {
    const out: { id: string; lat: number; lng: number; radiusM: number }[] = []
    for (const [id, st] of Object.entries(stations)) {
      if (st.ends <= MIN_ENDS_FOR_PIE) continue
      if (!bounds.contains([st.lat, st.lng])) continue
      const radiusM = sqrt(st.ends)
      if (isNaN(radiusM)) continue
      out.push({ id, lat: st.lat, lng: st.lng, radiusM })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, bounds.getNorth(), bounds.getSouth(), bounds.getEast(), bounds.getWest()])

  // Stable, sorted ID list for the TSQ query key (so identity-by-content is
  // preserved across re-renders that don't actually change the visible set).
  const visibleIds = useMemo(
    () => visible.map(v => v.id).sort(),
    [visible],
  )

  const totals = useTotalsQuery({
    kind: 'trips',
    scope: 'stations',
    end: pieRange.timestamp,
    duration: pieRange.duration,
    filterShortName: visibleIds,
    dims: ['side'],
  })

  // Build short_name → {start, end} map from the totals response.
  const countsByStation = useMemo(() => {
    const m = new Map<string, { start: number; end: number }>()
    const rows = totals.data?.rows
    if (!rows) return m
    for (const row of rows) {
      const id = row.short_name
      if (typeof id !== 'string') continue
      let entry = m.get(id)
      if (!entry) {
        entry = { start: 0, end: 0 }
        m.set(id, entry)
      }
      const c = typeof row.count === 'number' ? row.count : 0
      if (row.side === 'start') entry.start += c
      else if (row.side === 'end') entry.end += c
    }
    return m
  }, [totals.data])

  return (
    <Pane name="station-pies" style={{ zIndex: 430 }}>
      {visible.map(s => {
        const counts = countsByStation.get(s.id)
        // Defensive: no row for this station → render nothing (base circle shows through).
        if (!counts) return null
        const total = counts.start + counts.end
        if (total === 0) return null
        const diameterPx = max(4, (2 * s.radiusM) / mPerPx)
        const icon = buildPieIcon(diameterPx, counts.start, counts.end, colors)
        return (
          <Marker
            key={s.id}
            position={{ lat: s.lat, lng: s.lng }}
            icon={icon}
            interactive={false}
            keyboard={false}
          />
        )
      })}
    </Pane>
  )
}
