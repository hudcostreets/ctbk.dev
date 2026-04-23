/**
 * Embeddable stations map: loads the latest-month data, renders
 * `<StationMap>`, and shows a selected-station caption with a details link.
 * Uses local state only (no URL sync), so it can drop into any page
 * without clobbering the host page's URL params.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import StationMap, { type Stations, type StationPairCounts } from './StationMap'
import css from '../stations.module.css'

const MANIFEST_URL = '/assets/station-urls.json'
const DEFAULT_CENTER: [number, number] = [40.758, -73.965]
const DEFAULT_ZOOM = 12

type Manifest = {
  stations: Record<string, string>
  pairs: Record<string, string>
  latestMonth: string
}

/** Format `YYYYMM` → `MMM 'YY` (matches the `/stations` title). */
function formatMonth(yyyymm: string): string {
  const yr = yyyymm.substring(2, 4)
  const m = parseInt(yyyymm.substring(4))
  const monthName = new Date(2000, m - 1).toLocaleDateString('default', { month: 'short' })
  return `${monthName} '${yr}`
}

interface Props {
  /** Applied to the wrapping `<div>` that hosts the Leaflet map (controls size/aspect). */
  mapClassName?: string
  /** Optional extra content appended to the caption below the map (e.g. a link
   *  to the full-screen `/stations` page). Rendered after a `·` separator. */
  captionTrailing?: ReactNode
}

export default function StationMapEmbed({ mapClassName, captionTrailing }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [stations, setStations] = useState<Stations | null>(null)
  const [pairCounts, setPairCounts] = useState<StationPairCounts | null>(null)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  useEffect(() => {
    fetch(MANIFEST_URL)
      .then(r => r.json())
      .then(setManifest)
      .catch(err => console.warn('Failed to load stations manifest:', err))
  }, [])

  useEffect(() => {
    if (!manifest) return
    const { latestMonth } = manifest
    const stationsUrl = manifest.stations[latestMonth]
    const pairsUrl = manifest.pairs[latestMonth]
    if (!stationsUrl) return
    Promise.all([
      fetch(stationsUrl).then(r => r.json()),
      pairsUrl ? fetch(pairsUrl).then(r => r.json()) : Promise.resolve(null),
    ])
      .then(([stationsData, pairsData]) => {
        setStations(stationsData)
        if (pairsData) {
          const ids = Object.keys(stationsData)
          const idx2id: Record<string, string> = {}
          ids.forEach((id, idx) => { idx2id[idx.toString()] = id })
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
      })
      .catch(err => console.warn('Failed to load station data:', err))
  }, [manifest])

  const selectedStation = selectedId && stations ? stations[selectedId] : null
  const monthLabel = manifest ? formatMonth(manifest.latestMonth) : null

  return (
    <>
      <div className={mapClassName}>
        <StationMap
          stations={stations ?? {}}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          pairCounts={pairCounts}
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className={css.embedMap}
          hoverToSelect
          onClick={() => setSelectedId(undefined)}
          overlay={monthLabel && <>Citi Bike rides, {monthLabel}</>}
        />
      </div>
      <div className={css.embedCaption}>
        {selectedStation && selectedId ? (
          <>
            <strong>{selectedStation.name}</strong>
            {' — '}
            <Link to={`/s/${selectedId}`}>View station details →</Link>
          </>
        ) : (
          <span className={css.placeholder}>Tap a station to see its top destinations.</span>
        )}
        {captionTrailing && (
          <>
            <span className={css.captionSep}> · </span>
            {captionTrailing}
          </>
        )}
      </div>
    </>
  )
}
