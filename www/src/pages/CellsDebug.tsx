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
 * Modes:
 *  - static: the shipped region-cells assets.
 *  - minCover: live per-region `minimalCover` (pyrmts-geo).
 *  - custom: pick an arbitrary station set (click markers, lasso
 *    polygon, or geolocation/radius/N-nearest) and see BOTH covers of
 *    it: the raw-S2 `minimalCover` (± green/red) and the positive-only
 *    `vocabCover` the API actually serves (`specs/rg-manifest.md` P3),
 *    plus live rides/avail stats for the selection via the prod API.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Circle, CircleMarker, MapContainer, Polygon, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { cellToBoundary, latLngToCell } from 'h3-js'
import { buildVocabGraph, h3Index, isCellInCover, minimalCover, s2Index, vocabCover, type SpatialSet, type VocabGraph } from 'pyrmts-geo'
import { s2 } from 's2js'
import { API_BASE } from '../query/stations'

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

type Mode = 'static' | 'minCover' | 'custom'

// ─── custom-selection helpers ─────────────────────────────────────────

/** Ray-casting point-in-polygon on [lat, lng] vertices. */
function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i]!, [yj, xj] = poly[j]!
    if ((xi > lng) !== (xj > lng) && lat < ((yj - yi) * (lng - xi)) / (xj - xi) + yi) inside = !inside
  }
  return inside
}

/** Haversine distance in meters. */
function distM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, d2r = Math.PI / 180
  const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

type StationLucAsset = { by_short_name: Record<string, { cell: string; lat: number; lng: number }> }

type SelTool = 'click' | 'lasso' | 'radius'

/** Map click dispatcher for the custom-selection tools. */
function MapClicks({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onClick(e.latlng.lat, e.latlng.lng) })
  return null
}

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

  // ── custom-selection state ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tool, setTool] = useState<SelTool>('click')
  const [lassoPts, setLassoPts] = useState<[number, number][]>([])
  const [center, setCenter] = useState<[number, number] | null>(null)
  const [radiusM, setRadiusM] = useState(500)
  const [nearestN, setNearestN] = useState<number | ''>('')
  const [coverView, setCoverView] = useState<'vocab' | 's2'>('vocab')
  const [geoErr, setGeoErr] = useState<string | null>(null)

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
  // Frozen serving vocabulary (`station-vocab.json` cells + `station-luc`
  // leaves) — the graph `vocabCover` minimizes over.
  const vocabQ = useQuery<{ graph: VocabGraph; leafKeys: Set<string> }>({
    queryKey: ['station-vocab-graph'],
    queryFn: async () => {
      const [vocab, luc] = await Promise.all([
        fetch('/assets/station-vocab.json').then((r) => r.json()) as Promise<{ cells: string[] }>,
        fetch('/assets/station-luc.json').then((r) => r.json()) as Promise<StationLucAsset>,
      ])
      const leaves = Object.entries(luc.by_short_name).map(([sn, e]) => ({ key: `s:${sn}`, cell: e.cell }))
      return {
        graph: buildVocabGraph(s2Index, vocab.cells, leaves),
        leafKeys: new Set(leaves.map((l) => l.key)),
      }
    },
    staleTime: Infinity,
  })

  // ── custom-mode covers ──
  const customCovers = useMemo(() => {
    if (mode !== 'custom' || !stationsQ.data || selected.size === 0) return null
    const stations = stationsQ.data
    const { finestLevel, coarsestLevel } = INDEX_DEFAULTS.s2
    const leafByStation = Object.entries(stations).map(([id, s]) => ({
      id, cell: s2Index.latLngToCell(s.lat, s.lng, finestLevel),
    }))
    const system = Array.from(new Set(leafByStation.map((x) => x.cell)))
    const includeCells = Array.from(new Set(
      leafByStation.filter((x) => selected.has(x.id)).map((x) => x.cell),
    ))
    const s2Cover = minimalCover(s2Index, includeCells, system, {
      allowSubtraction: true,
      maxLevel: coarsestLevel,
    })
    let vocab: SpatialSet<string> | null = null
    if (vocabQ.data) {
      const wanted = [...selected].map((id) => `s:${id}`).filter((k) => vocabQ.data!.leafKeys.has(k))
      vocab = wanted.length > 0 ? vocabCover(vocabQ.data.graph, wanted, { positiveOnly: true }) : { include: [], exclude: [] }
    }
    return { s2Cover, vocab }
  }, [mode, stationsQ.data, selected, vocabQ.data])

  // ── live stats for the selection (vocab cover → prod API) ──
  const vocabTerms = customCovers?.vocab?.include ?? null
  const statsQ = useQuery<{ rides12mo: number; bikesAvg: number; docksAvg: number }>({
    queryKey: ['custom-cover-stats', vocabTerms?.join(',') ?? ''],
    enabled: mode === 'custom' && vocabTerms !== null && vocabTerms.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const cells = vocabTerms!.join(',')
      const nowS = Math.floor(Date.now() / 900_000) * 900
      const to = new Date(nowS * 1000).toISOString()
      // Rides ingest ends at the last closed month — a trailing-12mo
      // window is always populated (a 30d one is empty mid-cycle).
      const from12mo = new Date((nowS - 365 * 86400) * 1000).toISOString()
      const from1h = new Date((nowS - 3600) * 1000).toISOString()
      const ridesUrl = `${API_BASE}/api/rides-v5?anchor=start&cells=${encodeURIComponent(cells)}&from=${from12mo}&to=${to}&bin=1mo`
      // bin_budget=4 over 1h → 15min-or-finer bins, so the tip bin is
      // recent (bin_budget=1 picks a 3h tier whose bin may not have
      // closed inside the window → empty records).
      const availUrl = `${API_BASE}/api/avail-v3?cells=${encodeURIComponent(cells)}&from=${from1h}&to=${to}&bin_budget=4&reducer=mean`
      const [rides, avail] = await Promise.all([
        fetch(ridesUrl).then((r) => { if (!r.ok) throw new Error(`rides: ${r.status}`); return r.json() }),
        fetch(availUrl).then((r) => { if (!r.ok) throw new Error(`avail: ${r.status}`); return r.json() }),
      ]) as [{ records: { count: number }[] }, { records: { dt: number; bikes: number; ebikes: number; docks: number }[] }]
      const rides12mo = rides.records.reduce((a, r) => a + (r.count ?? 0), 0)
      // The non-/cells avail route pools the histogram monoid across the
      // whole cover per bin, so `mean` = average per station-minute
      // (NOT a total; the output's `s2_cell` label is just the first
      // term). Report the latest bin's per-station averages.
      const latest = avail.records.reduce<typeof avail.records[number] | null>(
        (a, r) => (a === null || r.dt > a.dt ? r : a), null)
      const bikesAvg = latest ? (latest.bikes ?? 0) + (latest.ebikes ?? 0) : 0
      const docksAvg = latest ? (latest.docks ?? 0) : 0
      return { rides12mo: Math.round(rides12mo), bikesAvg, docksAvg }
    },
  })

  // ── selection actions ──
  const stations = stationsQ.data
  const toggleStation = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const applyLasso = (add: boolean) => {
    if (!stations || lassoPts.length < 3) return
    setSelected((prev) => {
      const next = new Set(prev)
      for (const [id, s] of Object.entries(stations)) {
        if (pointInPolygon(s.lat, s.lng, lassoPts)) {
          if (add) next.add(id); else next.delete(id)
        }
      }
      return next
    })
    setLassoPts([])
  }
  const applyRadius = () => {
    if (!stations || center === null) return
    const [clat, clng] = center
    const withDist = Object.entries(stations)
      .map(([id, s]) => ({ id, d: distM(clat, clng, s.lat, s.lng) }))
    const ids = nearestN !== '' && nearestN > 0
      ? withDist.sort((a, b) => a.d - b.d).slice(0, nearestN).map((x) => x.id)
      : withDist.filter((x) => x.d <= radiusM).map((x) => x.id)
    setSelected(new Set(ids))
  }
  const useMyLocation = () => {
    setGeoErr(null)
    if (!navigator.geolocation) { setGeoErr('geolocation unavailable'); return }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCenter([pos.coords.latitude, pos.coords.longitude]),
      (e) => setGeoErr(e.message),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }
  const selectRegion = (r: Region) => {
    if (!stations) return
    setSelected(new Set(Object.entries(stations).filter(([, s]) => s.region === r).map(([id]) => id)))
  }
  const onMapClick = (lat: number, lng: number) => {
    if (mode !== 'custom') return
    if (tool === 'lasso') setLassoPts((p) => [...p, [lat, lng]])
    else if (tool === 'radius') setCenter([lat, lng])
  }

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
  if (!stations || !cellsQ.data) return null

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
              <option value="custom">Custom selection (live covers)</option>
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
        {mode === 'custom' && (
          <div style={{ background: '#f5f5f5', padding: 8, fontSize: 13, marginBottom: 12 }}>
            <div style={{ marginBottom: 8 }}>
              <strong>Tool: </strong>
              <select value={tool} onChange={(e) => { setTool(e.target.value as SelTool); setLassoPts([]) }}>
                <option value="click">Click stations</option>
                <option value="lasso">Lasso polygon</option>
                <option value="radius">Location / radius</option>
              </select>
            </div>
            {tool === 'lasso' && (
              <div style={{ marginBottom: 8 }}>
                <div>Click the map to add vertices ({lassoPts.length}).</div>
                <button disabled={lassoPts.length < 3} onClick={() => applyLasso(true)}>Select inside</button>{' '}
                <button disabled={lassoPts.length < 3} onClick={() => applyLasso(false)}>Deselect inside</button>{' '}
                <button disabled={lassoPts.length === 0} onClick={() => setLassoPts([])}>Clear</button>
              </div>
            )}
            {tool === 'radius' && (
              <div style={{ marginBottom: 8 }}>
                <button onClick={useMyLocation}>Use my location</button>
                <span style={{ marginLeft: 6, color: '#666' }}>or click the map</span>
                {geoErr && <div style={{ color: '#d32f2f' }}>{geoErr}</div>}
                {center && <div>center: {center[0].toFixed(5)}, {center[1].toFixed(5)}</div>}
                <div style={{ marginTop: 4 }}>
                  <label>radius <input type="number" style={{ width: 64 }} value={radiusM} min={50} step={50}
                    onChange={(e) => setRadiusM(Number(e.target.value) || 0)} /> m</label>
                  <label style={{ marginLeft: 8 }}>or N nearest <input type="number" style={{ width: 48 }} value={nearestN}
                    onChange={(e) => setNearestN(e.target.value === '' ? '' : Number(e.target.value))} /></label>
                </div>
                <button style={{ marginTop: 4 }} disabled={center === null} onClick={applyRadius}>Select</button>
              </div>
            )}
            <div style={{ marginBottom: 8 }}>
              <strong>Presets: </strong>
              {REGIONS.map((r) => (
                <button key={r} style={{ color: REGION_COLOR[r] }} onClick={() => selectRegion(r)}>{r}</button>
              ))}{' '}
              <button onClick={() => setSelected(new Set())}>None</button>
            </div>
            <div><strong>{selected.size}</strong> stations selected</div>
            {customCovers && (
              <div style={{ marginTop: 8 }}>
                <div>
                  <strong>Cover: </strong>
                  <select value={coverView} onChange={(e) => setCoverView(e.target.value as 'vocab' | 's2')}>
                    <option value="vocab">vocabCover (as served)</option>
                    <option value="s2">minimalCover (raw S2 ±)</option>
                  </select>
                </div>
                <table style={{ width: '100%', marginTop: 4 }}>
                  <tbody>
                    <tr>
                      <td>S2 ±</td>
                      <td>+{customCovers.s2Cover.include.length} −{customCovers.s2Cover.exclude.length}</td>
                    </tr>
                    <tr>
                      <td>vocab</td>
                      <td>{customCovers.vocab
                        ? `${customCovers.vocab.include.length} terms (${customCovers.vocab.include.filter((t) => !t.startsWith('s:')).length} cells + ${customCovers.vocab.include.filter((t) => t.startsWith('s:')).length} s:)`
                        : 'loading vocab…'}</td>
                    </tr>
                  </tbody>
                </table>
                {statsQ.data && (
                  <table style={{ width: '100%', marginTop: 4 }}>
                    <tbody>
                      <tr><td>rides, last 12mo</td><td>{statsQ.data.rides12mo.toLocaleString()}</td></tr>
                      <tr><td>bikes/station now</td><td>{statsQ.data.bikesAvg.toFixed(1)} (≈{Math.round(statsQ.data.bikesAvg * selected.size)} total)</td></tr>
                      <tr><td>free docks/station now</td><td>{statsQ.data.docksAvg.toFixed(1)} (≈{Math.round(statsQ.data.docksAvg * selected.size)} total)</td></tr>
                    </tbody>
                  </table>
                )}
                {statsQ.isFetching && <div style={{ color: '#666' }}>fetching stats…</div>}
                {statsQ.error && <div style={{ color: '#d32f2f' }}>stats: {String(statsQ.error)}</div>}
              </div>
            )}
          </div>
        )}
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
        <MapClicks onClick={onMapClick} />
        {mode === 'custom' && lassoPts.length > 0 && (
          <Polyline positions={[...lassoPts, lassoPts[0]!]} pathOptions={{ color: '#7b1fa2', weight: 2, dashArray: '6 4' }} />
        )}
        {mode === 'custom' && tool === 'radius' && center && nearestN === '' && (
          <Circle center={center} radius={radiusM} pathOptions={{ color: '#7b1fa2', weight: 1, fillOpacity: 0.05 }} />
        )}
        {mode === 'custom' && customCovers && coverView === 's2' && customCovers.s2Cover.include.map((tok) => (
          <Polygon key={`cs2i-${tok}`} positions={s2CellVertices(tok)}
            pathOptions={{ color: '#2e7d32', weight: 1.5, fillColor: '#2e7d32', fillOpacity: 0.15 }}>
            <Tooltip sticky>+ {tok} (L{cellid.level(cellid.fromToken(tok))})</Tooltip>
          </Polygon>
        ))}
        {mode === 'custom' && customCovers && coverView === 's2' && customCovers.s2Cover.exclude.map((tok) => (
          <Polygon key={`cs2e-${tok}`} positions={s2CellVertices(tok)}
            pathOptions={{ color: '#d32f2f', weight: 2, dashArray: '4 3', fillColor: '#d32f2f', fillOpacity: 0.15 }}>
            <Tooltip sticky>− {tok} (L{cellid.level(cellid.fromToken(tok))})</Tooltip>
          </Polygon>
        ))}
        {mode === 'custom' && customCovers?.vocab && coverView === 'vocab' && customCovers.vocab.include
          .filter((t) => !t.startsWith('s:'))
          .map((tok) => (
            <Polygon key={`cvi-${tok}`} positions={s2CellVertices(tok)}
              pathOptions={{ color: '#2e7d32', weight: 1.5, fillColor: '#2e7d32', fillOpacity: 0.15 }}>
              <Tooltip sticky>vocab {tok} (L{cellid.level(cellid.fromToken(tok))})</Tooltip>
            </Polygon>
          ))}
        {mode === 'custom' && customCovers?.vocab && coverView === 'vocab' && customCovers.vocab.include
          .filter((t) => t.startsWith('s:'))
          .map((term) => {
            const s = stations[term.slice(2)]
            return s ? (
              <CircleMarker key={`cvs-${term}`} center={[s.lat, s.lng]} radius={7}
                pathOptions={{ color: '#2e7d32', weight: 2, fillOpacity: 0 }}>
                <Tooltip>vocab term {term}</Tooltip>
              </CircleMarker>
            ) : null
          })}
        {showCells && mode !== 'custom' && REGIONS.flatMap((region) =>
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
        {showCells && mode !== 'custom' && REGIONS.flatMap((region) =>
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
        {showStations && Object.entries(stations).map(([id, s]) => {
          const isSel = mode === 'custom' && selected.has(id)
          return (
            <CircleMarker
              key={id}
              center={[s.lat, s.lng]}
              radius={isSel ? 4 : 2}
              eventHandlers={mode === 'custom' && tool === 'click' ? { click: () => toggleStation(id) } : undefined}
              pathOptions={{
                color: isSel ? '#7b1fa2' : REGION_COLOR[s.region],
                fillColor: isSel ? '#7b1fa2' : REGION_COLOR[s.region],
                fillOpacity: 0.9,
                weight: isSel ? 2 : 1,
              }}
            >
              <Tooltip>{id} ({s.region}){s.name ? ` — ${s.name}` : ''}</Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>
    </div>
  )
}

void round  // placate unused-import linter; available for future stat rounding
