/**
 * TSQ hook for the `smg-v1` pyramid: station-minute state histograms
 * (`specs/avail-smg-pyramid.md`). One query shape serves all three
 * selections — the system (`bbox`), one station (`cells=s:<short_name>`),
 * or a `?sel=` set (several `s:` keys): `/api/avail-v3?pyramid=smg-v1&reducer=hist`
 * sums the per-state minute counts across the covering cells, so every
 * record is one time bin with a 10-bucket partition of station-minutes.
 *
 * Both `state` (raw) and `state_ff` (forward-filled: the nullish ids 0–2
 * redistributed into each station's last measured state) come back in the
 * same response, so the FE's forward-fill toggle is a re-render, not a
 * refetch.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { dbgFetch } from '../lib/dbg'
import { API_BASE, durationToS } from './stations'

const { ceil, max } = Math

/** First day the `smg-v1` cover starts (source parquets go back to
 *  2026-04-07; the pyramid's genesis matches avail-v6's). */
export const SMG_GENESIS_S = Date.UTC(2026, 3, 7) / 1000

/** Whole-system bbox (NYC + JC + Hoboken) — the same one the stand-up
 *  parity check used, so `/` sums exactly the vocab's station set. */
export const SYSTEM_BBOX = '40.5,-74.3,41.0,-73.6'

/** Era boundaries worth marking on any SMG time axis:
 *  - heartbeat era: before it a minute with no snapshot is `no_poll`
 *    whether the poller ran or not (`stale_feed` ≡ 0 pre-2026-05-03);
 *  - poller v2: pre-v2 `stale_feed` is inflated by the CloudFront-cached
 *    1.1 feed. */
export const SMG_ERAS: readonly { atS: number; label: string }[] = [
  { atS: Date.UTC(2026, 4, 3, 12, 20) / 1000, label: 'heartbeats' },
  { atS: Date.UTC(2026, 7, 4) / 1000, label: 'poller v2' },
]

export type SmgGroup = 'gap' | 'dead' | 'live'

export interface SmgState {
  id: number
  key: string
  label: string
  /** Which band the state stacks into: `live` (5–9, the denominator that
   *  matters to riders), `dead` (3–4, the station wasn't usable), `gap`
   *  (0–2, we have no measurement). */
  group: SmgGroup
  light: string
  dark: string
}

/** The 10-state partition, in stack order (bottom → top): the live states
 *  first so `ok` sits on the x-axis, then the dead band, then the gap band. */
export const SMG_STATES: readonly SmgState[] = [
  { id: 9, key: 'ok',             label: 'OK',                  group: 'live', light: '#43a047', dark: '#4caf50' },
  { id: 8, key: 'classic_only',   label: 'No e-bikes',          group: 'live', light: '#9ccc65', dark: '#aed581' },
  { id: 7, key: 'full_no_ebikes', label: 'Full, no e-bikes',    group: 'live', light: '#ffb74d', dark: '#ffcc80' },
  { id: 6, key: 'full',           label: 'Full',                group: 'live', light: '#ef6c00', dark: '#fb8c00' },
  { id: 5, key: 'empty',          label: 'Empty',               group: 'live', light: '#e53935', dark: '#ef5350' },
  { id: 4, key: 'bogus',          label: 'Bogus (0 bikes, 0 docks)', group: 'dead', light: '#8d6e63', dark: '#a1887f' },
  { id: 3, key: 'offline',        label: 'Offline',             group: 'dead', light: '#757575', dark: '#9e9e9e' },
  { id: 2, key: 'absent',         label: 'Absent from feed',    group: 'gap',  light: '#bdbdbd', dark: '#616161' },
  { id: 1, key: 'stale_feed',     label: 'Stale feed',          group: 'gap',  light: '#b0bec5', dark: '#546e7a' },
  { id: 0, key: 'no_poll',        label: 'No poll',             group: 'gap',  light: '#e0e0e0', dark: '#424242' },
]

export const N_STATES = 10

export interface SmgBin {
  dtS: number
  /** Station-minutes per state id (index = id), raw partition. */
  state: number[]
  /** Same, forward-filled (ids 0–2 are always 0 here). */
  ff: number[]
}

export interface SmgResult {
  bins: SmgBin[]
  binS: number
  tier: string | null
}

export type SmgSelection =
  | { kind: 'bbox'; bbox: string }
  | { kind: 'cells'; cells: readonly string[] }

/** `s:<short_name>` identity keys for a station set. */
export function smgCellsFor(shortNames: readonly string[]): SmgSelection {
  return { kind: 'cells', cells: shortNames.map((s) => `s:${s}`) }
}

/** Auto bin: the smg-v1 ladder's tier bins, picked so the window fits in
 *  about half the viewport's pixels (stacked areas read fine at 2px/bin,
 *  and it halves the rows the worker has to sum for wide windows). */
export function pickSmgBinAuto(spanS: number, viewportPx: number): number {
  const NICE_BINS = [
    60, 120, 180, 300, 600, 900, 1800,
    3600, 7200, 10800, 21600, 43200,
    86400, 3 * 86400, 7 * 86400,
  ]
  const target = max(60, spanS / max(1, viewportPx / 2))
  return NICE_BINS.find((n) => n >= target) ?? NICE_BINS[NICE_BINS.length - 1]
}

interface HistRecord {
  s2_cell: string
  dt: number  // unix ms (bin start)
  state: Record<string, number>
  state_ff: Record<string, number>
}

interface HistResponse {
  records: HistRecord[]
  plan: { outputTier: string; outputBin: string } | null
}

function histToCounts(h: Record<string, number> | undefined): number[] {
  const out = new Array<number>(N_STATES).fill(0)
  if (!h) return out
  for (const [k, v] of Object.entries(h)) {
    const id = Number(k)
    if (id >= 0 && id < N_STATES) out[id] = v
  }
  return out
}

const selKey = (sel: SmgSelection): string =>
  sel.kind === 'bbox' ? `bbox:${sel.bbox}` : `cells:${[...sel.cells].sort().join(',')}`

async function fetchSmgHist(
  sel: SmgSelection,
  fromS: number,
  toS: number,
  binS: number,
): Promise<SmgResult> {
  const url = new URL(`${API_BASE}/api/avail-v3`)
  url.searchParams.set('pyramid', 'smg-v1')
  url.searchParams.set('reducer', 'hist')
  if (sel.kind === 'bbox') url.searchParams.set('bbox', sel.bbox)
  else url.searchParams.set('cells', sel.cells.join(','))
  url.searchParams.set('from', new Date(fromS * 1000).toISOString())
  url.searchParams.set('to', new Date(toS * 1000).toISOString())
  url.searchParams.set('bin_budget', String(max(1, ceil((toS - fromS) / binS))))
  const res = await dbgFetch(url.toString())
  if (!res.ok) throw new Error(`smg-v1: HTTP ${res.status}`)
  const data = await res.json() as HistResponse
  // The rollup route already summed across the cover; a defensive merge on
  // `dt` keeps the chart correct if a response ever carries several rows
  // per bin (e.g. a label per covering cell).
  const byDt = new Map<number, SmgBin>()
  for (const r of data.records) {
    const dtS = Math.floor(r.dt / 1000)
    const st = histToCounts(r.state)
    const ff = histToCounts(r.state_ff)
    const cur = byDt.get(dtS)
    if (!cur) {
      byDt.set(dtS, { dtS, state: st, ff })
    } else {
      for (let i = 0; i < N_STATES; i++) { cur.state[i] += st[i]; cur.ff[i] += ff[i] }
    }
  }
  const bins = [...byDt.values()].sort((a, b) => a.dtS - b.dtS)
  return {
    bins,
    binS: durationToS(data.plan?.outputBin) ?? binS,
    tier: data.plan?.outputTier ?? null,
  }
}

export function useSmgHist(
  sel: SmgSelection | null,
  fromS: number,
  toS: number,
  viewportPx: number,
  binOverrideS?: number,
): UseQueryResult<SmgResult> {
  const binS = binOverrideS ?? pickSmgBinAuto(toS - fromS, viewportPx)
  const key = sel ? selKey(sel) : ''
  return useQuery<SmgResult>({
    queryKey: ['smg-hist', key, fromS, toS, binS],
    enabled: sel !== null && fromS < toS,
    queryFn: () => fetchSmgHist(sel!, fromS, toS, binS),
    // Keep the previous window on screen while a range/bin change loads,
    // but only for the same selection — another station's partition is
    // misleading as a placeholder.
    placeholderData: (prev, prevQuery) => {
      if (!prev || !prevQuery) return undefined
      return (prevQuery.queryKey as readonly unknown[])[1] === key ? prev : undefined
    },
  })
}
