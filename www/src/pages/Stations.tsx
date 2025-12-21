import { useUrlParam, floatParam, stringParam } from '@rdub/use-url-params'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useState } from 'react'
import { Circle, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { Link } from 'react-router-dom'
import css from "../../pages/stations.module.css"

const MANIFEST_URL = '/assets/station-urls.json'
const DEFAULT_CENTER: [number, number] = [40.758, -73.965]
const DEFAULT_ZOOM = 12

const { sqrt, max } = Math

type StationValue = {
  name: string
  lat: number
  lng: number
  ends: number
}
type Stations = Record<string, StationValue>
type StationPairCounts = Record<string, Record<string, number>>
type Manifest = {
  stations: Record<string, string>
  pairs: Record<string, string>
  latestMonth: string
}

function getMetersPerPixel(map: L.Map): number {
  const center = map.getCenter()
  const metersPerDegree = 111320 * Math.cos(center.lat * Math.PI / 180)
  const bounds = map.getBounds()
  const degreesPerPixel = (bounds.getEast() - bounds.getWest()) / map.getSize().x
  return metersPerDegree * degreesPerPixel
}

function StationMarkers({
  stations,
  selectedId,
  setSelectedId,
  pairCounts,
}: {
  stations: Stations
  selectedId: string | undefined
  setSelectedId: (id: string | undefined) => void
  pairCounts: StationPairCounts | null
}) {
  const map = useMap()
  const zoom = map.getZoom()

  const selectedStation = selectedId ? stations[selectedId] : undefined

  // Calculate meters per pixel based on zoom
  const mPerPx = useMemo(() => getMetersPerPixel(map), [map, zoom])

  // Render destination lines when a station is selected
  const lines = useMemo(() => {
    if (!selectedStation || !selectedId || !pairCounts) return null
    if (!(selectedId in pairCounts)) {
      console.log(`${selectedId} not found among ${Object.keys(pairCounts).length} stations`)
      return null
    }
    const counts = pairCounts[selectedId]
    const maxCount = max(...Object.values(counts))
    const src = selectedStation

    return (
      <Pane name="lines" className={css.lines}>
        {Object.entries(counts).map(([dstId, count]) => {
          const dst = stations[dstId]
          if (!dst) return null

          const weight = max(0.7, (count / maxCount) * sqrt(src.ends) / mPerPx)

          return (
            <Polyline
              key={`${selectedId}-${dstId}-${zoom}`}
              positions={[[src.lat, src.lng], [dst.lat, dst.lng]]}
              color="red"
              weight={weight}
              opacity={0.7}
            >
              <Tooltip sticky>
                {src.name} → {dst.name}: {count}
              </Tooltip>
            </Polyline>
          )
        })}
      </Pane>
    )
  }, [selectedStation, selectedId, pairCounts, stations, mPerPx, zoom])

  // Render selected station on top
  const selectedCircle = useMemo(() => {
    if (!selectedStation || !selectedId) return null
    const radius = sqrt(selectedStation.ends)
    if (isNaN(radius)) return null

    return (
      <Pane name="selected" className={css.selected}>
        <Circle
          key={selectedId}
          center={{ lat: selectedStation.lat, lng: selectedStation.lng }}
          color="yellow"
          radius={radius}
          bubblingMouseEvents={false}
          eventHandlers={{
            click: () => setSelectedId(undefined),
          }}
        >
          <Tooltip className={css.tooltip} sticky permanent pane="selected">
            <p>{selectedStation.name}: {selectedStation.ends.toLocaleString()}</p>
          </Tooltip>
        </Circle>
      </Pane>
    )
  }, [selectedStation, selectedId, setSelectedId])

  // Render station circles
  const circles = useMemo(() => {
    return (
      <Pane name="circles" className={css.circles}>
        {Object.entries(stations).map(([id, station]) => {
          if (id === selectedId) return null
          const radius = sqrt(station.ends)
          if (isNaN(radius)) return null

          return (
            <Circle
              key={id}
              center={{ lat: station.lat, lng: station.lng }}
              color="orange"
              radius={radius}
              bubblingMouseEvents={false}
              eventHandlers={{
                click: () => setSelectedId(id),
                mouseover: () => {
                  if (id !== selectedId) setSelectedId(id)
                },
              }}
            >
              <Tooltip className={css.tooltip} sticky>
                <p>{station.name}: {station.ends.toLocaleString()}</p>
              </Tooltip>
            </Circle>
          )
        })}
      </Pane>
    )
  }, [stations, selectedId, setSelectedId])

  return (
    <>
      {selectedCircle}
      {lines}
      {circles}
    </>
  )
}

export default function Stations() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [stations, setStations] = useState<Stations | null>(null)
  const [pairCounts, setPairCounts] = useState<StationPairCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // URL parameters
  const [lat, setLat] = useUrlParam('lat', floatParam(DEFAULT_CENTER[0]))
  const [lng, setLng] = useUrlParam('lng', floatParam(DEFAULT_CENTER[1]))
  const [zoom, setZoom] = useUrlParam('z', floatParam(DEFAULT_ZOOM))
  const [selectedId, setSelectedId] = useUrlParam('s', stringParam())
  const [month, setMonth] = useUrlParam('m', stringParam())

  // Load manifest on mount
  useEffect(() => {
    fetch(MANIFEST_URL)
      .then(res => res.json())
      .then((m: Manifest) => {
        setManifest(m)
        // Set default month if not specified
        if (!month) setMonth(m.latestMonth)
      })
      .catch(err => setError(err.message))
  }, [])

  // Load station data when month changes
  useEffect(() => {
    if (!manifest || !month) return

    const stationsUrl = manifest.stations[month]
    const pairsUrl = manifest.pairs[month]

    if (!stationsUrl) {
      setError(`No data for month ${month}`)
      return
    }

    setLoading(true)
    Promise.all([
      fetch(stationsUrl).then(r => r.json()),
      pairsUrl ? fetch(pairsUrl).then(r => r.json()) : Promise.resolve(null),
    ])
      .then(([stationsData, pairsData]) => {
        setStations(stationsData)
        // Convert pair data indices to IDs
        if (pairsData) {
          const stationIds = Object.keys(stationsData)
          const idx2id: Record<string, string> = {}
          stationIds.forEach((id, idx) => { idx2id[idx.toString()] = id })

          const converted: StationPairCounts = {}
          for (const [srcIdx, dsts] of Object.entries(pairsData as Record<string, Record<string, number>>)) {
            const srcId = idx2id[srcIdx]
            if (!srcId) continue
            converted[srcId] = {}
            for (const [dstIdx, count] of Object.entries(dsts)) {
              const dstId = idx2id[dstIdx]
              if (dstId) converted[srcId][dstId] = count
            }
          }
          setPairCounts(converted)
        }
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [manifest, month])

  const monthLabel = useMemo(() => {
    if (!month) return ''
    const year = parseInt(month.substring(0, 4))
    const m = parseInt(month.substring(4))
    return new Date(year, m - 1).toLocaleDateString('default', { month: 'short', year: 'numeric' })
  }, [month])

  const title = useMemo(() => {
    let t = `Citi Bike rides by station, ${monthLabel}`
    if (selectedId && stations?.[selectedId]) {
      t += ` — ${stations[selectedId].name}`
    }
    return t
  }, [monthLabel, selectedId, stations])

  if (error) {
    return (
      <div className={css.container}>
        <main className={css.main}>
          <h1>Error: {error}</h1>
          <Link to="/">← Back to Home</Link>
        </main>
      </div>
    )
  }

  return (
    <div className={css.container}>
      <main className={css.main}>
        <MapContainer
          center={[lat, lng]}
          zoom={zoom}
          className={css.homeMap}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a>, &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'
            url="https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png"
          />
          {stations && (
            <StationMarkers
              stations={stations}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              pairCounts={pairCounts}
            />
          )}
          <MapEvents setLat={setLat} setLng={setLng} setZoom={setZoom} />
        </MapContainer>
        {loading && <div className={css.loading}>Loading...</div>}
        <div className={css.title}>{title}</div>
      </main>
    </div>
  )
}

// Component to sync map position to URL
function MapEvents({
  setLat,
  setLng,
  setZoom,
}: {
  setLat: (v: number) => void
  setLng: (v: number) => void
  setZoom: (v: number) => void
}) {
  const map = useMap()

  useEffect(() => {
    const handler = () => {
      const center = map.getCenter()
      setLat(Math.round(center.lat * 1000) / 1000)
      setLng(Math.round(center.lng * 1000) / 1000)
      setZoom(map.getZoom())
    }
    map.on('moveend', handler)
    return () => { map.off('moveend', handler) }
  }, [map, setLat, setLng, setZoom])

  return null
}
