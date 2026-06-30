/** `/health` — GBFS pipeline health overview.
 *
 *  Backed by a single `/api/health` snapshot endpoint on the worker.
 *  See `specs/gbfs-health-page.md`. */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

// Default to prod worker so `pnpm dev` works without a local api.
// Override at build/dev time with `VITE_API_BASE=http://localhost:51896 pnpm dev`.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

interface FeedHealth {
  latestPoll: { key: string; date: string; time: string; uploadedAt: string } | null
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
interface PyramidShardStatus {
  tier: string
  shardDur: string
  shardCount: number
  earliestPeriodStart: string | null
  latestPeriodEnd: string | null
  watermarkEnd: string | null
}
interface PyramidStatus {
  name: string
  tiers: Array<{
    tier: string
    bin: string
    shards: PyramidShardStatus[]
  }>
}
type PyramidsHealth = PyramidStatus[]
interface HealthSnapshot {
  generatedAt: number
  feed: FeedHealth
  compactions: CompactionHealth
  cascade: CascadeHealth
  pyramids: PyramidsHealth
  tripdata: TripdataHealth | null
}

async function fetchHealth(): Promise<HealthSnapshot> {
  const res = await fetch(`${API_BASE}/api/health`)
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
      <PyramidsSection pyramids={data.pyramids} />
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

function FeedSection({ feed }: { feed: FeedHealth }) {
  const todayPct = feed.todayCount / feed.todayExpected
  const ok = todayPct >= 0.98
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

function PyramidsSection({ pyramids }: { pyramids: PyramidsHealth | undefined }) {
  if (!pyramids || pyramids.length === 0) {
    return (
      <Section title="Avail-v3 / Rides-v3 pyramids">
        <div style={{ opacity: 0.6, fontSize: '0.9em' }}>
          No pyramid data — D1 unreachable or empty.
        </div>
      </Section>
    )
  }
  return (
    <Section title="Avail-v3 / Rides-v3 pyramids">
      {pyramids.map((p) => <PyramidGrid key={p.name} pyramid={p} />)}
      <div style={{ marginTop: '0.4em', fontSize: '0.8em', opacity: 0.7 }}>
        n = shard count · <span style={{ color: 'salmon' }}>∅</span> = no shards yet ·
        <span style={{ color: 'rgba(127,127,127,0.4)' }}> ·</span> = no rung at this column
      </div>
    </Section>
  )
}

function PyramidGrid({ pyramid }: { pyramid: PyramidStatus }) {
  // Union of all shard durs across tiers, ordered by their min duration.
  const allDurs = new Set<string>()
  pyramid.tiers.forEach((t) => t.shards.forEach((s) => allDurs.add(s.shardDur)))
  const durs = Array.from(allDurs).sort((a, b) => durMin(a) - durMin(b))

  const cellMap = new Map<string, PyramidShardStatus>()
  pyramid.tiers.forEach((t) => t.shards.forEach((s) => cellMap.set(`${t.tier}|${s.shardDur}`, s)))

  return (
    <div style={{ marginBottom: '1em' }}>
      <div style={{ fontWeight: 600, marginBottom: '0.3em' }}>{pyramid.name}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.85em', fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              <th style={cellStyle('left')}>tier \ shard</th>
              {durs.map((d) => <th key={d} style={cellStyle('center')}>{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {pyramid.tiers.map((t) => (
              <tr key={t.tier}>
                <td style={{ ...cellStyle('left'), fontWeight: 600 }}>/{t.tier}</td>
                {durs.map((d) => {
                  const s = cellMap.get(`${t.tier}|${d}`)
                  if (s === undefined) {
                    return <td key={d} style={cellStyle('center', 'rgba(127,127,127,0.25)')}>·</td>
                  }
                  if (s.shardCount === 0) {
                    return <td key={d} style={cellStyle('center', 'salmon')} title="rung declared but no shards yet">∅</td>
                  }
                  const wmHint = s.watermarkEnd ? `watermark ${s.watermarkEnd.slice(0, 16)}` : ''
                  const latestHint = s.latestPeriodEnd ? `latest ${s.latestPeriodEnd.slice(0, 16)}` : ''
                  const title = [wmHint, latestHint].filter(Boolean).join(' · ')
                  return (
                    <td key={d} style={cellStyle('center')} title={title}>
                      {s.shardCount}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Parse a pyrmts Duration string (`5min`, `1h`, `1d`, `4320d`) to
 *  minutes. Used to sort shard-dur columns. */
function durMin(d: string): number {
  const m = /^(\d+)(min|h|d|y)$/.exec(d)
  if (!m) return Number.MAX_SAFE_INTEGER
  const n = Number(m[1])
  const unit = m[2]
  return unit === 'min' ? n : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n * 1440 * 365
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
