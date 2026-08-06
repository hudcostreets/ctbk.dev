/**
 * TSQ hooks for the GBFS station API.
 *
 * - `useStationInfo(id)`: one-shot `/info` fetch.
 * - `useStationAvailability(...)`: time-windowed avail data via `/api/totals`,
 *   binned per `binOverrideS` or `pickAvailBinAuto`. Single shape regardless
 *   of window size (the worker handles tier selection: mo1/d1/h1/raw).
 */
import { keepPreviousData, type QueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useFlag } from '../contexts/FlagsContext'
import { dbgFetch } from '../lib/dbg'

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

const stationInfoKey = (id: string) => ['station-info', id] as const
const stationInfoFn = async (id: string): Promise<StationInfo | null> => {
  const res = await dbgFetch(`${API_BASE}/api/stations/${encodeURIComponent(id)}/info`)
  if (!res.ok) return null
  return res.json()
}

export function useStationInfo(id: string | undefined) {
  return useQuery<StationInfo | null>({
    queryKey: stationInfoKey(id ?? ''),
    enabled: !!id,
    queryFn: () => stationInfoFn(id!),
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
 *  No coarse-window tier floor: the avail-v3 ladder's min-cover keeps file
 *  counts bounded at any (span, bin) combination, so the pixel target alone
 *  decides (the legacy floor forced 1d bins past 30d spans — chunky). The
 *  worker's planner still coarsens the *output* tier if the budget warrants. */
export function pickAvailBinAuto(spanS: number, viewportPx: number): number {
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
  const target = Math.max(60, spanS / viewportPx)
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
const stationAvailKey = (gbfsId: string, fromS: number, toS: number, binS: number) =>
  ['station-avail', gbfsId, fromS, toS, `bin${binS}`] as const

const stationAvailFn = async (
  gbfsId: string, fromS: number, toS: number, binS: number, capacityHint: number | null,
): Promise<StationRangeResponse & { binS: number }> => {
  const url = new URL(`${API_BASE}/api/totals`)
  url.searchParams.set('kind', 'availability')
  url.searchParams.set('metric', 'all')
  url.searchParams.set('scope', 'stations')
  url.searchParams.set('from', String(fromS))
  url.searchParams.set('to', String(toS))
  url.searchParams.set('filter.station_id', gbfsId)
  url.searchParams.set('agg', 'mean')
  url.searchParams.set('bin', String(binS))
  const res = await dbgFetch(url.toString())
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { rows: AvailabilityOverviewRow[] }
  return {
    station_id: gbfsId,
    from: fromS,
    to: toS,
    capacity: capacityHint,
    last_polled_at: null,
    rows: totalsRowsToAvailabilityRows(data.rows),
    binS,
  }
}

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
    queryKey: stationAvailKey(gbfsId ?? '', fromS, toS, binS),
    enabled: !!gbfsId,
    queryFn: () => stationAvailFn(gbfsId!, fromS, toS, binS, capacityHint),
    // Keep stale data ONLY when the station_id hasn't changed (i.e. the user
    // toggled range/bin on the same station). On cross-station nav, drop to
    // `undefined` so the chart shows a spinner instead of the previous
    // station's data — which is misleading when the new station has different
    // capacity / activity profile.
    placeholderData: (prev, prevQuery) => {
      if (!prev || !prevQuery) return undefined
      const prevGbfsId = (prevQuery.queryKey as readonly unknown[])[1]
      return prevGbfsId === gbfsId ? prev : undefined
    },
    refetchInterval: liveRefresh ? 60_000 : false,
  })
}

// ─────────────────────────────────────────────────────────────────────
// avail-v3 path (per-station via station-LUC denorm)
//
// See `specs/per-station-luc-v3.md`. Once the avail-v3 backfill on `e`
// completes with the LUC-anchored builder, these hooks replace
// `useStationAvailability` / `useAvailabilityOverview` as the per-station
// query path. The legacy `/api/totals` path is then deleted.
// ─────────────────────────────────────────────────────────────────────

interface StationLucEntry {
  lat: number
  lng: number
  cell: string   // S2 hex token at `level`
  level: number  // LUC level (typically 13..19)
  uuid: string   // most-recently-seen GBFS station_id for this short_name
}

export interface StationLuc {
  by_short_name: Record<string, StationLucEntry>
  by_uuid: Record<string, string>  // gbfs_station_id → canonical short_name
}

const STATION_LUC_URL = '/assets/station-luc.json' as const

/** Fetch the station-LUC denorm once (TSQ infinite-stale). The file is
 *  built by `ctbk station-luc-build` and shipped both as a Git-tracked
 *  static asset and to R2. ~400 KB. */
export function useStationLuc(): UseQueryResult<StationLuc> {
  return useQuery<StationLuc>({
    queryKey: ['station-luc'],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(STATION_LUC_URL)
      if (!res.ok) throw new Error(`station-luc: HTTP ${res.status}`)
      return res.json()
    },
  })
}

/** Look up a station's LUC entry from its GBFS UUID. Returns null if the
 *  station isn't in the denorm (rare — usually means the station was
 *  decommissioned before the window-union snapshot range, or the LUC
 *  denorm is stale). */
/** avail-v5 identity key for a GBFS uuid: `s:<short_name>` (drop-LUC
 *  serving — one identity row per station, no LUC cell indirection). */
export function stationKeyForUuid(luc: StationLuc | undefined, gbfsId: string | null | undefined): string | null {
  if (!luc || !gbfsId) return null
  const shortName = luc.by_uuid[gbfsId]
  return shortName ? `s:${shortName}` : null
}

export function lucEntryForUuid(luc: StationLuc | undefined, gbfsId: string | null | undefined): StationLucEntry | null {
  if (!luc || !gbfsId) return null
  const shortName = luc.by_uuid[gbfsId]
  if (!shortName) return null
  return luc.by_short_name[shortName] ?? null
}

interface AvailV3Record {
  s2_cell: string
  dt: number  // unix ms (bin start)
  bikes: number
  ebikes: number
  docks: number
  disabled: number
  pending: number
}

interface AvailV3Response {
  records: AvailV3Record[]
  reducer: string
  plan: { outputTier: string; outputBin: string; outputRes: number; outputCells: string[] }
}

/** Reshape `/api/avail-v3` wide records into per-bin `AvailabilityRow`s
 *  the chart consumes. */
function availV3RowsToAvailabilityRows(
  records: AvailV3Record[],
  stationId: string,
): AvailabilityRow[] {
  return records
    .map((r) => ({
      // `dt` is ms; AvailabilityRow uses unix-s.
      polled_at: Math.floor(r.dt / 1000),
      ts: Math.floor(r.dt / 1000),
      station_id: stationId,
      num_bikes_available: r.bikes,
      num_ebikes_available: r.ebikes,
      num_docks_available: r.docks,
      num_bikes_disabled: r.disabled,
      num_docks_disabled: r.pending,
      is_installed: 1,
      is_renting: 1,
      is_returning: 1,
      last_reported: Math.floor(r.dt / 1000),
    }))
    .sort((a, b) => a.polled_at - b.polled_at)
}

/** Parse a pyrmts Duration string (`1min` / `30min` / `1h` / `3d`) to
 *  seconds; null on anything unrecognized. */
function durationToS(dur: string | undefined): number | null {
  if (!dur) return null
  const m = /^(\d+)(min|h|d|w|y)$/.exec(dur)
  if (!m) return null
  const mult = { min: 60, h: 3600, d: 86400, w: 7 * 86400, y: 365 * 86400 }[m[2] as 'min' | 'h' | 'd' | 'w' | 'y']
  return Number(m[1]) * mult
}

const stationAvailV3Key = (gbfsId: string, fromS: number, toS: number, binBudget: number, pyramid: string) =>
  ['station-avail-v5', gbfsId, fromS, toS, `bb${binBudget}`, pyramid] as const

const stationAvailV3Fn = async (
  gbfsId: string, sKey: string, fromS: number, toS: number, binBudget: number, capacityHint: number | null, pyramid: string,
): Promise<StationRangeResponse & { binS: number }> => {
  const fromIso = new Date(fromS * 1000).toISOString()
  const toIso   = new Date(toS   * 1000).toISOString()
  const url = new URL(`${API_BASE}/api/avail-v3`)
  // avail-v5 identity row (`s:<short_name>`) — fixes the LUC re-key
  // drift that leaves many stations' current cells empty in avail-v3.
  url.searchParams.set('cells', sKey)
  // `availPyramid` flag: 'default' omits the param (worker resolves
  // `DEFAULT_PYRAMID`); explicit values pin a pyramid.
  if (pyramid !== 'default') url.searchParams.set('pyramid', pyramid)
  url.searchParams.set('from', fromIso)
  url.searchParams.set('to', toIso)
  url.searchParams.set('bin_budget', String(binBudget))
  url.searchParams.set('reducer', 'mean')
  const res = await dbgFetch(url.toString())
  if (!res.ok) throw new Error(`avail-v3: HTTP ${res.status}`)
  const data = await res.json() as AvailV3Response
  // The planner reports the bin it actually served (`outputBin`, a pyrmts
  // Duration like '1h' / '30min' / '3d') — it may be coarser than
  // span/budget when a coarse tier satisfies the budget. Fall back to the
  // budget-derived estimate if the field is missing/unparseable.
  const binS = durationToS(data.plan?.outputBin)
    ?? Math.max(1, Math.round((toS - fromS) / Math.max(1, binBudget)))
  return {
    station_id: gbfsId,
    from: fromS,
    to: toS,
    capacity: capacityHint,
    last_polled_at: null,
    rows: availV3RowsToAvailabilityRows(data.records, gbfsId),
    binS,
  }
}

/** Per-station avail via avail-v3. Looks up the station's LUC cell from
 *  the denorm and queries `/api/avail-v3?cells=<luc>`. Returns the same
 *  shape as `useStationAvailability` so callers can swap. */
export function useStationAvailabilityV3(
  gbfsId: string | null | undefined,
  fromS: number,
  toS: number,
  viewportPx: number,
  capacityHint: number | null,
  binOverrideS?: number,
  liveRefresh: boolean = false,
) {
  const lucQ = useStationLuc()
  const sKey = stationKeyForUuid(lucQ.data, gbfsId)
  const pyramid = useFlag('availPyramid')
  const binS = binOverrideS ?? pickAvailBinAuto(toS - fromS, viewportPx)
  const binBudget = Math.max(1, Math.ceil((toS - fromS) / binS))
  return useQuery<StationRangeResponse & { binS: number }>({
    queryKey: stationAvailV3Key(gbfsId ?? '', fromS, toS, binBudget, pyramid),
    enabled: !!gbfsId && !!sKey,
    queryFn: () => stationAvailV3Fn(gbfsId!, sKey!, fromS, toS, binBudget, capacityHint, pyramid),
    placeholderData: (prev, prevQuery) => {
      if (!prev || !prevQuery) return undefined
      const prevGbfsId = (prevQuery.queryKey as readonly unknown[])[1]
      return prevGbfsId === gbfsId ? prev : undefined
    },
    refetchInterval: liveRefresh ? 60_000 : false,
  })
}

export type AvailSource = 'totals' | 'v3'

/** Soft-cutover wrapper. Dispatches between the legacy `/api/totals` path
 *  and the new avail-v3 path based on `source`. Both underlying hooks are
 *  always called (with the inactive one nullified via `gbfsId`); React's
 *  rules-of-hooks require stable call order across renders. The returned
 *  query is whichever one is active. */
export function useStationAvailabilityRouted(
  source: AvailSource,
  gbfsId: string | null | undefined,
  fromS: number,
  toS: number,
  viewportPx: number,
  capacityHint: number | null,
  binOverrideS?: number,
  liveRefresh: boolean = false,
) {
  const totalsResult = useStationAvailability(
    source === 'totals' ? gbfsId : null,
    fromS, toS, viewportPx, capacityHint, binOverrideS, liveRefresh,
  )
  const v3Result = useStationAvailabilityV3(
    source === 'v3' ? gbfsId : null,
    fromS, toS, viewportPx, capacityHint, binOverrideS, liveRefresh,
  )
  return source === 'v3' ? v3Result : totalsResult
}

/** Warm the cache for a station-detail navigation. Called from map hover
 *  handlers. Idempotent — repeat calls within the cache window are no-ops.
 *  Chains `info` → `avail` so the avail-query keys match the eventual page
 *  request (`gbfs_station_id` is only known after `/info`). */
export async function prefetchStationDetail(
  qc: QueryClient,
  slugOrShortName: string,
  fromS: number,
  toS: number,
  binS: number,
): Promise<void> {
  const info = await qc.fetchQuery({
    queryKey: stationInfoKey(slugOrShortName),
    queryFn: () => stationInfoFn(slugOrShortName),
  })
  if (!info?.gbfs_station_id) return
  await qc.prefetchQuery({
    queryKey: stationAvailKey(info.gbfs_station_id, fromS, toS, binS),
    queryFn: () => stationAvailFn(info.gbfs_station_id!, fromS, toS, binS, info.capacity ?? null),
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
      const res = await dbgFetch(url.toString())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    placeholderData: keepPreviousData,
  })
}

/** avail-v3 sibling of `useAvailabilityOverview`. Looks up the station's
 *  LUC cell from the denorm and queries `/api/avail-v3` with the
 *  requested reducer; extracts just the requested metric's column.
 *  Returns the same `AvailabilityOverviewResponse` shape so callers can
 *  swap in place. */
export function useAvailabilityOverviewV3(
  gbfsId: string | undefined,
  fromS: number,
  toS: number,
  binS: number,
  metric: 'bikes' | 'ebikes' | 'docks' | 'disabled' | 'pending' = 'bikes',
  agg: 'mean' | 'min' | 'max' | 'p05' | 'p25' | 'p50' | 'p75' | 'p95' = 'mean',
) {
  const lucQ = useStationLuc()
  const sKey = stationKeyForUuid(lucQ.data, gbfsId)
  const pyramid = useFlag('availPyramid')
  const binBudget = Math.max(1, Math.ceil((toS - fromS) / binS))
  return useQuery<AvailabilityOverviewResponse>({
    queryKey: ['availability-overview-v5', gbfsId, fromS, toS, binS, metric, agg, pyramid],
    enabled: !!gbfsId && !!sKey && fromS < toS && binS >= 3600,
    queryFn: async () => {
      const fromIso = new Date(fromS * 1000).toISOString()
      const toIso   = new Date(toS   * 1000).toISOString()
      const url = new URL(`${API_BASE}/api/avail-v3`)
      url.searchParams.set('cells', sKey!)
      if (pyramid !== 'default') url.searchParams.set('pyramid', pyramid)
      url.searchParams.set('from', fromIso)
      url.searchParams.set('to', toIso)
      url.searchParams.set('bin_budget', String(binBudget))
      url.searchParams.set('reducer', agg)
      const res = await dbgFetch(url.toString())
      if (!res.ok) throw new Error(`avail-v3: HTTP ${res.status}`)
      const data = await res.json() as AvailV3Response
      // Map the wide-format avail-v3 records to the tall AvailabilityOverviewRow
      // shape, extracting just the requested metric's column.
      const rows: AvailabilityOverviewRow[] = data.records.map((r) => ({
        dt: Math.floor(r.dt / 1000),
        station_id: gbfsId!,
        metric,
        sample_count: 0,  // avail-v3 doesn't expose the per-bin source-row count
        [agg]: (r as unknown as Record<string, number>)[metric],
      }) as AvailabilityOverviewRow)
      return {
        kind: 'availability',
        metric,
        scope: 'stations',
        tier: data.plan.outputTier,
        rows,
      }
    },
    placeholderData: keepPreviousData,
  })
}

export const stationsApi = { API_BASE }
