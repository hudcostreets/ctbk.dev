/**
 * `/merge-review` model: the station-merge clusters behind the rides
 * pyramids' materialized `c:<canonical>` rows (`specs/rides-rekey.md` P5).
 *
 * Input is `/assets/station-merges.json` (`ctbk rides-merge-review`): per
 * merged cluster of `station-canonicalize-map.json`, its raw reported ids
 * with their station-history eras, last positions, and merge provenance.
 * This module derives the static suspicion signals used to rank clusters;
 * the ride-series co-activity check (per-member monthly rides from
 * `/api/rides/cells?raw=1`) is computed on demand for the selected cluster.
 */

const { asin, cos, max, min, PI, sin, sqrt } = Math

export type Via = 'harmonize' | 'overlay'
/** `[name, first, last]` — ISO dates; `last` null = still active. */
export type Span = [string, string, string | null]

export interface Member {
  id: string
  via: Via
  pos: [number, number] | null
  spans: Span[]
}

export interface ReviewPair {
  pass: 'exact-name' | 'fuzzy' | 'fuzzy-borderline' | string
  a: string
  b: string
  shared_months: string[]
  merged?: boolean
}

export interface Cluster {
  members: Member[]
  review: ReviewPair[]
}

export interface MergesAsset {
  clusters: Record<string, Cluster>
}

export type Flag = 'far' | 'near' | 'co-active' | 'overlap' | 'borderline' | 'split-nearby' | 'overlay' | 'no-history'

export const FLAGS: Flag[] = ['far', 'near', 'co-active', 'overlap', 'borderline', 'split-nearby', 'overlay', 'no-history']

/** Thresholds. Renumbers/relabels of one dock sit within ~50 m and hand
 *  off in sequence; on the real map, member spreads are bimodal (≤ ~150 m,
 *  or ≥ 1 km), and extent overlaps of a year+ are rare. */
export const FAR_M = 1000
export const NEAR_M = 150
export const CO_ACTIVE_DAYS = 365
export const OVERLAP_DAYS = 90

export const FLAG_INFO: Record<Flag, { label: string, desc: string, weight: number }> = {
  'far': { label: `>${FAR_M / 1000} km apart`, desc: `Members' last positions are more than ${FAR_M / 1000} km apart — unlikely to be one dock.`, weight: 8 },
  'near': { label: `>${NEAR_M} m apart`, desc: `Members' last positions are ${NEAR_M} m–${FAR_M / 1000} km apart.`, weight: 3 },
  'co-active': { label: `overlap >1 y`, desc: `Two members' active date ranges overlap by more than ${CO_ACTIVE_DAYS} days — a renumber hands off, it doesn't run in parallel.`, weight: 5 },
  'overlap': { label: `overlap >${OVERLAP_DAYS} d`, desc: `Two members' active date ranges overlap by ${OVERLAP_DAYS}–${CO_ACTIVE_DAYS} days (history extents; stray rides can stretch them).`, weight: 2 },
  'borderline': { label: 'borderline', desc: 'The harmonize co-activity guard flagged a pair in this cluster as borderline, and it was merged anyway.', weight: 3 },
  'split-nearby': { label: 'split nearby', desc: 'The co-activity guard rejected a merge between a member and another station (the pair serves separately).', weight: 1 },
  'overlay': { label: 'overlay', desc: 'A member was folded in by the `station-luc.json` `merged` overlay, not the harmonize id-map.', weight: 1 },
  'no-history': { label: 'no history', desc: 'A member has no station-history eras (the history lags the id-map): name and dates unknown.', weight: 1 },
}

export interface ClusterStats {
  canon: string
  cluster: Cluster
  name: string
  first: string | null
  last: string | null      // null = still active
  maxDistM: number | null  // null = <2 positioned members
  maxOverlapDays: number
  flags: Flag[]
  score: number
}

const DAY_MS = 86_400_000

export function isoToMs(d: string): number {
  return Date.parse(`${d}T00:00:00Z`)
}

/** Great-circle distance in meters. */
export function haversineM(a: [number, number], b: [number, number]): number {
  const rad = (x: number) => x * PI / 180
  const [la1, lo1, la2, lo2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])]
  const h = sin((la2 - la1) / 2) ** 2 + cos(la1) * cos(la2) * sin((lo2 - lo1) / 2) ** 2
  return 2 * 6_371_000 * asin(sqrt(h))
}

/** A member's active extent `[firstMs, lastMs]` over all its eras
 *  (`last` null → `nowMs`); null without eras. */
export function extent(m: Member, nowMs: number): [number, number] | null {
  if (!m.spans.length) return null
  const firsts = m.spans.map(([, f]) => isoToMs(f))
  const lasts = m.spans.map(([, , l]) => (l === null ? nowMs : isoToMs(l)))
  return [min(...firsts), max(...lasts)]
}

/** The member's most recent era's name (latest `last`, active wins). */
export function latestName(m: Member): string | null {
  if (!m.spans.length) return null
  const key = (s: Span) => s[2] ?? '9999'
  const sorted = [...m.spans].sort((a, b) => key(a).localeCompare(key(b)) || a[1].localeCompare(b[1]))
  return sorted[sorted.length - 1][0]
}

function pairs<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = []
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]])
  return out
}

export function clusterStats(canon: string, cluster: Cluster, nowMs: number): ClusterStats {
  const { members, review } = cluster
  const exts = members.map((m) => extent(m, nowMs)).filter((e): e is [number, number] => e !== null)
  const maxOverlapDays = max(0, ...pairs(exts).map(([a, b]) => (min(a[1], b[1]) - max(a[0], b[0])) / DAY_MS))
  const positioned = members.map((m) => m.pos).filter((p): p is [number, number] => p !== null)
  const maxDistM = positioned.length < 2 ? null : max(...pairs(positioned).map(([a, b]) => haversineM(a, b)))

  const flags: Flag[] = []
  if (maxDistM !== null && maxDistM > FAR_M) flags.push('far')
  else if (maxDistM !== null && maxDistM > NEAR_M) flags.push('near')
  if (maxOverlapDays > CO_ACTIVE_DAYS) flags.push('co-active')
  else if (maxOverlapDays > OVERLAP_DAYS) flags.push('overlap')
  if (review.some((r) => r.merged)) flags.push('borderline')
  if (review.some((r) => !r.merged)) flags.push('split-nearby')
  if (members.some((m) => m.via === 'overlay')) flags.push('overlay')
  if (members.some((m) => !m.spans.length)) flags.push('no-history')

  const self = members.find((m) => m.id === canon)
  const byRecency = [...members].sort((a, b) => ((a.spans.length ? extent(a, nowMs)![1] : 0) - (b.spans.length ? extent(b, nowMs)![1] : 0)))
  const name = (self && latestName(self)) ?? latestName(byRecency[byRecency.length - 1]) ?? canon
  const firstMs = exts.length ? min(...exts.map((e) => e[0])) : null
  const lastMs = exts.length ? max(...exts.map((e) => e[1])) : null
  const activeNow = members.some((m) => m.spans.some((s) => s[2] === null))
  return {
    canon,
    cluster,
    name,
    first: firstMs === null ? null : new Date(firstMs).toISOString().slice(0, 10),
    last: activeNow || lastMs === null ? null : new Date(lastMs).toISOString().slice(0, 10),
    maxDistM,
    maxOverlapDays,
    flags,
    score: flags.reduce((s, f) => s + FLAG_INFO[f].weight, 0),
  }
}

/** Monthly rides per member (`s:<id>` → `YYYY-MM` → count). */
export type MemberSeries = Map<string, Map<string, number>>

export interface CoActivity {
  /** Months where ≥2 members each carried ≥ `share` of the cluster's rides
   *  (and ≥ `floor` rides): the ride-level evidence of two live docks. */
  months: string[]
  /** Months where the materialized `c:` row ≠ Σ members (should be none). */
  sumMismatches: { month: string, canon: number, members: number }[]
}

export function coActivity(
  series: MemberSeries,
  canonSeries: Map<string, number> | null,
  { share = 0.1, floor = 20 }: { share?: number, floor?: number } = {},
): CoActivity {
  const months = new Set<string>()
  for (const s of series.values()) for (const m of s.keys()) months.add(m)
  if (canonSeries) for (const m of canonSeries.keys()) months.add(m)
  const coMonths: string[] = []
  const sumMismatches: CoActivity['sumMismatches'] = []
  for (const month of [...months].sort()) {
    const counts = [...series.values()].map((s) => s.get(month) ?? 0)
    const total = counts.reduce((a, b) => a + b, 0)
    const live = counts.filter((c) => c >= floor && c >= share * total).length
    if (live >= 2) coMonths.push(month)
    if (canonSeries) {
      const canon = canonSeries.get(month) ?? 0
      if (canon !== total) sumMismatches.push({ month, canon, members: total })
    }
  }
  return { months: coMonths, sumMismatches }
}
