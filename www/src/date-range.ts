import moment from "moment"
import type { Param } from "@rdub/use-url-params"

export type DateRange = "All" | "1y" | "2y" | "3y" | "4y" | "5y" | { start?: Date; end?: Date }

const StartDate = moment("2013-06-01").toDate()
const Date2Query = (d: Date | undefined) => (d ? moment(d).format("YYMM") : "")
const Query2Date = (s: string) => {
  const year = `20${s.substring(0, 2)}`
  const month = s.substring(2, 4)
  return moment(`${year}-${month}-01`).toDate()
}

export const DateRange2Dates = (
  dateRange: DateRange,
  end?: Date
): { start: Date; end: Date } => {
  end = end ? end : new Date()
  if (dateRange === "All") {
    return { start: StartDate, end }
  } else if (typeof dateRange === "string") {
    const start = new Date(end)
    if (dateRange[dateRange.length - 1] !== "y") {
      throw Error(`Unrecognized date range string: ${dateRange}`)
    }
    const numYears = parseInt(dateRange.substr(0, dateRange.length - 1))
    start.setFullYear(start.getFullYear() - numYears)
    return { start, end }
  } else {
    const { start, end: e } = dateRange
    return { start: start || StartDate, end: e || end }
  }
}

export function dateRangeParam(defaultValue: DateRange = "All"): Param<DateRange> {
  const isEqual = (a: DateRange, b: DateRange) => {
    if (typeof a === "string" && typeof b === "string") return a === b
    if (typeof a === "object" && typeof b === "object") {
      return a.start?.getTime() === b.start?.getTime() && a.end?.getTime() === b.end?.getTime()
    }
    return false
  }

  return {
    encode(value: DateRange): string | undefined {
      if (isEqual(value, defaultValue)) return undefined
      if (typeof value === "string") return value
      const { start, end } = value
      return `${Date2Query(start)}-${Date2Query(end)}`
    },
    decode(value: string | undefined): DateRange {
      if (value === undefined) return defaultValue
      if (["All", "1y", "2y", "3y", "4y", "5y"].includes(value)) {
        return value as DateRange
      } else {
        const [start, end] = value.split("-").map((d) => (d ? Query2Date(d) : undefined))
        return { start, end } as DateRange
      }
    },
  }
}
