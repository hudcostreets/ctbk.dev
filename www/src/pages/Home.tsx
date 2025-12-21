import { Tooltip } from "@mui/material"
import { useUrlParam, boolParam, numberArrayParam } from '@rdub/use-url-params'
import { Data } from 'plotly.js'
import { ReactNode, useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import { Link, useLocation } from 'react-router-dom'
import css from "../../pages/index.module.css"
import controlCss from "../controls.module.css"
import { Checkbox } from "../components/Checkbox"
import { Checklist } from "../components/Checklist"
import { Radios } from "../components/Radios"
import { darken } from "../colors"
import { DateRange, DateRange2Dates, dateRangeParam } from "../date-range"
import {
  annualizedPercents,
  annualPercentStr,
  Colors,
  Gender,
  GenderQueryStrings,
  GenderRollingAvgCutoff,
  Genders,
  Int2Gender,
  multiCodeParam,
  NormalizeRideableType,
  RegionQueryStrings,
  Regions,
  RideableType,
  RideableTypeChars,
  RideableTypes,
  rollingAvg,
  Row,
  singleCodeParam,
  StackBy,
  StackByQueryStrings,
  stackKeyDict,
  toYM,
  UnknownRideableCutoff,
  UserTypeQueryStrings,
  UserTypes,
  YAxis,
  YAxisQueryStrings,
  yAxisLabelDict,
} from '../data'

const DATA_URL = '/assets/ymrgtb_cd.json'

type ProcessedRow = Row & {
  m: string
  Rides: number
  'Ride minutes': number
  GenderStr: Gender
  RideableTypeStr: RideableType
}

function processData(data: Row[]): ProcessedRow[] {
  return data.map(row => ({
    ...row,
    m: `${row.Year}-${row.Month.toString().padStart(2, '0')}`,
    Rides: row.Count,
    'Ride minutes': row.Duration / 60,
    GenderStr: Int2Gender[row.Gender],
    RideableTypeStr: NormalizeRideableType[row['Rideable Type']] || 'Unknown',
  }))
}

// Warning label with tooltip for deprecated data
const WarningLabel = ({ label, id, children }: { label: string; id: string; children: ReactNode }) => (
  <span>
    {label}
    <Tooltip id={id} className={css.tooltip} title={children}>
      <span id={id}>
        <img className={css.warning} alt="warning icon" src="/assets/warning.png" />
      </span>
    </Tooltip>
  </span>
)

const GenderLabel = (suffix: number | string) => (
  <WarningLabel label="Gender" id={`gender-label-tooltip-${suffix}`}>
    <div>Gender data no longer published</div>
    <div>(as of February 2021)</div>
  </WarningLabel>
)

export const RideableTypesExample = "/?y=m&s=b&rt=ce&d=2002-"

export default function Home() {
  // useLocation triggers re-render on URL change (React Router Link navigation)
  useLocation()

  const [data, setData] = useState<ProcessedRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // URL parameters with short code encoding (matching original Next.js version)
  // Note: params are re-read on each render, location dependency ensures this happens on navigation
  const [yAxis, setYAxis] = useUrlParam('y', singleCodeParam<YAxis>('Rides', YAxisQueryStrings))
  const [stackBy, setStackBy] = useUrlParam('s', singleCodeParam<StackBy>('None', StackByQueryStrings))
  const [stackRelative, setStackRelative] = useUrlParam('pct', boolParam)
  const [regions, setRegions] = useUrlParam('r', multiCodeParam(Regions, RegionQueryStrings))
  const [userTypes, setUserTypes] = useUrlParam('u', multiCodeParam(UserTypes, UserTypeQueryStrings))
  const [genders, setGenders] = useUrlParam('g', multiCodeParam(Genders, GenderQueryStrings))
  const [rideableTypes, setRideableTypes] = useUrlParam('rt', multiCodeParam(RideableTypes, RideableTypeChars))
  const [dateRange, setDateRange] = useUrlParam('d', dateRangeParam())
  const [rollingAvgs, setRollingAvgs] = useUrlParam('avg', numberArrayParam([12]))
  const [showLegend, setShowLegend] = useState<boolean | null>(null)

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

  // Compute date range bounds
  const { start, end } = useMemo(() => {
    if (!data || data.length === 0) return { start: '', end: '' }
    const maxDate = data.reduce((max, r) => {
      const d = new Date(r.Year, r.Month - 1)
      return d > max ? d : max
    }, new Date(0))
    // Add 1 month for exclusive end bound
    const lastPlusOne = new Date(maxDate)
    lastPlusOne.setMonth(lastPlusOne.getMonth() + 1)
    const { start: startD, end: endD } = DateRange2Dates(dateRange, lastPlusOne)
    return {
      start: toYM(startD),
      end: toYM(endD),
    }
  }, [data, dateRange])

  // Derived values
  const stackPercents = stackRelative && stackBy !== 'None'
  const hovertemplate = stackPercents ? "%{y:.0%}" : "%{y:,.0f}"
  const { hoverLabel: yHoverLabel, title } = yAxisLabelDict[yAxis]

  // Subtitle
  const subtitle = useMemo(() => {
    const parts: string[] = []
    if (regions.length && regions.length < Regions.length) {
      parts.push(regions.join('+'))
    }
    if (rideableTypes.length && rideableTypes.length < RideableTypes.length) {
      parts.push(`${rideableTypes.join('/')} bikes`)
    }
    if (userTypes.length && userTypes.length < UserTypes.length) {
      const [userType] = userTypes
      parts.push({ Annual: 'Annual members', Daily: 'Daily customers' }[userType] || userType)
    }
    const byName = stackBy === 'None' ? undefined : (stackBy === 'Rideable Type' ? 'Bike Type' : stackBy)
    if (stackPercents && byName) parts.push(`% by ${byName}`)
    else if (stackPercents) parts.push('%')
    else if (byName) parts.push(`by ${byName}`)
    return parts.length ? parts.join(', ') : undefined
  }, [regions, rideableTypes, userTypes, stackPercents, stackBy])

  // Filter and aggregate data
  const { traces } = useMemo(() => {
    if (!data) return { traces: [] }

    // Filter data
    const filtered = data.filter(row =>
      regions.includes(row.Region) &&
      userTypes.includes(row['User Type']) &&
      genders.includes(row.GenderStr) &&
      rideableTypes.includes(row.RideableTypeStr) &&
      row.m >= start &&
      row.m < end
    )

    // Group by month (and optionally stack key)
    const stackKeys = stackKeyDict[stackBy]
    const grouped: Record<string, Record<string, number>> = {}

    for (const row of filtered) {
      const m = row.m
      let stackVal = ''
      if (stackBy === 'Region') stackVal = row.Region
      else if (stackBy === 'User Type') stackVal = row['User Type']
      else if (stackBy === 'Gender') stackVal = row.GenderStr
      else if (stackBy === 'Rideable Type') stackVal = row.RideableTypeStr

      const val = row[yAxis]
      if (!grouped[m]) grouped[m] = {}
      grouped[m][stackVal] = (grouped[m][stackVal] || 0) + val
    }

    // Convert to sorted arrays
    const months = Object.keys(grouped).sort()

    // Build bar traces
    const colors = Colors[stackBy]
    const legendRanks: Record<string, number> = {}
    stackKeys.forEach((k, i) => { legendRanks[k] = -i })

    const barTraces = stackKeys
      .filter(key => stackBy === 'None' || months.some(m => grouped[m]?.[key]))
      .map(stackVal => {
        const name = stackVal || yHoverLabel
        const y = months.map(m => {
          const val = grouped[m]?.[stackVal] || 0
          if (stackPercents) {
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
          hovertemplate,
          legendrank: 100 + 2 * (legendRanks[stackVal] || 0),
        }
      })

    // Rolling average traces
    const show12mo = rollingAvgs.includes(12)
    const rollingTraces: Data[] = []

    if (show12mo) {
      if (stackBy === 'None') {
        // Single rolling average for total
        const totals = months.map(m =>
          Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
        )
        const avgY = rollingAvg(totals, 12)
        // Log annualized percents
        annualizedPercents(months, avgY).forEach(p => console.log(annualPercentStr(p)))
        rollingTraces.push({
          x: months,
          y: avgY as (number | null)[],
          name: '12mo avg',
          type: 'scatter',
          mode: 'lines',
          line: { color: 'black', width: 4 },
          hovertemplate,
          legendrank: 101,
        })
      } else {
        // Per-stack-value rolling averages
        const clampEnd = stackBy === 'Gender' && end > GenderRollingAvgCutoff
          ? GenderRollingAvgCutoff
          : end

        stackKeys
          .filter(key => months.some(m => grouped[m]?.[key]))
          .forEach(stackVal => {
            // For Unknown rideable type, clamp earlier
            let effectiveEnd = clampEnd
            if (stackBy === 'Rideable Type' && stackVal === 'Unknown' && end > UnknownRideableCutoff) {
              effectiveEnd = UnknownRideableCutoff
            }

            const clampedMonths = months.filter(m => m < effectiveEnd)
            // Use percentages when stackPercents is true, raw values otherwise
            const values = clampedMonths.map(m => {
              const val = grouped[m]?.[stackVal] || 0
              if (stackPercents) {
                const total = Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
                return total ? val / total : 0
              }
              return val
            })
            const avgY = rollingAvg(values, 12)

            // Log annualized percents (use raw values for growth calculation)
            if (!stackPercents) {
              annualizedPercents(clampedMonths, avgY).forEach(p =>
                console.log(`${stackVal}: ${annualPercentStr(p)}`)
              )
            }

            const color = darken(colors[stackVal] || colors[''], 0.75)
            rollingTraces.push({
              x: clampedMonths,
              y: avgY as (number | null)[],
              name: `${stackVal} (12mo)`,
              type: 'scatter',
              mode: 'lines',
              line: { color, width: 4 },
              hovertemplate,
              legendrank: 101 + 2 * (legendRanks[stackVal] || 0),
            })
          })
      }
    }

    return { traces: [...barTraces, ...rollingTraces] as Data[] }
  }, [data, yAxis, stackBy, stackPercents, regions, userTypes, genders, rideableTypes, start, end, rollingAvgs, yHoverLabel, hovertemplate])

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

  const showLegendValue = showLegend === null ? stackBy !== 'None' : showLegend
  const gridcolor = "#ddd"

  const layout = {
    autosize: true,
    barmode: 'stack' as const,
    showlegend: showLegendValue,
    hovermode: 'x' as const,
    legend: {
      x: 0.5,
      xanchor: 'center' as const,
      yanchor: 'top' as const,
      orientation: 'h' as const,
      traceorder: 'normal' as const,
    },
    xaxis: {
      tickfont: { size: 14 },
      titlefont: { size: 14 },
      tickformat: "%b '%y",
      gridcolor,
    },
    yaxis: {
      automargin: true,
      gridcolor,
      tickfont: { size: 14 },
      titlefont: { size: 14 },
      tickformat: stackPercents ? '.0%' : undefined,
      range: stackPercents ? [0, 1.01] : undefined,
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { t: 0, r: 0, b: 40, l: 0 },
  }

  const dateRangeButtons: (DateRange & string)[] = ["1y", "2y", "3y", "4y", "5y", "All"]

  return (
    <div id="plot" className={css.container}>
      <main className={css.main}>
        <div className={css.titleContainer}>
          <h1 className={css.title}>{title}</h1>
          {subtitle && <p className={css.subtitle}>{subtitle}</p>}
        </div>

        <Plot
          data={traces}
          layout={layout}
          useResizeHandler
          style={{ width: '100%', aspectRatio: '768 / 410' }}
          config={{ displayModeBar: false }}
        />

        <div className={css.row}>
          <details className={css.controls}>
            <summary><span className={css.settingsGear}>⚙</span>️</summary>

            {/* Date range controls */}
            <div className={`${css.dateControls} ${controlCss.control}`}>
              <label className={controlCss.controlHeader}>Dates</label>
              {dateRangeButtons.map(dr => (
                <input
                  type="button"
                  key={dr}
                  value={dr}
                  className={`${css.dateRangeButton} ${dateRange === dr ? css.activeButton : css.inactiveButton}`}
                  onClick={() => setDateRange(dr)}
                />
              ))}
            </div>

            <Checklist
              label="Region"
              data={Regions.map(region => ({
                name: region,
                data: region,
                checked: regions.includes(region),
              }))}
              cb={setRegions}
            />

            <Radios
              label="Stack by"
              options={[
                "None",
                "Region",
                "User Type",
                { label: GenderLabel(1), data: "Gender" },
                { label: "Bike Type", data: "Rideable Type" },
              ]}
              cb={setStackBy}
              choice={stackBy}
            />

            <div className={controlCss.control}>
              <Checkbox
                label="12mo avg"
                checked={rollingAvgs.includes(12)}
                cb={v => setRollingAvgs(v ? [12] : [])}
              />
              <Checkbox
                label="Legend"
                checked={showLegendValue}
                cb={setShowLegend}
              />
              <Checkbox
                label="Stack %"
                checked={stackRelative}
                cb={setStackRelative}
              />
            </div>

            <Radios
              label="Y Axis"
              options={["Rides", { label: "Minutes", data: "Ride minutes" }]}
              cb={setYAxis}
              choice={yAxis}
            />

            <Checklist
              label="User Type"
              data={UserTypes.map(userType => ({
                name: userType,
                data: userType,
                checked: userTypes.includes(userType),
              }))}
              cb={setUserTypes}
            />

            <Checklist
              label={GenderLabel(2)}
              data={[
                { name: 'Men', data: 'Men' as Gender, checked: genders.includes('Men') },
                { name: 'Women', data: 'Women' as Gender, checked: genders.includes('Women') },
                { name: 'Unknown', data: 'Unknown' as Gender, checked: genders.includes('Unknown') },
              ]}
              cb={setGenders}
            />

            <Checklist
              label="Bike Type"
              data={[
                { name: 'Classic', data: 'Classic' as RideableType, checked: rideableTypes.includes('Classic') },
                { name: 'Electric', data: 'Electric' as RideableType, checked: rideableTypes.includes('Electric') },
                { name: 'Unknown', data: 'Unknown' as RideableType, checked: rideableTypes.includes('Unknown') },
              ]}
              cb={setRideableTypes}
            />
          </details>
        </div>

        <hr />

        {/* Usage info */}
        <div className={css.row}>
          <p>Expand the "⚙️" to filter or stack by region, user type, gender, bike type, or date, or toggle aggregation of rides or total ride minutes.</p>
          <h4>Examples</h4>
          <ul>
            <li><Link to="/?r=jh">JC + Hoboken</Link> (<Link to="/?r=jh&s=r">stacked</Link>)</li>
            <li><Link to="/?y=m&s=g&pct=&g=mf&d=1406-2102">Ride minute %'s, Men vs. Women</Link>, Jun '14 – Jan '21</li>
            <li><Link to="/?s=u&pct=">Annual vs. daily user %'s</Link></li>
            <li><Link to={RideableTypesExample}>Classic / E-bike ride minutes</Link> (<Link to={`${RideableTypesExample}&pct`}>stacked</Link>)</li>
            <li><Link to="/">Default view (system-wide rides over time)</Link></li>
          </ul>
          <p>This plot refreshes when <a href="https://www.citibikenyc.com/system-data" target="_blank" rel="noopener noreferrer">new data is published by Citi Bike</a> (typically the 1st or 2nd week of each month, covering the previous month).</p>
          <p><a href="https://github.com/hudcostreets/ctbk.dev" target="_blank" rel="noopener noreferrer">The GitHub repo</a> has more info as well as <a href="https://github.com/hudcostreets/ctbk.dev/issues" target="_blank" rel="noopener noreferrer">planned enhancements</a>. Data updates are performed <a href="https://github.com/hudcostreets/ctbk.dev/actions" target="_blank" rel="noopener noreferrer">by Github Actions</a>.</p>

          <hr />

          <h3 id="map">Map: Stations + Common Destinations</h3>
          <p>Tap a station to see where rides originating there go:</p>
          <iframe src="/stations" className={css.map} title="Stations map" />
          <p>(<Link to="/stations">Full screen version</Link>)</p>

          <hr />

          <h3 id="qc">🚧 Data-quality issues 🚧</h3>
          <p>Several things changed in February 2021 (presumably as part of <a href="https://www.lyft.com/blog/posts/lyft-becomes-americas-largest-bikeshare-service" target="_blank" rel="noopener noreferrer">the Lyft acquisition</a>):</p>
          <ul>
            <li>"Gender" information is no longer provided:
              <ul>
                <li>All rides are labeled "unknown" starting February 2021</li>
                <li><Link to="/?y=m&s=g&pct=&g=mf&d=1406-2102">Here's an example showing the available data</Link></li>
              </ul>
            </li>
            <li>JC/HOB e-bike data only begins in Feb '21 (vs. Jan '20 for NYC) (<Link to={RideableTypesExample}>example</Link>)</li>
            <li>The "User Type" values changed ("Annual" → "member", "Daily" → "casual"); I'm using the former/old values here, they seem equivalent.</li>
          </ul>

          <div className={css.footer}>
            Code: <a href="https://github.com/hudcostreets/ctbk.dev" target="_blank" rel="noopener noreferrer">
              <img src="/assets/gh.png" alt="GitHub" className={css.icon} style={{ width: '2em', marginRight: '1em' }} />
            </a>
            Data: <a href="https://s3.amazonaws.com/ctbk/index.html" target="_blank" rel="noopener noreferrer">
              <img src="/assets/s3.png" alt="S3" className={css.icon} style={{ width: '2em', marginRight: '1em' }} />
            </a>
            Author: <a href="https://bsky.app/profile/runsascoded.com" target="_blank" rel="noopener noreferrer">
              @runsascoded
            </a>
          </div>
        </div>
      </main>
    </div>
  )
}
