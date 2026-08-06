/** `/health` — GBFS pipeline health overview.
 *
 *  Backed by a single `/api/health` snapshot endpoint on the worker.
 *  See `specs/gbfs-health-page.md`. */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Tooltip } from '@mui/material'
import type { CSSProperties } from 'react'

// Default to prod worker so `pnpm dev` works without a local api.
// Override at build/dev time with `VITE_API_BASE=http://localhost:51896 pnpm dev`.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

interface FeedDrift {
  latestS: number
  ts: number
  polledAt: number
  series: Array<[number, number]>  // [polled_at epoch s, drift s], ≤24h, oldest first
}
interface FeedHealth {
  latestPoll: { key: string; date: string; time: string; uploadedAt: string } | null
  drift: FeedDrift | null
  todayCount: number
  todayExpected: number
  last7Days: Array<{ date: string; count: number; expected: number }>
}
interface CompactionHealth {
  daily: { latestDate: string | null; count: number }
  hourly: { latestKey: string | null; todayCount: number }
}
interface CascadeCell {
  agg: string
  cons: string
  shardCount: number
  latestKey: string | null
  latestUploadedAt: string | null
}
interface CascadeHealth {
  cells: CascadeCell[]
  expectedCells: Array<{ agg: string; cons: string; deployed: boolean }>
}
interface TripdataHealth {
  generatedAt: string | null
  latestZip: string | null
  latestMonth: string | null
  recentMonths: string[]
  totalZips: number
}
interface PyramidCoverRung {
  shardDur: string
  role: 'max' | 'dust'
  expected: number
  present: number
  pending: number
}
interface PyramidCoverSegment {
  start: string
  end: string
  shardDur: string
  status: 'present' | 'pending' | 'missing'
  key?: string
  bytes?: number      // R2 object size (snapshot enrichment; present segments)
}
interface PyramidTierCoverStatus {
  tier: string
  bin: string
  maxRung: string
  rungs: PyramidCoverRung[]
  segments: PyramidCoverSegment[]
  totalExpected: number
  totalPresent: number
  totalPending: number
  complete: boolean
  firstMissingPeriod: string | null
  lastMaxBoundary: string
  dustAgeSec: number
  staleShardCount: number
}
interface PyramidCoverStatus {
  name: string
  genesis: string
  now: string
  tiers: PyramidTierCoverStatus[]
  totalMissing: number
  totalPending: number
  totalStale: number
  allComplete: boolean
}
type PyramidsHealth = PyramidCoverStatus[]
interface BuildLayer {
  tier: string
  rung: string
  scaffold: boolean
  n: number
  done?: number
  wallS?: number
  status?: Record<string, number>
}
interface BuildProgress {
  pyramid: string
  driver: string
  startedAt: string
  updatedAt?: string
  status: 'running' | 'done' | 'bounced'
  plan: { layers: number; invocations: number; scaffolds: number }
  byStatus: Record<string, number>
  layers: BuildLayer[]
  currentLayer: BuildLayer | null
}
interface HealthSnapshot {
  generatedAt: number
  feed: FeedHealth
  compactions: CompactionHealth
  cascade: CascadeHealth
  pyramids: PyramidsHealth
  defaultPyramid?: string
  tripdata: TripdataHealth | null
  builds?: BuildProgress[]
}

async function fetchHealth(): Promise<HealthSnapshot> {
  // `?live=1` forwards to the API's cache-bypass (live recompute) — for
  // verifying snapshot-shape changes before the prod cron picks them up.
  const live = new URLSearchParams(window.location.search).get('live')
  const res = await fetch(`${API_BASE}/api/health${live === '1' ? '?live=1' : ''}`)
  if (!res.ok) throw new Error(`health: ${res.status}`)
  return res.json()
}

function fmtAge(unixSec: number): string {
  const ageSec = Math.floor(Date.now() / 1000) - unixSec
  if (ageSec < 90) return `${ageSec}s ago`
  if (ageSec < 5400) return `${Math.floor(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`
  return `${Math.floor(ageSec / 86400)}d ago`
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return '0%'
  return `${(100 * num / denom).toFixed(1)}%`
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function Health() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['gbfs-health'],
    queryFn: fetchHealth,
    refetchInterval: 60_000, // refresh every minute
    staleTime: 30_000,
  })

  if (isLoading) return <Page><Loading /></Page>
  if (error) return <Page><Err msg={String(error)} /></Page>
  if (!data) return <Page><Err msg="no data" /></Page>

  return (
    <Page>
      <h1 style={{ fontSize: '1.6em', margin: '0 0 0.5em' }}>GBFS pipeline health</h1>
      <TripdataSection tripdata={data.tripdata} />
      <FeedSection feed={data.feed} />
      <CompactionsSection compactions={data.compactions} />
      <BuildsSection builds={data.builds} />
      <PyramidsSection pyramids={data.pyramids} defaultPyramid={data.defaultPyramid} />
      <CascadeSection cascade={data.cascade} />
      <BrowseSection feed={data.feed} compactions={data.compactions} />
      <FooterMeta generatedAt={data.generatedAt} />
    </Page>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      maxWidth: 1100,
      margin: '0 auto',
      padding: '1.5em 1.5em 3em',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  )
}

function Loading() { return <div style={{ opacity: 0.6 }}>loading health snapshot…</div> }
function Err({ msg }: { msg: string }) { return <div style={{ color: 'salmon' }}>error: {msg}</div> }

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '1.5em' }}>
      <h2 style={{ fontSize: '1.15em', margin: '0 0 0.4em', borderBottom: '1px solid rgba(127,127,127,0.25)', paddingBottom: '0.2em' }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function fmtMonth(yyyymm: string): string {
  const y = yyyymm.slice(0, 4), m = yyyymm.slice(4)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[parseInt(m, 10) - 1]} ${y}`
}

function monthsSince(yyyymm: string): number {
  const y = parseInt(yyyymm.slice(0, 4), 10), m = parseInt(yyyymm.slice(4), 10)
  const now = new Date()
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m)
}

function TripdataSection({ tripdata }: { tripdata: TripdataHealth | null }) {
  if (!tripdata || !tripdata.latestMonth) {
    return (
      <Section title="Tripdata (upstream s3://tripdata)">
        <div style={{ opacity: 0.6 }}>no summary yet — waiting for `tripdata.yml` to refresh</div>
      </Section>
    )
  }
  const since = monthsSince(tripdata.latestMonth)
  // Citi Bike publishes new months around the 10th–15th of the following
  // month, so 1 month behind UTC-now is normal; ≥2 months is suspicious.
  const status: 'ok' | 'warn' | 'bad' = since <= 1 ? 'ok' : since === 2 ? 'warn' : 'bad'
  const refreshAge = tripdata.generatedAt
    ? fmtAge(Math.floor(new Date(tripdata.generatedAt).getTime() / 1000))
    : null
  return (
    <Section title="Tripdata (upstream s3://tripdata)">
      <div style={{ display: 'flex', gap: '2em', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Stat
          label="Latest month"
          value={fmtMonth(tripdata.latestMonth)}
          sub={since === 0 ? 'current month' : since === 1 ? '1 month behind' : `${since} months behind`}
          status={status}
        />
        <Stat
          label="Latest file"
          value={tripdata.latestZip ?? '—'}
          sub={`${tripdata.totalZips} zips tracked`}
          status="ok"
        />
        {refreshAge && (
          <Stat
            label="Summary refreshed"
            value={refreshAge}
            sub="from `tripdata.yml`"
            status="ok"
          />
        )}
      </div>
    </Section>
  )
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[i]
}

/** Tiny inline sparkline of `[t, v]` points (drift seconds over 24h). */
function DriftSparkline({ series }: { series: Array<[number, number]> }) {
  const W = 180, H = 34, PAD = 2
  if (series.length < 2) return null
  const ts = series.map(([t]) => t)
  const vs = series.map(([, v]) => v)
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)]
  const vMax = Math.max(60, ...vs)  // floor the scale at 60s so quiet days don't look noisy
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD)
  const y = (v: number) => H - PAD - (Math.max(0, v) / vMax) * (H - 2 * PAD)
  const path = series.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <Tooltip title={`feed drift over last 24h (${series.length} polls); scale max ${vMax}s`} arrow>
      <svg width={W} height={H} style={{ display: 'block', opacity: 0.9 }}>
        <line x1={PAD} x2={W - PAD} y1={y(60)} y2={y(60)} stroke="#888" strokeDasharray="3 3" strokeWidth={0.5} />
        <path d={path} fill="none" stroke="#6699cc" strokeWidth={1.2} />
      </svg>
    </Tooltip>
  )
}

function FeedSection({ feed }: { feed: FeedHealth }) {
  const todayPct = feed.todayCount / feed.todayExpected
  const ok = todayPct >= 0.98
  const drift = feed.drift
  const driftSorted = drift ? [...drift.series.map(([, v]) => v)].sort((a, b) => a - b) : []
  return (
    <Section title="Feed (per-minute WAL polls)">
      <div style={{ display: 'flex', gap: '2em', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Stat
          label="Latest poll"
          value={feed.latestPoll ? `${feed.latestPoll.date} ${feed.latestPoll.time} UTC` : '—'}
          sub={feed.latestPoll ? fmtAge(Math.floor(new Date(feed.latestPoll.uploadedAt).getTime() / 1000)) : ''}
          status={feed.latestPoll ? 'ok' : 'bad'}
        />
        <Stat
          label="Today"
          value={`${feed.todayCount} / ${feed.todayExpected}`}
          sub={fmtPct(feed.todayCount, feed.todayExpected)}
          status={ok ? 'ok' : 'warn'}
        />
        {drift && (
          <Tooltip title="poll wall-clock minus the feed's own last_updated — how stale the GBFS payload was when we fetched it" arrow>
            <span>
              <Stat
                label="Feed drift"
                value={`${drift.latestS}s`}
                sub={driftSorted.length ? `24h p50 ${quantile(driftSorted, 0.5)}s · p95 ${quantile(driftSorted, 0.95)}s` : ''}
                status={drift.latestS < 120 ? 'ok' : drift.latestS < 300 ? 'warn' : 'bad'}
              />
            </span>
          </Tooltip>
        )}
        {drift && <DriftSparkline series={drift.series} />}
      </div>
      <div style={{ marginTop: '0.6em' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9em' }}>
          <thead>
            <tr style={{ opacity: 0.6 }}>
              <th style={cellStyle('left')}>Date</th>
              <th style={cellStyle('right')}>Count</th>
              <th style={cellStyle('right')}>Expected</th>
              <th style={cellStyle('right')}>%</th>
              <th style={cellStyle('left')}>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {feed.last7Days.map((d) => {
              const pct = d.count / d.expected
              return (
                <tr key={d.date}>
                  <td style={cellStyle('left')}>{d.date}</td>
                  <td style={cellStyle('right')}>{d.count}</td>
                  <td style={cellStyle('right')}>{d.expected}</td>
                  <td style={cellStyle('right', pct >= 0.99 ? 'inherit' : pct >= 0.95 ? '#cc9933' : 'salmon')}>
                    {fmtPct(d.count, d.expected)}
                  </td>
                  <td style={cellStyle('left')}>
                    <Bar pct={pct} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

function CompactionsSection({ compactions }: { compactions: CompactionHealth }) {
  const today = todayUtc()
  return (
    <Section title="Compactions">
      <div style={{ display: 'flex', gap: '2em', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Stat
          label="Daily compactions"
          value={compactions.daily.latestDate ?? '—'}
          sub={`${compactions.daily.count} files`}
          status={compactions.daily.latestDate ? 'ok' : 'bad'}
        />
        <Stat
          label="Hourly today"
          value={compactions.hourly.latestKey ? compactions.hourly.latestKey.match(/(\d{2})\.parquet$/)?.[1] ?? '—' : '—'}
          sub={`${compactions.hourly.todayCount} / 24 hours so far today (${today})`}
          status={compactions.hourly.todayCount > 0 ? 'ok' : 'warn'}
        />
      </div>
    </Section>
  )
}

function BuildsSection({ builds }: { builds: BuildProgress[] | undefined }) {
  if (!builds || builds.length === 0) return null
  return (
    <Section title="Pyramid builds">
      {builds.map((b) => <BuildCard key={`${b.pyramid}-${b.startedAt}`} build={b} />)}
    </Section>
  )
}

/** Terminal builds older than this render as a dim one-line history
 *  entry — a day-old BOUNCED banner reads as a live alarm when in fact
 *  the steady-state tick already superseded whatever bounced. */
const BUILD_STALE_MS = 6 * 3600_000

function BuildCard({ build }: { build: BuildProgress }) {
  const done = Object.values(build.byStatus ?? {}).reduce((a, n) => a + n, 0)
  const total = build.plan?.invocations ?? 0
  const frac = total > 0 ? done / total : 0
  const wrote = build.byStatus?.wrote ?? 0
  const errors = (build.byStatus?.error ?? 0) + (build.byStatus?.no_inputs ?? 0)
  const updatedSec = build.updatedAt ? Math.floor(Date.parse(build.updatedAt) / 1000) : null
  const color = build.status === 'done' ? '#2e7d32' : build.status === 'bounced' ? '#c62828' : '#1565c0'
  const cur = build.currentLayer
  const stale = build.status !== 'running'
    && updatedSec !== null && Date.now() - updatedSec * 1000 > BUILD_STALE_MS
  if (stale) {
    return (
      <div style={{ marginBottom: '0.4em', fontSize: '0.85em', opacity: 0.55, display: 'flex', gap: '0.6em', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600 }}>{build.pyramid}</span>
        <span>{build.driver}</span>
        <span style={{ color, fontWeight: 600, textTransform: 'uppercase', fontSize: '0.85em' }}>{build.status}</span>
        <span>{done}/{total} · {wrote} wrote{errors > 0 ? ` · ${errors} bounced` : ''}</span>
        <span>{fmtAge(updatedSec)}</span>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: '1em' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8em', marginBottom: '0.3em' }}>
        <span style={{ fontWeight: 600, fontSize: '1.05em' }}>{build.pyramid}</span>
        <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{build.driver}</span>
        <span style={{
          fontSize: '0.75em', fontWeight: 600, color: '#fff', background: color,
          borderRadius: '0.6em', padding: '0.1em 0.6em', textTransform: 'uppercase',
        }}>{build.status}</span>
        <span style={{ fontSize: '0.85em', opacity: 0.8 }}>
          {done}/{total} invocations ({fmtPct(done, total)}) · {wrote} wrote
          {errors > 0 ? ` · ${errors} bounced` : ''}
        </span>
        {updatedSec !== null && (
          <span style={{ fontSize: '0.8em', opacity: 0.6 }}>updated {fmtAge(updatedSec)}</span>
        )}
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--bar-bg, #e0e0e044)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, 100 * frac).toFixed(1)}%`, height: '100%', background: color }} />
      </div>
      <div style={{ marginTop: '0.25em', fontSize: '0.8em', opacity: 0.75 }}>
        {build.layers.length}/{build.plan?.layers ?? '?'} layers done
        {cur ? <> · current: <code>/{cur.tier}@{cur.rung}</code>{cur.scaffold ? ' [scaffold]' : ''} ({cur.done ?? 0}/{cur.n})</> : null}
      </div>
    </div>
  )
}

function PyramidsSection({ pyramids, defaultPyramid }: { pyramids: PyramidsHealth | undefined, defaultPyramid?: string }) {
  if (!pyramids || pyramids.length === 0) {
    return (
      <Section title="Pyramid min-cover status">
        <div style={{ opacity: 0.6, fontSize: '0.9em' }}>
          No pyramid data — D1 unreachable or empty.
        </div>
      </Section>
    )
  }
  // Prod-default pyramid full-size; non-default pyramids collapse into
  // <details> — burn-in successors ABOVE the primary (they're what's
  // coming next), legacy below. Version ordering rides the lexical name
  // ('avail' < 'avail-v5' < 'avail-v6').
  const dflt = defaultPyramid ?? 'avail-v5'
  const primary = pyramids.find((p) => p.name === dflt)
  const successors = pyramids.filter((p) => p.name > dflt).sort((a, b) => b.name.localeCompare(a.name))
  const legacy = pyramids.filter((p) => p.name !== dflt && p.name <= dflt)
  const collapsed = (p: PyramidCoverStatus, label: string) => (
    <details key={p.name} style={{ marginBottom: '0.8em' }}>
      <summary style={{ cursor: 'pointer', opacity: 0.75, fontSize: '0.9em' }}>
        <code>{p.name}</code> ({label}) ·{' '}
        {p.allComplete ? 'complete' : `${p.totalMissing} missing`}
      </summary>
      <div style={{ marginTop: '0.6em' }}>
        <PyramidCoverGrid pyramid={p} />
      </div>
    </details>
  )
  return (
    <Section title="Pyramid min-cover status">
      {successors.map((p) => collapsed(p, 'successor — burn-in'))}
      {primary && <PyramidCoverGrid pyramid={primary} />}
      {legacy.map((p) => collapsed(p, 'legacy'))}
      <div style={{ marginTop: '0.6em', fontSize: '0.8em', opacity: 0.7, lineHeight: 1.5 }}>
        Equilibrium per tier = <em>min-cover</em> of{' '}
        <code>[genesis, now)</code>: mostly max-rung tiles filling{' '}
        <code>[genesis, floor(now, max_rung))</code>, plus a small "dust" of
        finer-rung tiles filling <code>[floor(now, max_rung), now)</code>.
        Every max-rung boundary, the CFW consolidates the current dust into
        one new max-rung tile; the finer tiles it replaces become <em>stale</em>{' '}
        (GC candidates, never re-enter the cover).
      </div>
    </Section>
  )
}

function PyramidCoverGrid({ pyramid }: { pyramid: PyramidCoverStatus }) {
  const genesisD = pyramid.genesis.slice(0, 10)
  const nowD = pyramid.now.slice(0, 16).replace('T', ' ')
  return (
    <div style={{ marginBottom: '1.2em' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8em', marginBottom: '0.3em' }}>
        <span style={{ fontWeight: 600, fontSize: '1.05em' }}>{pyramid.name}</span>
        <StatusBadge complete={pyramid.allComplete} />
        {pyramid.allComplete ? (
          <span style={{ fontSize: '0.85em', opacity: 0.75 }}>
            CFW is maintaining a full min-cover at every tier.
          </span>
        ) : (
          <span style={{ fontSize: '0.85em', color: 'salmon' }}>
            {pyramid.totalMissing} missing shards across{' '}
            {pyramid.tiers.filter((t) => !t.complete).length} of {pyramid.tiers.length} tiers.
          </span>
        )}
        {pyramid.totalStale > 0 && (
          <span style={{ fontSize: '0.85em', opacity: 0.55 }}>
            · {pyramid.totalStale} stale (GC)
          </span>
        )}
      </div>
      <div style={{ fontSize: '0.8em', opacity: 0.6, marginBottom: '0.4em' }}>
        genesis <code>{genesisD}</code> · now <code>{nowD} UTC</code>
      </div>
      <CoverBars pyramid={pyramid} />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.85em', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th style={cellStyle('left')}>tier</th>
              <th style={cellStyle('center')}>status</th>
              <th style={cellStyle('right')}>max rung</th>
              <th style={cellStyle('center')}>max present / expected</th>
              <th style={cellStyle('left')}>dust (rung × present/expected)</th>
              <th style={cellStyle('right')}>dust age</th>
              <th style={cellStyle('right')}>stale</th>
              <th style={cellStyle('left')}>first missing</th>
            </tr>
          </thead>
          <tbody>
            {pyramid.tiers.map((t) => <PyramidTierRow key={t.tier} tier={t} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const SEGMENT_COLORS: Record<PyramidCoverSegment['status'], string> = {
  present: '#2e9e44',
  pending: '#d9a13b',
  missing: '#e05252',
}

/** Cross-hatch for bar regions where no shard is expected (the tail
 *  shorter than the tier's smallest rung — finer tiers cover it). */
const HATCH_BG = 'repeating-linear-gradient(45deg, transparent 0 3px, rgba(127,127,127,0.35) 3px 4px)'

const DUR_UNIT_MIN: Record<string, number> = { min: 1, h: 60, d: 1440 }

/** Fixed-width duration (`1min` / `12h` / `16d`) → minutes; null on
 *  anything else (calendar units never appear in the avail ladders). */
function durMin(d: string): number | null {
  const m = /^(\d+)(min|h|d)$/.exec(d)
  return m ? Number(m[1]) * DUR_UNIT_MIN[m[2]] : null
}

function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`
  const units = ['kB', 'MB', 'GB']
  let v = n / 1000
  for (const u of units) {
    if (v < 1000) return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u}`
    v /= 1000
  }
  return `${v.toFixed(1)} TB`
}

/** Lazy shard parquet metadata (row/RG counts) — fetched on first
 *  tooltip open via ranged reads of the parquet footer, cached forever
 *  (shards are immutable). */
function useShardMeta(key: string | undefined) {
  return useQuery({
    queryKey: ['shard-meta', key],
    enabled: !!key,
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      const [{ asyncBufferFromStore }, { HttpStore }, { parquetMetadataAsync }] = await Promise.all([
        import('@rdub/file-tree/react'),
        import('@rdub/file-tree/stores/http'),
        import('hyparquet'),
      ])
      const store = HttpStore(`${API_BASE}/api/files`)
      const file = await asyncBufferFromStore(store, key!)
      const md = await parquetMetadataAsync(file)
      return { rows: Number(md.num_rows), rowGroups: md.row_groups.length, bytes: file.byteLength }
    },
  })
}

const TIP_ROW: CSSProperties = { display: 'flex', gap: '0.7em', justifyContent: 'space-between' }

/** Tooltip body for one cover slot: rung + span + status, #bins, size,
 *  and (lazily) row/row-group counts read from the parquet footer. */
function ShardTip({ tier, seg }: { tier: PyramidTierCoverStatus; seg: PyramidCoverSegment }) {
  const meta = useShardMeta(seg.key)
  const bin = durMin(tier.bin)
  const dur = durMin(seg.shardDur)
  const bins = bin && dur ? Math.round(dur / bin) : null
  const span = `${seg.start.slice(0, 16).replace('T', ' ')} → ${seg.end.slice(0, 16).replace('T', ' ')} UTC`
  return (
    <div style={{ fontSize: '0.95em', fontVariantNumeric: 'tabular-nums', minWidth: '15em' }}>
      <div style={{ fontWeight: 600, marginBottom: '0.2em' }}>
        <code>/{tier.tier}@{seg.shardDur}</code>{' · '}{seg.status}
      </div>
      <div style={{ opacity: 0.85, marginBottom: '0.35em' }}>{span}</div>
      {bins !== null && <div style={TIP_ROW}><span>bins</span><span>{bins.toLocaleString()}</span></div>}
      {seg.bytes !== undefined && <div style={TIP_ROW}><span>size</span><span>{fmtBytes(seg.bytes)}</span></div>}
      {seg.key && (
        meta.data ? (
          <>
            <div style={TIP_ROW}><span>rows</span><span>{meta.data.rows.toLocaleString()}</span></div>
            <div style={TIP_ROW}><span>row groups</span><span>{meta.data.rowGroups.toLocaleString()}</span></div>
          </>
        ) : meta.isError ? (
          <div style={{ opacity: 0.6 }}>rows: unavailable</div>
        ) : (
          <div style={{ opacity: 0.6 }}>reading footer…</div>
        )
      )}
      {seg.key && <div style={{ opacity: 0.6, marginTop: '0.35em' }}>click to preview</div>}
    </div>
  )
}

/** Per-tier horizontal timeline bars over `[genesis, now]`: one bar per
 *  tier, one box per min-cover slot (so tile boundaries are visible),
 *  green/grey/red for present/pending/missing, hairline gaps between
 *  slots, unified month ticks on top. */
function CoverBars({ pyramid }: { pyramid: PyramidCoverStatus }) {
  const t0 = Date.parse(pyramid.genesis)
  const t1 = Date.parse(pyramid.now)
  const span = t1 - t0
  if (!(span > 0)) return null
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - t0) / span * 100))

  // Month boundaries within (genesis, now] — unified x-ticks.
  const ticks: Array<{ ms: number; label: string }> = []
  const d = new Date(t0)
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0)
  d.setUTCMonth(d.getUTCMonth() + 1)
  while (d.getTime() < t1) {
    ticks.push({
      ms: d.getTime(),
      label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
    })
    d.setUTCMonth(d.getUTCMonth() + 1)
  }

  const LABEL_W = '3.2em'
  return (
    <div style={{ margin: '0.5em 0 1em', fontSize: '0.85em' }}>
      {/* Tick labels + hairlines */}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ width: LABEL_W, flexShrink: 0 }} />
        <div style={{ position: 'relative', flex: 1, height: '1.3em' }}>
          {ticks.map((tk) => (
            <span key={tk.ms} style={{
              position: 'absolute', left: `${pct(tk.ms)}%`,
              transform: 'translateX(-50%)',
              fontSize: '0.85em', opacity: 0.6,
            }}>{tk.label}</span>
          ))}
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        {/* Vertical month gridlines behind the bars */}
        <div style={{ position: 'absolute', left: LABEL_W, right: 0, top: 0, bottom: 0, pointerEvents: 'none' }}>
          {ticks.map((tk) => (
            <div key={tk.ms} style={{
              position: 'absolute', left: `${pct(tk.ms)}%`, top: 0, bottom: 0,
              width: 1, background: 'rgba(127,127,127,0.3)',
            }} />
          ))}
        </div>
        {pyramid.tiers.map((t) => {
          const lastEnd = t.segments.reduce((mx, s) => Math.max(mx, Date.parse(s.end)), t0)
          const tailL = pct(lastEnd)
          return (
            <div key={t.tier} style={{ display: 'flex', alignItems: 'center', marginBottom: 3 }}>
              <div style={{ width: LABEL_W, flexShrink: 0, fontFamily: 'monospace', fontSize: '0.85em', opacity: 0.8 }}>
                /{t.tier}
              </div>
              <div style={{ position: 'relative', flex: 1, height: 13, background: 'rgba(127,127,127,0.12)', borderRadius: 2, overflow: 'hidden' }}>
                {/* No-shard-expected tail (shorter than this tier's smallest rung). */}
                {tailL < 100 && (
                  <div style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: `${tailL}%`, right: 0,
                    background: HATCH_BG,
                  }} />
                )}
                {t.segments.map((s, i) => {
                  const l = pct(Date.parse(s.start))
                  const r = pct(Date.parse(s.end))
                  const seg = (
                    <Tooltip title={<ShardTip tier={t} seg={s} />} placement="top" arrow enterDelay={150}>
                      <div
                        style={{
                          position: 'absolute', top: 0, bottom: 0,
                          left: `${l}%`, width: `${Math.max(0, r - l)}%`,
                          background: SEGMENT_COLORS[s.status],
                          boxShadow: 'inset 1px 0 0 rgba(255,255,255,0.85)',
                          ...(s.key ? { cursor: 'pointer' } : {}),
                        }}
                      />
                    </Tooltip>
                  )
                  // Present segments deep-link into the /files browser's
                  // parquet viewer (paginated table of the R2 object).
                  return s.key ? <Link key={i} to={`/files/${s.key}`}>{seg}</Link> : <span key={i}>{seg}</span>
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.2em 1.2em', marginTop: '0.3em', marginLeft: LABEL_W, fontSize: '0.8em', opacity: 0.75 }}>
        <span><Swatch color={SEGMENT_COLORS.present} /> present</span>
        <span><Swatch color={SEGMENT_COLORS.pending} /> pending (just closed; cron writes shortly)</span>
        <span><Swatch color={SEGMENT_COLORS.missing} /> missing</span>
        <span><Swatch color={HATCH_BG} /> no shard expected (tail shorter than this tier's smallest rung; finer tiers cover it)</span>
      </div>
    </div>
  )
}

function Swatch({ color }: { color: string }) {
  return <span style={{
    display: 'inline-block', width: 10, height: 10, background: color,
    borderRadius: 2, marginRight: 4, verticalAlign: 'baseline',
  }} />
}

function PyramidTierRow({ tier }: { tier: PyramidTierCoverStatus }) {
  const maxRung = tier.rungs.find((r) => r.role === 'max')
  const dust = tier.rungs.filter((r) => r.role === 'dust')
  const maxPresent = maxRung?.present ?? 0
  const maxExpected = maxRung?.expected ?? 0
  // Pending (just-closed, cron hasn't written yet) renders grey; only a
  // real gap goes salmon.
  const rungColor = (r: PyramidCoverRung): string | undefined =>
    r.present === r.expected ? undefined :
    r.present + r.pending === r.expected ? 'rgba(127,127,127,0.9)' :
    'salmon'
  return (
    <tr>
      <td style={{ ...cellStyle('left'), fontWeight: 600 }}>/{tier.tier}</td>
      <td style={cellStyle('center')}><StatusBadge complete={tier.complete} compact /></td>
      <td style={cellStyle('right')}><code>{tier.maxRung}</code></td>
      <td style={{ ...cellStyle('center'), color: maxRung ? rungColor(maxRung) : undefined }}>
        {maxPresent} / {maxExpected}
      </td>
      <td style={cellStyle('left')}>
        {dust.length === 0 ? (
          <span style={{ opacity: 0.4 }}>—</span>
        ) : (
          dust.map((r, i) => (
            <span key={r.shardDur} style={{ marginRight: i === dust.length - 1 ? 0 : '0.75em' }}>
              <code>{r.shardDur}</code>{' '}
              <span style={{ color: rungColor(r) }}>
                {r.present}/{r.expected}
              </span>
            </span>
          ))
        )}
      </td>
      <td style={cellStyle('right')} title={`last max boundary: ${tier.lastMaxBoundary.slice(0, 16).replace('T', ' ')} UTC`}>
        {fmtDur(tier.dustAgeSec)}
      </td>
      <td style={{ ...cellStyle('right'), opacity: tier.staleShardCount === 0 ? 0.4 : 1 }}>
        {tier.staleShardCount}
      </td>
      <td style={{ ...cellStyle('left'), color: tier.firstMissingPeriod ? 'salmon' : undefined, opacity: tier.firstMissingPeriod ? 1 : 0.4 }}>
        {tier.firstMissingPeriod ? tier.firstMissingPeriod.slice(0, 16).replace('T', ' ') : '—'}
      </td>
    </tr>
  )
}

function StatusBadge({ complete, compact }: { complete: boolean; compact?: boolean }) {
  const color = complete ? '#5fbf5f' : 'salmon'
  const symbol = complete ? '✓' : '✗'
  return (
    <span style={{
      color,
      fontWeight: 700,
      fontSize: compact ? '1em' : '1.1em',
    }}>{symbol}</span>
  )
}

/** Format a duration in seconds as "1d 4h", "3h 12m", "42m", "13s". */
function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm > 0 ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh > 0 ? `${d}d ${hh}h` : `${d}d`
}

function CascadeSection({ cascade }: { cascade: CascadeHealth }) {
  // Legacy ymdgtb cascade pyramid (rides v1/v2). Pivot cells into
  // tier × shard grid (= old agg × cons; renamed in the UI to match
  // the unified-ladder vocabulary used by the new pyramids section).
  const tiers = ['1m', '5m', '15m', '1h', '1d']
  const shards = ['1m', '5m', '15m', '1h', '3h', '8h', '1d', '3d', '1w', '10d', '1mo', '2mo', '3mo', '5d', '1y', '3y']
  const cellMap = new Map<string, CascadeCell>()
  cascade.cells.forEach((c) => cellMap.set(`${c.agg}|${c.cons}`, c))
  const expectedMap = new Map<string, boolean>()
  cascade.expectedCells.forEach((e) => expectedMap.set(`${e.agg}|${e.cons}`, e.deployed))

  // Filter to columns that have any expected entry.
  const activeShards = shards.filter((s) => tiers.some((t) => expectedMap.has(`${t}|${s}`)))

  return (
    <Section title="Legacy cascade (rides v1/v2)">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.85em', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th style={cellStyle('left')}>tier \ shard</th>
              {activeShards.map((c) => <th key={c} style={cellStyle('center')}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t}>
                <td style={{ ...cellStyle('left'), fontWeight: 600 }}>{t}</td>
                {activeShards.map((s) => {
                  const key = `${t}|${s}`
                  const cell = cellMap.get(key)
                  const deployed = expectedMap.get(key)
                  if (deployed === undefined) {
                    return <td key={s} style={cellStyle('center', 'rgba(127,127,127,0.25)')}>·</td>
                  }
                  if (!deployed) {
                    return <td key={s} style={cellStyle('center', 'rgba(127,127,127,0.4)')} title="specced (grid.yaml) but not deployed">○</td>
                  }
                  if (!cell || cell.shardCount === 0) {
                    return <td key={s} style={cellStyle('center', 'salmon')} title="deployed but no shards">∅</td>
                  }
                  return (
                    <td key={s} style={cellStyle('center')} title={cell.latestKey ?? ''}>
                      {cell.shardCount}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: '0.4em', fontSize: '0.8em', opacity: 0.7 }}>
        n = shard count · <span style={{ color: 'salmon' }}>∅</span> = deployed but empty ·
        <span style={{ color: 'rgba(127,127,127,0.6)' }}> ○</span> = specced (`grid.yaml`) but not deployed ·
        <span style={{ color: 'rgba(127,127,127,0.4)' }}> ·</span> = not in spec
      </div>
    </Section>
  )
}

function BrowseSection({ feed }: { feed: FeedHealth; compactions: CompactionHealth }) {
  const today = feed.latestPoll?.date ?? todayUtc()
  return (
    <Section title="Browse">
      <ul style={{ margin: 0, paddingLeft: '1.2em', lineHeight: 1.8 }}>
        <li><Link to={`/files/gbfs/status/${today}/`}>Today's WAL JSONs</Link> <Hint>raw minute polls</Hint></li>
        <li><Link to={`/files/gbfs/avail/agg=1m/cons=1m/${today}/`}>Today's cascade (1m@1m)</Link> <Hint>per-minute parquets</Hint></li>
        <li><Link to="/files/gbfs/status/">Daily compactions</Link> <Hint>parquet per day</Hint></li>
        <li><Link to={`/files/gbfs/avail/h1/${today}/`}>Today's hourly compactions</Link> <Hint>h1 parquets</Hint></li>
        <li><Link to="/files/">All files (root)</Link></li>
      </ul>
    </Section>
  )
}

function FooterMeta({ generatedAt }: { generatedAt: number }) {
  return (
    <div style={{ marginTop: '2em', fontSize: '0.8em', opacity: 0.6 }}>
      snapshot generated {fmtAge(generatedAt)} · refreshes every 60s
    </div>
  )
}

function Stat({ label, value, sub, status }: { label: string; value: string; sub?: string; status?: 'ok' | 'warn' | 'bad' }) {
  const color = status === 'ok' ? '#5db75d' : status === 'warn' ? '#cc9933' : status === 'bad' ? 'salmon' : undefined
  return (
    <div>
      <div style={{ fontSize: '0.75em', opacity: 0.65, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '1.1em', fontWeight: 600, color }}>{value}</div>
      {sub && <div style={{ fontSize: '0.85em', opacity: 0.75 }}>{sub}</div>}
    </div>
  )
}

function Bar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(1, pct)) * 120
  const color = pct >= 0.99 ? '#5db75d' : pct >= 0.95 ? '#cc9933' : 'salmon'
  return (
    <div style={{ display: 'inline-block', width: 120, height: 8, background: 'rgba(127,127,127,0.15)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: w, height: '100%', background: color }} />
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: '0.85em', opacity: 0.6 }}>— {children}</span>
}

function cellStyle(align: 'left' | 'right' | 'center', color?: string): React.CSSProperties {
  return {
    padding: '0.25em 0.7em',
    textAlign: align,
    borderBottom: '1px solid rgba(127,127,127,0.15)',
    color,
  }
}
