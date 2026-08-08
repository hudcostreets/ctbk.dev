/**
 * TSQ hook for multi-station rides via `/api/rides-v5` station-identity keys.
 *
 * Selected stations (short_names) map straight to the pyramid's `s:<sn>`
 * identity rows — the worker passes all-`s:` covers through untranslated
 * (`serveRidesV5`, `gbfs/api/src/rides_v1.ts`). Two parallel fetches (anchor
 * start + end) inside one query; records are summed across the response's
 * gender/user_type/bike_type dim rows and merged on `dt` into
 * `{ dtS, starts, ends }` rows for the chart.
 *
 * Fixed tiers only for now (1h..14d) — calendar bins (`1mo+`) arrive with
 * pyrmts #122 (see `specs/rides-v5.md` RESOLVED DESIGN).
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { dbgFetch } from '../lib/dbg'
import { API_BASE, durationToS } from './stations'
import type { Anchor } from './ridesV1'

const { ceil, max: mathMax, round } = Math

export interface MultiRidesRow {
  dtS: number       // unix s (bin start)
  starts: number    // rides starting at the selected stations in this bin
  ends: number      // rides ending at the selected stations in this bin
}

export interface MultiRidesResult {
  rows: MultiRidesRow[]
  binS: number
}

interface RidesV5Record {
  dt: number        // unix ms (bin start)
  count: number
  duration: number
  [k: string]: number | string | undefined
}

interface RidesV5Response {
  records: RidesV5Record[]
  plan: { outputBin: string } | null
}

/** Auto bin: ~1 bin per viewport px, floored at the pyramid's 1h base. */
export function pickRidesBinAuto(spanS: number, viewportPx: number): number {
  const NICE_BINS = [
    3600,          //  1 h
    3 * 3600,      //  3 h
    6 * 3600,      //  6 h
    12 * 3600,     // 12 h
    86400,         //  1 d
    3 * 86400,     //  3 d
    7 * 86400,     //  7 d
    14 * 86400,    // 14 d
  ]
  const target = mathMax(3600, spanS / mathMax(1, viewportPx))
  return NICE_BINS.find((n) => n >= target) ?? NICE_BINS[NICE_BINS.length - 1]
}

async function fetchAnchor(
  anchor: Anchor,
  sKeys: string[],
  fromIso: string,
  toIso: string,
  binBudget: number,
  signal?: AbortSignal,
): Promise<{ byDt: Map<number, number>; outputBin?: string }> {
  const url = new URL(`${API_BASE}/api/rides-v5`)
  const sp = url.searchParams
  sp.set('anchor', anchor)
  sp.set('from', fromIso)
  sp.set('to', toIso)
  sp.set('bin_budget', String(binBudget))
  sp.set('reducer', 'sum')
  sp.set('cells', sKeys.join(','))
  const res = await dbgFetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`rides-v5 ${anchor}: HTTP ${res.status}`)
  const data = await res.json() as RidesV5Response
  // One record per (dt, gender, user_type, bike_type) — collapse dims.
  const byDt = new Map<number, number>()
  for (const r of data.records) {
    const dtS = Math.floor(r.dt / 1000)
    byDt.set(dtS, (byDt.get(dtS) ?? 0) + r.count)
  }
  return { byDt, outputBin: data.plan?.outputBin }
}

export function useMultiStationRides(
  shortNames: readonly string[],
  fromS: number,
  toS: number,
  viewportPx: number,
  binOverrideS?: number,
): UseQueryResult<MultiRidesResult> {
  const sorted = [...shortNames].sort()
  const setKey = sorted.join(',')
  const binS = binOverrideS ?? pickRidesBinAuto(toS - fromS, viewportPx)
  const binBudget = mathMax(1, ceil((toS - fromS) / binS))
  return useQuery<MultiRidesResult>({
    queryKey: ['rides-multi', setKey, fromS, toS, `bb${binBudget}`],
    enabled: sorted.length > 0 && viewportPx > 0,
    // TSQ's signal cancels superseded fetches (rapid pans / re-bins) so
    // stale requests don't stack against the worker's in-flight cap (it
    // load-sheds 503s beyond 2 concurrent rides fetches per isolate).
    queryFn: async ({ signal }) => {
      const fromIso = new Date(fromS * 1000).toISOString()
      const toIso = new Date(toS * 1000).toISOString()
      const sKeys = sorted.map((sn) => `s:${sn}`)
      const [start, end] = await Promise.all([
        fetchAnchor('start', sKeys, fromIso, toIso, binBudget, signal),
        fetchAnchor('end', sKeys, fromIso, toIso, binBudget, signal),
      ])
      const dts = [...new Set([...start.byDt.keys(), ...end.byDt.keys()])].sort((a, b) => a - b)
      const rows: MultiRidesRow[] = dts.map((dtS) => ({
        dtS,
        starts: start.byDt.get(dtS) ?? 0,
        ends: end.byDt.get(dtS) ?? 0,
      }))
      const servedBinS = durationToS(start.outputBin) ?? durationToS(end.outputBin)
        ?? mathMax(1, round((toS - fromS) / binBudget))
      return { rows, binS: servedBinS }
    },
    // Cold wide windows can transiently fail while the worker's RG
    // manifest is still filling (footer parses serialize; the busy 503
    // clears in seconds) — retry harder than the app-wide default of 1.
    retry: 3,
    // Keep previous data across range/bin changes for the same station set
    // (smooth pans); reset on set changes so stale traces don't linger.
    placeholderData: (prev, prevQuery) => {
      if (!prev || !prevQuery) return undefined
      return (prevQuery.queryKey as readonly unknown[])[1] === setKey ? prev : undefined
    },
  })
}
