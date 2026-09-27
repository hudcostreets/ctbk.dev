/**
 * `/merge-review` — audit the station merges behind the rides pyramids'
 * materialized `c:<canonical>` rows (`specs/rides-rekey.md` P5).
 *
 * Left: every merged cluster (974; `station-merges.json` via
 * `ctbk rides-merge-review`), ranked by static suspicion flags (member
 * distance, active-range overlap, harmonize co-activity-guard pairs, overlay
 * provenance). Right: the selected cluster — its raw ids' eras on a shared
 * timeline, their last positions, and per-member monthly rides from
 * `/api/rides/cells?raw=1`, with ride-level co-activity months shaded and a
 * `c:` = Σ members check against the materialized row.
 *
 * URL state: `c` (canonical), `q` (search), `f` (flag filter), `a` (anchor).
 */
import { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { CircleMarker, MapContainer, TileLayer, Tooltip as LTooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Plot } from 'pltly/react'
import Seg from '../components/Seg'
import { enumParam, stringParam, stringsParam, useUrlState } from 'use-prms'
import { useTheme } from '../contexts/ThemeContext'
import { Tip, TipRows } from '../components/Tip'
import { Footer } from '../components/Footer'
import {
  clusterStats, coActivity, extent, FLAG_INFO, FLAGS, haversineM, isoToMs, latestName,
  type ClusterStats, type Decision, type Flag, type Member, type MergesAsset, type Repair, type Verdict,
} from '../lib/mergeReview'
import { useClusterSeries, useMergesAsset } from '../query/mergeReview'
import type { Anchor } from '../query/ridesV1'
import css from './MergeReview.module.css'

const { max, round } = Math

/** Member colors, shared by the timeline, map and chart (legible on both
 *  themes; clusters have ≤5 members). */
const MEMBER_COLORS = ['#1f77b4', '#e8710a', '#2ca02c', '#9c27b0', '#d62728']
const memberColor = (i: number) => MEMBER_COLORS[i % MEMBER_COLORS.length]

const DATA_START_MS = isoToMs('2013-06-01')
const ANCHORS = ['start', 'end'] as const
/** Members as stacked bars (default: each month's composition, summing to the
 *  `c:` row) or as lines (compare co-active members' levels). */
const CHART_MODES = ['bars', 'lines'] as const
type ChartMode = typeof CHART_MODES[number]

const fmtInt = (n: number) => n.toLocaleString('en-US')
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${round(m)} m`)

function FlagChip({ flag, onClick, active }: { flag: Flag, onClick?: () => void, active?: boolean }) {
  const info = FLAG_INFO[flag]
  const cls = `${css.chip} ${css[`flag-${flag}`]} ${active === false ? css.chipOff : ''}`
  return (
    <Tip content={info.desc}>
      {onClick
        ? <button type="button" className={cls} onClick={onClick} aria-pressed={active}>{info.label}</button>
        : <span className={cls}>{info.label}</span>}
    </Tip>
  )
}

function ClusterList({ stats, selected, onSelect }: {
  stats: ClusterStats[]
  selected: string | undefined
  onSelect: (canon: string) => void
}) {
  const selRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { selRef.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  if (!stats.length) return <p className={css.empty}>No clusters match.</p>
  return (
    <ol className={css.list}>
      {stats.map((s) => (
        <li key={s.canon}>
          <button
            type="button"
            ref={s.canon === selected ? selRef : undefined}
            className={`${css.row} ${s.canon === selected ? css.rowSel : ''}`}
            onClick={() => onSelect(s.canon)}
          >
            <span className={css.rowHead}>
              <span className={css.rowName}>{s.name}</span>
              <span className={css.rowId}>c:{s.canon}</span>
            </span>
            <span className={css.rowMeta}>
              <span>{s.cluster.members.length} ids</span>
              {s.maxDistM !== null && <span>{fmtDist(s.maxDistM)}</span>}
              {s.flags.map((f) => <FlagChip key={f} flag={f} />)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

/** Members' eras on one shared axis (data start → now), one lane each. */
function Timeline({ members, nowMs }: { members: Member[], nowMs: number }) {
  const span = nowMs - DATA_START_MS
  const pct = (ms: number) => `${(100 * (max(DATA_START_MS, ms) - DATA_START_MS)) / span}%`
  const years: number[] = []
  for (let y = 2014; y <= new Date(nowMs).getUTCFullYear(); y += 2) years.push(y)
  return (
    <div className={css.timeline}>
      <div className={css.tlAxis}>
        {years.map((y) => (
          <span key={y} className={css.tlTick} style={{ left: pct(Date.UTC(y, 0, 1)) }}>{`'${String(y).slice(2)}`}</span>
        ))}
      </div>
      {members.map((m, i) => (
        <div key={m.id} className={css.tlLane}>
          <Tip content={`s:${m.id}`}>
            <span className={css.tlLabel} style={{ color: memberColor(i) }}>s:{m.id}</span>
          </Tip>
          <div className={css.tlTrack}>
            {years.map((y) => <span key={y} className={css.tlGrid} style={{ left: pct(Date.UTC(y, 0, 1)) }} />)}
            {m.spans.map(([name, first, last]) => {
              const a = isoToMs(first)
              const b = last === null ? nowMs : isoToMs(last)
              return (
                <Tip key={`${name}|${first}`} content={<TipRows rows={[['name', name], ['first', first], ['last', last ?? 'active']]} />}>
                  <span
                    className={css.tlBar}
                    style={{ left: pct(a), width: `max(3px, ${(100 * (b - a)) / span}%)`, background: memberColor(i) }}
                    tabIndex={0}
                  />
                </Tip>
              )
            })}
            {!m.spans.length && <span className={css.tlNone}>no history</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function FitBounds({ pts }: { pts: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (pts.length === 1) map.setView(pts[0], 17)
    else if (pts.length > 1) map.fitBounds(pts, { padding: [28, 28], maxZoom: 18 })
  }, [map, pts])
  return null
}

function MemberMap({ members }: { members: Member[] }) {
  const pts = useMemo(() => members.map((m) => m.pos).filter((p): p is [number, number] => p !== null), [members])
  if (!pts.length) return <p className={css.empty}>No positions.</p>
  return (
    <MapContainer className={css.map} center={pts[0]} zoom={16} scrollWheelZoom={false}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      />
      <FitBounds pts={pts} />
      {members.map((m, i) => m.pos && (
        <CircleMarker
          key={m.id}
          center={m.pos}
          radius={8 - i}
          pathOptions={{ color: memberColor(i), weight: 3, fillColor: memberColor(i), fillOpacity: 0.35 }}
        >
          <LTooltip>s:{m.id} · {latestName(m) ?? 'no history'}</LTooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  )
}

function SeriesChart({ canon, members, anchor, mode }: { canon: string | null, members: Member[], anchor: Anchor, mode: ChartMode }) {
  const ids = useMemo(() => members.map((m) => m.id), [members])
  const q = useClusterSeries(canon, ids, anchor)
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const gridcolor = isDark ? '#505050' : '#ddd'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  const co = useMemo(() => q.data ? coActivity(q.data.members, q.data.canon) : null, [q.data])
  const traces = useMemo(() => {
    if (!q.data) return []
    const monthDate = (m: string) => `${m}-01`
    const ts = members.map((m, i) => {
      const s = q.data.members.get(`s:${m.id}`)!
      const months = [...s.keys()].sort()
      return {
        x: months.map(monthDate),
        y: months.map((mo) => s.get(mo)!),
        name: `s:${m.id}`,
        hovertemplate: `s:${m.id}: %{y:,}<extra></extra>`,
        ...(mode === 'bars'
          ? { type: 'bar' as const, marker: { color: memberColor(i) } }
          : { type: 'scatter' as const, mode: 'lines' as const, line: { color: memberColor(i), width: 2 } }),
      }
    })
    const cs = q.data.canon
    if (!cs) return ts
    const cm = [...cs.keys()].sort()
    return [
      {
        x: cm.map(monthDate),
        y: cm.map((mo) => cs.get(mo)!),
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: `c:${canon}`,
        line: { color: tickcolor, width: 1.5, dash: 'dot' as const },
        hovertemplate: `c:${canon}: %{y:,}<extra></extra>`,
      },
      ...ts,
    ]
  }, [q.data, members, canon, tickcolor, mode])

  const layout = useMemo(() => ({
    autosize: true,
    height: 280,
    hovermode: 'x unified' as const,
    dragmode: 'pan' as const,
    barmode: 'stack' as const,
    bargap: 0.1,
    showlegend: true,
    legend: { orientation: 'h' as const, x: 0, y: 1.14, font: { color: tickcolor, size: 11 } },
    xaxis: { type: 'date' as const, gridcolor, tickfont: { color: tickcolor, size: 11 }, hoverformat: '%b %Y' },
    yaxis: { gridcolor, tickfont: { color: tickcolor, size: 11 }, fixedrange: true, rangemode: 'tozero' as const, automargin: true },
    shapes: (co?.months ?? []).map((m) => {
      const [y, mo] = m.split('-').map(Number)
      return {
        type: 'rect' as const, xref: 'x' as const, yref: 'paper' as const,
        x0: `${m}-01`, x1: new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10), y0: 0, y1: 1,
        fillcolor: isDark ? 'rgba(255,152,0,0.22)' : 'rgba(255,152,0,0.18)', line: { width: 0 }, layer: 'below' as const,
      }
    }),
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 30, r: 8, b: 30, l: 8 },
  }), [co, gridcolor, tickcolor, isDark])

  if (q.isError) return <p className={css.error}>Couldn't load rides: {String(q.error)}</p>
  if (!q.data) return <p className={css.empty}>Loading {anchor === 'start' ? 'starts' : 'ends'}…</p>
  const totals = members.map((m) => [...q.data.members.get(`s:${m.id}`)!.values()].reduce((a, b) => a + b, 0))
  return (
    <>
      <p className={css.seriesSummary}>
        {members.map((m, i) => (
          <span key={m.id}><b style={{ color: memberColor(i) }}>s:{m.id}</b> {fmtInt(totals[i])}</span>
        ))}
        <span className={co!.months.length ? css.warn : css.ok}>
          {co!.months.length
            ? <Tip content={<>Months where ≥2 of these ids each carried ≥10% (and ≥20) of their combined {anchor}s: {co!.months.join(', ')}</>}>
                <span tabIndex={0}>co-active in {co!.months.length} mo (shaded)</span>
              </Tip>
            : 'no co-active months'}
        </span>
        {canon !== null && <span className={co!.sumMismatches.length ? css.bad : css.ok}>
          {co!.sumMismatches.length
            ? <Tip content={<TipRows rows={co!.sumMismatches.slice(0, 12).map((x) => [x.month, `c: ${fmtInt(x.canon)} vs Σ ${fmtInt(x.members)}`])} />}>
                <span tabIndex={0}>c: ≠ Σ members in {co!.sumMismatches.length} mo</span>
              </Tip>
            : 'c: = Σ members ✓'}
        </span>}
      </p>
      <Plot data={traces} layout={layout} style={{ width: '100%' }} config={{ displayModeBar: false, scrollZoom: false }} />
    </>
  )
}

/** Raw ids with their eras, span, and distance from `ref`; the last column
 *  is merge provenance (clusters) or the id-map's current canonical
 *  (decisions, whose ids may sit in different clusters). */
function MembersTable({ members, refPos, nowMs, last }: {
  members: (Member & { canon?: string })[]
  refPos: [number, number] | null
  nowMs: number
  last: 'via' | 'canon'
}) {
  return (
    <div className={css.tableWrap}>
      <table className={css.members}>
        <thead>
          <tr><th>raw id</th><th>names (eras)</th><th>active</th><th>distance</th><th>{last === 'via' ? 'via' : 'canonical now'}</th></tr>
        </thead>
        <tbody>
          {members.map((m, i) => {
            const ext = extent(m, nowMs)
            return (
              <tr key={m.id}>
                <td><code style={{ color: memberColor(i) }}>s:{m.id}</code></td>
                <td className={css.names}>
                  {m.spans.length
                    ? m.spans.map(([n, f, l]) => <div key={`${n}|${f}`}>{n} <span className={css.dim}>{f.slice(0, 7)}–{l?.slice(0, 7) ?? 'now'}</span></div>)
                    : <span className={css.dim}>no history</span>}
                </td>
                <td className={css.num}>{ext ? `${round((ext[1] - ext[0]) / 86_400_000)} d` : '—'}</td>
                <td className={css.num}>
                  {m.pos
                    ? <a href={`https://www.openstreetmap.org/?mlat=${m.pos[0]}&mlon=${m.pos[1]}#map=19/${m.pos[0]}/${m.pos[1]}`} target="_blank" rel="noreferrer">
                        {refPos ? fmtDist(haversineM(refPos, m.pos)) : '—'}
                      </a>
                    : '—'}
                </td>
                <td>
                  {last === 'canon'
                    ? <code className={css.dim}>{m.canon}</code>
                    : m.via === 'overlay' ? <FlagChip flag="overlay" /> : <span className={css.dim}>harmonize</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Monthly series (live, `/api/rides/cells?raw=1`) beside the members' map. */
function SeriesAndMap({ canon, members, anchor, setAnchor, mapKey }: {
  canon: string | null
  members: Member[]
  anchor: Anchor
  setAnchor: (a: Anchor) => void
  mapKey: string
}) {
  const [mode, setMode] = useUrlState('m', enumParam<ChartMode>('bars', CHART_MODES))
  return (
    <section className={css.split}>
      <div className={css.splitMain}>
        <div className={css.sectionHead}>
          <h3>Monthly {anchor === 'start' ? 'starts' : 'ends'}</h3>
          <div className={css.segs}>
            <Seg label="Chart" options={[['bars', 'Bars'], ['lines', 'Lines']] as const} value={mode} set={setMode} />
            <Seg label="Anchor" options={[['start', 'Starts'], ['end', 'Ends']] as const} value={anchor} set={setAnchor} />
          </div>
        </div>
        <SeriesChart canon={canon} members={members} anchor={anchor} mode={mode} />
      </div>
      <div className={css.splitSide}>
        <h3>Last positions</h3>
        <MemberMap key={mapKey} members={members} />
      </div>
    </section>
  )
}

function ClusterDetail({ stats, anchor, setAnchor, nowMs }: {
  stats: ClusterStats
  anchor: Anchor
  setAnchor: (a: Anchor) => void
  nowMs: number
}) {
  const { canon, cluster, name } = stats
  const { members, review } = cluster
  const refPos = members.find((m) => m.id === canon)?.pos ?? members.find((m) => m.pos)?.pos ?? null
  return (
    <article className={css.detail}>
      <header className={css.detailHead}>
        <h2>{name}</h2>
        <p className={css.detailSub}>
          <code>c:{canon}</code> · {members.length} raw ids · {stats.first ?? '?'} → {stats.last ?? 'active'}
          {' · '}<Link to={`/s/${canon}`}>station page</Link>
        </p>
        {stats.flags.length > 0 && <p className={css.chips}>{stats.flags.map((f) => <FlagChip key={f} flag={f} />)}</p>}
      </header>
      <section>
        <h3>Members</h3>
        <MembersTable members={members} refPos={refPos} nowMs={nowMs} last="via" />
      </section>
      <section>
        <h3>Active eras</h3>
        <Timeline members={members} nowMs={nowMs} />
      </section>
      <SeriesAndMap canon={canon} members={members} anchor={anchor} setAnchor={setAnchor} mapKey={canon} />
      {review.length > 0 && (
        <section>
          <h3>Harmonize co-activity guard</h3>
          <ul className={css.review}>
            {review.map((r) => (
              <li key={`${r.a}|${r.b}`}>
                <code>s:{r.a}</code> ↔ <code>s:{r.b}</code>{' '}
                <span className={css.dim}>({r.pass})</span>{' '}
                {r.merged ? <b className={css.warn}>merged anyway</b> : <span>rejected (serves separately)</span>}
                {' · '}shared {r.shared_months.length} mo
                <span className={css.dim}> ({r.shared_months.slice(0, 6).map((m) => `${m.slice(0, 4)}-${m.slice(4)}`).join(', ')}{r.shared_months.length > 6 ? ', …' : ''})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  )
}

const VERDICT_LABEL: Record<Verdict | 'repair', string> = {
  merge: 'merge',
  split: 'split',
  relabel: 'relabel',
  repair: 'id repair',
}

function VerdictChip({ verdict }: { verdict: Verdict | 'repair' }) {
  return <span className={`${css.chip} ${css[`verdict-${verdict}`]}`}>{VERDICT_LABEL[verdict]}</span>
}

/** A decisions-view list entry: a reviewed decision, or a trailing-zero repair. */
type Item =
  | { type: 'decision', key: string, verdict: Verdict, title: string, sub: string, decision: Decision }
  | { type: 'repair', key: string, verdict: 'repair', title: string, sub: string, repair: Repair }

function decisionTitle(d: Decision): string {
  const names = d.members.map((m) => latestName(m) ?? `s:${m.id}`)
  return [...new Set(names)].join(' / ')
}

function toItems(asset: MergesAsset): Item[] {
  const decisions: Item[] = asset.decisions.map((d) => ({
    type: 'decision', key: d.key, verdict: d.verdict, title: decisionTitle(d),
    sub: `${d.ids.map((i) => `s:${i}`).join(' · ')} · ${d.kind}`, decision: d,
  }))
  // Cross-region repairs first (they skewed regional totals), then by the
  // visits the fix moves.
  const moved = (r: Repair) => Object.values(r.series).reduce((n, [v]) => n + v, 0)
  const crossRegion = (r: Repair) => r.before.region !== r.after[r.n0].region || r.before.region !== r.after[r.n].region
  const sorted = [...asset.repairs].sort((a, b) => Number(crossRegion(b)) - Number(crossRegion(a)) || moved(b) - moved(a))
  const repairs: Item[] = sorted.map((r) => ({
    type: 'repair', key: `${r.n}+${r.n0}`, verdict: 'repair',
    title: `${r.names[r.n]?.[0] ?? r.n} / ${r.names[r.n0]?.[0] ?? r.n0}`,
    sub: `s:${r.n} → s:${r.n0} · ${r.before.region ?? '?'} → ${r.after[r.n0].region ?? '?'}`,
    repair: r,
  }))
  return [...decisions, ...repairs]
}

function DecisionDetail({ d, anchor, setAnchor, nowMs }: {
  d: Decision
  anchor: Anchor
  setAnchor: (a: Anchor) => void
  nowMs: number
}) {
  const canons = new Set(d.members.map((m) => m.canon))
  // One cluster now (a merge): check `c:` = Σ against its materialized row.
  const canon = canons.size === 1 && d.verdict === 'merge' ? [...canons][0] : null
  const refPos = d.members.find((m) => m.pos)?.pos ?? null
  return (
    <article className={css.detail}>
      <header className={css.detailHead}>
        <h2>{decisionTitle(d)}</h2>
        <p className={css.detailSub}>
          <VerdictChip verdict={d.verdict} /> · {d.kind} · decided {d.decided}
        </p>
        <p className={css.rationale}>{d.rationale}</p>
      </header>
      <section>
        <h3>Ids</h3>
        <MembersTable members={d.members} refPos={refPos} nowMs={nowMs} last="canon" />
      </section>
      <section>
        <h3>Active eras</h3>
        <Timeline members={d.members} nowMs={nowMs} />
      </section>
      <SeriesAndMap canon={canon} members={d.members} anchor={anchor} setAnchor={setAnchor} mapKey={d.key} />
    </article>
  )
}

/** Before (served): both stations' rides under `s:N0`, placed at the old
 *  canonical. After: split, each at its own canonical. Visits from the
 *  station meta_hists (starts + ends), since the served data is the "before". */
function RepairDetail({ r }: { r: Repair }) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const gridcolor = isDark ? '#505050' : '#ddd'
  const tickcolor = isDark ? '#e0e0e0' : '#333'
  const yms = Object.keys(r.series).sort()
  const x = yms.map((ym) => `${ym.slice(0, 4)}-${ym.slice(4)}-01`)
  const traces = [
    {
      x, y: yms.map((ym) => r.series[ym][0] + r.series[ym][1]), type: 'scatter' as const, mode: 'lines' as const,
      name: `before: s:${r.n0} (@ c:${r.before.canon})`, line: { color: tickcolor, width: 1.5, dash: 'dot' as const },
      hovertemplate: 'before: %{y:,}<extra></extra>',
    },
    ...[r.n, r.n0].map((sid, i) => ({
      x, y: yms.map((ym) => r.series[ym][i]), type: 'scatter' as const, mode: 'lines' as const,
      name: `after: s:${sid} (@ ${r.after[sid].canon})`, line: { color: memberColor(i), width: 2 },
      hovertemplate: `s:${sid}: %{y:,}<extra></extra>`,
    })),
  ]
  const layout = {
    autosize: true, height: 280, hovermode: 'x unified' as const, dragmode: 'pan' as const, showlegend: true,
    legend: { orientation: 'h' as const, x: 0, y: 1.2, font: { color: tickcolor, size: 11 } },
    xaxis: { type: 'date' as const, gridcolor, tickfont: { color: tickcolor, size: 11 }, hoverformat: '%b %Y' },
    yaxis: { gridcolor, tickfont: { color: tickcolor, size: 11 }, fixedrange: true, rangemode: 'tozero' as const, automargin: true },
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', margin: { t: 40, r: 8, b: 30, l: 8 },
  }
  const tot = (i: 0 | 1) => yms.reduce((a, ym) => a + r.series[ym][i], 0)
  const dist = r.after[r.n].pos && r.after[r.n0].pos ? haversineM(r.after[r.n].pos!, r.after[r.n0].pos!) : null
  return (
    <article className={css.detail}>
      <header className={css.detailHead}>
        <h2>s:{r.n} folded into s:{r.n0}</h2>
        <p className={css.detailSub}>
          <VerdictChip verdict="repair" /> · <code>cons</code> trailing-zero bug · {r.months[0].slice(0, 4)}-{r.months[0].slice(4)} → {r.months[r.months.length - 1].slice(0, 4)}-{r.months[r.months.length - 1].slice(4)}
        </p>
        <p className={css.rationale}>
          <code>cons</code> rewrote id <code>{r.n}</code> to <code>{r.n0}</code> in {r.months.length} months, so two stations
          {dist !== null && <> {fmtDist(dist)} apart</>} were served as one and drawn at <code>c:{r.before.canon}</code> ({r.before.region ?? '?'}).
          The <code>cons</code> regen splits them back.
        </p>
      </header>
      <section>
        <h3>Attribution</h3>
        <div className={css.tableWrap}>
          <table className={css.members}>
            <thead><tr><th>station</th><th>names</th><th>visits</th><th>before</th><th>after</th></tr></thead>
            <tbody>
              {([r.n, r.n0] as const).map((sid, i) => (
                <tr key={sid}>
                  <td><code style={{ color: memberColor(i) }}>s:{sid}</code></td>
                  <td className={css.names}>{(r.names[sid] ?? []).join(' · ') || '—'}</td>
                  <td className={css.num}>{fmtInt(tot(i as 0 | 1))}</td>
                  <td className={css.num}><code>{r.before.canon}</code> {r.before.region}</td>
                  <td className={css.num}><code>{r.after[sid].canon}</code> {r.after[sid].region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>Monthly station visits, before vs after</h3>
        <Plot data={traces} layout={layout} style={{ width: '100%' }} config={{ displayModeBar: false, scrollZoom: false }} />
      </section>
    </article>
  )
}

function ItemList({ items, selected, onSelect }: { items: Item[], selected: string | undefined, onSelect: (k: string) => void }) {
  const selRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { selRef.current?.scrollIntoView({ block: 'nearest' }) }, [selected])
  if (!items.length) return <p className={css.empty}>No items match.</p>
  return (
    <ol className={css.list}>
      {items.map((it) => (
        <li key={it.key}>
          <button
            type="button"
            ref={it.key === selected ? selRef : undefined}
            className={`${css.row} ${it.key === selected ? css.rowSel : ''}`}
            onClick={() => onSelect(it.key)}
          >
            <span className={css.rowHead}>
              <span className={css.rowName}>{it.title}</span>
              <VerdictChip verdict={it.verdict} />
            </span>
            <span className={css.rowMeta}><span>{it.sub}</span></span>
          </button>
        </li>
      ))}
    </ol>
  )
}

const VIEWS = ['clusters', 'decisions'] as const
type View = typeof VIEWS[number]
const VERDICTS = ['merge', 'split', 'relabel', 'repair'] as const

export default function MergeReview() {
  const asset = useMergesAsset()
  const [view, setView] = useUrlState('v', enumParam<View>('clusters', VIEWS))
  const [selected, setSelected] = useUrlState('c', stringParam())
  const [selItem, setSelItem] = useUrlState('d', stringParam())
  const [search, setSearch] = useUrlState('q', stringParam())
  const [flagFilter, setFlagFilter] = useUrlState('f', stringsParam([], ','))
  const [verdictFilter, setVerdictFilter] = useUrlState('vf', stringsParam([], ','))
  const [anchor, setAnchor] = useUrlState('a', enumParam<Anchor>('start', ANCHORS))
  const nowMs = useMemo(() => Date.now(), [])
  const q = search?.trim().toLowerCase()

  const all = useMemo(() => {
    if (!asset.data) return []
    return Object.entries(asset.data.clusters)
      .map(([canon, c]) => clusterStats(canon, c, nowMs))
      .sort((a, b) => b.score - a.score || a.canon.localeCompare(b.canon))
  }, [asset.data, nowMs])

  const flagCounts = useMemo(() => {
    const n = Object.fromEntries(FLAGS.map((f) => [f, 0])) as Record<Flag, number>
    for (const s of all) for (const f of s.flags) n[f]++
    return n
  }, [all])

  const shown = useMemo(() => all.filter((s) =>
    (!flagFilter.length || flagFilter.some((f) => s.flags.includes(f as Flag)))
    && (!q || s.canon.toLowerCase().includes(q) || s.cluster.members.some((m) =>
      m.id.toLowerCase().includes(q) || m.spans.some(([n]) => n.toLowerCase().includes(q)))),
  ), [all, flagFilter, q])

  const items = useMemo(() => (asset.data ? toItems(asset.data) : []), [asset.data])
  const verdictCounts = useMemo(() => {
    const n = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<typeof VERDICTS[number], number>
    for (const it of items) n[it.verdict]++
    return n
  }, [items])
  const shownItems = useMemo(() => items.filter((it) =>
    (!verdictFilter.length || verdictFilter.includes(it.verdict))
    && (!q || it.key.toLowerCase().includes(q) || it.title.toLowerCase().includes(q)),
  ), [items, verdictFilter, q])

  const current = all.find((s) => s.canon === selected) ?? shown[0]
  const currentItem = items.find((it) => it.key === selItem) ?? shownItems[0]
  const detailRef = useRef<HTMLElement>(null)
  // Stacked (phone) layout: the detail sits below the list, so bring it
  // into view on pick.
  const reveal = () => {
    if (window.matchMedia('(max-width: 820px)').matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }
  const pick = (canon: string) => { setSelected(canon); reveal() }
  const pickItem = (key: string) => { setSelItem(key); reveal() }
  const flagged = all.filter((s) => s.flags.some((f) => f !== 'no-history' && f !== 'overlay')).length
  const toggleFlag = (f: Flag) =>
    setFlagFilter(flagFilter.includes(f) ? flagFilter.filter((x) => x !== f) : [...flagFilter, f])
  const toggleVerdict = (v: string) =>
    setVerdictFilter(verdictFilter.includes(v) ? verdictFilter.filter((x) => x !== v) : [...verdictFilter, v])

  return (
    <div className={css.page}>
      <header className={css.head}>
        <h1>Station merge review</h1>
        <p className={css.lede}>
          Each merged cluster folds several raw reported station ids into one canonical <code>c:</code> row in the rides pyramids.
          {asset.data && <> {fmtInt(all.length)} clusters, {fmtInt(all.reduce((n, s) => n + s.cluster.members.length, 0))} raw ids; {fmtInt(flagged)} with a distance, overlap, or co-activity-guard flag.
            {' '}{fmtInt(asset.data.decisions.length)} reviewed decisions and {fmtInt(asset.data.repairs.length)} id repairs.</>}
        </p>
      </header>

      {asset.isError && <p className={css.error}>Couldn't load <code>station-merges.json</code>: {String(asset.error)}</p>}

      <div className={css.filters}>
        <div className={css.seg} role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? css.segOn : ''} onClick={() => setView(v)}>
              {v === 'clusters' ? 'Clusters' : 'Decisions'}
            </button>
          ))}
        </div>
        <input
          id="merge-review-search"
          className={css.search}
          type="search"
          placeholder="Search id or name"
          value={search ?? ''}
          onChange={(e) => setSearch(e.target.value || undefined)}
        />
        <div className={css.chips}>
          {view === 'clusters'
            ? FLAGS.map((f) => (
                <span key={f} className={css.filterChip}>
                  <FlagChip flag={f} active={flagFilter.includes(f)} onClick={() => toggleFlag(f)} />
                  <span className={css.dim}>{flagCounts[f]}</span>
                </span>
              ))
            : VERDICTS.map((v) => (
                <span key={v} className={css.filterChip}>
                  <button type="button" className={`${css.chip} ${css[`verdict-${v}`]} ${verdictFilter.includes(v) ? '' : css.chipOff}`} aria-pressed={verdictFilter.includes(v)} onClick={() => toggleVerdict(v)}>
                    {VERDICT_LABEL[v]}
                  </button>
                  <span className={css.dim}>{verdictCounts[v]}</span>
                </span>
              ))}
        </div>
      </div>

      <div className={css.body}>
        {view === 'clusters'
          ? <>
              <nav className={css.listPane} aria-label="Clusters">
                <p className={css.listCount}>{fmtInt(shown.length)} of {fmtInt(all.length)} · ranked by flags</p>
                {asset.data ? <ClusterList stats={shown} selected={current?.canon} onSelect={pick} /> : <p className={css.empty}>Loading…</p>}
              </nav>
              <main className={css.detailPane} ref={detailRef}>
                {current
                  ? <ClusterDetail key={current.canon} stats={current} anchor={anchor} setAnchor={setAnchor} nowMs={nowMs} />
                  : asset.data && <p className={css.empty}>Pick a cluster.</p>}
              </main>
            </>
          : <>
              <nav className={css.listPane} aria-label="Decisions">
                <p className={css.listCount}>{fmtInt(shownItems.length)} of {fmtInt(items.length)} · decisions, then id repairs</p>
                {asset.data ? <ItemList items={shownItems} selected={currentItem?.key} onSelect={pickItem} /> : <p className={css.empty}>Loading…</p>}
              </nav>
              <main className={css.detailPane} ref={detailRef}>
                {!currentItem
                  ? asset.data && <p className={css.empty}>Pick a decision.</p>
                  : currentItem.type === 'decision'
                    ? <DecisionDetail key={currentItem.key} d={currentItem.decision} anchor={anchor} setAnchor={setAnchor} nowMs={nowMs} />
                    : <RepairDetail key={currentItem.key} r={currentItem.repair} />}
              </main>
            </>}
      </div>
      <Footer showHome />
    </div>
  )
}
