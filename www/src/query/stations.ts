/**
 * TSQ hooks for the GBFS station API.
 *
 * - `useStationInfo(id)`: one-shot `/info` fetch.
 * - `useStationAvailability(...)`: time-windowed avail data via `/api/totals`,
 *   binned per `binOverrideS` or `pickAvailBinAuto`. Single shape regardless
 *   of window size (the worker handles tier selection: mo1/d1/h1/raw).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'

// Override at build/dev time with `VITE_API_BASE=http://localhost:51896 pnpm dev`.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

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
  /** Number of source-minute polls aggregated into this row, when row came
   *  from `/api/totals` (binned). Absent on raw `/range` rows (each row IS
   *  one minute). Used by the chart's tooltip to label the aggregation. */
  sample_count?: number
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

/** Auto-bin picker for the availability chart: `target_bin = span/viewport`,
 *  rounded UP to the nearest "nice" duration in `NICE_BINS`. With the unified
 *  raw tier (sub-hour bins served via `/day raw` bundles + WAL-stitched today)
 *  there's no longer a useRaw fork; sub-hour bins are first-class.
 *
 *  Tier-cost floor for very-wide windows: span > 30d forces binS ≥ 86400
 *  (d1 tier, yearly files); span > 1y forces binS ≥ 1mo (mo1 tier, decade
 *  files). Caps the per-file decode load on the Worker. */
export function pickAvailBinAuto(spanS: number, viewportPx: number): number {
  const DAY_S = 86400
  const MONTH_S = 30 * DAY_S
  const YEAR_S = 365 * DAY_S
  const tierFloor = spanS > YEAR_S ? MONTH_S : spanS > 30 * DAY_S ? DAY_S : 60
  const NICE_BINS = [
    60,              //  1 min
    300,             //  5 min
    900,             // 15 min
    1800,            // 30 min
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
  return NICE_BINS.find((n) => n >= target) ?? NICE_BINS[NICE_BINS.length - 1]
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
        sample_count: r.sample_count,
      }
      byDt.set(key, row)
    }
    // Per-metric `sample_count` is the same per (dt, station) — keep the max
    // in case a later metric row carries it but an earlier one didn't.
    if (r.sample_count != null && (row.sample_count == null || r.sample_count > row.sample_count)) {
      row.sample_count = r.sample_count
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

/** Availability hook. Always calls `/api/totals?metric=all` regardless of
 *  window or bin — the unified raw tier serves sub-hour bins via `/day raw`
 *  bundles + WAL stitching for today. No useRaw fork.
 *
 *  `liveRefresh` enables a 60s refetch interval (for "Latest" mode where
 *  newly-arrived polls should appear without a manual reload). Worker
 *  stitches today's WAL into in-progress bins, so a refetch returns rows
 *  through `now`. */
export function useStationAvailability(
  gbfsId: string | null | undefined,  // canonical UUID — required for /totals
  fromS: number,
  toS: number,
  viewportPx: number,
  capacityHint: number | null,
  /** Manual bin override in seconds. When undefined, falls back to
   *  `pickAvailBinAuto`'s auto choice. */
  binOverrideS?: number,
  liveRefresh: boolean = false,
) {
  const binS = binOverrideS ?? pickAvailBinAuto(toS - fromS, viewportPx)
  return useQuery<StationRangeResponse & { binS: number }>({
    queryKey: ['station-avail', gbfsId, fromS, toS, `bin${binS}`],
    enabled: !!gbfsId,
    queryFn: async () => {
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
        last_polled_at: null,
        rows: totalsRowsToAvailabilityRows(data.rows),
        binS,
      }
    },
    placeholderData: keepPreviousData,
    refetchInterval: liveRefresh ? 60_000 : false,
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
