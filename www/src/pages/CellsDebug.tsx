/**
 * Debug page for region-cells covers (h3 / s2).
 *
 * Renders stations colored by region + the static region-cells.json /
 * region-cells-s2.json cells as polygons on Leaflet. Shows per-region
 * cover-quality stats: which stations are correctly covered, leaked
 * from another region, or missed by their own region's cover.
 *
 * Mount: `/cells-debug` (lazy via main.tsx).
 *
 * Phase 1 (this file): static covers only.
 * Phase 2 (future): live minimalCover toggle.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Polygon, TileLayer, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { cellToBoundary, latLngToCell } from 'h3-js'
import { h3Index, isCellInCover, minimalCover, s2Index, type SpatialSet } from 'pyrmts-geo'
import { s2 } from 's2js'

const { cellid, Cell, LatLng } = s2
const { round } = Math

type Region = 'NYC' | 'JC' | 'HOB' | 'Other'
const REGIONS: Region[] = ['NYC', 'JC', 'HOB']

type Station = { lat: number; lng: number; region: Region; name?: string }
type Stations = Record<string, Station>
type RegionCells = Record<Region, string[]>
type RegionCover = Record<Region, SpatialSet<string>>

const REGION_COLOR: Record<Region, string> = {
  NYC: '#1976d2',
  JC: '#f57c00',
  HOB: '#388e3c',
  Other: '#9e9e9e',
}

const INDEX_DEFAULTS: Record<'h3' | 's2', { url: string; level: number; finestLevel: number; coarsestLevel: number }> = {
  // `finestLevel` = where station leaves land before minimalCover compacts them.
  // `coarsestLevel` = maxLevel allowed in cover output. For h3 use the materialized
  // pyramid resolutions (5/7/9); for s2, the v3 build materializes 10..15.
  h3: { url: '/assets/region-cells.json',    level: 7,  finestLevel: 9,  coarsestLevel: 5  },
  s2: { url: '/assets/region-cells-s2.json', level: 11, finestLevel: 15, coarsestLevel: 10 },
}

/** Convert s2 token to closed polygon (4 vertices + repeat first to close). */
function s2CellVertices(token: string): [number, number][] {
  const ci = cellid.fromToken(token)
  const cell = Cell.fromCellID(ci)
  const pts: [number, number][] = []
  for (let i = 0; i < 4; i++) {
    const p = cell.vertex(i)
    const ll = LatLng.fromPoint(p)
    pts.push([(ll.lat as number) * 180 / Math.PI, (ll.lng as number) * 180 / Math.PI])
  }
  return pts
}

function cellBoundary(token: string, index: 'h3' | 's2'): [number, number][] {
  return index === 'h3' ? cellToBoundary(token) : s2CellVertices(token)
}

/** Per-region coverage stats:
 *  - `covered`: stations whose own region's cover contains them.
 *  - `leaked`: stations from OTHER regions caught by this region's cover.
 *  - `missed`: own-region stations whose cell isn't in this region's cover. */
type RegionStats = { covered: number; leaked: number; missed: number; cellCount: number }

/** Derive the canonical level from the first cell across all regions
 *  (covers may be single-level only — Phase 1). */
function detectLevel(cells: RegionCells, index: 'h3' | 's2'): number | null {
  for (const r of REGIONS) {
    const ts = cells[r]
    if (!ts || ts.length === 0) continue
    const tok = ts[0]!
    if (index === 'h3') return parseInt(tok[1]!, 16)
    return cellid.level(cellid.fromToken(tok))
  }
  return null
}

function computeStats(
  stations: Stations,
  cells: RegionCells,
  index: 'h3' | 's2',
  level: number,
): Record<Region, RegionStats> {
  const cellSets: Record<Region, Set<string>> = {} as Record<Region, Set<string>>
  for (const r of REGIONS) cellSets[r] = new Set(cells[r] ?? [])
  cellSets.Other = new Set()

  const init = (): RegionStats => ({ covered: 0, leaked: 0, missed: 0, cellCount: 0 })
  const out: Record<Region, RegionStats> = {
    NYC: init(), JC: init(), HOB: init(), Other: init(),
  }
  for (const r of REGIONS) out[r].cellCount = cellSets[r].size

  for (const sid in stations) {
    const s = stations[sid]!
    const c = index === 'h3'
      ? latLngToCell(s.lat, s.lng, level)
      : cellid.toToken(cellid.parent(cellid.fromLatLng(LatLng.fromDegrees(s.lat, s.lng)), level))
    let coveredBy: Region | null = null
    for (const r of REGIONS) {
      if (cellSets[r].has(c)) { coveredBy = r; break }
    }
    if (coveredBy === null) {
      if (REGIONS.includes(s.region)) out[s.region].missed += 1
    } else if (coveredBy === s.region) {
      out[coveredBy].covered += 1
    } else {
      out[coveredBy].leaked += 1
      if (REGIONS.includes(s.region)) out[s.region].missed += 1
    }
  }
  return out
}

type Mode = 'static' | 'minCover'

/** Compute per-region `minimalCover(include=this-region's stations,
 *  system=ALL stations)`. Returns mixed-resolution `{include, exclude}`
 *  per region, with lineage-disjoint cells. */
function computeMinCovers(
  stations: Stations,
  index: 'h3' | 's2',
  finestLevel: number,
  coarsestLevel: number,
): RegionCover {
  const idx = index === 'h3' ? h3Index : s2Index
  // Map each station to its leaf cell at `finestLevel`.
  const leafByStation: { region: Region; cell: string }[] = []
  for (const sid in stations) {
    const s = stations[sid]!
    leafByStation.push({ region: s.region, cell: idx.latLngToCell(s.lat, s.lng, finestLevel) })
  }
  const systemCells = Array.from(new Set(leafByStation.map((x) => x.cell)))
  const out: RegionCover = {
    NYC: { include: [], exclude: [] },
    JC: { include: [], exclude: [] },
    HOB: { include: [], exclude: [] },
    Other: { include: [], exclude: [] },
  }
  for (const r of REGIONS) {
    const includeCells = Array.from(new Set(leafByStation.filter((x) => x.region === r).map((x) => x.cell)))
    if (includeCells.length === 0) continue
    out[r] = minimalCover(idx, includeCells, systemCells, {
      allowSubtraction: true,
      maxLevel: coarsestLevel,
    })
  }
  return out
}

export default function CellsDebug() {
  const [index, setIndex] = useState<'h3' | 's2'>('s2')
  const [mode, setMode] = useState<Mode>('static')
  const [showStations, setShowStations] = useState(true)
  const [showCells, setShowCells] = useState(true)

  const stationsQ = useQuery<Stations>({
    queryKey: ['stations-regional'],
    queryFn: async () => (await fetch('/assets/stations-regional.json')).json(),
    staleTime: Infinity,
  })
  const cellsQ = useQuery<RegionCells>({
    queryKey: ['region-cells', index],
    queryFn: async () => (await fetch(INDEX_DEFAULTS[index].url)).json(),
    staleTime: Infinity,
  })

  const detectedLevel = useMemo(
    () => (cellsQ.data ? detectLevel(cellsQ.data, index) : null),
    [cellsQ.data, index],
  )
  const minCovers = useMemo<RegionCover | null>(() => {
    if (mode !== 'minCover' || !stationsQ.data) return null
    const { finestLevel, coarsestLevel } = INDEX_DEFAULTS[index]
    return computeMinCovers(stationsQ.data, index, finestLevel, coarsestLevel)
  }, [mode, stationsQ.data, index])

  // Cells to render: static includes-only, vs minimalCover include/exclude.
  const renderCells: RegionCells = useMemo(() => {
    if (mode === 'minCover' && minCovers) {
      return {
        NYC: minCovers.NYC.include, JC: minCovers.JC.include,
        HOB: minCovers.HOB.include, Other: [],
      }
    }
    return cellsQ.data ?? { NYC: [], JC: [], HOB: [], Other: [] }
  }, [mode, minCovers, cellsQ.data])
  const renderExcludes: RegionCells = useMemo(() => {
    if (mode === 'minCover' && minCovers) {
      return {
        NYC: minCovers.NYC.exclude, JC: minCovers.JC.exclude,
        HOB: minCovers.HOB.exclude, Other: [],
      }
    }
    return { NYC: [], JC: [], HOB: [], Other: [] }
  }, [mode, minCovers])

  const staticStats = useMemo(() => {
    if (!stationsQ.data || !cellsQ.data || detectedLevel === null) return null
    return computeStats(stationsQ.data, cellsQ.data, index, detectedLevel)
  }, [stationsQ.data, cellsQ.data, index, detectedLevel])
  const minCoverStats = useMemo(() => {
    if (mode !== 'minCover' || !stationsQ.data || !minCovers) return null
    const idx = index === 'h3' ? h3Index : s2Index
    const { finestLevel } = INDEX_DEFAULTS[index]
    const init = (): RegionStats => ({ covered: 0, leaked: 0, missed: 0, cellCount: 0 })
    const out: Record<Region, RegionStats> = {
      NYC: init(), JC: init(), HOB: init(), Other: init(),
    }
    for (const r of REGIONS) {
      out[r].cellCount = minCovers[r].include.length + minCovers[r].exclude.length
    }
    for (const sid in stationsQ.data) {
      const s = stationsQ.data[sid]!
      const cell = idx.latLngToCell(s.lat, s.lng, finestLevel)
      let coveredBy: Region | null = null
      for (const r of REGIONS) {
        if (isCellInCover(idx, cell, minCovers[r])) { coveredBy = r; break }
      }
      if (coveredBy === null) {
        if (REGIONS.includes(s.region)) out[s.region].missed += 1
      } else if (coveredBy === s.region) {
        out[coveredBy].covered += 1
      } else {
        out[coveredBy].leaked += 1
        if (REGIONS.includes(s.region)) out[s.region].missed += 1
      }
    }
    return out
  }, [mode, stationsQ.data, minCovers, index])
  const stats = mode === 'minCover' ? minCoverStats : staticStats

  if (stationsQ.isLoading || cellsQ.isLoading) return <div style={{ padding: 16 }}>Loading…</div>
  if (stationsQ.error || cellsQ.error)
    return <div style={{ padding: 16 }}>Error loading data</div>
  if (!stationsQ.data || !cellsQ.data) return null

  const stations = stationsQ.data

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      <aside style={{ width: 320, padding: 16, overflowY: 'auto', borderRight: '1px solid #ccc' }}>
        <h2 style={{ marginTop: 0 }}>Cells Debug</h2>
        <p style={{ fontSize: 13, color: '#666' }}>
          Visualize region covers — static single-level vs live
          <code> minimalCover</code> (pyrmts-geo).
        </p>
        <div style={{ marginBottom: 12 }}>
          <label><strong>Index: </strong>
            <select value={index} onChange={(e) => setIndex(e.target.value as 'h3' | 's2')}>
              <option value="h3">H3</option>
              <option value="s2">S2</option>
            </select>
          </label>
          {detectedLevel !== null && <span style={{ marginLeft: 8, fontSize: 13, color: '#666' }}>
            (detected level: {index === 'h3' ? 'r' : 'L'}{detectedLevel})
          </span>}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label><strong>Cover: </strong>
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="static">Static (region-cells.json)</option>
              <option value="minCover">minimalCover (live; pyrmts-geo)</option>
            </select>
          </label>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label>
            <input type="checkbox" checked={showCells} onChange={(e) => setShowCells(e.target.checked)} />
            Show cell polygons
          </label>
          <br />
          <label>
            <input type="checkbox" checked={showStations} onChange={(e) => setShowStations(e.target.checked)} />
            Show stations
          </label>
        </div>
        {mode === 'minCover' && minCovers && (
          <div style={{ background: '#f5f5f5', padding: 8, fontSize: 13, marginBottom: 12 }}>
            <strong>minCover sizes:</strong>
            <table style={{ width: '100%' }}>
              <tbody>
                {REGIONS.map((r) => (
                  <tr key={r}>
                    <td style={{ color: REGION_COLOR[r] }}>{r}</td>
                    <td>+{minCovers[r].include.length}</td>
                    <td>−{minCovers[r].exclude.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>Coverage</h3>
        {stats && (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
                <th>Region</th><th>Cells</th><th title="own-region stations in own-region cover">✓</th>
                <th title="other-region stations caught by this region's cover">leak</th>
                <th title="own-region stations missed by own-region cover">miss</th>
              </tr>
            </thead>
            <tbody>
              {REGIONS.map((r) => {
                const s = stats[r]
                return (
                  <tr key={r}>
                    <td style={{ color: REGION_COLOR[r] }}>{r}</td>
                    <td>{s.cellCount}</td>
                    <td>{s.covered}</td>
                    <td>{s.leaked}</td>
                    <td>{s.missed}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <h3>Stations</h3>
        <table style={{ width: '100%', fontSize: 13 }}>
          <tbody>
            {REGIONS.map((r) => {
              const n = Object.values(stations).filter((s) => s.region === r).length
              return <tr key={r}><td style={{ color: REGION_COLOR[r] }}>{r}</td><td>{n}</td></tr>
            })}
            <tr><td>Total</td><td>{Object.keys(stations).length}</td></tr>
          </tbody>
        </table>
      </aside>
      <MapContainer
        style={{ flex: 1, background: '#eee' }}
        center={[40.74, -73.98]}
        zoom={11}
        scrollWheelZoom
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        {showCells && REGIONS.flatMap((region) =>
          (renderCells[region] ?? []).map((tok) => (
            <Polygon
              key={`inc-${region}-${tok}`}
              positions={cellBoundary(tok, index)}
              pathOptions={{
                color: REGION_COLOR[region],
                weight: 1,
                fillColor: REGION_COLOR[region],
                fillOpacity: 0.1,
              }}
            >
              <Tooltip sticky>{region} +: {tok}</Tooltip>
            </Polygon>
          )),
        )}
        {showCells && REGIONS.flatMap((region) =>
          (renderExcludes[region] ?? []).map((tok) => (
            <Polygon
              key={`exc-${region}-${tok}`}
              positions={cellBoundary(tok, index)}
              pathOptions={{
                color: '#d32f2f',
                weight: 2,
                dashArray: '4 3',
                fillColor: '#d32f2f',
                fillOpacity: 0.05,
              }}
            >
              <Tooltip sticky>{region} −: {tok}</Tooltip>
            </Polygon>
          )),
        )}
        {showStations && Object.entries(stations).map(([id, s]) => (
          <CircleMarker
            key={id}
            center={[s.lat, s.lng]}
            radius={2}
            pathOptions={{
              color: REGION_COLOR[s.region],
              fillColor: REGION_COLOR[s.region],
              fillOpacity: 0.9,
              weight: 1,
            }}
          >
            <Tooltip>{id} ({s.region}){s.name ? ` — ${s.name}` : ''}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  )
}

void round  // placate unused-import linter; available for future stat rounding
