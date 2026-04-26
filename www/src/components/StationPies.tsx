/**
 * Per-station "trips starts vs ends" pie overlays for the /stations map.
 *
 * Strictly behind the `?pies=1` URL flag (POC). Each visible station with
 * `ends > MIN_ENDS_FOR_PIE` fires a `useRollupQuery({kind:'trips', station,
 * end, duration, dims:['side']})` that returns ≤2 rows (one per side). The
 * pie radius matches the existing `<Circle radius={sqrt(ends)}>` so the
 * SVG slices visually replace the circle's fill.
 *
 * Defensive: if the per-station query 404s or returns empty, we render
 * nothing (the base circle's normal fill peeks through).
 */
import { useEffect, useMemo, useState } from 'react'
import { Marker, Pane, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useRollupQuery } from '../query/rollups'
import type { Stations } from './StationMap'
import type { TimeRange } from '../time-range'

const { sqrt, cos, sin, PI, max } = Math

/** Don't fire a query for stations smaller than this — otherwise we'd
 *  request thousands of stations whose pies are 1-3 pixels anyway. */
export const MIN_ENDS_FOR_PIE = 100

/** Effectively "no binning" — return one row per `side` over the full window. */
const HUGE_BIN_MS = 100 * 365 * 24 * 60 * 60 * 1000  // 100 years

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

/** One station's pie. Owns its own TSQ subscription. */
function StationPie({
  id, lat, lng, radiusM, mPerPx, end, duration, colors,
}: {
  id: string
  lat: number
  lng: number
  /** Same `radius` (in meters) the existing `<Circle>` uses. */
  radiusM: number
  mPerPx: number
  end: Date | null
  duration: number
  colors: PieColors
}) {
  const q = useRollupQuery({
    kind: 'trips',
    station: id,
    end,
    duration,
    binMs: HUGE_BIN_MS,
    dims: ['side'],
  })

  // Defensive: 404/empty/error → render nothing (base circle shows through).
  const rows = q.data?.rows
  if (!rows || rows.length === 0) return null

  let startCount = 0
  let endCount = 0
  for (const row of rows) {
    const c = typeof row.count === 'number' ? row.count : 0
    if (row.side === 'start') startCount += c
    else if (row.side === 'end') endCount += c
  }
  if (startCount + endCount === 0) return null

  // Convert the existing radius (meters) to a pixel diameter for the SVG icon
  // so the pie footprint exactly matches the underlying circle at this zoom.
  const diameterPx = max(4, (2 * radiusM) / mPerPx)
  const icon = buildPieIcon(diameterPx, startCount, endCount, colors)
  return (
    <Marker
      position={{ lat, lng }}
      icon={icon}
      interactive={false}
      keyboard={false}
    />
  )
}

export interface StationPiesProps {
  stations: Stations
  pieRange: TimeRange
  /** Optional override for slice colors. */
  colors?: PieColors
}

/** Renders pie overlays for stations currently visible in the map AND with
 *  `ends > MIN_ENDS_FOR_PIE`. Re-evaluates the visible set on `moveend` /
 *  `zoomend`. */
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
  }, [stations, bounds])

  return (
    <Pane name="station-pies" style={{ zIndex: 430 }}>
      {visible.map(s => (
        <StationPie
          key={s.id}
          id={s.id}
          lat={s.lat}
          lng={s.lng}
          radiusM={s.radiusM}
          mPerPx={mPerPx}
          end={pieRange.timestamp}
          duration={pieRange.duration}
          colors={colors}
        />
      ))}
    </Pane>
  )
}
