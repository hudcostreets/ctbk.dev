/** Renderers for the pyramid `cell` / `s2_cell` column.
 *
 *  That column's values are the pyramid's *frozen vocabulary*, which is
 *  two different things (`gbfs/api/src/avail_geo.ts`): S2 cell tokens
 *  (`89c244c`) and `s:<short_name>` station identity keys. They deserve
 *  different treatment — a station key has no footprint to draw, and an
 *  S2 token has no station page to link to — so they're discriminated
 *  before anything else happens.
 *
 *  Both get a locator: a tokenless SVG of the whole system's stations,
 *  with the cell footprint (or the station) marked. A bare `89c244c` is
 *  unreadable, and 2,340 station dots draw a recognizable city outline
 *  for free — no tiles, no map instance per hover, and the asset is one
 *  the app already ships. */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  fmtMeters, isS2Token, s2CellBounds, s2CellEdgeMeters, s2CellLevel,
  type LatLngBounds,
} from '../lib/s2geo'
import { Tip } from './Tip'
import css from './parquetCells.module.css'

const { PI, cos, min, max, abs } = Math

type Station = { lat: number; lng: number; region: string; name?: string }
type Stations = Record<string, Station>

const MAP_W = 190
const MAP_H = 150

function useStations() {
  return useQuery<Stations>({
    queryKey: ['stations-regional'],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch('/assets/stations-regional.json')
      if (!res.ok) throw new Error(`stations-regional: HTTP ${res.status}`)
      return (await res.json()) as Stations
    },
  })
}

/** Equirectangular fit of `bounds` into `w`×`h`, with a `cos(lat)`
 *  correction so the city isn't stretched. Fine at this scale; the
 *  point is recognizability, not cartography. */
function projector(bounds: LatLngBounds, w: number, h: number) {
  const { latMin, latMax, lngMin, lngMax } = bounds
  const kx = cos(((latMin + latMax) / 2) * PI / 180)
  const dLng = max(1e-9, (lngMax - lngMin) * kx)
  const dLat = max(1e-9, latMax - latMin)
  const s = min(w / dLng, h / dLat)
  const padX = (w - dLng * s) / 2
  const padY = (h - dLat * s) / 2
  return {
    x: (lng: number) => (lng - lngMin) * kx * s + padX,
    y: (lat: number) => h - ((lat - latMin) * s + padY),
  }
}

function stationBounds(stations: Stations): LatLngBounds {
  let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180
  for (const s of Object.values(stations)) {
    latMin = min(latMin, s.lat); latMax = max(latMax, s.lat)
    lngMin = min(lngMin, s.lng); lngMax = max(lngMax, s.lng)
  }
  return { latMin, latMax, lngMin, lngMax }
}

/** System locator. `mark` is drawn over the station field; at pyramid
 *  levels (L10–15) a cell is a few px across at city scale, so it also
 *  gets a ring — otherwise the thing you hovered to find is invisible. */
function Locator({ mark }: { mark: (p: ReturnType<typeof projector>) => JSX.Element | null }) {
  const { data: stations } = useStations()
  const proj = useMemo(() => (stations ? projector(stationBounds(stations), MAP_W, MAP_H) : null), [stations])
  if (!stations || !proj) return <div style={{ width: MAP_W, height: MAP_H, opacity: 0.4 }}>loading…</div>
  return (
    <svg width={MAP_W} height={MAP_H} style={{ display: 'block' }}>
      <g fill="currentColor" opacity={0.28}>
        {Object.entries(stations).map(([k, s]) => (
          <circle key={k} cx={proj.x(s.lng)} cy={proj.y(s.lat)} r={0.7} />
        ))}
      </g>
      {mark(proj)}
    </svg>
  )
}

function CellMark({ token }: { token: string }) {
  return (
    <Locator mark={(p) => {
      const b = s2CellBounds(token)
      const x0 = p.x(b.lngMin), x1 = p.x(b.lngMax)
      const y0 = p.y(b.latMax), y1 = p.y(b.latMin)
      const w = abs(x1 - x0), h = abs(y1 - y0)
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
      return (
        <g>
          <rect x={min(x0, x1)} y={min(y0, y1)} width={max(w, 2)} height={max(h, 2)}
            fill="#e53935" fillOpacity={0.35} stroke="#e53935" strokeWidth={1} />
          {max(w, h) < 14 && <circle cx={cx} cy={cy} r={9} fill="none" stroke="#e53935" strokeWidth={1} opacity={0.7} />}
        </g>
      )
    }} />
  )
}

function StationMark({ lat, lng }: { lat: number; lng: number }) {
  return (
    <Locator mark={(p) => (
      <g>
        <circle cx={p.x(lng)} cy={p.y(lat)} r={2.5} fill="#e53935" />
        <circle cx={p.x(lng)} cy={p.y(lat)} r={9} fill="none" stroke="#e53935" strokeWidth={1} opacity={0.7} />
      </g>
    )} />
  )
}

function Meta({ rows }: { rows: [string, string][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: '0.6em', marginBottom: '0.35em' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ opacity: 0.65 }}>{k}</span>
          <span style={{ fontFamily: 'ui-monospace, monospace' }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

/** Is this one of the two vocabulary forms `CellValue` can render?
 *  Checked by the caller so a value that's neither can fall through to
 *  the viewer's default rather than rendering an empty cell. */
export function isVocabValue(s: string): boolean {
  return s.startsWith('s:') || isS2Token(s)
}

/** The `cell` column's renderer. Only call when `isVocabValue`. */
export function CellValue({ value }: { value: string }) {
  return value.startsWith('s:')
    ? <StationKey shortName={value.slice(2)} raw={value} />
    : <S2Cell token={value} />
}

function S2Cell({ token }: { token: string }) {
  const level = s2CellLevel(token)!
  const content = (
    <>
      <Meta rows={[['token', token], ['level', `L${level}`], ['~edge', fmtMeters(s2CellEdgeMeters(token))]]} />
      <CellMark token={token} />
    </>
  )
  return (
    <Tip content={content} interactive placement="right">
      <Link className={css.cellLink} to={`/cells-debug?cell=${token}`}>
        {token}<sup className={css.level}>{level}</sup>
      </Link>
    </Tip>
  )
}

function StationKey({ shortName, raw }: { shortName: string; raw: string }) {
  const { data: stations } = useStations()
  const st = stations?.[shortName]
  const content = (
    <>
      <Meta rows={[
        ['key', raw],
        ...(st?.name ? ([['station', st.name]] as [string, string][]) : []),
        ...(st ? ([['region', st.region]] as [string, string][]) : []),
      ]} />
      {st ? <StationMark lat={st.lat} lng={st.lng} /> : null}
    </>
  )
  return (
    <Tip content={content} interactive placement="right">
      <Link className={css.cellLink} to={`/s/${shortName}`}>{shortName}</Link>
    </Tip>
  )
}
