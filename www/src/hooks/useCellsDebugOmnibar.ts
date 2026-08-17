import { useCallback, useRef } from 'react'
import { useOmnibarEndpoint } from 'use-kbd'

/** Minimal shapes — mirrors of `CellsDebug`'s local types, kept structural
 *  so this hook doesn't drag the page's imports around. */
type Station = { lat: number; lng: number; region: string; name?: string }
type Stations = Record<string, Station>
type NbhdSet = { id: string; name: string; group: string; region: string; stations: string[] }
type NbhdGroup = { key: string; region: string; group: string; stations: string[] }

interface Props {
  stations: Stations | undefined
  sets: NbhdSet[] | undefined
  groups: NbhdGroup[] | undefined
  /** Bulk toggle (select all unless all are already selected, then clear). */
  toggleStationIds: (ids: string[]) => void
  toggleStation: (id: string) => void
  enabled?: boolean
}

type Entry = {
  id: string
  label: string
  description: string
  group: string
  handler: () => void
}

const page = <T,>(all: T[], { offset, limit }: { offset: number; limit: number }) => ({
  slice: all.slice(offset, offset + limit),
  total: all.length,
})

/** Rank: prefix matches first, then substring position, then size (bigger
 *  sets / busier stations first) — so "bergen" surfaces "Bergen Hill"
 *  above "…Bergen St". */
function rank<T>(items: T[], q: string, name: (t: T) => string, weight: (t: T) => number): T[] {
  if (!q) return [...items].sort((a, b) => weight(b) - weight(a))
  const scored = items
    .map((t) => ({ t, i: name(t).toLowerCase().indexOf(q) }))
    .filter(({ i }) => i >= 0)
  scored.sort((a, b) => (a.i !== b.i ? a.i - b.i : weight(b.t) - weight(a.t)))
  return scored.map(({ t }) => t)
}

/**
 * Omnibar endpoints for `/cells-debug`: every neighborhood set, every
 * neighborhood *group* (a whole borough / JC area), and every station,
 * searchable by name. Selecting toggles the same way clicking the
 * corresponding checkbox or marker does, so the omnibar composes with
 * whatever is already selected rather than replacing it.
 *
 * These are endpoints rather than `useAction`s because there are ~2500 of
 * them: static actions would all land in the shortcuts modal and be
 * registered on every render, where an endpoint filters lazily per query.
 */
export function useCellsDebugOmnibar({
  stations,
  sets,
  groups,
  toggleStationIds,
  toggleStation,
  enabled = true,
}: Props) {
  // The page's toggles close over `selected`, so they're new every render.
  // Route through a ref so the endpoints don't re-register on every
  // selection change (and so handlers always see the latest selection).
  const cbs = useRef({ toggleStationIds, toggleStation })
  cbs.current = { toggleStationIds, toggleStation }

  const nbhdFilter = useCallback(
    (query: string, pagination: { offset: number; limit: number }) => {
      const q = query.trim().toLowerCase()
      const setEntries: Entry[] = rank(sets ?? [], q, (s) => `${s.name} ${s.group}`, (s) => s.stations.length)
        .map((s) => ({
          id: `nbhd:${s.id}`,
          label: s.name,
          description: `${s.group} (${s.region}) · ${s.stations.length} station${s.stations.length === 1 ? '' : 's'}`,
          group: 'Neighborhoods',
          handler: () => cbs.current.toggleStationIds(s.stations),
        }))
      const groupEntries: Entry[] = rank(groups ?? [], q, (g) => g.group, (g) => g.stations.length)
        .map((g) => ({
          id: `nbhd-group:${g.key}`,
          label: `${g.group} (all)`,
          description: `${g.region} · ${g.stations.length} stations`,
          group: 'Neighborhoods',
          handler: () => cbs.current.toggleStationIds(g.stations),
        }))
      // Groups first: "Manhattan" should offer the whole borough before
      // each of its NTAs.
      const { slice, total } = page([...groupEntries, ...setEntries], pagination)
      return { entries: slice, total, hasMore: pagination.offset + slice.length < total }
    },
    [sets, groups],
  )

  const stationFilter = useCallback(
    (query: string, pagination: { offset: number; limit: number }) => {
      const q = query.trim().toLowerCase()
      const all = Object.entries(stations ?? {})
      const ranked = rank(all, q, ([id, s]) => `${s.name ?? ''} ${id}`, () => 0)
      const entries: Entry[] = ranked.map(([id, s]) => ({
        id: `cd-station:${id}`,
        label: s.name ?? id,
        description: `${id} · ${s.region}`,
        group: 'Stations',
        handler: () => cbs.current.toggleStation(id),
      }))
      const { slice, total } = page(entries, pagination)
      return { entries: slice, total, hasMore: pagination.offset + slice.length < total }
    },
    [stations],
  )

  useOmnibarEndpoint('cells-debug-neighborhoods', {
    filter: nbhdFilter,
    group: 'Neighborhoods',
    priority: 110,
    pageSize: 10,
    pagination: 'scroll',
    minQueryLength: 0,
    enabled: enabled && !!sets,
  })

  useOmnibarEndpoint('cells-debug-stations', {
    filter: stationFilter,
    group: 'Stations',
    priority: 100,
    pageSize: 10,
    pagination: 'scroll',
    // Stations only once the user types — otherwise an empty omnibar is
    // 2340 rows of noise under the neighborhood list.
    minQueryLength: 1,
    enabled: enabled && !!stations,
  })
}
