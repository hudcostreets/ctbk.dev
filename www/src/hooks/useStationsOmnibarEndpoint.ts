import { useCallback } from 'react'
import { useOmnibarEndpoint } from 'use-kbd'

type StationValue = {
  name: string
  lat: number
  lng: number
  ends: number
}

type Stations = Record<string, StationValue>

interface UseStationsOmnibarEndpointProps {
  stations: Stations
  onSelect: (id: string) => void
  enabled?: boolean
}

/**
 * Register an omnibar endpoint for station search.
 * Uses client-side in-memory filtering since station data is already loaded for the map.
 */
export function useStationsOmnibarEndpoint({
  stations,
  onSelect,
  enabled = true,
}: UseStationsOmnibarEndpointProps) {
  const filter = useCallback(
    (query: string, pagination: { offset: number; limit: number }) => {
      const stationEntries = Object.entries(stations)

      let filtered: [string, StationValue][]
      if (!query.trim()) {
        // Sort by ride count when no query
        filtered = stationEntries
          .sort((a, b) => b[1].ends - a[1].ends)
      } else {
        const lowerQuery = query.toLowerCase()
        filtered = stationEntries
          .filter(([, station]) => station.name.toLowerCase().includes(lowerQuery))
          .sort((a, b) => {
            const aName = a[1].name.toLowerCase()
            const bName = b[1].name.toLowerCase()
            // Prioritize starts-with matches
            const aStarts = aName.startsWith(lowerQuery)
            const bStarts = bName.startsWith(lowerQuery)
            if (aStarts && !bStarts) return -1
            if (!aStarts && bStarts) return 1
            // Then by ride count
            return b[1].ends - a[1].ends
          })
      }

      const total = filtered.length
      const paginated = filtered.slice(pagination.offset, pagination.offset + pagination.limit)

      return {
        entries: paginated.map(([id, station]) => ({
          id: `station:${id}`,
          label: station.name,
          description: `${station.ends.toLocaleString()} rides`,
          group: 'Stations',
          handler: () => onSelect(id),
        })),
        total,
        hasMore: pagination.offset + paginated.length < total,
      }
    },
    [stations, onSelect]
  )

  useOmnibarEndpoint('stations', {
    filter,
    group: 'Stations',
    priority: 100, // High priority so stations appear first
    pageSize: 10,
    pagination: 'scroll',
    minQueryLength: 0, // Show top stations even with no query
    enabled,
  })
}
