import { Link } from 'react-router-dom'
import css from '../stations.module.css'
import type { Stations, StationPairCounts } from './stationMapCommon'

interface Props {
  stations: Stations
  sourceIds: readonly string[]
  hoveredId: string | null
  pairCounts?: StationPairCounts | null
  hoverHint?: string
}

export default function StationInfoDrawer({ stations, sourceIds, hoveredId, pairCounts, hoverHint }: Props) {
  const sources = sourceIds.flatMap((id) => stations[id] ? [{ id, ...stations[id] }] : [])
  const hovered = hoveredId && !sourceIds.includes(hoveredId) ? stations[hoveredId] : null
  const flow = hovered && hoveredId && pairCounts
    ? sourceIds.reduce((sum, src) => sum + (pairCounts[src]?.[hoveredId] ?? 0), 0)
    : 0

  if (!sources.length && !hovered) return null

  return (
    <aside className={css.hoverDrawer} aria-label="Station information">
      {sources.length > 0 && (
        <section className={css.drawerSource} aria-label="Selected sources" data-testid="source-info">
          <span className={css.drawerRole}>{sources.length === 1 ? 'Selected source' : `${sources.length} selected sources`}</span>
          <div className={css.drawerSourceList}>
            {sources.map((source) => (
              <div className={css.drawerSourceStation} key={source.id}>
                <span className={css.hoverDrawerName}>{source.name}</span>
                <span className={css.hoverDrawerStat}>{source.ends.toLocaleString()} rides</span>
                <Link className={css.drawerDetails} to={`/s/${source.id}`}>View station details</Link>
              </div>
            ))}
          </div>
        </section>
      )}
      {hovered && (
        <section className={css.drawerDestination} aria-label={sources.length ? 'Destination' : 'Hovered station'} data-testid="destination-info">
          <span className={css.drawerRole}>{sources.length ? 'Destination' : 'Station'}</span>
          <span className={css.hoverDrawerName}>{hovered.name}</span>
          {hovered.ends > 0 && <span className={css.hoverDrawerStat}>{hovered.ends.toLocaleString()} rides</span>}
          {flow > 0 && <span className={css.hoverDrawerFlow}>{flow.toLocaleString()} from selection</span>}
          {hoverHint && <span className={css.hoverDrawerHint}>{hoverHint}</span>}
        </section>
      )}
    </aside>
  )
}
