/**
 * Debug page for station-set covers (S2 / vocab).
 *
 * Pick an arbitrary station set — click markers/cover-cells, lasso
 * polygon, geolocation/radius/N-nearest, region presets, or the
 * searchable neighborhoods catalog (`neighborhoods.json` via `ctbk
 * neighborhoods`: NYC NTA2020 + JC neighborhood associations) — and
 * see BOTH covers of it:
 *
 *  - raw-S2 `minimalCover` (± green/red, pyrmts-geo)
 *  - the positive-only `vocabCover` the API serves for region/bbox
 *    queries (`specs/rg-manifest.md` P3). Its `wanted` set is
 *    GEOGRAPHIC (every LUC leaf inside the selection's S2 footprint,
 *    incl. retired stations) — `v5UserCover` semantics. Exact-selection
 *    wanted fragments the cover badly: any coarse vocab ancestor is
 *    blocked when it would swallow a retired leaf (JC: 46 terms exact
 *    vs 10 cells geographic).
 *
 * Plus live rides/avail stats for the selection via the prod API.
 * Mount: `/cells-debug` (lazy via main.tsx).
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Circle, CircleMarker, MapContainer, Polygon, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { buildVocabGraph, isCellInCover, minimalCover, s2Index, vocabCover, type SpatialSet, type VocabGraph } from 'pyrmts-geo'
import { s2 } from 's2js'
import { API_BASE } from '../query/stations'

const { cellid, Cell } = s2

type Region = 'NYC' | 'JC' | 'HOB' | 'Other'
const REGIONS: Region[] = ['NYC', 'JC', 'HOB']

type Station = { lat: number; lng: number; region: Region; name?: string }
type Stations = Record<string, Station>

const REGION_COLOR: Record<Region, string> = {
  NYC: '#1976d2',
  JC: '#f57c00',
  HOB: '#388e3c',
  Other: '#9e9e9e',
}

// Station leaves land at FINEST before `minimalCover` compacts them;
// COARSEST caps output cells (the v3/v5 builds materialize L10..15).
const FINEST_LEVEL = 15
const COARSEST_LEVEL = 10

/** S2 cell → boundary polygon. Each edge is a great-circle arc (constant
 *  u/v on the cube face = a plane through the origin), so sample along it —
 *  normalized lerp between the endpoint vectors stays on the arc. Straight
 *  lat/lng segments visibly bow off-course at coarse levels. */
function s2CellVertices(token: string): [number, number][] {
  const ci = cellid.fromToken(token)
  const cell = Cell.fromCellID(ci)
  const level = cellid.level(ci)
  const perEdge = Math.max(1, Math.min(32, 2 ** (12 - level)))
  const r2d = 180 / Math.PI
  const pts: [number, number][] = []
  for (let i = 0; i < 4; i++) {
    const a = cell.vertex(i), b = cell.vertex((i + 1) & 3)
    for (let s = 0; s < perEdge; s++) {
      const t = s / perEdge
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t
      pts.push([Math.atan2(z, Math.hypot(x, y)) * r2d, Math.atan2(y, x) * r2d])
    }
  }
  return pts
}

// ─── selection helpers ────────────────────────────────────────────────

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

type LucLeaf = { key: string; cell: string }
type StationLucAsset = { by_short_name: Record<string, { cell: string; lat: number; lng: number }> }

/** `neighborhoods.json` (built by `ctbk neighborhoods`): named station-sets
 *  with source polygons — NYC NTA2020 + JC neighborhood associations. */
type NbhdSet = {
  id: string
  name: string
  group: string
  region: string
  stations: string[]
  polys: [number, number][][][]  // [poly][ring][pt] as [lat, lng]
}
type NbhdAsset = { sets: NbhdSet[] }
type NbhdGroup = { key: string; region: string; group: string; stations: string[]; members: NbhdSet[] }

function groupNbhds(sets: NbhdSet[]): NbhdGroup[] {
  const byKey = new Map<string, NbhdGroup>()
  const groups: NbhdGroup[] = []
  for (const s of sets) {
    const key = `${s.region}/${s.group}`
    let g = byKey.get(key)
    if (!g) {
      g = { key, region: s.region, group: s.group, stations: [], members: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.stations.push(...s.stations)
    g.members.push(s)
  }
  return groups
}

type SelTool = 'click' | 'lasso' | 'radius'

/** Map click dispatcher for the selection tools. */
function MapClicks({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onClick(e.latlng.lat, e.latlng.lng) })
  return null
}

export default function CellsDebug() {
  const [showStations, setShowStations] = useState(true)
  const [showCells, setShowCells] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tool, setTool] = useState<SelTool>('click')
  const [lassoPts, setLassoPts] = useState<[number, number][]>([])
  const [center, setCenter] = useState<[number, number] | null>(null)
  const [radiusM, setRadiusM] = useState(500)
  const [nearestN, setNearestN] = useState<number | ''>('')
  const [coverView, setCoverView] = useState<'vocab' | 's2'>('vocab')
  const [geoErr, setGeoErr] = useState<string | null>(null)
  const [setQuery, setSetQuery] = useState('')

  const stationsQ = useQuery<Stations>({
    queryKey: ['stations-regional'],
    queryFn: async () => (await fetch('/assets/stations-regional.json')).json(),
    staleTime: Infinity,
  })
  // Frozen serving vocabulary (`station-vocab.json` cells + `station-luc`
  // leaves) — the graph `vocabCover` minimizes over. `leaves` spans the
  // full LUC universe (incl. retired stations), needed for geographic
  // `wanted` computation.
  const vocabQ = useQuery<{ graph: VocabGraph; leaves: LucLeaf[]; leafKeys: Set<string> }>({
    queryKey: ['station-vocab-graph'],
    queryFn: async () => {
      const [vocab, luc] = await Promise.all([
        fetch('/assets/station-vocab.json').then((r) => r.json()) as Promise<{ cells: string[] }>,
        fetch('/assets/station-luc.json').then((r) => r.json()) as Promise<StationLucAsset>,
      ])
      const leaves = Object.entries(luc.by_short_name).map(([sn, e]) => ({ key: `s:${sn}`, cell: e.cell }))
      return {
        graph: buildVocabGraph(s2Index, vocab.cells, leaves),
        leaves,
        leafKeys: new Set(leaves.map((l) => l.key)),
      }
    },
    staleTime: Infinity,
  })
  const nbhdQ = useQuery<NbhdAsset>({
    queryKey: ['neighborhoods'],
    queryFn: async () => (await fetch('/assets/neighborhoods.json')).json(),
    staleTime: Infinity,
  })
  const nbhdGroups = useMemo(() => (nbhdQ.data ? groupNbhds(nbhdQ.data.sets) : []), [nbhdQ.data])

  // ── covers for the current selection ──
  const customCovers = useMemo(() => {
    if (!stationsQ.data || selected.size === 0) return null
    const stations = stationsQ.data
    const leafByStation = Object.entries(stations).map(([id, s]) => ({
      id, cell: s2Index.latLngToCell(s.lat, s.lng, FINEST_LEVEL),
    }))
    const system = Array.from(new Set(leafByStation.map((x) => x.cell)))
    const includeCells = Array.from(new Set(
      leafByStation.filter((x) => selected.has(x.id)).map((x) => x.cell),
    ))
    const s2Cover = minimalCover(s2Index, includeCells, system, {
      allowSubtraction: true,
      maxLevel: COARSEST_LEVEL,
    })
    let vocab: SpatialSet<string> | null = null
    let wantedCount = 0
    if (vocabQ.data) {
      // Geographic wanted: every LUC leaf inside the selection's S2
      // footprint — incl. retired stations that only exist in the LUC
      // universe. Matches `v5UserCover` region/bbox serving; see module
      // doc for why exact-selection wanted fragments the cover.
      const wanted = vocabQ.data.leaves
        .filter((l) => isCellInCover(s2Index, l.cell, s2Cover))
        .map((l) => l.key)
      wantedCount = wanted.length
      vocab = wanted.length > 0 ? vocabCover(vocabQ.data.graph, wanted, { positiveOnly: true }) : { include: [], exclude: [] }
    }
    return { s2Cover, vocab, wantedCount }
  }, [stationsQ.data, selected, vocabQ.data])

  // ── live stats for the selection (vocab cover → prod API) ──
  const vocabTerms = customCovers?.vocab?.include ?? null
  const statsQ = useQuery<{ rides12mo: number; bikesAvg: number; docksAvg: number }>({
    queryKey: ['custom-cover-stats', vocabTerms?.join(',') ?? ''],
    enabled: vocabTerms !== null && vocabTerms.length > 0,
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
  /** Bulk toggle: if every id is already selected, deselect them all;
   *  otherwise select them all. */
  const toggleStationIds = (ids: string[]) => {
    if (ids.length === 0) return
    setSelected((prev) => {
      const next = new Set(prev)
      const all = ids.every((id) => next.has(id))
      for (const id of ids) { if (all) next.delete(id); else next.add(id) }
      return next
    })
  }
  /** Clicking a rendered cover cell toggles the stations inside it —
   *  the easy way to de-select a chunk (2nd click on a fully-selected
   *  cell removes its stations). */
  const toggleCellStations = (tok: string) => {
    if (!stations) return
    const cover: SpatialSet<string> = { include: [tok], exclude: [] }
    const ids = Object.entries(stations)
      .filter(([, s]) => isCellInCover(s2Index, s2Index.latLngToCell(s.lat, s.lng, s2Index.maxLevel), cover))
      .map(([id]) => id)
    toggleStationIds(ids)
  }
  const isAllSelected = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id))
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
    if (tool === 'lasso') setLassoPts((p) => [...p, [lat, lng]])
    else if (tool === 'radius') setCenter([lat, lng])
  }

  if (stationsQ.isLoading) return <div style={{ padding: 16 }}>Loading…</div>
  if (stationsQ.error) return <div style={{ padding: 16 }}>Error loading data</div>
  if (!stations) return null

  const selectedInLuc = vocabQ.data
    ? [...selected].filter((id) => vocabQ.data!.leafKeys.has(`s:${id}`)).length
    : 0

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      <aside style={{ width: 320, padding: 16, overflowY: 'auto', borderRight: '1px solid rgba(128,128,128,0.4)' }}>
        <h2 style={{ marginTop: 0 }}>Cells Debug</h2>
        <p style={{ fontSize: 13, color: '#999' }}>
          Select stations (click, lasso, radius, or neighborhoods) and see
          their live <code>minimalCover</code> / <code>vocabCover</code> (pyrmts-geo).
        </p>
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
        <div style={{ background: 'rgba(128,128,128,0.15)', padding: 8, fontSize: 13, marginBottom: 12 }}>
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
              <span style={{ marginLeft: 6, color: '#999' }}>or click the map</span>
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
          <div style={{ marginBottom: 8 }}>
            <strong>Sets: </strong>
            <input
              type="text"
              placeholder="search neighborhoods…"
              value={setQuery}
              onChange={(e) => setSetQuery(e.target.value)}
              style={{ width: '60%' }}
            />
            {nbhdQ.isLoading && <div style={{ color: '#999' }}>loading sets…</div>}
            {nbhdQ.data && (() => {
              const q = setQuery.trim().toLowerCase()
              const matches = (s: NbhdSet) => !q || s.name.toLowerCase().includes(q) || s.group.toLowerCase().includes(q)
              const row = (label: string, ids: string[], onClick: () => void, indent: boolean, key: string, bold?: boolean) => (
                <div
                  key={key}
                  onClick={onClick}
                  style={{
                    paddingLeft: indent ? 16 : 0,
                    cursor: 'pointer',
                    fontWeight: bold ? 600 : 400,
                    userSelect: 'none',
                  }}
                >
                  {isAllSelected(ids) ? '☑' : '☐'} {label} <span style={{ color: '#999' }}>({ids.length})</span>
                </div>
              )
              return (
                <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4, border: '1px solid rgba(128,128,128,0.4)', padding: 4 }}>
                  {nbhdGroups.map((g) => {
                    const vis = g.members.filter(matches)
                    if (vis.length === 0) return null
                    return (
                      <div key={g.key}>
                        {row(`${g.group} (${g.region})`, g.stations, () => toggleStationIds(g.stations), false, g.key, true)}
                        {vis.map((s) => row(s.name, s.stations, () => toggleStationIds(s.stations), true, s.id))}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
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
                  {customCovers.vocab && (
                    <tr>
                      <td style={{ color: '#999' }}>wanted</td>
                      <td style={{ color: '#999' }}>
                        {customCovers.wantedCount} LUC leaves
                        {customCovers.wantedCount > selectedInLuc ? ` (+${customCovers.wantedCount - selectedInLuc} retired in footprint)` : ''}
                      </td>
                    </tr>
                  )}
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
              {statsQ.isFetching && <div style={{ color: '#999' }}>fetching stats…</div>}
              {statsQ.error && <div style={{ color: '#d32f2f' }}>stats: {String(statsQ.error)}</div>}
            </div>
          )}
        </div>
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
        {lassoPts.length > 0 && (
          <Polyline positions={[...lassoPts, lassoPts[0]!]} pathOptions={{ color: '#7b1fa2', weight: 2, dashArray: '6 4' }} />
        )}
        {tool === 'radius' && center && nearestN === '' && (
          <Circle center={center} radius={radiusM} pathOptions={{ color: '#7b1fa2', weight: 1, fillOpacity: 0.05 }} />
        )}
        {showCells && customCovers && coverView === 's2' && customCovers.s2Cover.include.map((tok) => (
          <Polygon key={`cs2i-${tok}`} positions={s2CellVertices(tok)}
            eventHandlers={tool === 'click' ? { click: () => toggleCellStations(tok) } : undefined}
            pathOptions={{ color: '#2e7d32', weight: 1.5, fillColor: '#2e7d32', fillOpacity: 0.15 }}>
            <Tooltip sticky>+ {tok} (L{cellid.level(cellid.fromToken(tok))}) — click to toggle stations</Tooltip>
          </Polygon>
        ))}
        {showCells && customCovers && coverView === 's2' && customCovers.s2Cover.exclude.map((tok) => (
          <Polygon key={`cs2e-${tok}`} positions={s2CellVertices(tok)}
            eventHandlers={tool === 'click' ? { click: () => toggleCellStations(tok) } : undefined}
            pathOptions={{ color: '#d32f2f', weight: 2, dashArray: '4 3', fillColor: '#d32f2f', fillOpacity: 0.15 }}>
            <Tooltip sticky>− {tok} (L{cellid.level(cellid.fromToken(tok))}) — click to toggle stations</Tooltip>
          </Polygon>
        ))}
        {showCells && customCovers?.vocab && coverView === 'vocab' && customCovers.vocab.include
          .filter((t) => !t.startsWith('s:'))
          .map((tok) => (
            <Polygon key={`cvi-${tok}`} positions={s2CellVertices(tok)}
              eventHandlers={tool === 'click' ? { click: () => toggleCellStations(tok) } : undefined}
              pathOptions={{ color: '#2e7d32', weight: 1.5, fillColor: '#2e7d32', fillOpacity: 0.15 }}>
              <Tooltip sticky>vocab {tok} (L{cellid.level(cellid.fromToken(tok))}) — click to toggle stations</Tooltip>
            </Polygon>
          ))}
        {showCells && customCovers?.vocab && coverView === 'vocab' && customCovers.vocab.include
          .filter((t) => t.startsWith('s:'))
          .map((term) => {
            const s = stations[term.slice(2)]
            return s ? (
              <CircleMarker key={`cvs-${term}`} center={[s.lat, s.lng]} radius={7}
                eventHandlers={tool === 'click' ? { click: () => toggleStation(term.slice(2)) } : undefined}
                pathOptions={{ color: '#2e7d32', weight: 2, fillOpacity: 0 }}>
                <Tooltip>vocab term {term}</Tooltip>
              </CircleMarker>
            ) : null
          })}
        {nbhdQ.data && nbhdQ.data.sets
          .filter((s) => isAllSelected(s.stations))
          .map((s) => (
            <Polygon key={`nb-${s.id}`} positions={s.polys} interactive={false}
              pathOptions={{ color: '#7b1fa2', weight: 1.5, dashArray: '2 4', fill: false }} />
          ))}
        {showStations && Object.entries(stations).map(([id, s]) => {
          const isSel = selected.has(id)
          return (
            <CircleMarker
              key={id}
              center={[s.lat, s.lng]}
              radius={isSel ? 4 : 2}
              eventHandlers={tool === 'click' ? { click: () => toggleStation(id) } : undefined}
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
