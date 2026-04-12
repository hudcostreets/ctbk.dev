# Migrate map URL params to `llzParam`

## Motivation

Stations.tsx currently uses three separate `floatParam` URL params for map view state:

```typescript
const [lat, setLat] = useUrlState('lat', floatParam(40.758))
const [lng, setLng] = useUrlState('lng', floatParam(-73.965))
const [zoom, setZoom] = useUrlState('z', floatParam(12))
```

URL: `?lat=40.758&lng=-73.965&z=12`

`use-prms` now has `llzParam` which encodes all three (+ optional pitch/bearing) in a single param:

```typescript
const [view, setView] = useUrlState('ll', llzParam({
  default: { lat: 40.758, lng: -73.965, zoom: 12 },
  latLngDecimals: 3,
}))
```

URL: `?ll=40.758_-73.965_12.00`

## Migration strategy

Old shared URLs (`?lat=...&lng=...&z=...`) should still work. On mount, read old params and rewrite to the new format.

### Step 1: Update `use-prms` dependency

Update `package.json` to point at a commit that includes `llzParam` (currently pinned to `cf28edc`).

### Step 2: Add migration hook in Stations.tsx

Before the `llzParam` `useUrlState` call, add a one-time migration that reads old params and rewrites:

```typescript
import { llzParam } from 'use-prms'

const DEFAULT_VIEW = { lat: 40.758, lng: -73.965, zoom: 12 }

// One-time migration: old ?lat=...&lng=...&z=... → new ?ll=...
useEffect(() => {
  const params = new URLSearchParams(window.location.search)
  const oldLat = params.get('lat')
  const oldLng = params.get('lng')
  const oldZoom = params.get('z')
  if (oldLat || oldLng || oldZoom) {
    const lat = oldLat ? parseFloat(oldLat) : DEFAULT_VIEW.lat
    const lng = oldLng ? parseFloat(oldLng) : DEFAULT_VIEW.lng
    const zoom = oldZoom ? parseFloat(oldZoom) : DEFAULT_VIEW.zoom
    params.delete('lat')
    params.delete('lng')
    params.delete('z')
    // Encode using llzParam's encode, set as 'll'
    const llEncoded = viewParam.encode({ lat, lng, zoom })
    if (llEncoded) params.set('ll', llEncoded)
    const url = new URL(window.location.href)
    url.search = params.toString()
    window.history.replaceState(window.history.state, '', url.toString())
  }
}, [])

const viewParam = llzParam({ default: DEFAULT_VIEW, latLngDecimals: 3 })
const [view, setView] = useUrlState('ll', viewParam)
```

### Step 3: Simplify MapEvents

Replace three separate setters with one:

```typescript
function MapEvents({
  setView,
  setSelectedId,
}: {
  setView: (v: LLZ) => void
  setSelectedId: (v: string | undefined) => void
}) {
  const map = useMap()

  useEffect(() => {
    const moveHandler = () => {
      const center = map.getCenter()
      setView({
        lat: Math.round(center.lat * 1000) / 1000,
        lng: Math.round(center.lng * 1000) / 1000,
        zoom: map.getZoom(),
      })
    }
    const clickHandler = () => {
      setSelectedId(undefined)
    }
    map.on('moveend', moveHandler)
    map.on('click', clickHandler)
    return () => {
      map.off('moveend', moveHandler)
      map.off('click', clickHandler)
    }
  }, [map, setView, setSelectedId])

  return null
}
```

### Step 4: Update MapContainer

```typescript
<MapContainer center={[view.lat, view.lng]} zoom={view.zoom} ...>
```

## Changes summary

- `src/pages/Stations.tsx`: replace 3 `floatParam` calls with 1 `llzParam`, add migration `useEffect`, simplify `MapEvents`
- `package.json`: update `use-prms` commit SHA

## Notes

- `latLngDecimals: 3` matches the existing `Math.round(...*1000)/1000` rounding in `MapEvents`
- The migration is a one-time `replaceState` — old URLs silently rewrite to new format on first visit
- The `useEffect` migration runs before any map interaction, so there's no race condition
