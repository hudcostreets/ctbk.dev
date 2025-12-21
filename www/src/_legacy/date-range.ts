import { Param } from "@rdub/next-params/params"
import _ from "lodash"
import moment from "moment"

export type HandleUnexpectedValue = 'Default' | 'Warn' | 'Throw'

export function returnDefaultOrError<D>(value: any, rv: D, handleUnexpectedValue: HandleUnexpectedValue): D {
  if (handleUnexpectedValue === 'Default') {
    return rv
  } else {
    const error = `Unexpected value ${value} in decoded query param; returning default ${rv}`
    if (handleUnexpectedValue === 'Warn') {
      console.error(error)
      return rv
    } else {
      throw new Error(error)
    }
  }
}

export type DateRange = 'All' | '1y' | '2y' | '3y' | '4y' | '5y' | { start?: Date, end?: Date }

const StartDate = moment('2013-06-01').toDate()
const Date2Query = (d: Date | undefined) => d ? moment(d).format('YYMM') : ''
const Query2Date = (s: string) => {
  const year = `20${s.substring(0, 2)}`
  const month = s.substring(2, 4)
  return moment(`${year}-${month}-01`).toDate()
}

export function dateRangeIncludes(dr: DateRange, ym: string | Date) {
  const date: Date = typeof ym === 'string' ? new Date(ym) : ym
  const { start, end } = DateRange2Dates(dr)
  return start <= date && date < end
}

export const DateRange2Dates = (dateRange: DateRange, end?: Date): { start: Date, end: Date, } => {
  end = end ? end : new Date
  if (dateRange == 'All') {
    return { start: StartDate, end }
  }
  else if (typeof dateRange === 'string') {
    let start: Date = new Date(end)
    if (dateRange[dateRange.length - 1] != 'y') {
      throw Error(`Unrecognized date range string: ${dateRange}`)
    }
    const numYears = parseInt(dateRange.substr(0, dateRange.length - 1))
    start.setFullYear(start.getFullYear() - numYears)
    console.log(`subtracted ${numYears} years: ${start}, ${end}`)
    return { start, end }
  } else {
    const { start, end: e } = dateRange
    return { start: start || StartDate, end: e || end }
  }
}

export function dateRangeParam(
  {
    defaultValue = 'All',
    handleUnexpectedValue = "Warn",
  }: {
        defaultValue?: DateRange,
        handleUnexpectedValue?: HandleUnexpectedValue,
    } = {}
): Param<DateRange> {
  const eq = _.isEqual
  return {
    encode(value: DateRange): string | undefined {
      if (eq(value, defaultValue)) return undefined
      if (typeof value === 'string') return value
      const { start, end } = value
      return `${Date2Query(start)}-${Date2Query(end)}`
    },
    decode(value: string | undefined): DateRange {
      if (value === undefined) return defaultValue
      if (value === null) return returnDefaultOrError(value, 'All', handleUnexpectedValue)
      if (['All', '1y', '2y', '3y', '4y', '5y',].includes(value)) {
        return value as DateRange
      } else {
        const [start, end] = value.split('-').map(d => d ? Query2Date(d) : undefined)
        return { start, end } as DateRange
      }
    },
    // equals(l: DateRange, r: DateRange): boolean { return eq(l, r) }
  }
}
