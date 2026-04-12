import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStationsOmnibarEndpoint } from './useStationsOmnibarEndpoint'
import type { Stations } from '../components/StationMap'

const MANIFEST_URL = '/assets/station-urls.json'

interface Manifest {
  stations: Record<string, string>
  latestMonth: string
}

/**
 * Register a global omnibar endpoint for navigating to station detail pages.
 * Loads the latest-month stations data once. Disabled on `/stations`
 * (which has its own local endpoint that selects on the map instead).
 */
export function useGlobalStationsOmnibar() {
  const [stations, setStations] = useState<Stations | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  // Disable on /stations — that page has its own omnibar endpoint
  const onStationsPage = location.pathname === '/stations' || location.pathname === '/stations/'

  useEffect(() => {
    if (onStationsPage) return  // skip fetch if we won't use it
    if (stations) return        // already loaded
    fetch(MANIFEST_URL)
      .then((r) => r.json())
      .then((m: Manifest) => fetch(m.stations[m.latestMonth]).then((r) => r.json()))
      .then(setStations)
      .catch((err) => console.warn('Failed to load stations for global omnibar:', err))
  }, [onStationsPage, stations])

  useStationsOmnibarEndpoint({
    stations: stations ?? {},
    onSelect: (id) => navigate(`/s/${id}`),
    enabled: !!stations && !onStationsPage,
  })
}
