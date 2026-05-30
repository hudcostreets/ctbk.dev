/**
 * Phase 1a parity preview: same chart as Home, but powered by
 * `/api/rides-v1` (pyrmts-geo) instead of the static `ymrgtb_cd.json`.
 *
 * Region picker + Region stack-by are hidden — phase 1b adds the
 * h3-covering filter per region. Until then `/v2` queries the
 * system-wide bbox and reports totals across all 3 regions.
 *
 * Validates: temporal binning, dim aggregation (User Type / Gender /
 * Bike Type), and that pyrmts numerics match the static-JSON ground
 * truth. Once parity is comfortable, phase 1c cuts `/` over and
 * deletes this file.
 */
import { Alert } from "@mui/material"
import { useUrlState, boolParam, numberArrayParam } from 'use-prms'
import { PlotRelayoutEvent } from 'plotly.js'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plot } from 'pltly/react'
import { useLocation } from 'react-router-dom'
import css from "../index.module.css"
import controlCss from "../controls.module.css"
import { Checkbox } from "../components/Checkbox"
import { Checklist } from "../components/Checklist"
import MonthRangePicker from "../components/MonthRangePicker"
import { Radios } from "../components/Radios"
import { useTheme } from "../contexts/ThemeContext"
import { DateRange2Dates, dateRangeParam, parseDuration, isDurationBased, isExplicitRange, formatDuration } from "../date-range"
import {
  Gender,
  GenderQueryStrings,
  Genders,
  codesParam,
  Regions,
  RideableType,
  RideableTypeChars,
  RideableTypes,
  codeParam,
  StackBy,
  toYM,
  UserTypeDisplayNames,
  UserTypeQueryStrings,
  UserTypes,
  YAxis,
  YAxisQueryStrings,
  yAxisLabelDict,
} from '../data'
import { buildTraces, monthToDate } from '../chart/ymrgtb-traces'
import { buildLayout } from '../chart/ymrgtb-layout'
import { useRidesV1 } from '../query/ridesV1'

function dateToMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// `Region` and `Docking` stack options are intentionally absent — phase 1b.
type StackByV2 = Exclude<StackBy, 'Region' | 'Docking'>
const StackByV2QueryStrings: [StackByV2, string][] = [
  ['None', 'n'],
  ['Gender', 'g'],
  ['User Type', 'u'],
  ['Rideable Type', 'b'],
]

export default function HomeV2() {
  useLocation()
  const { actualTheme } = useTheme()

  const [yAxis, setYAxis] = useUrlState('y', codeParam<YAxis>('Rides', YAxisQueryStrings))
  const [stackBy, setStackBy] = useUrlState('s', codeParam<StackByV2>('None', StackByV2QueryStrings))
  const [stackRelative, setStackRelative] = useUrlState('pct', boolParam)
  const [userTypes, setUserTypes] = useUrlState('u', codesParam(UserTypes, UserTypeQueryStrings))
  const [genders, setGenders] = useUrlState('g', codesParam(Genders, GenderQueryStrings))
  const [rideableTypes, setRideableTypes] = useUrlState('rt', codesParam(RideableTypes, RideableTypeChars))
  const [dateRange, setDateRange] = useUrlState('d', dateRangeParam())
  const [rollingAvgs, setRollingAvgs] = useUrlState('avg', numberArrayParam([12]))
  const [controlsClosed, setControlsClosed] = useUrlState('cc', boolParam)
  const controlsOpen = !controlsClosed
  const setControlsOpen = (open: boolean) => setControlsClosed(!open)
  const [showLegend, setShowLegend] = useState<boolean | null>(null)
  const showLegendValue = showLegend === null ? (stackBy !== 'None' || rollingAvgs.length > 0) : showLegend
  const [windowWidth, setWindowWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 800)
  const [snapCounter, setSnapCounter] = useState(0)

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const { data, isLoading, error } = useRidesV1()

  const { start, end } = useMemo(() => {
    if (!data || data.length === 0) return { start: '', end: '' }
    const maxDate = data.reduce((max, r) => {
      const d = new Date(r.Year, r.Month - 1)
      return d > max ? d : max
    }, new Date(0))
    const lastPlusOne = new Date(maxDate)
    lastPlusOne.setMonth(lastPlusOne.getMonth() + 1)
    const { start: startD, end: endD } = DateRange2Dates(dateRange, lastPlusOne)
    return { start: toYM(startD), end: toYM(endD) }
  }, [data, dateRange])

  const stackPercents = stackRelative && stackBy !== 'None'
  const { title } = yAxisLabelDict[yAxis]

  const isDark = actualTheme === 'dark'
  const rollingAvgColor = isDark ? '#e0e0e0' : 'black'
  const lineOutlineColor = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.15)'
  const lineDarkenFactor = isDark ? 0.6 : 0.75

  const { traces, months, allMonths } = useMemo(() => buildTraces(data ?? null, {
    yAxis, stackBy, stackPercents,
    // Phase 1a: region filter is a no-op (every synthetic row has Region='NYC').
    regions: Regions,
    userTypes, genders, rideableTypes,
    start, end, rollingAvgs,
    isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor,
  }), [data, yAxis, stackBy, stackPercents, userTypes, genders, rideableTypes, start, end, rollingAvgs, isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor])

  const dataBounds = useMemo(() => {
    if (allMonths.length === 0) return null
    return {
      start: monthToDate(allMonths[0]),
      end: monthToDate(allMonths[allMonths.length - 1]),
    }
  }, [allMonths])

  const handleRelayout = useCallback((event: PlotRelayoutEvent) => {
    const x0 = event['xaxis.range[0]']
    const x1 = event['xaxis.range[1]']
    if (x0 === undefined || x1 === undefined || !dataBounds) return
    if (dateRange === "All") {
      setSnapCounter(c => c + 1)
      return
    }
    const newEnd = new Date(x1 as unknown as string)
    let durationMonths: number
    let durationStr: string
    if (isDurationBased(dateRange)) {
      durationStr = dateRange.duration
      durationMonths = parseDuration(durationStr)
    } else if (isExplicitRange(dateRange)) {
      const explicitEnd = dateRange.end || dataBounds.end
      durationMonths = (explicitEnd.getFullYear() - dateRange.start.getFullYear()) * 12 +
        (explicitEnd.getMonth() - dateRange.start.getMonth())
      durationStr = formatDuration(durationMonths)
    } else {
      return
    }
    const minEnd = new Date(dataBounds.start)
    minEnd.setMonth(minEnd.getMonth() + durationMonths)
    let clampedEnd = newEnd
    let snapped = false
    if (clampedEnd < minEnd) { clampedEnd = minEnd; snapped = true }
    if (clampedEnd > dataBounds.end) { clampedEnd = dataBounds.end; snapped = true }
    const fullDurationMonths = (dataBounds.end.getFullYear() - dataBounds.start.getFullYear()) * 12 +
      (dataBounds.end.getMonth() - dataBounds.start.getMonth())
    if (durationMonths >= fullDurationMonths) {
      setDateRange("All")
      return
    }
    const endMonth = dateToMonth(clampedEnd)
    const endDate = monthToDate(endMonth)
    endDate.setMonth(endDate.getMonth() + 1)
    if (snapped) setSnapCounter(c => c + 1)
    setDateRange({ duration: durationStr, end: endDate })
  }, [dataBounds, dateRange, setDateRange])

  if (isLoading) {
    return <div className={css.container}><main className={css.main}><h1 className={css.title}>Loading…</h1></main></div>
  }
  if (error) {
    return <div className={css.container}><main className={css.main}><h1 className={css.title}>Error: {error.message}</h1></main></div>
  }

  const gridcolor = isDark ? '#505050' : '#ccc'
  const tickcolor = isDark ? '#e0e0e0' : '#333'

  const uiRevision = (() => {
    const suffix = `${snapCounter}-${stackPercents}-${yAxis}`
    if (dateRange === "All") return `All-${suffix}`
    if (isDurationBased(dateRange)) return `dur-${dateRange.duration}-${dateRange.end?.getTime() ?? "present"}-${suffix}`
    return `exp-${dateRange.start.getTime()}-${dateRange.end?.getTime() ?? "present"}-${suffix}`
  })()
  const yAxisRevision = [
    stackBy,
    [...userTypes].sort().join(','),
    [...genders].sort().join(','),
    [...rideableTypes].sort().join(','),
    rollingAvgs.join(','),
  ].join('|')

  const layout = buildLayout({
    months, plotWidth: windowWidth, stackPercents, showLegend: showLegendValue,
    tickcolor, gridcolor, isDark, uiRevision, yAxisRevision,
  })

  const durationButtons = ["1y", "2y", "3y", "4y", "5y"] as const
  const currentDuration = dateRange === "All" ? null
    : isDurationBased(dateRange) ? dateRange.duration : null
  const isDurationActive = (dur: string) => currentDuration === dur

  return (
    <div id="plot" className={css.container}>
      <main className={css.main}>
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>v2 parity preview</strong> — data served live from{' '}
          <code>/api/rides-v1</code> (pyrmts-geo). Region picker + region
          stacking arrive next; for now this is system-wide totals.
        </Alert>
        <div className={css.titleContainer}>
          <h1 className={css.title}>{title}</h1>
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
        <div className={css.row}>
          <details
            className={css.controls}
            open={controlsOpen}
            onToggle={(e) => setControlsOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary><span className={css.settingsGear}>⚙</span>️</summary>

            <div className={`${css.dateControls} ${controlCss.control}`}>
              <label className={controlCss.controlHeader}>Dates</label>
              {durationButtons.map(dur => (
                <input
                  type="button" key={dur} value={dur}
                  className={`${css.dateRangeButton} ${isDurationActive(dur) ? css.activeButton : css.inactiveButton}`}
                  onClick={() => {
                    const currentEnd = dateRange === "All" ? undefined
                      : isDurationBased(dateRange) ? dateRange.end : dateRange.end
                    setDateRange({ duration: dur, end: currentEnd })
                  }}
                />
              ))}
              <input
                type="button" value="All"
                className={`${css.dateRangeButton} ${dateRange === "All" ? css.activeButton : css.inactiveButton}`}
                onClick={() => setDateRange("All")}
              />
              <MonthRangePicker
                start={isExplicitRange(dateRange) ? dateRange.start : undefined}
                end={dateRange === "All" ? undefined
                  : isExplicitRange(dateRange) || isDurationBased(dateRange) ? dateRange.end : undefined}
                minDate={dataBounds?.start}
                maxDate={dataBounds?.end}
                onChange={(newStart, newEnd) => {
                  if (newStart) setDateRange({ start: newStart, end: newEnd })
                  else if (newEnd) setDateRange({ start: dataBounds?.start ?? new Date(2013, 5, 1), end: newEnd })
                  else setDateRange("All")
                }}
              />
            </div>

            <Radios
              label="Stack by"
              options={[
                { label: "None", data: "None" },
                { label: "User Type", data: "User Type" },
                { label: "Gender", data: "Gender" },
                { label: "Bike Type", data: "Rideable Type" },
              ]}
              cb={setStackBy as (v: StackBy) => void}
              choice={stackBy}
            />

            <div className={controlCss.control}>
              <Checkbox label="12mo avg" checked={rollingAvgs.includes(12)} cb={v => setRollingAvgs(v ? [12] : [])} />
              <Checkbox label="Legend" checked={showLegendValue} cb={setShowLegend} />
              <Checkbox label="Stack %" checked={stackRelative} cb={setStackRelative} />
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
                name: userType, label: UserTypeDisplayNames[userType],
                data: userType, checked: userTypes.includes(userType),
              }))}
              cb={setUserTypes}
            />

            <Checklist
              label="Gender"
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
      </main>
    </div>
  )
}
