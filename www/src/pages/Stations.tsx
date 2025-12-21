import { useUrlParam, floatParam, stringParam } from '@rdub/use-url-params'
import 'leaflet/dist/leaflet.css'
import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { Link } from 'react-router-dom'
import css from "../../pages/stations.module.css"

const MANIFEST_URL = '/assets/station-urls.json'
const DEFAULT_CENTER: [number, number] = [40.758, -73.965]
const DEFAULT_ZOOM = 12

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

  // Calculate line weights based on zoom
  const mPerPx = useMemo(() => {
    const center = map.getCenter()
    const metersPerDegree = 111320 * Math.cos(center.lat * Math.PI / 180)
    const bounds = map.getBounds()
    const degreesPerPixel = (bounds.getEast() - bounds.getWest()) / map.getSize().x
    return metersPerDegree * degreesPerPixel
  }, [map, zoom])

  // Render destination lines when a station is selected
  const lines = useMemo(() => {
    if (!selectedStation || !selectedId || !pairCounts) return null
    const counts = pairCounts[selectedId]
    if (!counts) return null

    const maxCount = Math.max(...Object.values(counts))
    const srcLat = selectedStation.lat
    const srcLng = selectedStation.lng

    return Object.entries(counts).map(([dstId, count]) => {
      const dst = stations[dstId]
      if (!dst) return null

      const weight = Math.max(0.7, (count / maxCount) * Math.sqrt(selectedStation.ends) / mPerPx)

      return (
        <Polyline
          key={`${selectedId}-${dstId}`}
          positions={[[srcLat, srcLng], [dst.lat, dst.lng]]}
          color="red"
          weight={weight}
          opacity={0.7}
        >
          <Tooltip sticky>
            {selectedStation.name} → {dst.name}: {count}
          </Tooltip>
        </Polyline>
      )
    })
  }, [selectedStation, selectedId, pairCounts, stations, mPerPx])

  // Render station circles
  const circles = useMemo(() => {
    const maxEnds = Math.max(...Object.values(stations).map(s => s.ends))

    return Object.entries(stations).map(([id, station]) => {
      const isSelected = id === selectedId
      const radius = Math.max(3, Math.sqrt(station.ends / maxEnds) * 20)

      return (
        <CircleMarker
          key={id}
          center={[station.lat, station.lng]}
          radius={radius}
          pathOptions={{
            color: isSelected ? 'red' : 'blue',
            fillColor: isSelected ? 'red' : 'blue',
            fillOpacity: 0.6,
            weight: isSelected ? 3 : 1,
          }}
          eventHandlers={{
            click: () => setSelectedId(isSelected ? undefined : id),
          }}
        >
          <Tooltip>
            {station.name}: {station.ends.toLocaleString()} rides
          </Tooltip>
        </CircleMarker>
      )
    })
  }, [stations, selectedId, setSelectedId])

  return (
    <>
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
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
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
        <div className={css.title}>
          Citi Bike rides by station, {monthLabel}
          {selectedId && stations?.[selectedId] && ` — ${stations[selectedId].name}`}
        </div>
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
