/**
 * Debug page for station-set covers (S2 / vocab).
 *
 * Pick an arbitrary station set — click markers/cover-cells, ⌘-drag
 * rectangle, lasso polygon, geolocation/radius/N-nearest, region
 * presets, or the searchable neighborhoods catalog (`neighborhoods.json`
 * via `ctbk neighborhoods`: NYC NTA2020 + JC neighborhood associations)
 * — and see how `vocabCover` (pyrmts-geo) resolves it: the actual
 * terms the API would be handed for EXACTLY the selected stations
 * (`s:` leaf keys), in both the positive-only form (`cells=` is an
 * include-list) and the ± variant an `exclude_cells=` param would
 * allow. Cell terms only appear when every LUC leaf under them (incl.
 * retired stations) is selected — a retired leaf blocks its vocab
 * ancestors, which is why area-shaped selections still cost `s:`
 * fan-out (region/bbox serving instead uses geographic wanted,
 * `v5UserCover`).
 *
 * The Cover dropdown also has a raw-S2 `minimalCover` (± green/red)
 * what-if baseline: stations as uniform-L15 point cells, no `s:`
 * terms (see the `FINEST_LEVEL` lossiness caveat below).
 *
 * Plus live rides/avail stats for the selection via the prod API.
 * Mount: `/cells-debug` (lazy via main.tsx).
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Circle, CircleMarker, MapContainer, Polygon, Polyline, Rectangle, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { buildVocabGraph, isCellInCover, minimalCover, s2Index, vocabCover, type SpatialSet, type VocabGraph } from 'pyrmts-geo'
import { llzParam, useUrlState } from 'use-prms'
import type { LLZ, Param } from 'use-prms'
import { s2 } from 's2js'
import { API_BASE } from '../query/stations'
import { useCellsDebugOmnibar } from '../hooks/useCellsDebugOmnibar'
import { isS2Token, s2CellBounds, s2CellVertices, s2ParentEdgeArcs } from '../lib/s2geo'

const { cellid } = s2

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

// Station leaves land at FINEST before `minimalCover` compacts them.
// L15 is lossy: ~1100/2340 stations share their L15 cell with a neighbor
// (LUC level ≥16), so a cover for one silently spans the other (e.g.
// JC081 ⇒ its L14 also holds unselected JC075). The right system is
// per-station LUC cells from `station-luc.json`.
//
// That used to be blocked on `minimalCover` requiring a uniform-level
// system; it isn't since 2026-08-14 (pyrmts
// `specs/minimal-cover-mixed-levels.md` — `buildTree` is now a
// level-stratified deepest-first walk) and `www` already pins a dist
// with the fix. What's left is switching the system here and deduping
// the `_`-alias stations whose fallback cells nest real LUC cells —
// tracked in `specs/pyrmts-geo-h3-removal.md` item 4.
// COARSEST caps output cells (the v3/v5 builds materialize L10..15).
const FINEST_LEVEL = 15
const COARSEST_LEVEL = 10

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

type LucLeaf = { key: string; cell: string; lat: number; lng: number }
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

const DEFAULT_LLZ: LLZ = { lat: 40.74, lng: -73.98, zoom: 11 }
const viewParam = llzParam({ default: DEFAULT_LLZ, latLngDecimals: 3 })

/** `?sel=`: comma-joined sorted short_names. NB: region presets select
 *  2k+ stations → very long (but functional) URLs; fine for a debug page. */
const selParam: Param<Set<string>> = {
  encode: (v) => (v.size ? [...v].sort().join(',') : undefined),
  decode: (raw) => new Set(raw ? raw.split(',').filter(Boolean) : []),
}

/** `?cell=<s2 token>`: deep-link one S2 cell. Written by the parquet
 *  viewer's cell tooltips (`/files/*`), where a bare token like
 *  `89c244c` is otherwise unlocatable. Invalid tokens decode to `null`
 *  rather than throwing downstream in the geometry helpers. */
const cellParam: Param<string | null> = {
  encode: (v) => v ?? undefined,
  decode: (raw) => (raw && isS2Token(raw) ? raw : null),
}

/** Fits the viewport to `?cell=` on mount and on token change.
 *
 *  Deliberately overrides a `?ll=` present in the same URL: the point of
 *  the link is "show me this cell", and the `ll` a share carries is
 *  whatever viewport the linker happened to be at. Panning afterwards
 *  updates `ll` normally without re-triggering (the effect is keyed on
 *  the token). */
function FitCell({ token }: { token: string | null }) {
  const map = useMap()
  useEffect(() => {
    if (!token) return
    const b = s2CellBounds(token)
    map.fitBounds([[b.latMin, b.lngMin], [b.latMax, b.lngMax]], { padding: [80, 80], maxZoom: 17 })
  }, [map, token])
  return null
}

/** Map click + zoom dispatcher for the selection tools / marker sizing. */
function MapEvents({ onClick, onMoveEnd, onMove, onDown, onDblClick, disableDblZoom, disableDrag }: {
  onClick: (lat: number, lng: number) => void
  onMoveEnd: (lat: number, lng: number, zoom: number) => void
  onMove: (lat: number, lng: number) => void
  onDown: (lat: number, lng: number, meta: boolean, ev: MouseEvent) => void
  onDblClick: () => void
  disableDblZoom: boolean
  disableDrag: boolean
}) {
  const map = useMapEvents({
    click: (e) => onClick(e.latlng.lat, e.latlng.lng),
    // `moveend` also fires after zooms — one hook covers pan + zoom.
    moveend: (e) => {
      const m = e.target, c = m.getCenter()
      onMoveEnd(c.lat, c.lng, m.getZoom())
    },
    mousemove: (e) => onMove(e.latlng.lat, e.latlng.lng),
    // ⌘-rect release is handled by a window `mouseup` listener (works
    // even when the pointer leaves the map), not a map `mouseup`.
    mousedown: (e) => onDown(e.latlng.lat, e.latlng.lng, e.originalEvent.metaKey || e.originalEvent.ctrlKey, e.originalEvent),
    dblclick: () => onDblClick(),
  })
  // Double-click finishes the lasso — zoom would fight it.
  useEffect(() => {
    if (disableDblZoom) map.doubleClickZoom.disable()
    else map.doubleClickZoom.enable()
  }, [map, disableDblZoom])
  // ⌘-drag draws a selection rectangle — map panning would fight it.
  useEffect(() => {
    if (disableDrag) map.dragging.disable()
    else map.dragging.enable()
  }, [map, disableDrag])
  return null
}

export default function CellsDebug() {
  const [showStations, setShowStations] = useState(true)
  const [showCells, setShowCells] = useState(true)
  const [selected, setSelected] = useUrlState('sel', selParam)
  const [view, setView] = useUrlState('ll', viewParam)
  const [focusCell] = useUrlState('cell', cellParam)
  const [tool, setTool] = useState<SelTool>('click')
  const [lassoPts, setLassoPts] = useState<[number, number][]>([])
  const [cursor, setCursor] = useState<[number, number] | null>(null)
  // In-progress ⌘-drag selection rectangle (corner a = mousedown, b =
  // cursor). State renders it; the ref is the source of truth for the
  // event handlers — a fast down→move→up can finish before React commits
  // (or paints), so gesture logic can't wait on state.
  const [rect, setRect] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const rectRef = useRef<{ a: [number, number]; b: [number, number] } | null>(null)
  // ⌘ held: map dragging must be OFF *before* the mousedown lands —
  // Leaflet's Draggable captures the gesture synchronously, so disabling
  // in reaction to the mousedown itself is too late (it pans anyway).
  const [metaHeld, setMetaHeld] = useState(false)
  useEffect(() => {
    const set = (e: KeyboardEvent, v: boolean) => { if (e.key === 'Meta' || e.key === 'Control') setMetaHeld(v) }
    const down = (e: KeyboardEvent) => set(e, true)
    const up = (e: KeyboardEvent) => set(e, false)
    const blur = () => setMetaHeld(false)  // ⌘-Tab away would strand the disable
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  // A finished ⌘-rect's mouseup still emits a `click` (Leaflet only eats
  // it after a real map pan) — ignore clicks in this window after release.
  const suppressClicksUntil = useRef(0)
  const [highlightTok, setHighlightTok] = useState<string | null>(null)
  const [center, setCenter] = useState<[number, number] | null>(null)
  const [radiusM, setRadiusM] = useState(500)
  const [nearestN, setNearestN] = useState<number | ''>('')
  const [coverView, setCoverView] = useState<'vocab' | 'vocabPm' | 's2'>('vocab')
  const [geoErr, setGeoErr] = useState<string | null>(null)
  const [setQuery, setSetQuery] = useState('')
  const [zoom, setZoom] = useState(view.zoom)
  const [showVocabGrid, setShowVocabGrid] = useState(false)

  const stationsQ = useQuery<Stations>({
    queryKey: ['stations-regional'],
    queryFn: async () => (await fetch('/assets/stations-regional.json')).json(),
    staleTime: Infinity,
  })
  // Frozen serving vocabulary (`station-vocab.json` cells + `station-luc`
  // leaves) — the graph `vocabCover` minimizes over. `leaves` spans the
  // full LUC universe (incl. retired stations), used for vocab-grid
  // counts and retired-leaf marker positions.
  const vocabQ = useQuery<{ graph: VocabGraph; leaves: LucLeaf[]; leafKeys: Set<string>; cells: string[] }>({
    queryKey: ['station-vocab-graph'],
    queryFn: async () => {
      const [vocab, luc] = await Promise.all([
        fetch('/assets/station-vocab.json').then((r) => r.json()) as Promise<{ cells: string[] }>,
        fetch('/assets/station-luc.json').then((r) => r.json()) as Promise<StationLucAsset>,
      ])
      const leaves = Object.entries(luc.by_short_name).map(([sn, e]) => ({ key: `s:${sn}`, cell: e.cell, lat: e.lat, lng: e.lng }))
      return {
        graph: buildVocabGraph(s2Index, vocab.cells, leaves),
        leaves,
        leafKeys: new Set(leaves.map((l) => l.key)),
        cells: vocab.cells,
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

  // Vocab-grid layer: every frozen vocab cell, with its LUC-leaf count and
  // whether it split (has vocab children). Counts by walking each leaf's
  // ancestor tokens (cheap: leaves × levels), not cell×leaf containment.
  const vocabGrid = useMemo(() => {
    if (!showVocabGrid || !vocabQ.data) return null
    const vocabSet = new Set(vocabQ.data.cells)
    const counts = new Map<string, number>()
    for (const l of vocabQ.data.leaves) {
      const ci = cellid.fromToken(l.cell)
      const leafLvl = cellid.level(ci)
      for (let lvl = 10; lvl <= Math.min(20, leafLvl); lvl++) {
        const tok = cellid.toToken(cellid.parent(ci, lvl))
        if (vocabSet.has(tok)) counts.set(tok, (counts.get(tok) ?? 0) + 1)
      }
    }
    return vocabQ.data.cells.map((tok) => {
      const kids = cellid.children(cellid.fromToken(tok))
      const split = kids.some((k) => vocabSet.has(cellid.toToken(k)))
      return { tok, level: cellid.level(cellid.fromToken(tok)), count: counts.get(tok) ?? 0, split, verts: s2CellVertices(tok) }
    })
  }, [showVocabGrid, vocabQ.data])

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
    // NB: `maxLevel` is a dead `MinimalCoverOpts` field (unread by the DP);
    // `coarsestLevel` is the real cap — without it big selections roll up
    // to L7-8 cells no materialized tier can serve.
    const s2Cover = minimalCover(s2Index, includeCells, system, {
      allowSubtraction: true,
      coarsestLevel: COARSEST_LEVEL,
    })
    let vocab: SpatialSet<string> | null = null
    let vocabPm: SpatialSet<string> | null = null
    if (vocabQ.data) {
      // Exact-selection wanted: the cover must resolve to precisely the
      // chosen stations — what the API would be handed for this set.
      // Positive-only = what rides-v5 serving can express (`cells=` is an
      // include-list). The ± variant shows what an exclude param would buy:
      // sibling groups collapse to "parent minus blockers".
      const wanted = [...selected].map((id) => `s:${id}`).filter((k) => vocabQ.data!.leafKeys.has(k))
      vocab = wanted.length > 0 ? vocabCover(vocabQ.data.graph, wanted, { positiveOnly: true }) : { include: [], exclude: [] }
      vocabPm = wanted.length > 0 ? vocabCover(vocabQ.data.graph, wanted) : { include: [], exclude: [] }
    }
    return { s2Cover, vocab, vocabPm }
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
  const clickSuppressed = () => performance.now() < suppressClicksUntil.current
  const toggleStation = (id: string) => {
    if (clickSuppressed()) return
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }
  /** Bulk toggle: if every id is already selected, deselect them all;
   *  otherwise select them all. */
  const toggleStationIds = (ids: string[]) => {
    if (ids.length === 0) return
    const next = new Set(selected)
    const all = ids.every((id) => next.has(id))
    for (const id of ids) { if (all) next.delete(id); else next.add(id) }
    setSelected(next)
  }
  // Omnibar (⌘K): every neighborhood set/group and every station.
  useCellsDebugOmnibar({
    stations,
    sets: nbhdQ.data?.sets,
    groups: nbhdGroups,
    toggleStationIds,
    toggleStation,
  })

  /** Clicking a rendered cover cell toggles the stations inside it —
   *  the easy way to de-select a chunk (2nd click on a fully-selected
   *  cell removes its stations). */
  const toggleCellStations = (tok: string) => {
    if (!stations || clickSuppressed()) return
    const cover: SpatialSet<string> = { include: [tok], exclude: [] }
    const ids = Object.entries(stations)
      .filter(([, s]) => isCellInCover(s2Index, s2Index.latLngToCell(s.lat, s.lng, s2Index.maxLevel), cover))
      .map(([id]) => id)
    toggleStationIds(ids)
  }
  const isAllSelected = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id))
  const applyLasso = (add: boolean, pts: [number, number][] = lassoPts) => {
    if (!stations || pts.length < 3) return
    const next = new Set(selected)
    for (const [id, s] of Object.entries(stations)) {
      if (pointInPolygon(s.lat, s.lng, pts)) {
        if (add) next.add(id); else next.delete(id)
      }
    }
    setSelected(next)
    setLassoPts([])
    setCursor(null)
  }
  /** Double-click finish: the dblclick's two click events each appended
   *  a vertex at ~the same point — drop the dup(s) before applying. */
  const finishLasso = () => {
    const q = [...lassoPts]
    while (q.length >= 2) {
      const [alat, alng] = q[q.length - 1]!, [blat, blng] = q[q.length - 2]!
      if (Math.abs(alat - blat) < 1e-7 && Math.abs(alng - blng) < 1e-7) q.pop()
      else break
    }
    if (q.length >= 3) applyLasso(true, q)
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
  /** ⌘-drag rectangle: bulk-toggle stations in the dragged bounds (any tool). */
  const onMapDown = (lat: number, lng: number, meta: boolean, ev: MouseEvent) => {
    if (!meta) return
    ev.preventDefault()  // no text selection while dragging
    rectRef.current = { a: [lat, lng], b: [lat, lng] }
    setRect(rectRef.current)
  }
  const finishRect = () => {
    const r = rectRef.current
    if (!r) return
    rectRef.current = null
    setRect(null)
    const { a, b } = r
    // Sub-4px drags are just ⌘clicks — let the ensuing click through.
    const degPerPx = 360 / (256 * 2 ** zoom)
    if (Math.hypot((a[1] - b[1]) / degPerPx, (a[0] - b[0]) / degPerPx) < 4) return
    suppressClicksUntil.current = performance.now() + 200
    if (!stations) return
    const [latLo, latHi] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
    const [lngLo, lngHi] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
    toggleStationIds(Object.entries(stations)
      .filter(([, s]) => s.lat >= latLo && s.lat <= latHi && s.lng >= lngLo && s.lng <= lngHi)
      .map(([id]) => id))
  }
  const onMapClick = (lat: number, lng: number) => {
    if (clickSuppressed()) return
    if (tool === 'lasso') {
      // Clicking back on the 1st vertex (≤12px at current zoom) closes
      // the polygon and selects inside.
      if (lassoPts.length >= 3) {
        const [flat, flng] = lassoPts[0]!
        const degPerPx = 360 / (256 * 2 ** zoom)  // Web-Mercator lng°/px
        const dx = (lng - flng) / degPerPx
        const dy = (lat - flat) / (degPerPx * Math.cos(flat * Math.PI / 180))
        if (Math.hypot(dx, dy) <= 12) { applyLasso(true); return }
      }
      setLassoPts((p) => [...p, [lat, lng]])
    } else if (tool === 'radius') setCenter([lat, lng])
  }
  const onMoveEnd = (lat: number, lng: number, z: number) => {
    setZoom(z)
    setView({ lat, lng, zoom: z })
  }
  const onMapMove = (lat: number, lng: number) => {
    if (rectRef.current) {
      rectRef.current = { a: rectRef.current.a, b: [lat, lng] }
      setRect(rectRef.current)
    } else if (tool === 'lasso' && lassoPts.length > 0) setCursor([lat, lng])
    else if (cursor !== null) setCursor(null)
  }
  // ⌘-rect lifecycle: window `mouseup` finalizes (fires even when the
  // pointer is released outside the map); Esc cancels. Listeners are
  // mounted for the whole page life — attaching them only while a rect
  // is active would race a fast drag (effects run post-paint).
  const finishRectRef = useRef(finishRect)
  finishRectRef.current = finishRect
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && rectRef.current) { rectRef.current = null; setRect(null) }
    }
    const onUp = () => finishRectRef.current()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])
  // Esc abandons an in-progress lasso.
  useEffect(() => {
    if (!(tool === 'lasso' && lassoPts.length > 0)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLassoPts([]); setCursor(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, lassoPts.length > 0])

  if (stationsQ.isLoading) return <div style={{ padding: 16 }}>Loading…</div>
  if (stationsQ.error) return <div style={{ padding: 16 }}>Error loading data</div>
  if (!stations) return null

  const selectedInLuc = vocabQ.data
    ? [...selected].filter((id) => vocabQ.data!.leafKeys.has(`s:${id}`)).length
    : 0
  // Marker radii scale with zoom (tiny dots are unreadable when zoomed in).
  const unselR = Math.min(6, Math.max(2, 2 + (zoom - 12)))
  const selR = Math.min(11, Math.max(4, 4 + (zoom - 12)))
  const termCounts = (c: SpatialSet<string>) => {
    const cells = c.include.filter((t) => !t.startsWith('s:')).length
    const excl = c.exclude.length ? ` − ${c.exclude.length}` : ''
    return `${c.include.length + c.exclude.length} terms (${cells} cells + ${c.include.length - cells} s:${excl})`
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif' }}>
      {/* Leaflet focuses clicked SVG paths; the browser then outlines the
        * element's axis-aligned bounding box — noise on nested cell grids. */}
      <style>{`.leaflet-interactive:focus { outline: none; }`}</style>
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
          <br />
          <label>
            <input type="checkbox" checked={showVocabGrid} onChange={(e) => setShowVocabGrid(e.target.checked)} />
            Show vocab grid
            <span style={{ color: '#999' }}> (solid = split, dashed = terminal)</span>
          </label>
        </div>
        <div style={{ background: 'rgba(128,128,128,0.15)', padding: 8, fontSize: 13, marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Tool: </strong>
            <select value={tool} onChange={(e) => { setTool(e.target.value as SelTool); setLassoPts([]); setCursor(null) }}>
              <option value="click">Click stations</option>
              <option value="lasso">Lasso polygon</option>
              <option value="radius">Location / radius</option>
            </select>
            <div style={{ color: '#999', marginTop: 2 }}>⌘-drag a rectangle to bulk-toggle stations (any tool)</div>
          </div>
          {tool === 'lasso' && (
            <div style={{ marginBottom: 8 }}>
              <div>Click the map to add vertices ({lassoPts.length}).</div>
              <div style={{ color: '#999' }}>Click the 1st vertex or double-click to close (selects inside); Esc cancels.</div>
              <button disabled={lassoPts.length < 3} onClick={() => applyLasso(true)}>Select inside</button>{' '}
              <button disabled={lassoPts.length < 3} onClick={() => applyLasso(false)}>Deselect inside</button>{' '}
              <button disabled={lassoPts.length === 0} onClick={() => { setLassoPts([]); setCursor(null) }}>Clear</button>
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
                <select value={coverView} onChange={(e) => setCoverView(e.target.value as 'vocab' | 'vocabPm' | 's2')}>
                  <option value="vocab">vocabCover (as served, + only)</option>
                  <option value="vocabPm">vocabCover (±)</option>
                  <option value="s2">minimalCover (raw S2 ±)</option>
                </select>
              </div>
              <table style={{ width: '100%', marginTop: 4 }}>
                <tbody>
                  <tr>
                    <td>vocab +</td>
                    <td>{customCovers.vocab ? termCounts(customCovers.vocab) : 'loading vocab…'}</td>
                  </tr>
                  {customCovers.vocabPm && (
                    <tr>
                      <td>vocab ±</td>
                      <td>+{customCovers.vocabPm.include.length} −{customCovers.vocabPm.exclude.length}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ color: '#999' }}>S2 raw ±</td>
                    <td style={{ color: '#999' }}>+{customCovers.s2Cover.include.length} −{customCovers.s2Cover.exclude.length}</td>
                  </tr>
                  {selected.size > selectedInLuc && (
                    <tr>
                      <td style={{ color: '#999' }} colSpan={2}>{selected.size - selectedInLuc} selected not in vocab (unserved)</td>
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
        center={[view.lat, view.lng]}
        zoom={view.zoom}
        scrollWheelZoom
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        <MapEvents onClick={onMapClick} onMoveEnd={onMoveEnd} onMove={onMapMove}
          onDown={onMapDown} onDblClick={finishLasso}
          disableDblZoom={tool === 'lasso'} disableDrag={metaHeld || rect !== null} />
        {rect && (
          <Rectangle bounds={[rect.a, rect.b]} interactive={false}
            pathOptions={{ color: '#7b1fa2', weight: 1.5, dashArray: '4 4', fillColor: '#7b1fa2', fillOpacity: 0.08 }} />
        )}
        {vocabGrid && vocabGrid.flatMap(({ tok, level, count, split, verts }) => [
          <Polygon key={`vg-${tok}`} positions={verts}
            eventHandlers={tool === 'click' ? { click: () => { if (clickSuppressed()) return; setHighlightTok((t) => (t === tok ? null : tok)) } } : undefined}
            pathOptions={{
              color: '#607d8b',
              weight: 1,
              opacity: 0.6,
              dashArray: split ? undefined : '3 3',
              fillColor: '#607d8b',
              fillOpacity: 0.02,
            }}>
            <Tooltip sticky>vocab {tok} (L{level}) — {count} stations, {split ? 'split' : 'terminal'} — click to highlight</Tooltip>
          </Polygon>,
          <Polyline key={`vgp-${tok}`} positions={s2ParentEdgeArcs(tok)} interactive={false}
            pathOptions={{ color: '#607d8b', weight: 2.5, opacity: 0.6 }} />,
        ])}
        {highlightTok && (
          <Polygon positions={s2CellVertices(highlightTok)} interactive={false}
            pathOptions={{ color: '#1976d2', weight: 3, fill: false }} />
        )}
        <FitCell token={focusCell} />
        {focusCell && (
          <Polygon positions={s2CellVertices(focusCell)} interactive={false}
            pathOptions={{ color: '#e53935', weight: 3, fillColor: '#e53935', fillOpacity: 0.06 }} />
        )}
        {lassoPts.length > 0 && (
          <>
            <Polyline positions={lassoPts} interactive={false}
              pathOptions={{ color: '#7b1fa2', weight: 2 }} />
            {cursor && (
              <Polyline
                positions={[lassoPts[lassoPts.length - 1]!, cursor, ...(lassoPts.length >= 2 ? [lassoPts[0]!] : [])]}
                interactive={false}
                pathOptions={{ color: '#7b1fa2', weight: 1.5, dashArray: '4 4', opacity: 0.7 }} />
            )}
            <CircleMarker center={lassoPts[0]!} radius={6} interactive={false}
              pathOptions={{ color: '#7b1fa2', weight: 2, fillColor: '#fff', fillOpacity: 1 }} />
          </>
        )}
        {tool === 'radius' && center && nearestN === '' && (
          <Circle center={center} radius={radiusM} pathOptions={{ color: '#7b1fa2', weight: 1, fillOpacity: 0.05 }} />
        )}
        {showCells && customCovers && coverView === 's2' && customCovers.s2Cover.include.flatMap((tok) => [
          <Polygon key={`cs2i-${tok}`} positions={s2CellVertices(tok)}
            eventHandlers={tool === 'click' ? { click: () => toggleCellStations(tok) } : undefined}
            pathOptions={{ color: '#2e7d32', weight: 1.5, fillColor: '#2e7d32', fillOpacity: 0.15 }}>
            <Tooltip sticky>+ {tok} (L{cellid.level(cellid.fromToken(tok))}) — click to toggle stations</Tooltip>
          </Polygon>,
          <Polyline key={`cs2ip-${tok}`} positions={s2ParentEdgeArcs(tok)} interactive={false}
            pathOptions={{ color: '#2e7d32', weight: 4 }} />,
        ])}
        {showCells && customCovers && coverView === 's2' && customCovers.s2Cover.exclude.flatMap((tok) => [
          <Polygon key={`cs2e-${tok}`} positions={s2CellVertices(tok)}
            eventHandlers={tool === 'click' ? { click: () => toggleCellStations(tok) } : undefined}
            pathOptions={{ color: '#d32f2f', weight: 2, dashArray: '4 3', fillColor: '#d32f2f', fillOpacity: 0.15 }}>
            <Tooltip sticky>− {tok} (L{cellid.level(cellid.fromToken(tok))}) — click to toggle stations</Tooltip>
          </Polygon>,
          <Polyline key={`cs2ep-${tok}`} positions={s2ParentEdgeArcs(tok)} interactive={false}
            pathOptions={{ color: '#d32f2f', weight: 4, dashArray: '4 3' }} />,
        ])}
        {showCells && (coverView === 'vocab' || coverView === 'vocabPm') && (() => {
          const cover = coverView === 'vocab' ? customCovers?.vocab : customCovers?.vocabPm
          if (!cover) return null
          const cellLayers = (terms: string[], excluded: boolean) => terms
            .filter((t) => !t.startsWith('s:'))
            .flatMap((tok) => [
              <Polygon key={`cv${excluded ? 'e' : 'i'}-${tok}`} positions={s2CellVertices(tok)}
                eventHandlers={tool === 'click' ? { click: () => toggleCellStations(tok) } : undefined}
                pathOptions={excluded
                  ? { color: '#d32f2f', weight: 2, dashArray: '4 3', fillColor: '#d32f2f', fillOpacity: 0.15 }
                  : { color: '#2e7d32', weight: 1.5, fillColor: '#2e7d32', fillOpacity: 0.15 }}>
                <Tooltip sticky>{excluded ? '−' : '+'} vocab {tok} (L{cellid.level(cellid.fromToken(tok))}) — click to toggle stations</Tooltip>
              </Polygon>,
              // Thicker where the edge is also the PARENT's boundary — the
              // merge cue: a fully-thick ring of siblings ⇒ parent-collapsible.
              <Polyline key={`cv${excluded ? 'e' : 'i'}p-${tok}`} positions={s2ParentEdgeArcs(tok)} interactive={false}
                pathOptions={excluded
                  ? { color: '#d32f2f', weight: 4, dashArray: '4 3' }
                  : { color: '#2e7d32', weight: 4 }} />,
            ])
          const sLayers = (terms: string[], excluded: boolean) => terms
            .filter((t) => t.startsWith('s:'))
            .map((term) => {
              const sn = term.slice(2)
              const pos = stations[sn] ?? vocabQ.data?.leaves.find((l) => l.key === term)
              return pos ? (
                <CircleMarker key={`cvs${excluded ? 'e' : 'i'}-${term}`} center={[pos.lat, pos.lng]} radius={selR + 3}
                  eventHandlers={tool === 'click' && stations[sn] ? { click: () => toggleStation(sn) } : undefined}
                  pathOptions={{ color: excluded ? '#d32f2f' : '#2e7d32', weight: 2, fillOpacity: 0 }}>
                  <Tooltip>{excluded ? '−' : '+'} vocab term {term}</Tooltip>
                </CircleMarker>
              ) : null
            })
          return [
            ...cellLayers(cover.include, false),
            ...cellLayers(cover.exclude, true),
            ...sLayers(cover.include, false),
            ...sLayers(cover.exclude, true),
          ]
        })()}
        {/* Source polygons for any set with ≥1 selected station. Solid-ish
            when fully selected, fainter when partial — a partially-selected
            set is exactly when you most want to see where its boundary runs.
            These are the *neighborhood* outlines, distinct from the green
            cover cells: S2 cells ignore neighborhood boundaries entirely, so
            a rolled-up cell routinely extends well outside the polygon that
            sourced it (and a concave neighborhood like Bergen Hill reads as
            disjoint when its cover splits across its lobes). */}
        {nbhdQ.data && nbhdQ.data.sets
          .map((s) => ({ s, n: s.stations.filter((id) => selected.has(id)).length }))
          .filter(({ n }) => n > 0)
          .map(({ s, n }) => (
            <Polygon key={`nb-${s.id}`} positions={s.polys} interactive={false}
              pathOptions={n === s.stations.length
                ? { color: '#7b1fa2', weight: 2.5, dashArray: '6 4', fill: true, fillColor: '#7b1fa2', fillOpacity: 0.07 }
                : { color: '#7b1fa2', weight: 1.5, dashArray: '2 5', opacity: 0.7, fill: true, fillColor: '#7b1fa2', fillOpacity: 0.03 }} />
          ))}
        {showStations && vocabQ.data && vocabQ.data.leaves
          .filter((l) => !stations[l.key.slice(2)])
          .map((l) => (
            <CircleMarker
              key={`ret-${l.key}`}
              center={[l.lat, l.lng]}
              radius={unselR}
              interactive={true}
              pathOptions={{
                color: '#757575',
                fillColor: '#757575',
                fillOpacity: 0.5,
                weight: 1,
                dashArray: '2 2',
              }}
            >
              <Tooltip>{l.key.slice(2)} — retired (LUC-only; blocks vocab ancestors)</Tooltip>
            </CircleMarker>
          ))}
        {showStations && Object.entries(stations).map(([id, s]) => {
          const isSel = selected.has(id)
          return (
            <CircleMarker
              key={id}
              center={[s.lat, s.lng]}
              radius={isSel ? selR : unselR}
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
