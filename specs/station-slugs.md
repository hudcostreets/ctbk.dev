# Spec: Human-Readable Station Slugs

## Goal

Generate a human-readable canonical URL slug for every station, e.g. `/stations/28-ave-44-st` instead of `/stations/00284700-9d22-42ce-8485-113fed9879c1` (UUID) or `/stations/6879.04` (short_name).

## Constraints

- **Slugs are canonical** (used in `<a href>`, OG tags, social previews, etc.)
- **Stable across renames where reasonable** — stations may have minor name changes that shouldn't change the slug
- **Collision-free** — no two currently-active stations share a slug
- **Backward compatible** — old slugs, short_names, and UUIDs all redirect (302) to current canonical slug

## Empirical Reality

From `station-history.parquet` (4044 spans, 2609 canonical id0s):
- ~280 canonical IDs (11%) have had multiple names
- ~218 canonical IDs (8%) have changed location (different lat/lng)
- 74 locations have hosted multiple canonical IDs sequentially (real "swap" events)

Most collisions are old/test/inactive stations. Active GBFS stations have minimal collision risk.

## Slug Generation Algorithm

### 1. Base slug
For each canonical id0, take the **current/latest name** and slugify:
- Lowercase
- Replace `&`, `/`, `@` with empty
- Replace whitespace + punctuation with `-`
- Collapse runs of `-`
- Strip leading/trailing `-`
- Drop common stopwords? No — `St`, `Ave`, etc. carry signal

Examples:
- "28 Ave & 44 St" → `28-ave-44-st`
- "E 17 St & Broadway" → `e-17-st-broadway`
- "Cadman Plaza W & Pierrepont St" → `cadman-plaza-w-pierrepont-st`

### 2. Collision detection
A collision is two **currently-active** canonical IDs (in_gbfs=1 or last_seen within 12 months) with the same base slug.

### 3. Collision resolution (auto)
For each collision group, append a borough suffix derived from lat/lng:
- `-mn` (Manhattan), `-bk` (Brooklyn), `-qns` (Queens), `-bx` (Bronx), `-si` (Staten Island)
- `-jc` (Jersey City), `-hbk` (Hoboken)

If still colliding within the same borough: append id0 (e.g. `-6879.04`).

### 4. Manual overrides
A `station-slugs-overrides.yaml` file in `s3/ctbk/stations/`:
```yaml
# Manual slug overrides — wins over auto-generation
overrides:
  "6879.04": "28-ave-44-st"          # force a specific slug
  "190 Morgan": "morgan-hct"         # short, friendly form
deprecated:
  "old-slug-foo": "current-slug-bar"  # explicit redirect (rarely needed)
```

### 5. Deprecated slugs (auto)
When a station's name changes such that its slug would change, keep the old slug as a deprecated alias → 302 redirect.

## Borough Detection

Bounding boxes (good enough for NYC + Hudson County):

| Borough | Lat range | Lng range |
|---------|-----------|-----------|
| Manhattan | 40.700–40.880 | -74.020 – -73.910 |
| Bronx | 40.785–40.920 | -73.935 – -73.765 |
| Brooklyn | 40.570–40.740 | -74.045 – -73.835 |
| Queens | 40.540–40.800 | -73.965 – -73.700 |
| Staten Island | 40.495–40.650 | -74.260 – -74.050 |
| Jersey City | 40.700–40.770 | -74.090 – -74.020 |
| Hoboken | 40.735–40.760 | -74.040 – -74.020 |

Fall back to `nyc` if no match. Use point-in-polygon if more accuracy is needed later.

## Output Format

`s3/ctbk/stations/station-slugs.json`:
```json
{
  "by_slug": {
    "28-ave-44-st": "6879.04",
    "e-17-st-broadway": "5980.10",
    ...
  },
  "by_short_name": {
    "6879.04": "28-ave-44-st",
    ...
  },
  "deprecated": {
    "5-ave-e-73-st": "5-ave-e-72-st",
    ...
  }
}
```

## Implementation

### `gbfs/d1/load_station_slugs.py`

Generate slugs from `station-history.parquet`, write `station-slugs.json`, optionally upsert into D1 `stations.slug` column.

### D1 schema addition
```sql
ALTER TABLE stations ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_stations_slug ON stations(slug);
```

### API additions
- `GET /api/stations/:slug/info` — accepts slug (in addition to UUID, short_name)
- `GET /api/stations/:slug/today` — same
- Lookup order: slug, then UUID, then short_name
- If user requested an old slug: include `redirect_to` in response, frontend issues `<Navigate replace>`

### Frontend route
```tsx
<Route path="/stations/:id" element={<StationDetail />} />
```
StationDetail accepts any of slug / short_name / UUID. On load, fetches `/info` which tells it the canonical slug. If different from URL, replace URL via `useNavigate({ replace: true })`. (Effectively a 302 client-side.)

## Workflow

1. **Initial generation** (one-time after station-harmonize):
   ```bash
   python3 gbfs/d1/load_station_slugs.py
   ```
   Outputs `station-slugs.json` and pushes slugs into D1.

2. **Manual curation**: edit `station-slugs-overrides.yaml`, re-run.

3. **Periodic regeneration**: monthly (after `ctbk update`), regen slugs. Most won't change. New stations get auto-assigned. Renamed stations keep old slug as deprecated → redirect to new.

## Open Questions

- Where exactly does `station-slugs-overrides.yaml` live? Tracked in git, hand-edited.
- Should slugs include a year for dead stations to disambiguate against newer same-named ones? Probably not — those URLs are unlikely to be linked.
- Truncate very long slugs? Most NYC station names are short; might cap at 60 chars.
