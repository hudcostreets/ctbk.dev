/**
 * TanStack Query hook for the multi-scale rollup endpoint
 * (`GET ${API_BASE}/api/query`; see `specs/multiscale-timeseries-backend.md`).
 *
 * Covers both trips and availability, per-station or per-region(s). The
 * Worker owns file selection + tier routing; the client just passes a
 * `{kind, station XOR regions, from, to, binMs?, targetPxPerBin?}` shape.
 *
 * - `Date.now()` is snapshotted once when the caller's `end` is `null`
 *   ("Latest" mode), matching the pattern in `StationDetail` — using it
 *   directly would churn the query key every render.
 * - The visible `[from, to]` range is quantized to the bin grid via
 *   `quantizeToBin` so drag-pan within a single bin is a TSQ cache hit.
 *   When `binMs` is `undefined` (auto), we skip client-side quantization
 *   and let the Worker round to whatever tier it picks.
 * - `placeholderData: keepPreviousData` keeps the chart visible during
 *   refetches (drag-pan commits, Latest snap-back, etc.).
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import { stationsApi } from './stations'

export type QueryKind = 'trips' | 'availability'
export type Region = 'nyc' | 'jc' | 'hob'
export type Side = 'start' | 'end'

export interface RollupQueryParams {
  kind: QueryKind
  /** Per-station short_name. XOR with `regions`. */
  station?: string
  /** Regions to union. XOR with `station`. Defaults to all regions server-side. */
  regions?: Region[]
  /** End timestamp; `null` → "Latest" (snapshotted to `Date.now()`). */
  end: Date | null
  /** Lookback duration (ms). */
  duration: number
  /** Explicit bin size (ms). `undefined` → Worker auto-picks. */
  binMs?: number
  /** Target px per bin for auto-mode. Defaults to 3. */
  targetPxPerBin?: number
  /** Plot width in px; used with auto-mode. */
  plotWidth?: number
  /** Per-station only: restrict to rides where the station is the start/end. */
  side?: Side
  /** Dim columns to break out as group keys (e.g. `['side']` returns one
   *  row per `(bin × side)` instead of one row per bin). Default: `[]`. */
  dims?: string[]
}

/** Worker returns `dt` (number, unix-s) plus metric columns (`count`,
 *  `duration_s`) plus any requested dim columns (strings or numeric
 *  categoricals). Use index-signature for dims. */
export interface RollupRow {
  dt: number
  count?: number
  duration_s?: number
  [field: string]: number | string | undefined
}

export interface RollupResponse {
  /** Which tier/source the Worker served from, e.g. `'h1' | 'n1' | 'raw'`. */
  tier: string
  /** Actual bin size used (ms) — may differ from caller's `binMs` in auto-mode. */
  binMs: number
  rows: RollupRow[]
}

/**
 * Round `[fromS, toS]` outward to bin boundaries so small drag-pans stay
 * within a single cached query. Seconds-granularity to match the Worker
 * endpoint. Caller must pass `binMs > 0`.
 */
export function quantizeToBin(
  fromS: number,
  toS: number,
  binMs: number,
): [quantFromS: number, quantToS: number] {
  const binS = Math.max(1, Math.floor(binMs / 1000))
  return [
    Math.floor(fromS / binS) * binS,
    Math.ceil(toS / binS) * binS,
  ]
}

const DEFAULT_TARGET_PX_PER_BIN = 3

export function useRollupQuery(
  params: RollupQueryParams,
): UseQueryResult<RollupResponse> {
  const {
    kind, station, regions, end, duration,
    binMs, targetPxPerBin, plotWidth, side, dims,
  } = params

  // Snapshot `Date.now()` once per relevant input change — using it directly
  // would recompute `toS` every render in Latest mode, churning the query key.
  const endMs = end?.getTime() ?? null
  const { fromS, toS } = useMemo(() => {
    const toMs = endMs ?? Date.now()
    return {
      fromS: Math.floor((toMs - duration) / 1000),
      toS: Math.floor(toMs / 1000),
    }
  }, [endMs, duration])

  // Quantize visible range to bin grid so drag-pan within a bin is a cache hit.
  // Auto-mode: let the Worker round — we don't know the tier client-side yet.
  const [qFromS, qToS] = useMemo(() => {
    if (binMs === undefined) return [fromS, toS]
    return quantizeToBin(fromS, toS, binMs)
  }, [fromS, toS, binMs])

  const regionsKey = regions ? [...regions].sort().join(',') : ''
  const dimsKey = dims?.length ? [...dims].sort().join(',') : ''
  const enabled = !!station || !!regions?.length

  return useQuery<RollupResponse>({
    queryKey: [
      'rollup', kind,
      station ?? null, regionsKey,
      qFromS, qToS,
      binMs ?? 'auto',
      side ?? null,
      dimsKey,
    ],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const url = new URL(`${stationsApi.API_BASE}/api/query`)
      const sp = url.searchParams
      sp.set('kind', kind)
      if (station) sp.set('station', station)
      else if (regions?.length) sp.set('region', regions.join(','))
      sp.set('from', String(qFromS))
      sp.set('to', String(qToS))
      if (binMs !== undefined) {
        sp.set('bin', String(binMs))
      } else {
        sp.set('targetPxPerBin', String(targetPxPerBin ?? DEFAULT_TARGET_PX_PER_BIN))
        if (plotWidth !== undefined) sp.set('plotWidth', String(plotWidth))
      }
      if (side) sp.set('side', side)
      if (dims?.length) sp.set('dims', dims.join(','))
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })
}
