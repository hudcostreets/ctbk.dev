import { useUrlParam, boolParam, enumParam, stringsParam } from '@rdub/use-url-params'
import { useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import { Link } from 'react-router-dom'
import css from "../../pages/index.module.css"
import {
  Colors,
  Int2Gender,
  NormalizeRideableType,
  Regions,
  RideableTypes,
  Row,
  StackBy,
  StackBys,
  stackKeyDict,
  UserTypes,
  YAxes,
  YAxis,
  yAxisLabelDict,
} from '../data'

const DATA_URL = '/assets/ymrgtb_cd.json'

type ProcessedRow = Row & { m: string; Rides: number; 'Ride minutes': number }

function processData(data: Row[]): ProcessedRow[] {
  return data.map(row => ({
    ...row,
    m: `${row.Year}-${row.Month.toString().padStart(2, '0')}`,
    Rides: row.Count,
    'Ride minutes': row.Duration / 60,
  }))
}

export default function Home() {
  const [data, setData] = useState<ProcessedRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // URL parameters using use-url-params
  const [yAxis, setYAxis] = useUrlParam('y', enumParam<YAxis>('Rides', YAxes))
  const [stackBy, setStackBy] = useUrlParam('s', enumParam<StackBy>('None', StackBys))
  const [stackRelative, setStackRelative] = useUrlParam('pct', boolParam)
  const [regions, setRegions] = useUrlParam('r', stringsParam([...Regions], ','))
  const [userTypes] = useUrlParam('u', stringsParam([...UserTypes], ','))
  const [rideableTypes] = useUrlParam('rt', stringsParam([...RideableTypes], ','))
  const [showLegend, setShowLegend] = useUrlParam('legend', boolParam)
  const [show12moAvg, setShow12moAvg] = useUrlParam('avg', boolParam)

  // Fetch data on mount
  useEffect(() => {
    fetch(DATA_URL)
      .then(res => res.json())
      .then((rawData: Row[]) => {
        setData(processData(rawData))
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  // Filter and group data
  const { traces, title, subtitle } = useMemo(() => {
    if (!data) return { traces: [], title: '', subtitle: '' }

    // Normalize and filter data
    const filtered = data
      .map(row => ({
        ...row,
        Gender: Int2Gender[row.Gender],
        'Rideable Type': NormalizeRideableType[row['Rideable Type']] || 'Unknown',
      }))
      .filter(row =>
        regions.includes(row.Region) &&
        userTypes.includes(row['User Type']) &&
        rideableTypes.includes(row['Rideable Type'])
      )

    // Group by month (and optionally stack key)
    const grouped: Record<string, Record<string, number>> = {}
    const stackKeys = stackKeyDict[stackBy]

    for (const row of filtered) {
      const m = row.m
      const stackVal = stackBy === 'None' ? '' : (row as Record<string, unknown>)[stackBy] as string
      const val = row[yAxis]

      if (!grouped[m]) grouped[m] = {}
      grouped[m][stackVal] = (grouped[m][stackVal] || 0) + val
    }

    // Convert to sorted arrays
    const months = Object.keys(grouped).sort()

    // Build traces
    const colors = Colors[stackBy]
    const barTraces = stackKeys
      .filter(key => stackBy === 'None' || months.some(m => grouped[m]?.[key]))
      .map(stackVal => {
        const name = stackVal || yAxisLabelDict[yAxis].hoverLabel
        const y = months.map(m => {
          const val = grouped[m]?.[stackVal] || 0
          if (stackRelative && stackBy !== 'None') {
            const total = Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
            return total ? val / total : 0
          }
          return val
        })
        return {
          x: months,
          y,
          name,
          type: 'bar' as const,
          marker: { color: colors[stackVal] || colors[''] },
        }
      })

    // Rolling average trace
    const rollingTraces = show12moAvg ? (() => {
      const totals = months.map(m =>
        Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
      )
      const n = 12
      const avgY = totals.map((_, i) => {
        if (i < n - 1) return null
        const sum = totals.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0)
        return sum / n
      })
      return [{
        x: months,
        y: avgY,
        name: '12mo avg',
        type: 'scatter' as const,
        mode: 'lines' as const,
        line: { color: 'black', width: 3 },
      }]
    })() : []

    const { title } = yAxisLabelDict[yAxis]
    const subtitleParts: string[] = []
    if (regions.length < Regions.length) subtitleParts.push(regions.join('+'))
    if (stackBy !== 'None') subtitleParts.push(`by ${stackBy}`)
    if (stackRelative) subtitleParts.push('%')

    return {
      traces: [...barTraces, ...rollingTraces],
      title,
      subtitle: subtitleParts.join(', '),
    }
  }, [data, yAxis, stackBy, stackRelative, regions, userTypes, rideableTypes, show12moAvg])

  if (loading) {
    return (
      <div className={css.container}>
        <main className={css.main}>
          <h1 className={css.title}>Loading...</h1>
        </main>
      </div>
    )
  }

  if (error) {
    return (
      <div className={css.container}>
        <main className={css.main}>
          <h1 className={css.title}>Error: {error}</h1>
        </main>
      </div>
    )
  }

  const layout = {
    autosize: true,
    barmode: 'stack' as const,
    showlegend: showLegend ?? stackBy !== 'None',
    hovermode: 'x' as const,
    legend: { x: 0.5, xanchor: 'center' as const, yanchor: 'top' as const, orientation: 'h' as const },
    xaxis: { tickformat: "%b '%y", gridcolor: '#ddd' },
    yaxis: {
      automargin: true,
      gridcolor: '#ddd',
      tickformat: stackRelative ? '.0%' : undefined,
      range: stackRelative ? [0, 1.01] : undefined,
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 0, r: 0, b: 40, l: 60 },
  }

  return (
    <div className={css.container}>
      <main className={css.main}>
        <div className={css.titleContainer}>
          <h1 className={css.title}>{title}</h1>
          {subtitle && <p className={css.subtitle}>{subtitle}</p>}
        </div>

        <Plot
          data={traces}
          layout={layout}
          useResizeHandler
          style={{ width: '100%', height: '400px' }}
          config={{ displayModeBar: false }}
        />

        <div className={css.row}>
          <details className={css.controls}>
            <summary><span className={css.settingsGear}>⚙</span>️</summary>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '1rem' }}>
              <label>
                Y-Axis:
                <select value={yAxis} onChange={e => setYAxis(e.target.value as YAxis)}>
                  {YAxes.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>

              <label>
                Stack by:
                <select value={stackBy} onChange={e => setStackBy(e.target.value as StackBy)}>
                  {StackBys.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <label>
                <input type="checkbox" checked={stackRelative} onChange={e => setStackRelative(e.target.checked)} />
                Stack %
              </label>

              <label>
                <input type="checkbox" checked={showLegend ?? stackBy !== 'None'} onChange={e => setShowLegend(e.target.checked)} />
                Legend
              </label>

              <label>
                <input type="checkbox" checked={show12moAvg} onChange={e => setShow12moAvg(e.target.checked)} />
                12mo avg
              </label>

              <div>
                Regions:
                {Regions.map(r => (
                  <label key={r} style={{ marginLeft: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={regions.includes(r)}
                      onChange={e => {
                        if (e.target.checked) setRegions([...regions, r])
                        else setRegions(regions.filter(x => x !== r))
                      }}
                    />
                    {r}
                  </label>
                ))}
              </div>
            </div>
          </details>
        </div>

        <hr />
        <div className={css.row}>
          <h3 id="map">Map: Stations + Common Destinations</h3>
          <p>Tap a station to see where rides originating there go:</p>
          <Link to="/stations">View Stations Map →</Link>
        </div>

        <hr />
        <div className={css.row}>
          <p>
            Data from <a href="https://www.citibikenyc.com/system-data" target="_blank" rel="noopener noreferrer">Citi Bike System Data</a>.
            Source on <a href="https://github.com/hudcostreets/ctbk.dev" target="_blank" rel="noopener noreferrer">GitHub</a>.
          </p>
        </div>
      </main>
    </div>
  )
}
