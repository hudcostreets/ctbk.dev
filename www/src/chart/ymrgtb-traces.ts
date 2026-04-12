/**
 * Pure trace-building logic for ymrgtb stacked-bar + rolling-avg charts.
 * Shared between the homepage (system-wide ymrgtb_cd.json) and the
 * station detail page (per-station ymdgtb_cd.json, filtered to one station).
 *
 * No React, no URL state — just data → Plotly traces.
 */
import type { Data } from 'plotly.js'
import {
  type Gender,
  type RideableType,
  type Region,
  type Row,
  type StackBy,
  type UserType,
  type YAxis,
  Colors,
  GenderRollingAvgCutoff,
  Int2Gender,
  NormalizeRideableType,
  UnknownRideableCutoff,
  UserTypeDisplayNames,
  annualizedPercents,
  annualPercentStr,
  rollingAvg,
  stackKeyDict,
  yAxisLabelDict,
} from '../data'

// Augmented row after lightweight preprocessing
export type ProcessedRow = Row & {
  m: string
  Rides: number
  'Ride minutes': number
  GenderStr: Gender
  RideableTypeStr: RideableType
}

export function processData(data: Row[]): ProcessedRow[] {
  return data.map((row) => ({
    ...row,
    m: `${row.Year}-${row.Month.toString().padStart(2, '0')}`,
    Rides: row.Count,
    'Ride minutes': row.Duration / 60,
    GenderStr: Int2Gender[row.Gender],
    RideableTypeStr: NormalizeRideableType[row['Rideable Type']] || 'Unknown',
  }))
}

export function monthToDate(ym: string): Date {
  const [year, month] = ym.split('-').map(Number)
  return new Date(year, month - 1, 1)
}

// Bar width in ms (roughly 25 days, leaves gaps between months for readability)
export const BAR_WIDTH_MS = 25 * 24 * 60 * 60 * 1000

export interface BuildTracesConfig {
  yAxis: YAxis
  stackBy: StackBy
  stackPercents: boolean
  regions: Region[]
  userTypes: UserType[]
  genders: Gender[]
  rideableTypes: RideableType[]
  /** Inclusive start YYYY-MM, exclusive end YYYY-MM. */
  start: string
  end: string
  rollingAvgs: number[]
  /** Theme colors — caller supplies based on light/dark mode. */
  isDark: boolean
  rollingAvgColor: string
  lineOutlineColor: string
  lineDarkenFactor: number
  /** Optional: additional filter (e.g. to restrict by Docking for station detail). */
  extraFilter?: (row: ProcessedRow) => boolean
}

export interface BuildTracesResult {
  traces: Data[]
  months: string[]
  allMonths: string[]
}

/** Darken a hex color by a factor in [0, 1]. */
function darken(hex: string, factor: number): string {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = Math.round(((n >> 16) & 0xff) * factor)
  const g = Math.round(((n >> 8) & 0xff) * factor)
  const b = Math.round((n & 0xff) * factor)
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function buildTraces(data: ProcessedRow[] | null, cfg: BuildTracesConfig): BuildTracesResult {
  if (!data) return { traces: [], months: [], allMonths: [] }

  const {
    yAxis, stackBy, stackPercents,
    regions, userTypes, genders, rideableTypes,
    start, end, rollingAvgs,
    isDark, rollingAvgColor, lineOutlineColor, lineDarkenFactor,
    extraFilter,
  } = cfg
  const isStacked = stackBy !== 'None'
  const { hoverLabel: yHoverLabel } = yAxisLabelDict[yAxis]

  // Filter by dimension (but NOT by date - we need full history for rolling avg)
  const dimensionFiltered = data.filter((row) =>
    regions.includes(row.Region) &&
    userTypes.includes(row['User Type']) &&
    genders.includes(row.GenderStr) &&
    rideableTypes.includes(row.RideableTypeStr) &&
    (!extraFilter || extraFilter(row))
  )

  const stackKeys = stackKeyDict[stackBy]
  const allGrouped: Record<string, Record<string, number>> = {}

  for (const row of dimensionFiltered) {
    const m = row.m
    let stackVal = ''
    if (stackBy === 'Region') stackVal = row.Region
    else if (stackBy === 'User Type') stackVal = row['User Type']
    else if (stackBy === 'Gender') stackVal = row.GenderStr
    else if (stackBy === 'Rideable Type') stackVal = row.RideableTypeStr
    else if (stackBy === 'Docking') stackVal = row.Docking ?? ''

    const val = row[yAxis]
    if (!allGrouped[m]) allGrouped[m] = {}
    allGrouped[m][stackVal] = (allGrouped[m][stackVal] || 0) + val
  }

  const allMonths = Object.keys(allGrouped).sort()
  const months = allMonths.filter((m) => m >= start && m < end)
  const grouped = allGrouped

  const colors = Colors[stackBy]
  const legendRanks: Record<string, number> = {}
  stackKeys.forEach((k, i) => { legendRanks[k] = -i })

  const getDisplayName = (val: string) =>
    stackBy === 'User Type' && val in UserTypeDisplayNames
      ? UserTypeDisplayNames[val as keyof typeof UserTypeDisplayNames]
      : val

  const monthDates = months.map(monthToDate)

  const barTraces = stackKeys
    .filter((key) => stackBy === 'None' || months.some((m) => grouped[m]?.[key]))
    .map((stackVal) => {
      const name = getDisplayName(stackVal) || yHoverLabel
      const customdata: ([number, number] | null)[] = []
      const y = months.map((m) => {
        const val = grouped[m]?.[stackVal] || 0
        if (val === 0) { customdata.push(null); return null }
        const total = Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
        const pct = total ? val / total : 0
        customdata.push([val, pct])
        return stackPercents ? pct : val
      })
      const hovertemplate = isStacked
        ? `${name}: %{customdata[0]:,.0f} (%{customdata[1]:.0%})<extra></extra>`
        : '%{customdata[0]:,.0f}<extra></extra>'
      return {
        x: monthDates,
        y,
        width: BAR_WIDTH_MS,
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

  const show12mo = rollingAvgs.includes(12)
  const rollingTraces: Data[] = []

  if (show12mo && months.length > 0) {
    const visibleStartIdx = allMonths.indexOf(months[0])
    const visibleEndIdx = visibleStartIdx + months.length

    if (visibleStartIdx < 0) {
      console.warn('Rolling avg: visible months not found in allMonths')
    } else if (stackBy === 'None') {
      const allTotals = allMonths.map((m) =>
        Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
      )
      const allAvgY = rollingAvg(allTotals, 12)
      const visibleAvgY = allAvgY.slice(visibleStartIdx, visibleEndIdx)

      annualizedPercents(months, visibleAvgY).forEach((p) => console.log(annualPercentStr(p)))

      rollingTraces.push({
        x: monthDates, y: visibleAvgY as (number | null)[],
        name: '12mo avg (outline)', type: 'scatter', mode: 'lines',
        line: { color: lineOutlineColor, width: 7 },
        hoverinfo: 'skip', showlegend: false, legendrank: 100,
      })
      rollingTraces.push({
        x: monthDates, y: visibleAvgY as (number | null)[],
        name: '12mo avg', type: 'scatter', mode: 'lines',
        line: { color: rollingAvgColor, width: 4 },
        hovertemplate: '12mo avg: %{y:,.0f}<extra></extra>',
        legendrank: 101,
      })
    } else {
      const clampEnd = stackBy === 'Gender' && end > GenderRollingAvgCutoff
        ? GenderRollingAvgCutoff
        : end

      stackKeys
        .filter((key) => allMonths.some((m) => grouped[m]?.[key]))
        .forEach((stackVal) => {
          let effectiveEnd = clampEnd
          if (stackBy === 'Rideable Type' && stackVal === 'Unknown' && end > UnknownRideableCutoff) {
            effectiveEnd = UnknownRideableCutoff
          }

          const allClampedMonths = allMonths.filter((m) => m < effectiveEnd)
          const rawValues = allClampedMonths.map((m) => grouped[m]?.[stackVal] || 0)
          const pctValues = allClampedMonths.map((m) => {
            const val = grouped[m]?.[stackVal] || 0
            const total = Object.values(grouped[m] || {}).reduce((a, b) => a + b, 0)
            return total ? val / total : 0
          })
          const avgRaw = rollingAvg(rawValues, 12)
          const avgPct = rollingAvg(pctValues, 12)

          const firstDataIdx = rawValues.findIndex((v) => v > 0)
          let lastDataIdx = -1
          for (let i = rawValues.length - 1; i >= 0; i--) {
            if (rawValues[i] > 0) { lastDataIdx = i; break }
          }

          const allAvgY = (stackPercents ? avgPct : avgRaw).map((v, i) => {
            if (firstDataIdx < 0 || i < firstDataIdx + 11) return null
            if (i > lastDataIdx) return null
            return v
          })
          const allCustomdata = avgRaw.map((raw, i) => allAvgY[i] === null ? null : [raw, avgPct[i]])

          const clampedVisibleStart = allClampedMonths.indexOf(months[0])
          const clampedMonths = allClampedMonths.filter((m) => m >= start && m < end && m < effectiveEnd)
          const clampedDates = clampedMonths.map(monthToDate)
          const avgY = clampedVisibleStart >= 0
            ? allAvgY.slice(clampedVisibleStart, clampedVisibleStart + clampedMonths.length)
            : []
          const customdata = clampedVisibleStart >= 0
            ? allCustomdata.slice(clampedVisibleStart, clampedVisibleStart + clampedMonths.length)
            : []

          if (!stackPercents) {
            const visibleAvgRaw = clampedVisibleStart >= 0
              ? avgRaw.slice(clampedVisibleStart, clampedVisibleStart + clampedMonths.length)
              : []
            annualizedPercents(clampedMonths, visibleAvgRaw).forEach((p) =>
              console.log(`${stackVal}: ${annualPercentStr(p)}`)
            )
          }

          const baseColor = colors[stackVal] || colors['']
          const color = stackVal === 'HOB' ? baseColor : darken(baseColor, lineDarkenFactor)
          const displayName = getDisplayName(stackVal)

          rollingTraces.push({
            x: clampedDates, y: avgY as (number | null)[],
            name: `${displayName} (12mo outline)`, type: 'scatter', mode: 'lines',
            line: { color: lineOutlineColor, width: 7 },
            hoverinfo: 'skip', showlegend: false,
            legendrank: 100 + 2 * (legendRanks[stackVal] || 0),
          })
          rollingTraces.push({
            x: clampedDates, y: avgY as (number | null)[],
            customdata: customdata as any,
            name: `${displayName} (12mo)`, type: 'scatter', mode: 'lines',
            line: { color, width: 4 },
            hovertemplate: `${displayName} (12mo): %{customdata[0]:,.0f} (%{customdata[1]:.0%})<extra></extra>`,
            legendrank: 101 + 2 * (legendRanks[stackVal] || 0),
          })
        })
    }
  }

  return { traces: [...barTraces, ...rollingTraces] as Data[], months, allMonths }
}
