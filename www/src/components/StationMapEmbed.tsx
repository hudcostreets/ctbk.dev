/**
 * Embeddable stations map: loads the latest-month data, renders the GL
 * `<StationMapGL>` (deck.gl + MapLibre, loaded lazily with this module), and
 * keeps selected-source details in the map's drawer. Selection is the
 * shared `lib/mapSelection` model (tap / long-press multi-select / rectangle,
 * as on `/stations`), held in local state (no URL sync), so it can drop into
 * any page without clobbering the host page's URL params; a multi-station
 * set links out to `/stations?sel=…`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { flowArcs, flowLens } from './flowLens'
import MultiSelectBar from './MultiSelectBar'
import StationMapGL from './StationMapGL'
import { selParam, useSelection } from '../lib/mapSelection'
import css from '../stations.module.css'
import type { Stations, StationPairCounts } from './stationMapCommon'

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
  /** Applied to the wrapping `<div>` that hosts the map (controls size/aspect). */
  mapClassName?: string
  /** Optional extra content appended to the caption below the map (e.g. a link
   *  to the full-screen `/stations` page). Rendered after a `·` separator. */
  captionTrailing?: ReactNode
}

export default function StationMapEmbed({ mapClassName, captionTrailing }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [stations, setStations] = useState<Stations | null>(null)
  const [pairCounts, setPairCounts] = useState<StationPairCounts | null>(null)
  const [selIds, setSelIds] = useState<string[]>([])
  const { multi, apply } = useSelection(selIds, setSelIds)

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

  const monthLabel = manifest ? formatMonth(manifest.latestMonth) : null

  // Flow lens: once stations are selected, size + color every other station
  // by the set's outbound trips ending there (the `/stations` default; no URL
  // config here), with the arc fan on top. Keyed on the selection (not the
  // transient hover), so restyling commits on tap.
  const lens = useMemo(
    () => flowLens(stations ?? {}, pairCounts, selIds, 'cr'),
    [stations, pairCounts, selIds],
  )
  const arcs = useMemo(
    () => (stations ? flowArcs(stations, pairCounts, selIds, 'out') : null),
    [stations, pairCounts, selIds],
  )

  return (
    <>
      <div className={mapClassName}>
        <StationMapGL
          stations={stations ?? {}}
          pinnedIds={selIds}
          onSelAction={apply}
          multi={multi}
          pairCounts={pairCounts}
          stationColors={lens?.colors ?? null}
          stationRadii={lens?.radii ?? null}
          arcs={arcs}
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className={css.embedMap}
          overlay={monthLabel && <>Citi Bike rides, {monthLabel}</>}
        >
          {multi && (
            <MultiSelectBar n={selIds.length} onDone={() => apply({ t: 'done' })} onClear={() => apply({ t: 'clear' })} />
          )}
        </StationMapGL>
      </div>
      {(selIds.length !== 1 || captionTrailing) && <div className={css.embedCaption}>
        {selIds.length > 1 ? (
          <>
            <strong>{selIds.length} stations</strong>
            {' — '}
            <Link to={`/stations?sel=${selParam.encode(selIds)}`}>Compare on the stations page →</Link>
          </>
        ) : selIds.length === 0 ? (
          <span className={css.placeholder}>Tap a station to see its top destinations and open its page.</span>
        ) : null}
        {captionTrailing && (
          <>
            {selIds.length !== 1 && <span className={css.captionSep}> · </span>}
            {captionTrailing}
          </>
        )}
      </div>}
    </>
  )
}
