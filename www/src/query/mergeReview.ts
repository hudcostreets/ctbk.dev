/**
 * TSQ hooks for `/merge-review`: the static clusters asset, and one
 * cluster's per-member monthly rides.
 *
 * Series come from `/api/rides/cells` (per-cell rows): the members' raw
 * `s:<id>` leaves via `raw=1` (explicit ids are taken verbatim), and the
 * materialized `c:<canonical>` row via the default canonical mode — so the
 * page can check `c:` = Σ members as well as show who carried the rides.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { dbgFetch } from '../lib/dbg'
import type { MemberSeries, MergesAsset } from '../lib/mergeReview'
import type { Anchor } from './ridesV1'
import { API_BASE } from './stations'

const DATA_START_ISO = '2013-06-01T00:00:00Z'

export function useMergesAsset(): UseQueryResult<MergesAsset> {
  return useQuery<MergesAsset>({
    queryKey: ['station-merges'],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch('/assets/station-merges.json')
      if (!res.ok) throw new Error(`station-merges: HTTP ${res.status}`)
      return res.json() as Promise<MergesAsset>
    },
  })
}

interface CellsRecord {
  dt: number      // unix ms (bin start)
  cell: string
  count: number
}

/** First of next month (UTC): the current partial month is included. */
function toIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

/** Per-request deadline. Some cold `/api/rides/cells` requests have been
 *  observed to hang with no response (2026-09-26, 1 in ~10 uncached
 *  probes); timing out lets TSQ's retry re-issue them. */
const FETCH_TIMEOUT_MS = 25_000

async function fetchCells(
  anchor: Anchor,
  cells: string[],
  raw: boolean,
): Promise<Map<string, Map<string, number>>> {
  const url = new URL(`${API_BASE}/api/rides/cells`)
  const sp = url.searchParams
  sp.set('anchor', anchor)
  sp.set('from', DATA_START_ISO)
  sp.set('to', toIso())
  sp.set('bin', '1mo')
  sp.set('reducer', 'sum')
  sp.set('cells', cells.join(','))
  if (raw) sp.set('raw', '1')
  const res = await dbgFetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`rides/cells ${anchor}: HTTP ${res.status}`)
  const { records } = await res.json() as { records: CellsRecord[] }
  // One record per (dt, cell, gender, user_type, bike_type) — collapse dims.
  const out = new Map<string, Map<string, number>>()
  for (const r of records) {
    const month = new Date(r.dt).toISOString().slice(0, 7)
    let byMonth = out.get(r.cell)
    if (!byMonth) out.set(r.cell, byMonth = new Map())
    byMonth.set(month, (byMonth.get(month) ?? 0) + r.count)
  }
  return out
}

export interface ClusterSeries {
  /** `s:<id>` → month → rides (every member present, possibly empty). */
  members: MemberSeries
  /** The materialized `c:<canonical>` row's month → rides. */
  canon: Map<string, number>
}

export function useClusterSeries(
  canon: string | undefined,
  memberIds: readonly string[],
  anchor: Anchor,
): UseQueryResult<ClusterSeries> {
  return useQuery<ClusterSeries>({
    queryKey: ['merge-review-series', canon, anchor, memberIds.join(',')],
    enabled: !!canon && memberIds.length > 0,
    staleTime: Infinity,
    retry: 3,
    // No TSQ abort signal: these are cheap, edge-cached full-history
    // reads, and cancelling them mid-flight (unmount, StrictMode's double
    // mount) only wastes the worker's footer parse.
    queryFn: async () => {
      const sKeys = memberIds.map((id) => `s:${id}`)
      const [raw, canonical] = await Promise.all([
        fetchCells(anchor, sKeys, true),
        fetchCells(anchor, [`c:${canon}`], false),
      ])
      const members: MemberSeries = new Map(sKeys.map((k) => [k, raw.get(k) ?? new Map()]))
      return { members, canon: canonical.get(`c:${canon}`) ?? new Map() }
    },
  })
}
