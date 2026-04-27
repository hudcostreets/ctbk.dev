/**
 * TSQ hooks for the GBFS station API.
 *
 * - `useStationInfo(id)`: one-shot `/info` fetch.
 * - `useStationRange(id, fromS, toS)`: time-windowed `/range?from=&to=` fetch
 *   with `keepPreviousData` so the chart stays visible during refetches
 *   (drag-pan commits, Latest snap-back, etc.). `fromS`/`toS` are the
 *   **buffered** bounds the caller wants cached; slice B will widen them so
 *   small drags hit the cache.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'

const API_BASE = 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

export interface StationInfo {
  short_name: string
  slug: string | null
  gbfs_station_id: string | null
  name: string | null
  lat: number | null
  lon: number | null
  capacity: number | null
  station_type: string | null
  first_seen: string | null
  last_seen: string | null
  in_gbfs: number
}

export interface AvailabilityRow {
  station_id: string
  ts: number
  polled_at: number
  num_bikes_available: number
  num_ebikes_available: number
  num_docks_available: number
  num_bikes_disabled: number
  num_docks_disabled: number
  is_installed: number
  is_renting: number
  is_returning: number
  last_reported: number
}

export interface StationRangeResponse {
  station_id: string
  from?: number
  to?: number
  date?: string
  rows: AvailabilityRow[]
  capacity: number | null
  last_polled_at: number | null
}

export function useStationInfo(id: string | undefined) {
  return useQuery<StationInfo | null>({
    queryKey: ['station-info', id],
    enabled: !!id,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/stations/${encodeURIComponent(id!)}/info`)
      if (!res.ok) return null
      return res.json()
    },
  })
}

export function useStationRange(
  id: string | undefined,
  fromS: number,
  toS: number,
) {
  return useQuery<StationRangeResponse>({
    queryKey: ['station-range', id, fromS, toS],
    enabled: !!id,
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/stations/${encodeURIComponent(id!)}/range?from=${fromS}&to=${toS}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    placeholderData: keepPreviousData,
  })
}

/** One row of binned availability aggregation, returned by
 *  `/api/totals?kind=availability&bin=<seconds>&filter.station_id=<uuid>`.
 *  When the request has `metric=all`, each row also has a `metric` field
 *  identifying which of the 5 metrics (bikes/ebikes/docks/disabled/pending)
 *  this row's stat values belong to. */
export interface AvailabilityOverviewRow {
  dt: number               // bin start, unix-s
  station_id: string
  metric?: string          // present when request used metric=all
  sample_count: number     // total minutes-in-state behind the reducer
  mean?: number            // when agg=mean
  min?: number             // when agg=min
  max?: number             // when agg=max
  p05?: number; p25?: number; p50?: number; p75?: number; p95?: number
}

export interface AvailabilityOverviewResponse {
  kind: 'availability'
  metric: string
  scope: string
  tier: string
  rows: AvailabilityOverviewRow[]
}

/** Bin/agg picker shared by chart hooks. `target_bin = max(3600, span/vw)`,
 *  rounded UP to the nearest "nice" duration. Below 24h we use the raw
 *  `/range` endpoint instead (since avail-agg's finest bin is 1h, sub-hour
 *  bins require raw data). Returns `{ binS, useRaw }`.
 *
 *  Tier-cost floor: h1 daily shards are ~110MB parsed each (530k rows × 5
 *  cols), and the Worker can only hold ~1 in memory at the 128MB cap. To
 *  bound CPU/IO regardless of viewport: span > 7d forces binS ≥ 86400 (d1
 *  tier, monthly files); span > 1y forces binS ≥ 1mo (mo1 tier, yearly
 *  files). The visual bin-count rule still applies on top — we just refuse
 *  to over-spend on hourly granularity when the window is too wide. */
export function pickAvailBinMode(spanS: number, viewportPx: number): { binS: number; useRaw: boolean } {
  const RAW_THRESHOLD_S = 86400  // 24h: at/below this, raw /range is bounded enough
  if (spanS <= RAW_THRESHOLD_S) {
    // /range raw — minute-resolution, FE displays as-is.
    return { binS: 60, useRaw: true }
  }
  const HOUR_S = 3600
  const DAY_S = 86400
  const MONTH_S = 30 * DAY_S
  const YEAR_S = 365 * DAY_S
  // Tier-floor cutoffs are based on the # of h1/d1 shards the Worker can
  // sequentially decode within ~10s of CPU. h1 = ~1s/file, so cap at ~14
  // files (14d visible + buffer ≈ 14.7d). Past that we step up to d1.
  const tierFloor = spanS > YEAR_S ? MONTH_S : spanS > 14 * DAY_S ? DAY_S : HOUR_S
  // /totals — pick smallest "nice" bin ≥ span/viewport, bounded by tier floor.
  const NICE_BINS = [
    3600,            //  1 h
    7200,            //  2 h
    14400,           //  4 h
    21600,           //  6 h
    43200,           // 12 h
    86400,           //  1 d
    86400 * 2,       //  2 d
    86400 * 7,       //  1 w
    2592000,         // ~30 d (1 mo)
    2592000 * 3,     // ~3 mo
    2592000 * 12,    // ~1 y
  ]
  const target = Math.max(tierFloor, spanS / viewportPx)
  const binS = NICE_BINS.find((n) => n >= target) ?? NICE_BINS[NICE_BINS.length - 1]
  return { binS, useRaw: false }
}

/** Reshape `/api/totals?metric=all` rows (one per (dt, station, metric))
 *  into per-bin `AvailabilityRow`s the chart consumes. */
function totalsRowsToAvailabilityRows(
  rows: AvailabilityOverviewRow[],
): AvailabilityRow[] {
  const byDt = new Map<number, AvailabilityRow>()
  for (const r of rows) {
    const key = r.dt
    let row = byDt.get(key)
    if (!row) {
      row = {
        // Use bin-start dt as the single time field; chart's `polled_at`
        // is just rendered as the x-axis value, no semantic dependency.
        polled_at: key,
        ts: key,
        station_id: r.station_id,
        num_bikes_available: 0,
        num_ebikes_available: 0,
        num_docks_available: 0,
        num_bikes_disabled: 0,
        num_docks_disabled: 0,
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
        last_reported: key,
      }
      byDt.set(key, row)
    }
    const v = r.mean ?? 0
    switch (r.metric) {
      case 'bikes':    row.num_bikes_available  = v; break
      case 'ebikes':   row.num_ebikes_available = v; break
      case 'docks':    row.num_docks_available  = v; break
      case 'disabled': row.num_bikes_disabled   = v; break
      case 'pending':  row.num_docks_disabled   = v; break
    }
  }
  return Array.from(byDt.values()).sort((a, b) => a.polled_at - b.polled_at)
}

/** Smart availability hook. Picks `/range` (raw, ≤24h windows) or
 *  `/totals?metric=all` (binned, >24h windows) based on viewport.
 *
 *  Returns the same `StationRangeResponse` shape regardless, so the chart
 *  doesn't need to know which path served the data. `last_polled_at` is set
 *  only for the raw path (live-refresh hook gates on it). */
export function useStationAvailability(
  id: string | undefined,           // slug, short_name, or UUID — for /range
  gbfsId: string | null | undefined, // canonical UUID — for /totals
  fromS: number,
  toS: number,
  viewportPx: number,
  capacityHint: number | null,
) {
  const { binS, useRaw } = pickAvailBinMode(toS - fromS, viewportPx)
  return useQuery<StationRangeResponse & { binS: number; useRaw: boolean }>({
    queryKey: ['station-avail', id, gbfsId, fromS, toS, useRaw ? 'raw' : `bin${binS}`],
    enabled: !!id && (useRaw || !!gbfsId),
    queryFn: async () => {
      if (useRaw) {
        const url = `${API_BASE}/api/stations/${encodeURIComponent(id!)}/range?from=${fromS}&to=${toS}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as StationRangeResponse
        return { ...data, binS, useRaw }
      }
      const url = new URL(`${API_BASE}/api/totals`)
      url.searchParams.set('kind', 'availability')
      url.searchParams.set('metric', 'all')
      url.searchParams.set('scope', 'stations')
      url.searchParams.set('from', String(fromS))
      url.searchParams.set('to', String(toS))
      url.searchParams.set('filter.station_id', gbfsId!)
      url.searchParams.set('agg', 'mean')
      url.searchParams.set('bin', String(binS))
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { rows: AvailabilityOverviewRow[] }
      return {
        station_id: gbfsId!,
        from: fromS,
        to: toS,
        capacity: capacityHint,
        last_polled_at: null,  // no live-refresh in binned mode
        rows: totalsRowsToAvailabilityRows(data.rows),
        binS,
        useRaw,
      }
    },
    placeholderData: keepPreviousData,
  })
}

/** Fetch binned availability aggregation for one station. `gbfsId` is the
 *  GBFS UUID (not slug or short_name). Returns `mean` per `binS`-sized bucket
 *  by default; pass `agg='p50'` etc. for percentile reducers. */
export function useAvailabilityOverview(
  gbfsId: string | undefined,
  fromS: number,
  toS: number,
  binS: number,
  metric: 'bikes' | 'ebikes' | 'docks' | 'disabled' | 'pending' = 'bikes',
  agg: 'mean' | 'min' | 'max' | 'p05' | 'p25' | 'p50' | 'p75' | 'p95' = 'mean',
) {
  return useQuery<AvailabilityOverviewResponse>({
    queryKey: ['availability-overview', gbfsId, fromS, toS, binS, metric, agg],
    enabled: !!gbfsId && fromS < toS && binS >= 3600,
    queryFn: async () => {
      const url = new URL(`${API_BASE}/api/totals`)
      url.searchParams.set('kind', 'availability')
      url.searchParams.set('metric', metric)
      url.searchParams.set('scope', 'stations')
      url.searchParams.set('from', String(fromS))
      url.searchParams.set('to', String(toS))
      url.searchParams.set('filter.station_id', gbfsId!)
      url.searchParams.set('agg', agg)
      url.searchParams.set('bin', String(binS))
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    placeholderData: keepPreviousData,
  })
}

export const stationsApi = { API_BASE }
