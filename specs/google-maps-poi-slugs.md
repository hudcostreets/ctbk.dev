# Spec: Resolve human-readable Google Maps slugs for station POIs

## Status

Proposed. Low priority — the current `?q=lat,lon` link works; this is a polish
improvement.

## Motivation

The Google Maps link on `/s/:slug` currently uses a raw lat/lon query:

```
https://www.google.com/maps?q=40.72569,-74.04879
```

This works but:

- Drops the user onto a lat/lon pin, not the actual business/POI page for the
  Citi Bike station. So users lose the photos, reviews, place metadata, etc.
- For well-known Citi Bike stations (co-located with PATH stations, parks,
  landmarks), there's typically a dedicated place-page with a human-readable
  short URL like `maps.app.goo.gl/<id>` or `goo.gl/maps/<id>`.

A better link would resolve each station to its Place ID or short URL, so the
user lands on the actual POI page.

## Data sources

Options for resolving lat/lon → Place ID / short URL:

1. **Google Places API (Nearby Search)** — paid, has quota. Given (lat, lon,
   radius), returns nearby Places with their IDs. Pick the closest / highest
   match_confidence. `textQuery` variant accepts the station name for better
   matching.
2. **Google Maps Platform Geocoding API** — paid, returns a Place ID for a
   given address or lat/lon. Less POI-aware than Places.
3. **OpenStreetMap / Overpass** — free, has Citi Bike station data as
   `amenity=bicycle_rental`, but doesn't map to Google Place IDs.
4. **Manual curation** — small one-off table mapping `short_name → place_id`,
   hand-curated for the ~2k stations. Labor-intensive but avoids API cost.
5. **Hybrid** — use Places API once per station to build a cached mapping,
   then serve from D1 / JSON manifest. One-time cost, permanent benefit.

## Proposed approach

Hybrid (option 5):

1. Add a `place_id` column to the `stations` D1 table (`TEXT NULL`).
2. One-off script (Python, via `googlemaps` SDK) runs Places `textQuery` for
   each station: `"{name} Citi Bike, near {lat},{lon}"`. Stores the resulting
   Place ID.
3. Serve via `/api/stations/:id/info` — add `place_id` to the response.
4. Frontend link becomes:
   ```
   https://www.google.com/maps/place/?q=place_id:<place_id>
   ```
   This opens the actual POI page. Fall back to `?q=lat,lon` when `place_id`
   is null.
5. Optionally also resolve the short URL (`maps.app.goo.gl/<id>`) for even
   shorter display, but the `place_id:` URL is sufficient and self-documenting.

## Cost estimate

- Places API "Text Search" (2024 pricing): $0.032 per request.
- ~2,000 stations × $0.032 = **~$64 one-time** to populate the table.
- Quarterly refresh (new stations + corrections): trivial (~$5/quarter).

Could also apply station-name aliasing (e.g. "Grove St PATH" → "Grove Street
PATH Station") to improve match accuracy before calling the API.

## Validation

Each resolved `place_id` should be verified:

- Compute distance between the Places response `location` and the station's
  GBFS `(lat, lon)`. Reject matches > ~50 m away.
- Confidence threshold on the match_score from the API response.
- Spot-check a sample (20-30 stations) against the actual Google Maps UI
  before rolling out.

## UX

- When `place_id` is set: link to `https://www.google.com/maps/place/?q=place_id:<id>`
  — user lands on the actual POI page with name, photos, reviews.
- When `place_id` is null: fall back to `?q=<lat>,<lon>` (current behavior).
- Link text can stay "Google Maps ↗"; the target URL differs.
- Consider swapping in the Google-resolved name (from Places) as the station
  page title when it's more user-friendly than GBFS's. (Separate decision —
  GBFS names are already reasonably clean.)

## Non-goals

- Deep integration with Google Places (reviews, photos embedded on
  `/s/:slug`).
- Apple Maps / other map providers. Single link target.
- Live POI metadata refresh (e.g. hours, ratings). Not worth the API cost.

## Open questions

- Do Citi Bike *docks* have their own Google Places entries, or do they
  colocate with nearby venues (PATH stations, parks)? Needs spot-checking
  before investing in the population script.
- Is there a Citi Bike-provided mapping anywhere (e.g. in their app's
  internal API)? Worth a quick scrape before paying Places.
- Frequency of stale Place IDs (stations move, venues close). Plan for
  quarterly refresh + validation.

## See also

- Current implementation: `www/src/pages/StationDetail.tsx` — `mapsUrl` uses
  lat/lon query.
- `specs/station-harmonize-ec2.md` (done) — the one-off scripts framework
  this would live in.
