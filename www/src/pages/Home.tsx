import { Tooltip } from "@mui/material"
import { useUrlState, boolParam, numberArrayParam } from 'use-prms'
import { PlotRelayoutEvent } from 'plotly.js'
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Plot } from 'pltly/react'
import { Link, useLocation } from 'react-router-dom'
import { GitHubIcon, S3Icon, BlueskyIcon } from "@/components/icons"
import css from "../index.module.css"
import controlCss from "../controls.module.css"
import { Checkbox } from "../components/Checkbox"
import { Checklist } from "../components/Checklist"
import MonthRangePicker from "../components/MonthRangePicker"
import StationMapEmbed from "../components/StationMapEmbed"
import { Radios } from "../components/Radios"
import { useTheme } from "../contexts/ThemeContext"
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts"
import { DateRange2Dates, dateRangeParam, parseDuration, isDurationBased, isExplicitRange, formatDuration } from "../date-range"
import {
  Gender,
  GenderQueryStrings,
  Genders,
  codesParam,
  RegionQueryStrings,
  Regions,
  RideableType,
  RideableTypeChars,
  RideableTypes,
  Row,
  codeParam,
  StackBy,
  StackByQueryStrings,
  toYM,
  UserTypeDisplayNames,
  UserTypeQueryStrings,
  UserTypes,
  YAxis,
  YAxisQueryStrings,
  yAxisLabelDict,
} from '../data'
import { buildTraces, monthToDate, processData, type ProcessedRow } from '../chart/ymrgtb-traces'
import { buildLayout } from '../chart/ymrgtb-layout'

const DATA_URL = '/assets/ymrgtb_cd.json'

// Convert "YYYY-MM" to Date (first day of month)
// Convert Date to "YYYY-MM" string (used for duration-based snap logic)
function dateToMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
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
  const [yAxis, setYAxis] = useUrlState('y', codeParam<YAxis>('Rides', YAxisQueryStrings))
  const [stackBy, setStackBy] = useUrlState('s', codeParam<StackBy>('None', StackByQueryStrings))
  const [stackRelative, setStackRelative] = useUrlState('pct', boolParam)
  const [regions, setRegions] = useUrlState('r', codesParam(Regions, RegionQueryStrings))
  const [userTypes, setUserTypes] = useUrlState('u', codesParam(UserTypes, UserTypeQueryStrings))
  const [genders, setGenders] = useUrlState('g', codesParam(Genders, GenderQueryStrings))
  const [rideableTypes, setRideableTypes] = useUrlState('rt', codesParam(RideableTypes, RideableTypeChars))
  const [dateRange, setDateRange] = useUrlState('d', dateRangeParam())
  const [rollingAvgs, setRollingAvgs] = useUrlState('avg', numberArrayParam([12]))
  const [controlsClosed, setControlsClosed] = useUrlState('cc', boolParam)  // Param present = closed
  const controlsOpen = !controlsClosed
  const setControlsOpen = (open: boolean) => setControlsClosed(!open)
  const [screenshotMode] = useUrlState('screenshot', boolParam)  // Hides gear/controls for screenshots
  const [showLegend, setShowLegend] = useState<boolean | null>(null)
  const showLegendValue = showLegend === null ? (stackBy !== 'None' || rollingAvgs.length > 0) : showLegend
  const [windowWidth, setWindowWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 800)
  const [snapCounter, setSnapCounter] = useState(0)  // Increment to force Plotly to reset after snap

  // Keyboard shortcuts
  useKeyboardShortcuts({
    dateRange,
    setDateRange,
    setStackBy,
    setYAxis,
    setRollingAvgs,
    rollingAvgs,
    setStackRelative,
    stackRelative,
    setShowLegend,
    showLegendValue,
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
  const { title } = yAxisLabelDict[yAxis]

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

  // Filter and aggregate data (extracted to chart/ymrgtb-traces.ts)
  const { traces, months, allMonths } = useMemo(() => buildTraces(data, {
    yAxis, stackBy, stackPercents,
    regions, userTypes, genders, rideableTypes,
    start, end, rollingAvgs,
    isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor,
  }), [data, yAxis, stackBy, stackPercents, regions, userTypes, genders, rideableTypes, start, end, rollingAvgs, isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor])

  // Compute data bounds for pan constraints
  const dataBounds = useMemo(() => {
    if (allMonths.length === 0) return null
    const firstMonth = allMonths[0]
    const lastMonth = allMonths[allMonths.length - 1]
    return {
      start: monthToDate(firstMonth),
      end: monthToDate(lastMonth),
    }
  }, [allMonths])

  // Handle pan/zoom relayout events - preserve duration, update end date
  const handleRelayout = useCallback((event: PlotRelayoutEvent) => {
    const x0 = event['xaxis.range[0]']
    const x1 = event['xaxis.range[1]']

    if (x0 !== undefined && x1 !== undefined && dataBounds) {
      // If in "All" mode, snap back - don't allow panning
      if (dateRange === "All") {
        setSnapCounter(c => c + 1)
        return
      }

      const newEnd = new Date(x1 as unknown as string)

      // Get duration - preserve existing or compute from explicit range
      let durationMonths: number
      let durationStr: string
      if (isDurationBased(dateRange)) {
        durationStr = dateRange.duration
        durationMonths = parseDuration(durationStr)
      } else if (isExplicitRange(dateRange)) {
        // Compute duration from explicit range, then convert to duration-based for panning
        const explicitEnd = dateRange.end || dataBounds.end
        durationMonths = (explicitEnd.getFullYear() - dateRange.start.getFullYear()) * 12 +
          (explicitEnd.getMonth() - dateRange.start.getMonth())
        durationStr = formatDuration(durationMonths)
      } else {
        return // Shouldn't happen
      }

      // Calculate the minimum end date that allows full duration to be shown
      const minEnd = new Date(dataBounds.start)
      minEnd.setMonth(minEnd.getMonth() + durationMonths)

      // Clamp end: not before minEnd (so full duration fits), not after dataBounds.end
      let clampedEnd = newEnd
      let snapped = false
      if (clampedEnd < minEnd) {
        clampedEnd = minEnd
        snapped = true
      }
      if (clampedEnd > dataBounds.end) {
        clampedEnd = dataBounds.end
        snapped = true
      }

      // Check if we're effectively showing all data
      const fullDurationMonths = (dataBounds.end.getFullYear() - dataBounds.start.getFullYear()) * 12 +
        (dataBounds.end.getMonth() - dataBounds.start.getMonth())
      if (durationMonths >= fullDurationMonths) {
        setDateRange("All")
        return
      }

      // Set new date range with preserved duration and clamped end
      const endMonth = dateToMonth(clampedEnd)
      const endDate = monthToDate(endMonth)
      // Add 1 month since our end is exclusive
      endDate.setMonth(endDate.getMonth() + 1)

      // If we snapped, increment counter to force Plotly to reset
      if (snapped) {
        setSnapCounter(c => c + 1)
      }

      setDateRange({ duration: durationStr, end: endDate })
    }
  }, [dataBounds, dateRange, setDateRange])

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

  // Generate a revision key that changes when date range, y-axis scale, or snap changes
  // This forces Plotly to reset its UI state (including pan/zoom) to our specified ranges
  const uiRevision = (() => {
    const suffix = `${snapCounter}-${stackPercents}-${yAxis}`
    if (dateRange === "All") return `All-${suffix}`
    if (isDurationBased(dateRange)) {
      return `dur-${dateRange.duration}-${dateRange.end?.getTime() ?? "present"}-${suffix}`
    }
    return `exp-${dateRange.start.getTime()}-${dateRange.end?.getTime() ?? "present"}-${suffix}`
  })()

  const layout = buildLayout({
    months,
    plotWidth: windowWidth,
    stackPercents,
    showLegend: showLegendValue,
    tickcolor, gridcolor,
    uiRevision,
  })

  // Duration buttons - clicking sets duration anchored to present
  const durationButtons = ["1y", "2y", "3y", "4y", "5y"] as const
  const currentDuration = dateRange === "All" ? null
    : isDurationBased(dateRange) ? dateRange.duration
    : null  // Explicit ranges don't have a fixed duration button

  // Check if a duration button is active (matches current duration)
  const isDurationActive = (dur: string) => currentDuration === dur

  return (
    <div id="plot" className={css.container}>
      <main className={css.main}>
        <div className={css.titleContainer}>
          <h1 className={css.title}>{title}</h1>
          {subtitle && <p className={css.subtitle}>{subtitle}</p>}
        </div>

        <div className={css.plot}>
          <Plot
            data={traces}
            layout={layout}
            style={{ height: '100%' }}
            config={{ displayModeBar: false, scrollZoom: false }}
            onRelayout={handleRelayout}
          />
        </div>

        {!screenshotMode && (
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
              {durationButtons.map(dur => (
                <input
                  type="button"
                  key={dur}
                  value={dur}
                  className={`${css.dateRangeButton} ${isDurationActive(dur) ? css.activeButton : css.inactiveButton}`}
                  onClick={() => {
                    // Preserve end from current range (whether duration-based or explicit)
                    const currentEnd = dateRange === "All" ? undefined
                      : isDurationBased(dateRange) ? dateRange.end
                      : dateRange.end  // explicit range
                    setDateRange({ duration: dur, end: currentEnd })
                  }}
                />
              ))}
              <input
                type="button"
                value="All"
                className={`${css.dateRangeButton} ${dateRange === "All" ? css.activeButton : css.inactiveButton}`}
                onClick={() => setDateRange("All")}
              />
              <MonthRangePicker
                start={isExplicitRange(dateRange) ? dateRange.start : undefined}
                end={
                  dateRange === "All"
                    ? undefined
                    : isExplicitRange(dateRange) || isDurationBased(dateRange)
                      ? dateRange.end
                      : undefined
                }
                minDate={dataBounds?.start}
                maxDate={dataBounds?.end}
                onChange={(newStart, newEnd) => {
                  if (newStart) {
                    setDateRange({ start: newStart, end: newEnd })
                  } else if (newEnd) {
                    setDateRange({ start: dataBounds?.start ?? new Date(2013, 5, 1), end: newEnd })
                  } else {
                    setDateRange("All")
                  }
                }}
              />
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
          <StationMapEmbed mapClassName={css.map} />
          <p>(<Link to="/stations">Full screen version</Link>)</p>

          <hr />

          <h3 id="pipeline">Data Pipeline</h3>
          <p>See the <Link to="/pipeline">pipeline documentation</Link> for details on data processing stages, sources, and <Link to="/pipeline#legacy-data">data-quality issues</Link> (e.g. gender data removed since 2021-02).</p>

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
