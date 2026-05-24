# Migrate map URL params to `llzParam`

> Status: **done** (2026-05-24, local-use-prms validation;
> commit lands once `use-prms` cuts a new dist release)

## Motivation

`Stations.tsx` previously encoded the Leaflet map view as three separate
URL params:

```
?lat=40.758&lng=-73.965&z=12
```

Three `floatParam` declarations, three setters, three callbacks in
`onMove`. `use-prms` now ships `llzParam` (single param encoding
lat/lng/zoom + optional pitch/bearing) plus `cleanUrl`'s
`deprecated` policy — together these make the migration trivial.

## Final shape

```ts
import { useUrlState, cleanUrl, llzParam } from 'use-prms'
import type { LLZ } from 'use-prms'

const DEFAULT_LLZ: LLZ = { lat: 40.758, lng: -73.965, zoom: 12 }
const viewParam = llzParam({ default: DEFAULT_LLZ, latLngDecimals: 3 })

const [view, setView] = useUrlState('ll', viewParam)

useEffect(() => {
  const migrate = () => {
    const sp = new URLSearchParams(window.location.search)
    return {
      ll: {
        lat: sp.has('lat') ? parseFloat(sp.get('lat')!) : DEFAULT_LLZ.lat,
        lng: sp.has('lng') ? parseFloat(sp.get('lng')!) : DEFAULT_LLZ.lng,
        zoom: sp.has('z') ? parseFloat(sp.get('z')!) : DEFAULT_LLZ.zoom,
      },
    }
  }
  cleanUrl({ ll: viewParam }, { deprecated: { lat: migrate, lng: migrate, z: migrate } })
}, [])
```

URLs:

```
new   ?ll=40.7580+-73.9650+12.00   (signDelim default)
old   ?lat=40.758&lng=-73.965&z=12 → migrates in-place on mount
```

`onMove` collapses from three setters to one:

```ts
onMove={(la, ln, z) => setView({ lat: la, lng: ln, zoom: z })}
```

## Why three migrate callbacks (not array form)?

`cleanUrl`'s array form (`deprecated: ['lat', 'lng', 'z']`) only **drops**
the deprecated keys — fine for keys with no replacement, wrong here:
old bookmarks would lose their map view entirely.

The object form lets each migrate callback re-derive the full `ll` from
`window.location.search`. Since the URL is mutated atomically at the end
of `cleanUrl` (after all per-key migrations have run), each callback
sees the same raw URL and produces the same `{ ll: {...} }` value —
idempotent regardless of which subset of `{lat, lng, z}` is present.

## What was tested

Against the workspace-linked `use-prms@84efcc8` (dirty):

- Fresh URL `/stations` → defaults render, no migration warnings
- Legacy URL `/stations?lat=40.71&lng=-74.01&z=14` → 3 `[use-prms]
  migrated deprecated URL param` warnings, URL rewritten to
  `?ll=40.710-74.010+14.00`, map renders at the migrated view
- Migrated URL `/stations?ll=40.710-74.010+14.00` → round-trips cleanly,
  no further migration

## Files Changed

| File | Change |
|------|--------|
| `www/src/pages/Stations.tsx` | 3 `floatParam` → 1 `llzParam`; migration `useEffect`; `onMove` 3→1 setter |
| `www/package.json` | will pin `use-prms` to the post-release dist SHA |

## Notes

- `signDelim: true` is the `llzParam` default — produces
  `?ll=40.7580+-73.9650+12.00` (space-encoded). Renders nicely in the
  omnibar; decode also accepts older `_`-delimited forms for back-compat.
- `latLngDecimals: 3` preserves the historical `Math.round(...*1000)/1000`
  rounding that `MapEvents.onMove` used to apply manually.
- Default `onDeprecated` is `console.warn` — useful in dev to spot
  lingering legacy URLs. Override with `null` to silence in prod-build.
