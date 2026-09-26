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
import { enumParam, stringParam, stringsParam, useUrlState } from 'use-prms'
import { useTheme } from '../contexts/ThemeContext'
import { Tip, TipRows } from '../components/Tip'
import { Footer } from '../components/Footer'
import {
  clusterStats, coActivity, extent, FLAG_INFO, FLAGS, haversineM, isoToMs, latestName,
  type ClusterStats, type Flag, type Member,
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

function SeriesChart({ canon, members, anchor }: { canon: string, members: Member[], anchor: Anchor }) {
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
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: `s:${m.id}`,
        line: { color: memberColor(i), width: 2 },
        hovertemplate: `s:${m.id}: %{y:,}<extra></extra>`,
      }
    })
    const cm = [...q.data.canon.keys()].sort()
    return [
      {
        x: cm.map(monthDate),
        y: cm.map((mo) => q.data.canon.get(mo)!),
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: `c:${canon}`,
        line: { color: tickcolor, width: 1.5, dash: 'dot' as const },
        hovertemplate: `c:${canon}: %{y:,}<extra></extra>`,
      },
      ...ts,
    ]
  }, [q.data, members, canon, tickcolor])

  const layout = useMemo(() => ({
    autosize: true,
    height: 280,
    hovermode: 'x unified' as const,
    dragmode: 'pan' as const,
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
            ? <Tip content={<>Months where ≥2 members each carried ≥10% (and ≥20) of the cluster's {anchor}s: {co!.months.join(', ')}</>}>
                <span tabIndex={0}>co-active in {co!.months.length} mo (shaded)</span>
              </Tip>
            : 'no co-active months'}
        </span>
        <span className={co!.sumMismatches.length ? css.bad : css.ok}>
          {co!.sumMismatches.length
            ? <Tip content={<TipRows rows={co!.sumMismatches.slice(0, 12).map((x) => [x.month, `c: ${fmtInt(x.canon)} vs Σ ${fmtInt(x.members)}`])} />}>
                <span tabIndex={0}>c: ≠ Σ members in {co!.sumMismatches.length} mo</span>
              </Tip>
            : 'c: = Σ members ✓'}
        </span>
      </p>
      <Plot data={traces} layout={layout} style={{ width: '100%' }} config={{ displayModeBar: false, scrollZoom: false }} />
    </>
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
  const ref = members.find((m) => m.id === canon)?.pos ?? members.find((m) => m.pos)?.pos ?? null
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
        <div className={css.tableWrap}>
          <table className={css.members}>
            <thead>
              <tr><th>raw id</th><th>names (eras)</th><th>active</th><th>from c: pos</th><th>via</th></tr>
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
                            {ref ? fmtDist(haversineM(ref, m.pos)) : '—'}
                          </a>
                        : '—'}
                    </td>
                    <td>{m.via === 'overlay' ? <FlagChip flag="overlay" /> : <span className={css.dim}>harmonize</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>Active eras</h3>
        <Timeline members={members} nowMs={nowMs} />
      </section>

      <section className={css.split}>
        <div className={css.splitMain}>
          <div className={css.sectionHead}>
            <h3>Monthly {anchor === 'start' ? 'starts' : 'ends'}</h3>
            <div className={css.seg} role="radiogroup" aria-label="Anchor">
              {ANCHORS.map((a) => (
                <button key={a} type="button" role="radio" aria-checked={anchor === a} className={anchor === a ? css.segOn : ''} onClick={() => setAnchor(a)}>
                  {a === 'start' ? 'Starts' : 'Ends'}
                </button>
              ))}
            </div>
          </div>
          <SeriesChart canon={canon} members={members} anchor={anchor} />
        </div>
        <div className={css.splitSide}>
          <h3>Last positions</h3>
          <MemberMap key={canon} members={members} />
        </div>
      </section>

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

export default function MergeReview() {
  const asset = useMergesAsset()
  const [selected, setSelected] = useUrlState('c', stringParam())
  const [search, setSearch] = useUrlState('q', stringParam())
  const [flagFilter, setFlagFilter] = useUrlState('f', stringsParam([], ','))
  const [anchor, setAnchor] = useUrlState('a', enumParam<Anchor>('start', ANCHORS))
  const nowMs = useMemo(() => Date.now(), [])

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

  const shown = useMemo(() => {
    const q = search?.trim().toLowerCase()
    return all.filter((s) =>
      (!flagFilter.length || flagFilter.some((f) => s.flags.includes(f as Flag)))
      && (!q || s.canon.toLowerCase().includes(q) || s.cluster.members.some((m) =>
        m.id.toLowerCase().includes(q) || m.spans.some(([n]) => n.toLowerCase().includes(q)))),
    )
  }, [all, flagFilter, search])

  const current = all.find((s) => s.canon === selected) ?? shown[0]
  const detailRef = useRef<HTMLElement>(null)
  // Stacked (phone) layout: the detail sits below the list, so bring it
  // into view on pick.
  const pick = (canon: string) => {
    setSelected(canon)
    if (window.matchMedia('(max-width: 820px)').matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }
  const flagged = all.filter((s) => s.flags.some((f) => f !== 'no-history' && f !== 'overlay')).length
  const toggleFlag = (f: Flag) =>
    setFlagFilter(flagFilter.includes(f) ? flagFilter.filter((x) => x !== f) : [...flagFilter, f])

  return (
    <div className={css.page}>
      <header className={css.head}>
        <h1>Station merge review</h1>
        <p className={css.lede}>
          Each merged cluster folds several raw reported station ids into one canonical <code>c:</code> row in the rides pyramids.
          {asset.data && <> {fmtInt(all.length)} clusters, {fmtInt(all.reduce((n, s) => n + s.cluster.members.length, 0))} raw ids; {fmtInt(flagged)} with a distance, overlap, or co-activity-guard flag.</>}
        </p>
      </header>

      {asset.isError && <p className={css.error}>Couldn't load <code>station-merges.json</code>: {String(asset.error)}</p>}

      <div className={css.filters}>
        <input
          id="merge-review-search"
          className={css.search}
          type="search"
          placeholder="Search id or name"
          value={search ?? ''}
          onChange={(e) => setSearch(e.target.value || undefined)}
        />
        <div className={css.chips}>
          {FLAGS.map((f) => (
            <span key={f} className={css.filterChip}>
              <FlagChip flag={f} active={flagFilter.includes(f)} onClick={() => toggleFlag(f)} />
              <span className={css.dim}>{flagCounts[f]}</span>
            </span>
          ))}
        </div>
      </div>

      <div className={css.body}>
        <nav className={css.listPane} aria-label="Clusters">
          <p className={css.listCount}>{fmtInt(shown.length)} of {fmtInt(all.length)} · ranked by flags</p>
          {asset.data ? <ClusterList stats={shown} selected={current?.canon} onSelect={pick} /> : <p className={css.empty}>Loading…</p>}
        </nav>
        <main className={css.detailPane} ref={detailRef}>
          {current
            ? <ClusterDetail key={current.canon} stats={current} anchor={anchor} setAnchor={setAnchor} nowMs={nowMs} />
            : asset.data && <p className={css.empty}>Pick a cluster.</p>}
        </main>
      </div>
      <Footer showHome />
    </div>
  )
}
