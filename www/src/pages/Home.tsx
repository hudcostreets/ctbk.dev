import { Tooltip } from "@mui/material"
import { useUrlParam, boolParam, numberArrayParam } from '@rdub/use-url-params'
import { Data } from 'plotly.js'
import { ReactNode, useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import { Link, useLocation } from 'react-router-dom'
import { GitHubIcon, S3Icon, BlueskyIcon } from "@/components/icons"
import css from "../index.module.css"
import controlCss from "../controls.module.css"
import { Checkbox } from "../components/Checkbox"
import { Checklist } from "../components/Checklist"
import { Radios } from "../components/Radios"
import { useShortcutsModal } from "../contexts/ShortcutsModalContext"
import { useTheme } from "../contexts/ThemeContext"
import { darken } from "../colors"
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts"
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
  codesParam,
  NormalizeRideableType,
  RegionQueryStrings,
  Regions,
  RideableType,
  RideableTypeChars,
  RideableTypes,
  rollingAvg,
  Row,
  codeParam,
  StackBy,
  StackByQueryStrings,
  stackKeyDict,
  toYM,
  UnknownRideableCutoff,
  UserTypeDisplayNames,
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
  const { actualTheme, toggleTheme } = useTheme()

  const [data, setData] = useState<ProcessedRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // URL parameters with short code encoding (matching original Next.js version)
  // Note: params are re-read on each render, location dependency ensures this happens on navigation
  const [yAxis, setYAxis] = useUrlParam('y', codeParam<YAxis>('Rides', YAxisQueryStrings))
  const [stackBy, setStackBy] = useUrlParam('s', codeParam<StackBy>('None', StackByQueryStrings))
  const [stackRelative, setStackRelative] = useUrlParam('pct', boolParam)
  const [regions, setRegions] = useUrlParam('r', codesParam(Regions, RegionQueryStrings))
  const [userTypes, setUserTypes] = useUrlParam('u', codesParam(UserTypes, UserTypeQueryStrings))
  const [genders, setGenders] = useUrlParam('g', codesParam(Genders, GenderQueryStrings))
  const [rideableTypes, setRideableTypes] = useUrlParam('rt', codesParam(RideableTypes, RideableTypeChars))
  const [dateRange, setDateRange] = useUrlParam('d', dateRangeParam())
  const [rollingAvgs, setRollingAvgs] = useUrlParam('avg', numberArrayParam([12]))
  const [controlsClosed, setControlsClosed] = useUrlParam('cc', boolParam)  // Param present = closed
  const controlsOpen = !controlsClosed
  const setControlsOpen = (open: boolean) => setControlsClosed(!open)
  const [hideControls] = useUrlParam('nc', boolParam)  // For screenshots
  const [showLegend, setShowLegend] = useState<boolean | null>(null)
  const showLegendValue = showLegend === null ? (stackBy !== 'None' || rollingAvgs.length > 0) : showLegend
  const [windowWidth, setWindowWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 800)

  // Keyboard shortcuts
  const { open: openShortcutsModal } = useShortcutsModal()
  useKeyboardShortcuts({
    setDateRange,
    setStackBy,
    setYAxis,
    setRollingAvgs,
    rollingAvgs,
    setStackRelative,
    stackRelative,
    setShowLegend,
    showLegendValue,
    openShortcutsModal,
    setControlsOpen,
    controlsOpen,
    toggleTheme,
    setRegions,
    regions,
    setUserTypes,
    userTypes,
    setGenders,
    genders,
    setRideableTypes,
    rideableTypes,
  })

  // Update window width on resize
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

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
  const isStacked = stackBy !== 'None'
  const { hoverLabel: yHoverLabel, title } = yAxisLabelDict[yAxis]

  // Theme-based colors (needed for trace generation)
  const isDark = actualTheme === 'dark'
  const rollingAvgColor = isDark ? '#e0e0e0' : 'black'
  const lineOutlineColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.15)'
  const lineDarkenFactor = isDark ? 0.6 : 0.75

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
      parts.push(`${UserTypeDisplayNames[userType]}s`)
    }
    const byName = stackBy === 'None' ? undefined : (stackBy === 'Rideable Type' ? 'Bike Type' : stackBy)
    if (stackPercents && byName) parts.push(`% by ${byName}`)
    else if (stackPercents) parts.push('%')
    else if (byName) parts.push(`by ${byName}`)
    return parts.length ? parts.join(', ') : undefined
  }, [regions, rideableTypes, userTypes, stackPercents, stackBy])

  // Filter and aggregate data
  const { traces, months } = useMemo(() => {
    if (!data) return { traces: [], months: [] }

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

    // Map internal values to display names (for User Type)
    const getDisplayName = (val: string) =>
      stackBy === 'User Type' && val in UserTypeDisplayNames
        ? UserTypeDisplayNames[val as keyof typeof UserTypeDisplayNames]
        : val

    const barTraces = stackKeys
      .filter(key => stackBy === 'None' || months.some(m => grouped[m]?.[key]))
      .map(stackVal => {
        const name = getDisplayName(stackVal) || yHoverLabel
        const customdata: ([number, number] | null)[] = []
        const y = months.map(m => {
          const val = grouped[m]?.[stackVal] || 0
          if (val === 0) {
            customdata.push(null)
            return null
          }
          const total = Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
          const pct = total ? val / total : 0
          customdata.push([val, pct])
          return stackPercents ? pct : val
        })
        // Show both count and percentage when stacked, just count when not stacked
        const hovertemplate = isStacked
          ? `${name}: %{customdata[0]:,.0f} (%{customdata[1]:.0%})<extra></extra>`
          : '%{customdata[0]:,.0f}<extra></extra>'
        return {
          x: months,
          y,
          customdata,
          name,
          type: 'bar' as const,
          marker: {
            color: colors[stackVal] || colors[''],
            line: { color: isDark ? 'rgba(0,0,0,1)' : 'rgba(255,255,255,1)', width: .5 },
          },
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
        // Shadow trace (thicker, contrasting color for outline effect)
        rollingTraces.push({
          x: months,
          y: avgY as (number | null)[],
          name: '12mo avg (outline)',
          type: 'scatter',
          mode: 'lines',
          line: { color: lineOutlineColor, width: 7 },
          hoverinfo: 'skip',
          showlegend: false,
          legendrank: 100,
        })
        // Main trace
        rollingTraces.push({
          x: months,
          y: avgY as (number | null)[],
          name: '12mo avg',
          type: 'scatter',
          mode: 'lines',
          line: { color: rollingAvgColor, width: 4 },
          hovertemplate: '12mo avg: %{y:,.0f}<extra></extra>',
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
            // Compute both raw values and percentages for customdata
            const rawValues = clampedMonths.map(m => grouped[m]?.[stackVal] || 0)
            const pctValues = clampedMonths.map(m => {
              const val = grouped[m]?.[stackVal] || 0
              const total = Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
              return total ? val / total : 0
            })
            const avgRaw = rollingAvg(rawValues, 12)
            const avgPct = rollingAvg(pctValues, 12)

            // Find first and last months with actual data for this series
            const firstDataIdx = rawValues.findIndex(v => v > 0)
            let lastDataIdx = -1
            for (let i = rawValues.length - 1; i >= 0; i--) {
              if (rawValues[i] > 0) { lastDataIdx = i; break }
            }

            // Null out rolling avg where series hasn't started (need 12 months of data) or has ended
            const avgY = (stackPercents ? avgPct : avgRaw).map((v, i) => {
              // Need 12 months of data before showing rolling avg (firstDataIdx + 11)
              if (firstDataIdx < 0 || i < firstDataIdx + 11) return null
              // Don't show after series ends
              if (i > lastDataIdx) return null
              return v
            })
            // Combine into customdata for tooltips (null where avgY is null)
            const customdata = avgRaw.map((raw, i) => avgY[i] === null ? null : [raw, avgPct[i]])

            // Log annualized percents (use raw values for growth calculation)
            if (!stackPercents) {
              annualizedPercents(clampedMonths, avgRaw).forEach(p =>
                console.log(`${stackVal}: ${annualPercentStr(p)}`)
              )
            }

            const baseColor = colors[stackVal] || colors['']
            // HOB's light blue gets lost against JC's purple bars, so keep it unchanged
            const color = stackVal === 'HOB' ? baseColor : darken(baseColor, lineDarkenFactor)
            const displayName = getDisplayName(stackVal)
            // Shadow trace (thicker, contrasting color for outline effect)
            rollingTraces.push({
              x: clampedMonths,
              y: avgY as (number | null)[],
              name: `${displayName} (12mo outline)`,
              type: 'scatter',
              mode: 'lines',
              line: { color: lineOutlineColor, width: 7 },
              hoverinfo: 'skip',
              showlegend: false,
              legendrank: 100 + 2 * (legendRanks[stackVal] || 0),
            })
            // Main trace - show both count and percentage in tooltip
            rollingTraces.push({
              x: clampedMonths,
              y: avgY as (number | null)[],
              customdata: customdata as any,
              name: `${displayName} (12mo)`,
              type: 'scatter',
              mode: 'lines',
              line: { color, width: 4 },
              hovertemplate: `${displayName} (12mo): %{customdata[0]:,.0f} (%{customdata[1]:.0%})<extra></extra>`,
              legendrank: 101 + 2 * (legendRanks[stackVal] || 0),
            })
          })
      }
    }

    return { traces: [...barTraces, ...rollingTraces] as Data[], months }
  }, [data, yAxis, stackBy, stackPercents, isStacked, regions, userTypes, genders, rideableTypes, start, end, rollingAvgs, yHoverLabel, rollingAvgColor, lineOutlineColor, lineDarkenFactor])

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

  const gridcolor = isDark ? '#505050' : '#ccc'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  // Adaptive tick intervals based on date range AND viewport width
  const totalMonths = months.length
  // Estimate max ticks that fit comfortably (~50px per tick with rotation)
  const estimatedPlotWidth = windowWidth * 0.9
  const maxTicks = Math.floor(estimatedPlotWidth / 50)

  let tickMonths: string[]
  let tickLabels: string[]
  let tickFormat: 'quarterly' | 'semiannual' | 'annual'

  // Choose tick interval based on both date range and available space
  const quarterlyTicks = Math.ceil(totalMonths / 3)
  const semiAnnualTicks = Math.ceil(totalMonths / 6)

  if (quarterlyTicks <= maxTicks && totalMonths <= 60) {
    // Quarterly ticks (Jan, Apr, Jul, Oct) - if they fit and ≤5 years
    tickFormat = 'quarterly'
    tickMonths = months.filter(m => m.endsWith('-01') || m.endsWith('-04') || m.endsWith('-07') || m.endsWith('-10'))
    tickLabels = tickMonths.map(m => {
      const mo = m.slice(5, 7)
      const yr = m.slice(2, 4)
      const moName = mo === '01' ? 'Jan' : mo === '04' ? 'Apr' : mo === '07' ? 'Jul' : 'Oct'
      return `${moName} '${yr}`
    })
  } else if (semiAnnualTicks <= maxTicks && totalMonths <= 144) {
    // Semi-annual ticks (Jan, Jul) with consistent month prefix
    tickFormat = 'semiannual'
    tickMonths = months.filter(m => m.endsWith('-01') || m.endsWith('-07'))
    tickLabels = tickMonths.map(m => {
      const mo = m.slice(5, 7)
      const yr = m.slice(2, 4)
      return mo === '01' ? `Jan '${yr}` : `Jul '${yr}`
    })
  } else {
    // Annual ticks (Jan only)
    tickFormat = 'annual'
    tickMonths = months.filter(m => m.endsWith('-01'))
    tickLabels = tickMonths.map(m => `'${m.slice(2, 4)}`)
  }

  const layout = {
    autosize: true,
    barmode: 'stack' as const,
    bargap: 0,  // No gaps - use marker.line for visual separation instead
    dragmode: false as const,  // Disable drag pan/zoom
    showlegend: showLegendValue,
    hovermode: 'x' as const,
    legend: {
      x: 0.5,
      xanchor: 'center' as const,
      yanchor: 'top' as const,
      orientation: 'h' as const,
      traceorder: 'normal' as const,
      font: { color: tickcolor },
    },
    xaxis: {
      type: 'category' as const,
      tickfont: { size: 12, color: tickcolor },
      titlefont: { size: 14 },
      tickangle: -45,
      tickmode: 'array' as const,
      tickvals: tickMonths,
      ticktext: tickLabels,
      gridcolor,
    },
    yaxis: {
      automargin: true,
      gridcolor,
      tickfont: { size: 14, color: tickcolor },
      titlefont: { size: 14 },
      tickformat: stackPercents ? '.0%' : undefined,
      range: stackPercents ? [0, 1.01] : undefined,
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    // Bottom margin varies by tick label length: annual "'YY" needs less room than "MMM 'YY"
    margin: { t: 0, r: 0, b: tickFormat === 'annual' ? 40 : 70, l: 0, },
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
          className={css.plot}
          config={{ displayModeBar: false, scrollZoom: false }}
        />

        {!hideControls && (
        <div className={css.row}>
          <details
            className={css.controls}
            open={controlsOpen}
            onToggle={(e) => setControlsOpen((e.target as HTMLDetailsElement).open)}
          >
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
                label: region,
                data: region,
                checked: regions.includes(region),
              }))}
              cb={setRegions}
            />

            <Radios
              label="Stack by"
              options={[
                { label: "None", data: "None" },
                { label: "Region", data: "Region" },
                { label: "User Type", data: "User Type" },
                { label: <>{GenderLabel(1)}</>, data: "Gender" },
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
              options={[
                { label: "Rides", data: "Rides" },
                { label: "Minutes", data: "Ride minutes" },
              ]}
              cb={setYAxis}
              choice={yAxis}
            />

            <Checklist
              label="User Type"
              data={UserTypes.map(userType => ({
                name: userType,
                label: UserTypeDisplayNames[userType],
                data: userType,
                checked: userTypes.includes(userType),
              }))}
              cb={setUserTypes}
            />

            <Checklist
              label={GenderLabel(2)}
              data={[
                { name: 'Men', label: 'Men', data: 'Men' as Gender, checked: genders.includes('Men') },
                { name: 'Women', label: 'Women', data: 'Women' as Gender, checked: genders.includes('Women') },
                { name: 'Unknown', label: 'Unknown', data: 'Unknown' as Gender, checked: genders.includes('Unknown') },
              ]}
              cb={setGenders}
            />

            <Checklist
              label="Bike Type"
              data={[
                { name: 'Classic', label: 'Classic', data: 'Classic' as RideableType, checked: rideableTypes.includes('Classic') },
                { name: 'Electric', label: 'Electric', data: 'Electric' as RideableType, checked: rideableTypes.includes('Electric') },
                { name: 'Unknown', label: 'Unknown', data: 'Unknown' as RideableType, checked: rideableTypes.includes('Unknown') },
              ]}
              cb={setRideableTypes}
            />
          </details>
        </div>
        )}

        <hr />

        {/* Usage info */}
        <div className={css.row}>
          <h4>Examples</h4>
          <ul>
            <li><Link to="/?r=jh">JC + Hoboken</Link> (<Link to="/?r=jh&s=r">stacked</Link>)</li>
            <li><Link to="/?y=m&s=g&pct=&g=mf&d=1406-2102">Ride minute %'s, Men vs. Women</Link>, Jun '14 – Jan '21</li>
            <li><Link to="/?s=u&pct=">Member vs. customer %'s</Link></li>
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

          <h3 id="pipeline">Data Pipeline</h3>
          <p>See the <Link to="/pipeline">pipeline documentation</Link> for details on data processing stages, sources, and <Link to="/pipeline#legacy-data">data-quality issues</Link> (e.g. gender data removed in 2021).</p>

          <div className={css.footer}>
            Code: <a href="https://github.com/hudcostreets/ctbk.dev" target="_blank" rel="noopener noreferrer">
              <GitHubIcon className={css.icon} />
            </a>
            Data: <a href="https://s3.amazonaws.com/ctbk/index.html" target="_blank" rel="noopener noreferrer">
              <S3Icon className={css.icon} />
            </a>
            Author: <a href="https://bsky.app/profile/runsascoded.com" target="_blank" rel="noopener noreferrer">
              <BlueskyIcon className={css.icon} />
            </a>
          </div>
        </div>
      </main>
    </div>
  )
}
