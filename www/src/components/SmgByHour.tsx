/**
 * Hour-of-day profile of a station's states (`specs/avail-smg-pyramid.md`
 * "HH" view): `smg-v1` 1h bins over the page's window (the same `r` range
 * the availability + states charts show), filtered to chosen days of week
 * (Eastern time), summed per ET hour, and drawn as each hour's share of
 * usable minutes (states 5–9) per state. Single-station pages only.
 *
 * URL state: `hd` days (codes m t w r f s u; omitted = all); `sff`
 * (forward-fill) is shared with the states panel.
 */
import { useMemo } from 'react'
import { Plot } from 'pltly/react'
import { boolParam, codesParam, useUrlState } from 'use-prms'
import { useTheme } from '../contexts/ThemeContext'
import { SMG_STATES, useSmgHist, type SmgSelection } from '../query/smg'
import { smgByEtHour, type Dow } from '../query/smgStats'
import MultiSelect from './MultiSelect'
import { plotlyMarker } from './smgStyle'
import css from './SmgPanel.module.css'

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
type Day = typeof DAYS[number]
const DAY_LABEL: Record<Day, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' }
const WEEKDAYS: readonly Day[] = ['mon', 'tue', 'wed', 'thu', 'fri']
const WEEKEND: readonly Day[] = ['sat', 'sun']
const daysParam = codesParam<Day>(DAYS, { mon: 'm', tue: 't', wed: 'w', thu: 'r', fri: 'f', sat: 's', sun: 'u' })

const LIVE = SMG_STATES.filter((s) => s.group === 'live')
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`)
const HOUR_S = 3600
const PLOT_H = 260

const same = (a: readonly Day[], b: readonly Day[]) => a.length === b.length && a.every((d) => b.includes(d))

export default function SmgByHour({ sel, fromS, toS }: { sel: SmgSelection | null; fromS: number; toS: number }) {
  const [days, setDays] = useUrlState('hd', daysParam)
  const [ff] = useUrlState('sff', boolParam)
  const { actualTheme } = useTheme()
  const dark = actualTheme === 'dark'

  // Whole ET-aligned hours (every US offset is whole hours).
  const q = useSmgHist(sel, Math.floor(fromS / HOUR_S) * HOUR_S, Math.ceil(toS / HOUR_S) * HOUR_S, 0, HOUR_S)

  const dows = useMemo(() => new Set(days.map((d) => DAYS.indexOf(d) as Dow)), [days])
  const rows = useMemo(() => (q.data ? smgByEtHour(q.data.bins, ff, dows) : null), [q.data, ff, dows])

  const tick = dark ? '#e0e0e0' : '#333'
  const grid = dark ? '#505050' : '#ddd'
  const traces = useMemo(() => {
    if (!rows) return []
    const live = rows.map((r) => LIVE.reduce((s, st) => s + r[st.id], 0))
    return LIVE.map((st) => ({
      type: 'bar' as const,
      name: st.label,
      x: HOUR_LABELS,
      y: rows.map((r, h) => (live[h] ? (100 * r[st.id]) / live[h] : 0)),
      marker: plotlyMarker(st, dark),
      hovertemplate: `${st.label}: %{y:.1f}%<extra></extra>`,
    }))
  }, [rows, dark])

  const layout = useMemo(() => ({
    autosize: true,
    height: PLOT_H,
    barmode: 'stack' as const,
    bargap: 0.08,
    hovermode: 'x unified' as const,
    hoverlabel: {
      bgcolor: dark ? '#2d2d2d' : '#fff',
      bordercolor: dark ? '#555' : '#ccc',
      font: { color: tick, size: 12 },
    },
    showlegend: true,
    legend: { orientation: 'h' as const, x: 0, y: -0.18, font: { color: tick, size: 11 } },
    xaxis: { type: 'category' as const, tickfont: { color: tick, size: 11 }, fixedrange: true },
    yaxis: { range: [0, 100], ticksuffix: '%', gridcolor: grid, tickfont: { color: tick, size: 11 }, fixedrange: true },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 8, r: 8, b: 30, l: 40 },
  }), [tick, grid, dark])

  const hasData = rows?.some((r) => LIVE.some((st) => r[st.id] > 0))
  return (
    <div className={css.panel} data-testid="smg-by-hour">
      <div className={css.toolbar}>
        <MultiSelect
          items={DAYS.map((d) => ({ value: d, label: DAY_LABEL[d] }))}
          selected={days}
          onChange={setDays}
          groups={[{ label: 'Weekdays', values: WEEKDAYS }, { label: 'Weekend', values: WEEKEND }]}
          noun={{ one: 'day', many: 'days' }}
          summary={(s) => (same(s, WEEKDAYS) ? 'Weekdays' : same(s, WEEKEND) ? 'Weekend' : undefined)}
        />
        <span className={css.status}>Eastern time · share of usable minutes</span>
        {q.isFetching && <span className={css.status}>loading…</span>}
        {q.isError && <span className={css.error}>states fetch failed</span>}
      </div>
      {hasData
        ? <Plot data={traces} layout={layout} style={{ width: '100%', height: PLOT_H }} config={{ displayModeBar: false, scrollZoom: false }} />
        : !q.isFetching && <span className={css.status}>{days.length ? 'no station-state data for these days' : 'no days selected'}</span>}
    </div>
  )
}
