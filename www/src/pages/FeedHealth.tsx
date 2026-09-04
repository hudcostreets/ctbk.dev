/** `/health/feed` — GBFS feed metrics: observed-minute coverage and `last_updated` cadence,
 *  per day over the whole scraping history.
 *
 *  Backed by `/api/coverage` (one doc per UTC day, written by `ctbk gbfs empty build` from the
 *  empty-bitmap `observed` plane; see `specs/avail-empty-bitmaps.md` §9.2). Unlike the poll-file
 *  count on `/health`, this sees partial-feed minutes, and the lost-minute gaps + update-interval
 *  histogram tell a continuous outage from a sagging `last_updated` cadence. */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { Tip, TipRows } from '../components/Tip'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://ctbk-gbfs-api.ryan-0dc.workers.dev'

interface CoverageDay {
  day: string
  live: number
  observed_minutes: number
  gaps: Array<[number, number, number]>  // [start_minute, length, min_observed_count]
  /** Feed `last_updated` cadence (absent on docs written before it existed). */
  lu_updates?: number
  lu_per_hour?: number[]
  lu_skips_per_hour?: number[]
  lu_skips?: number
  lu_interval?: { p50: number; p99: number; max: number }
  lu_hist?: Record<string, number>       // interval seconds → count
}
interface CoverageRange { from: string; to: string; days: CoverageDay[]; missing: string[] }

const COVERAGE_GENESIS = '2026-04-07'
const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }, { label: 'all', days: null },
]

function utcDayOffset(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
}

async function fetchCoverage(from: string, to: string): Promise<CoverageRange> {
  const res = await fetch(`${API_BASE}/api/coverage?from=${from}&to=${to}`)
  if (!res.ok) throw new Error(`coverage ${res.status}`)
  return res.json()
}

function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
function pctColor(pct: number): string | undefined {
  return pct >= 0.99 ? undefined : pct >= 0.95 ? '#cc9933' : 'salmon'
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export default function FeedHealth() {
  const [params, setParams] = useSearchParams()
  const [preset, setPresetState] = useState(1)
  const [wide, setWide] = useState(false)
  // `?from=&to=` (UTC days) override the presets — shareable ranges; picking a preset clears them.
  const pFrom = params.get('from'), pTo = params.get('to')
  const explicit = !!(pFrom && pTo && DAY_RE.test(pFrom) && DAY_RE.test(pTo))
  const to = explicit ? pTo! : utcDayOffset(-1)
  const days = PRESETS[preset].days
  const from = explicit ? pFrom! : days === null ? COVERAGE_GENESIS : utcDayOffset(-days)
  const setPreset = (i: number) => {
    setPresetState(i)
    if (explicit) setParams({}, { replace: true })
  }
  const { data, error, isLoading } = useQuery({
    queryKey: ['gbfs-coverage', from, to],
    queryFn: () => fetchCoverage(from, to),
    staleTime: 3_600_000,
  })
  return (
    <Page wide={wide}>
      <div style={{ fontSize: '0.85em', opacity: 0.7 }}><Link to="/health">← pipeline health</Link></div>
      <h1 style={{ fontSize: '1.6em', margin: '0.2em 0 0.3em' }}>GBFS feed metrics</h1>
      <p style={{ margin: '0 0 1em', opacity: 0.8, maxWidth: '60em' }}>
        Per-minute station coverage and the feed's own <code>last_updated</code> cadence, from the availability bitmaps
        (<code>empty-v1p/coverage/&lt;day&gt;.json</code>). A lost minute is one with no <code>last_updated</code> tick for any
        station; the update-interval histogram shows whether that was one long outage or many skipped ~60 s cycles.
      </p>
      <div style={{
        display: 'flex', gap: '0.5em', fontSize: '0.9em', alignItems: 'center',
        position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)',
        margin: '0 -1.5em 1em', padding: '0.6em 1.5em', borderBottom: '1px solid rgba(127,127,127,0.25)',
      }}>
        {PRESETS.map((p, i) => (
          <button
            key={p.label}
            onClick={() => setPreset(i)}
            style={{
              cursor: 'pointer', padding: '0.15em 0.7em', borderRadius: 3, border: '1px solid rgba(127,127,127,0.4)',
              background: i === preset && !explicit ? 'rgba(127,127,127,0.25)' : 'none', color: 'inherit',
            }}
          >{p.label}</button>
        ))}
        <span style={{ opacity: 0.6 }}>{from} → {to} UTC{explicit ? ' (from URL)' : ''}</span>
        <button
          onClick={() => setWide((w) => !w)}
          title="expand the timeline strips to the full window width"
          style={{
            cursor: 'pointer', marginLeft: 'auto', padding: '0.15em 0.7em', borderRadius: 3, border: '1px solid rgba(127,127,127,0.4)',
            background: wide ? 'rgba(127,127,127,0.25)' : 'none', color: 'inherit',
          }}
        >{wide ? '▣ wide' : '▢ wide'}</button>
      </div>
      {isLoading && <div style={{ opacity: 0.6 }}>loading coverage…</div>}
      {error && <div style={{ color: 'salmon' }}>error: {String(error)}</div>}
      {data && (
        <>
          <Section title="Summary">
            <Summary range={data} />
          </Section>
          <Section title="Update intervals" hint="seconds between consecutive feed last_updated values, summed over the range">
            <IntervalHistogram range={data} />
          </Section>
          <Section title="Per day" hint="one row per UTC day, newest first · top strip = 1,440 minutes (red = no feed tick); bottom strip = 24 hours (amber = skipped update cycles). Hover a strip to scrub; click a row to list its gaps. Toggle “wide” for full width.">
            <CoverageTable range={data} />
          </Section>
        </>
      )}
    </Page>
  )
}

function Page({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: wide ? '100%' : 1100, margin: '0 auto', padding: '1.5em 1.5em 3em', fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.5 }}>
      {children}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '1.5em' }}>
      <h2 style={{ fontSize: '1.15em', margin: '0 0 0.4em', borderBottom: '1px solid rgba(127,127,127,0.25)', paddingBottom: '0.2em' }}>
        {title}{hint && <span style={{ fontSize: '0.75em', opacity: 0.6, fontWeight: 400 }}> — {hint}</span>}
      </h2>
      {children}
    </section>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.75em', opacity: 0.65, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '1.1em', fontWeight: 600, color }}>{value}</div>
      {sub && <div style={{ fontSize: '0.85em', opacity: 0.75 }}>{sub}</div>}
    </div>
  )
}

function Summary({ range }: { range: CoverageRange }) {
  const n = range.days.length
  const minutes = n * 1440
  const observed = range.days.reduce((s, d) => s + d.observed_minutes, 0)
  const gapCount = range.days.reduce((s, d) => s + d.gaps.length, 0)
  const longest = range.days.reduce((m, d) => d.gaps.reduce((mm, g) => (g[1] > mm.len ? { len: g[1], day: d.day, start: g[0] } : mm), m), { len: 0, day: '', start: 0 })
  const withCadence = range.days.filter((d) => d.lu_skips !== undefined)
  const skips = withCadence.reduce((s, d) => s + (d.lu_skips ?? 0), 0)
  const pct = observed / Math.max(minutes, 1)
  return (
    <div style={{ display: 'flex', gap: '2em', flexWrap: 'wrap', alignItems: 'baseline' }}>
      <Stat label="Days" value={String(n)} sub={range.missing.length ? `${range.missing.length} without a doc yet` : undefined} />
      <Stat label="Observed minutes" value={`${(100 * pct).toFixed(2)}%`} sub={`${(minutes - observed).toLocaleString()} lost of ${minutes.toLocaleString()}`} color={pctColor(pct)} />
      <Stat label="Lost-minute gaps" value={gapCount.toLocaleString()} sub={longest.len ? `longest gap ${longest.len} min · ${longest.day} ${fmtMin(longest.start)} UTC` : 'none'} />
      <Stat
        label="Skipped feed cycles"
        value={withCadence.length ? skips.toLocaleString() : '—'}
        sub={withCadence.length ? `${withCadence.length} of ${n} days have cadence data` : 'no cadence data in range'}
      />
    </div>
  )
}

/** Fixed bins so the shape is readable at a glance: the feed ticks every 60 ± 1 s, so almost all mass
 *  sits in 59–61; 120 / 180 are one / two skipped cycles; the rest is jitter around those. */
const BINS: Array<{ label: string; lo: number; hi: number; skip?: boolean }> = [
  { label: '< 59 s', lo: 0, hi: 58 },
  { label: '59 s', lo: 59, hi: 59 },
  { label: '60 s', lo: 60, hi: 60 },
  { label: '61 s', lo: 61, hi: 61 },
  { label: '62–89 s', lo: 62, hi: 89 },
  { label: '90–119 s', lo: 90, hi: 119, skip: true },
  { label: '120 s', lo: 120, hi: 120, skip: true },
  { label: '121–179 s', lo: 121, hi: 179, skip: true },
  { label: '180 s', lo: 180, hi: 180, skip: true },
  { label: '181–239 s', lo: 181, hi: 239, skip: true },
  { label: '≥ 240 s', lo: 240, hi: Infinity, skip: true },
]

function IntervalHistogram({ range }: { range: CoverageRange }) {
  const { counts, total, maxSec } = useMemo(() => {
    const counts = BINS.map(() => 0)
    let total = 0
    let maxSec = 0
    for (const d of range.days) {
      for (const [sec, n] of Object.entries(d.lu_hist ?? {})) {
        const s = Number(sec)
        const i = BINS.findIndex((b) => s >= b.lo && s <= b.hi)
        if (i >= 0) counts[i] += n
        total += n
        if (s > maxSec) maxSec = s
      }
    }
    return { counts, total, maxSec }
  }, [range])
  if (!total) return <div style={{ opacity: 0.6 }}>no cadence data in this range yet</div>
  const max = Math.max(...counts, 1)
  const skipped = BINS.reduce((s, b, i) => s + (b.skip ? counts[i] : 0), 0)
  return (
    <div>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.9em' }}>
        <thead>
          <tr style={{ opacity: 0.6 }}>
            <th style={cell('left')}>Interval</th>
            <th style={cell('right')}>Count</th>
            <th style={cell('right')}>Share</th>
            <th style={cell('left')}>
              <Tip content="log scale — a normal day puts ~1,400 intervals at 60 s and a handful anywhere else"><span>Count (log)</span></Tip>
            </th>
          </tr>
        </thead>
        <tbody>
          {BINS.map((b, i) => {
            const n = counts[i]
            const w = n ? Math.max(2, (Math.log10(n + 1) / Math.log10(max + 1)) * 320) : 0
            return (
              <tr key={b.label}>
                <td style={{ ...cell('left'), color: b.skip ? '#cc9933' : undefined, whiteSpace: 'nowrap' }}>{b.label}</td>
                <td style={cell('right')}>{n.toLocaleString()}</td>
                <td style={cell('right')}>{n ? `${(100 * n / total).toFixed(n / total < 0.001 ? 3 : 1)}%` : '—'}</td>
                <td style={cell('left')}>
                  <div style={{ width: 320, height: 10, background: 'rgba(127,127,127,0.12)', borderRadius: 2 }}>
                    <div style={{ width: w, height: '100%', background: b.skip ? '#cc9933' : '#5db75d', borderRadius: 2 }} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ fontSize: '0.85em', opacity: 0.7, marginTop: '0.4em' }}>
        {total.toLocaleString()} intervals · {skipped.toLocaleString()} ({(100 * skipped / total).toFixed(2)}%) at ≥ 90 s (skipped cycles) · longest {maxSec.toLocaleString()} s
      </div>
    </div>
  )
}

function CoverageTable({ range }: { range: CoverageRange }) {
  const rows = [...range.days].reverse()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (day: string) => setOpen((s) => {
    const next = new Set(s)
    next.has(day) ? next.delete(day) : next.add(day)
    return next
  })
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.85em', width: '100%' }}>
        <thead>
          <tr style={{ opacity: 0.6 }}>
            <th style={cell('left')}>Date</th>
            <th style={cell('right')}><Tip content="share of the day's 1,440 minutes in which ≥50% of live stations were observed"><span>Obs %</span></Tip></th>
            <th style={cell('right')}>
              <Tip content={<TipRows rows={[['lost', 'minutes with no feed tick (below the 50% threshold)'], ['hover', 'a cell for the gap count, longest gap, and live-station denominator']]} />}>
                <span>Lost</span>
              </Tip>
            </th>
            <th style={cell('right')}>
              <Tip content={<TipRows rows={[['skips', 'skipped ~60 s update cycles (last_updated interval ≥ 90 s) — one fleet-wide lost minute each'], ['p99', '99th-percentile interval between feed updates']]} />}>
                <span>Skips · p99</span>
              </Tip>
            </th>
            <th style={{ ...cell('left'), whiteSpace: 'nowrap', width: '100%' }}>
              <Tip content={<TipRows rows={[['top strip', '1,440 minutes of the UTC day, 00→24; red = a minute with no feed tick (lost)'], ['bottom strip', 'the same day in 24 hours; amber = skipped update cycles that hour (darker = more)'], ['hover', 'either strip to inspect the minute / hour under the pointer']]} />}>
                <span>
                  <span style={{ color: 'salmon' }}>▔</span> lost min · <span style={{ color: '#cc9933' }}>▁</span> skips/hr · 00→24 UTC
                </span>
              </Tip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => <DayRow key={d.day} d={d} isOpen={open.has(d.day)} onToggle={() => toggle(d.day)} />)}
          {range.missing.length > 0 && (
            <tr><td colSpan={5} style={{ ...cell('left'), opacity: 0.6 }}>no coverage doc yet: {range.missing.join(', ')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** One day's two `<tr>`s (strip row + expandable detail row). Owns the brush state so hovering a
 *  detail line — a lost-minute gap OR an hour roll-up — lights up the matching region on BOTH strips
 *  and the matching lines in the other list. An hour brush spans its 60-minute range on the top strip
 *  and every gap that hour contains; a gap brush lights the minute + the hour column that contains it. */
function DayRow({ d, isOpen, onToggle }: { d: CoverageDay; isOpen: boolean; onToggle: () => void }) {
  const [brush, setBrush] = useState<Brush>(null)
  const pct = d.observed_minutes / 1440
  const lost = 1440 - d.observed_minutes
  const longest = d.gaps.reduce((m, g) => Math.max(m, g[1]), 0)
  const skips = d.lu_skips
  const topHl: [number, number] | null =
    brush?.kind === 'gap' ? [brush.start, brush.len] : brush?.kind === 'hour' ? [brush.hour * 60, 60] : null
  const botHl: number | null =
    brush?.kind === 'hour' ? brush.hour : brush?.kind === 'gap' ? Math.floor(brush.start / 60) : null
  return (
    <Fragment>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }} title={isOpen ? 'collapse' : 'expand: list this day’s gaps'}>
        <td style={{ ...cell('left'), whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-block', width: '1em', opacity: 0.5 }}>{isOpen ? '▾' : '▸'}</span>{d.day}
        </td>
        <td style={cell('right', pctColor(pct))}>{(100 * pct).toFixed(1)}%</td>
        <td style={cell('right')}>
          <Tip content={<TipRows rows={[['lost minutes', String(lost)], ['gaps', String(d.gaps.length)], ['longest gap', longest ? `${longest} min` : '—'], ['live stations', String(d.live)]]} />}>
            <span style={{ color: lost >= 60 ? 'salmon' : lost >= 15 ? '#cc9933' : undefined }}>{lost}</span>
          </Tip>
        </td>
        <td style={cell('right', skips === undefined ? undefined : skips >= 60 ? 'salmon' : skips >= 15 ? '#cc9933' : undefined)}>
          {skips === undefined ? '—' : `${skips} · ${d.lu_interval?.p99 ?? '—'}s`}
        </td>
        <td style={cell('left')}>
          <GapStrip day={d} skipsPerHour={d.lu_skips_per_hour} highlight={topHl} />
          {d.lu_skips_per_hour && <SkipStrip day={d.day} skips={d.lu_skips_per_hour} updates={d.lu_per_hour ?? []} highlight={botHl} />}
          {isOpen && <HourInset day={d} hour={botHl} />}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={5} style={{ ...cell('left'), whiteSpace: 'normal', background: 'rgba(127,127,127,0.06)' }}>
            <DayDetail day={d} brush={brush} onBrush={setBrush} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

/** A hovered detail element: one lost-minute gap (top-strip minute) or one hour roll-up (24-strip hour).
 *  Lifted to `DayRow` so either can brush both strips and cross-highlight the other list. */
type Brush = { kind: 'gap'; start: number; len: number } | { kind: 'hour'; hour: number } | null
const HL_BG = 'rgba(127,127,127,0.22)'

/** Scroll `el` into view within its scroll-`container` ONLY (never the window) — so linked-scrolling
 *  one list can't yank the page or move the cursor off the list being hovered. `top` parks the target
 *  near the container top (so an hour's whole run of gaps shows below it); `nearest` just reveals it. */
function scrollWithin(container: HTMLElement | null, el: HTMLElement | null, align: 'nearest' | 'top') {
  if (!container || !el) return
  const c = container.getBoundingClientRect(), e = el.getBoundingClientRect()
  if (align === 'top') container.scrollTop += (e.top - c.top) - 8
  else if (e.top < c.top) container.scrollTop += (e.top - c.top) - 8
  else if (e.bottom > c.bottom) container.scrollTop += (e.bottom - c.bottom) + 8
}

/** Expanded row: the day's lost-minute gaps and skipped-cycle hours as readable/copyable text. */
const GAP_CAP = 200
function DayDetail({ day, brush, onBrush }: { day: CoverageDay; brush: Brush; onBrush: (b: Brush) => void }) {
  const gaps = day.gaps
  const shown = gaps.slice(0, GAP_CAP)
  const skipHours = (day.lu_skips_per_hour ?? [])
    .map((n, h) => ({ h, n, u: day.lu_per_hour?.[h] }))
    .filter((x) => x.n > 0)
  const gapListRef = useRef<HTMLDivElement>(null)
  const hourListRef = useRef<HTMLDivElement>(null)
  // Linked scrolling: brushing one list reveals the matching entries in the other (never scrolls the page).
  useEffect(() => {
    if (!brush) return
    if (brush.kind === 'hour') {
      scrollWithin(gapListRef.current, gapListRef.current?.querySelector<HTMLElement>(`[data-gap-hour="${brush.hour}"]`) ?? null, 'top')
    } else {
      scrollWithin(hourListRef.current, hourListRef.current?.querySelector<HTMLElement>(`[data-hour="${Math.floor(brush.start / 60)}"]`) ?? null, 'nearest')
    }
  }, [brush])
  // A gap line is lit by its own gap-brush, or by an hour-brush whose hour contains it (and vice-versa).
  const gapLit = (start: number) => brush?.kind === 'gap' ? brush.start === start : brush?.kind === 'hour' ? Math.floor(start / 60) === brush.hour : false
  const hourLit = (h: number) => brush?.kind === 'hour' ? brush.hour === h : brush?.kind === 'gap' ? Math.floor(brush.start / 60) === h : false
  const col: React.CSSProperties = { flex: '1 1 22em', minWidth: 0 }
  const list: React.CSSProperties = { margin: '0.3em 0 0', maxHeight: '32em', overflowY: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '0.92em', lineHeight: 1.7 }
  const head: React.CSSProperties = { fontSize: '0.85em', opacity: 0.65, textTransform: 'uppercase', letterSpacing: '0.04em' }
  const line = (lit: boolean): React.CSSProperties => ({ cursor: 'default', padding: '0 0.2em', borderRadius: 3, background: lit ? HL_BG : 'none' })
  return (
    <div style={{ display: 'flex', gap: '2.5em', flexWrap: 'wrap', padding: '0.4em 0.2em 0.6em' }}>
      <div style={col}>
        <div style={head}>Lost-minute gaps ({gaps.length})<span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}> — last ok → back · minutes lost</span></div>
        {gaps.length === 0
          ? <div style={{ opacity: 0.55, marginTop: '0.3em' }}>none — full coverage</div>
          : (
            <div ref={gapListRef} style={list} onMouseLeave={() => onBrush(null)}>
              {shown.map(([start, len, obs], i) => (
                <div key={i} data-gap-hour={Math.floor(start / 60)} onMouseEnter={() => onBrush({ kind: 'gap', start, len })} style={line(gapLit(start))}>
                  <span style={{ opacity: 0.75 }}>{start === 0 ? '—' : fmtMin(start - 1)}</span>
                  {' → '}
                  <span style={{ opacity: 0.75 }}>{fmtMin(start + len)}</span>
                  {' · '}<span style={{ color: 'salmon' }}>{len} min lost</span>
                  {' · '}<span style={{ opacity: 0.6 }}>{obs}/{day.live} obs</span>
                </div>
              ))}
              {gaps.length > GAP_CAP && <div style={{ opacity: 0.55 }}>+{gaps.length - GAP_CAP} more…</div>}
            </div>
          )}
      </div>
      <div style={col}>
        <div style={head}>Skipped-cycle hours ({skipHours.reduce((s, x) => s + x.n, 0)})</div>
        {day.lu_skips_per_hour === undefined
          ? <div style={{ opacity: 0.55, marginTop: '0.3em' }}>no cadence data for this day</div>
          : skipHours.length === 0
            ? <div style={{ opacity: 0.55, marginTop: '0.3em' }}>none — feed ticked every cycle</div>
            : (
              <div ref={hourListRef} style={list} onMouseLeave={() => onBrush(null)}>
                {skipHours.map(({ h, n, u }) => (
                  <div key={h} data-hour={h} onMouseEnter={() => onBrush({ kind: 'hour', hour: h })} style={line(hourLit(h))}>
                    <span style={{ color: '#cc9933' }}>{String(h).padStart(2, '0')}:00</span>
                    {' '}· {n} skipped{u !== undefined ? ` · ${u}/60 updates` : ''}
                  </div>
                ))}
              </div>
            )}
      </div>
    </div>
  )
}

/** Pointer x → fraction of the element's rendered width. */
function fracX(e: React.MouseEvent<SVGSVGElement>): number {
  const r = e.currentTarget.getBoundingClientRect()
  return Math.min(0.999, Math.max(0, (e.clientX - r.left) / Math.max(r.width, 1)))
}

/** One day as a 1440-minute strip: green ground, red for minutes with no feed tick. All gaps go in
 *  ONE `<path>` (a day of cadence sag has ~700 gaps; 150 rows × 700 rects made the page unpaintable).
 *  The tooltip follows the pointer: the gap under it (snapped to the nearest within a few px, so a
 *  1-minute — sub-pixel — gap is still inspectable), else the day + that hour's skip context. */
function GapStrip({ day, skipsPerHour, highlight }: { day: CoverageDay; skipsPerHour?: number[]; highlight?: [number, number] | null }) {
  const [hover, setHover] = useState<{ minute: number; tol: number } | null>(null)
  const gaps = day.gaps
  const d = gaps.map(([start, len]) => `M${start} 0h${Math.max(len, 2)}v14h-${Math.max(len, 2)}z`).join('')
  const lost = 1440 - day.observed_minutes
  const longest = gaps.reduce((m, g) => Math.max(m, g[1]), 0)
  // Nearest gap to the pointer (0 distance = directly over it), used only when within `tol` minutes.
  const near = hover && gaps.reduce<{ g: [number, number, number]; dist: number } | null>((best, g) => {
    const [s, l] = g
    const dist = hover.minute < s ? s - hover.minute : hover.minute >= s + l ? hover.minute - (s + l - 1) : 0
    return !best || dist < best.dist ? { g, dist } : best
  }, null)
  const run = near && near.dist <= hover!.tol ? near.g : undefined
  const hour = hover ? Math.floor(hover.minute / 60) : null
  const hourSkips = hour !== null && skipsPerHour ? skipsPerHour[hour] : undefined
  const content = (
    <TipRows rows={run
      ? [
          ['lost', `${fmtMin(run[0])}–${fmtMin(run[0] + run[1])} UTC`],
          ['length', `${run[1]} min`],
          ['observed', `${run[2]} of ${day.live} stations`],
        ]
      : [
          ['minute', hover === null ? '00:00→24:00 UTC' : `${fmtMin(hover.minute)} UTC`],
          ['lost this day', `${lost} min${longest ? `, longest gap ${longest} min` : ''}`],
          ...(hourSkips !== undefined
            ? ([[`hour ${String(hour).padStart(2, '0')}`, `${hourSkips} skipped cycle${hourSkips === 1 ? '' : 's'}`]] as [string, string][])
            : []),
        ]} />
  )
  return (
    <Tip content={content}>
      <svg
        viewBox="0 0 1440 14" preserveAspectRatio="none" style={{ width: '100%', height: 14, display: 'block' }}
        onMouseMove={(e) => {
          const w = e.currentTarget.getBoundingClientRect().width
          setHover({ minute: Math.floor(1440 * fracX(e)), tol: Math.max(1, Math.round((1440 / Math.max(w, 1)) * 3)) })
        }}
        onMouseLeave={() => setHover(null)}
      >
        <rect x={0} y={0} width={1440} height={14} fill="#5db75d" opacity={0.55} />
        {d && <path d={d} fill="salmon" />}
        {highlight && (
          <rect x={highlight[0]} y={0} width={Math.max(highlight[1], 5)} height={14} fill="#ffef99" stroke="#fff" strokeWidth={0.7} />
        )}
      </svg>
    </Tip>
  )
}

/** Zoomed inset of one UTC hour: its 60 minutes at 24× the top strip's resolution, so individual
 *  lost minutes (and the good minutes bracketing each gap) are legible. Driven by the brushed hour
 *  (from a gap or hour-line hover); rendered whenever the row is open with a FIXED height, so the
 *  list under the cursor never shifts as the inset fills in or clears. */
function HourInset({ day, hour }: { day: CoverageDay; hour: number | null }) {
  const lo = hour == null ? 0 : hour * 60
  let d = ''
  if (hour != null) for (const [s, l] of day.gaps) {
    const a = Math.max(s, lo), b = Math.min(s + l, lo + 60)
    if (a < b) d += `M${a - lo} 0h${b - a}v14h-${b - a}z`
  }
  const label = hour == null
    ? 'hover an hour or gap to zoom into that hour ↑'
    : `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00 UTC · 60-min zoom (each tick = 15 min)`
  return (
    <div style={{ marginTop: 5 }}>
      <div style={{ fontSize: '0.72em', height: '1.4em', lineHeight: 1.4, opacity: hour == null ? 0.4 : 0.65 }}>{label}</div>
      <svg viewBox="0 0 60 14" preserveAspectRatio="none" style={{ width: '100%', height: 12, display: 'block', opacity: hour == null ? 0.18 : 1 }}>
        <rect x={0} y={0} width={60} height={14} fill="#5db75d" opacity={0.5} />
        {hour != null && [15, 30, 45].map((t) => <rect key={t} x={t} y={0} width={0.15} height={14} fill="rgba(0,0,0,0.4)" />)}
        {d && <path d={d} fill="salmon" />}
      </svg>
    </div>
  )
}

/** Skipped feed-update cycles per UTC hour (amber intensity). */
function SkipStrip({ day, skips, updates, highlight }: { day: string; skips: number[]; updates: number[]; highlight?: number | null }) {
  const [hour, setHour] = useState<number | null>(null)
  const max = Math.max(1, ...skips)
  const total = skips.reduce((a, b) => a + b, 0)
  const content = hour === null
    ? <TipRows rows={[['hours', `${day} · 00→24 UTC`], ['skipped cycles', `${total} total (amber per hour, darker = more)`]]} />
    : <TipRows rows={[['hour', `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00 UTC`], ['feed updates', `${updates[hour] ?? '?'} of 60`], ['skipped cycles', String(skips[hour] ?? 0)]]} />
  return (
    <Tip content={content}>
      <svg
        viewBox="0 0 24 8" preserveAspectRatio="none" style={{ width: '100%', height: 8, display: 'block', marginTop: 3 }}
        onMouseMove={(e) => setHour(Math.floor(24 * fracX(e)))}
        onMouseLeave={() => setHour(null)}
      >
        <rect x={0} y={0} width={24} height={8} fill="rgba(127,127,127,0.15)" />
        {skips.map((n, h) => n ? <rect key={h} x={h} y={0} width={1} height={8} fill="#cc9933" opacity={0.25 + 0.75 * (n / max)} /> : null)}
        {highlight != null && <rect x={highlight} y={0} width={1} height={8} fill="#ffef99" opacity={0.85} />}
      </svg>
    </Tip>
  )
}

function cell(align: 'left' | 'right', color?: string): React.CSSProperties {
  return { padding: '0.25em 0.7em', textAlign: align, borderBottom: '1px solid rgba(127,127,127,0.15)', color, whiteSpace: 'nowrap' }
}
