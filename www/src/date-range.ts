import moment from "moment"
import type { Param } from "@rdub/use-url-params"

// DateRange can be:
// - "All" for full data range
// - { duration: string, end?: Date } where duration is like "3y" or "3y6m"
//   If end is undefined, it means "present" (anchored to now)
//   Note: end is exclusive internally (first month NOT included)
//   URL format uses inclusive endpoint: "2511-3y" means Nov 2025 inclusive
export type DateRange = "All" | { duration: string; end?: Date }

const StartDate = moment("2013-06-01").toDate()

// Format: YYMM
const Date2Query = (d: Date | undefined) => (d ? moment(d).format("YYMM") : "")
const Query2Date = (s: string) => {
  const year = `20${s.substring(0, 2)}`
  const month = s.substring(2, 4)
  return moment(`${year}-${month}-01`).toDate()
}

// Add/subtract months from a date
function addMonths(d: Date, n: number): Date {
  const result = new Date(d)
  result.setMonth(result.getMonth() + n)
  return result
}

// Parse duration string like "3y", "3y6m", "6m" into months
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)y(?:(\d+)m)?$|^(\d+)m$/)
  if (!match) throw new Error(`Invalid duration: ${duration}`)
  const years = match[1] ? parseInt(match[1]) : 0
  const months = match[2] ? parseInt(match[2]) : match[3] ? parseInt(match[3]) : 0
  return years * 12 + months
}

// Format months as duration string (prefer years when possible)
export function formatDuration(months: number): string {
  const years = Math.floor(months / 12)
  const remainingMonths = months % 12
  if (years === 0) return `${remainingMonths}m`
  if (remainingMonths === 0) return `${years}y`
  return `${years}y${remainingMonths}m`
}

// Apply duration backwards from end date
function applyDuration(end: Date, durationMonths: number): Date {
  const start = new Date(end)
  start.setMonth(start.getMonth() - durationMonths)
  return start
}

export const DateRange2Dates = (
  dateRange: DateRange,
  maxEnd?: Date
): { start: Date; end: Date } => {
  maxEnd = maxEnd || new Date()
  if (dateRange === "All") {
    return { start: StartDate, end: maxEnd }
  }
  const { duration, end } = dateRange
  const effectiveEnd = end || maxEnd
  const durationMonths = parseDuration(duration)
  const start = applyDuration(effectiveEnd, durationMonths)
  return { start, end: effectiveEnd }
}

// Get duration from DateRange (returns months)
export function getDurationMonths(dateRange: DateRange): number | null {
  if (dateRange === "All") return null
  return parseDuration(dateRange.duration)
}

// Check if two DateRanges are equal
function isEqual(a: DateRange, b: DateRange): boolean {
  if (a === "All" && b === "All") return true
  if (a === "All" || b === "All") return false
  return a.duration === b.duration && a.end?.getTime() === b.end?.getTime()
}

export function dateRangeParam(defaultValue: DateRange = "All"): Param<DateRange> {
  return {
    encode(value: DateRange): string | undefined {
      if (isEqual(value, defaultValue)) return undefined
      if (value === "All") return "All"
      const { duration, end } = value
      // If end is undefined (present), just return duration
      if (!end) return duration
      // Otherwise return "YYMM-duration" where YYMM is inclusive endpoint
      // Internal end is exclusive, so subtract 1 month for display
      const inclusiveEnd = addMonths(end, -1)
      return `${Date2Query(inclusiveEnd)}-${duration}`
    },
    decode(value: string | undefined): DateRange {
      if (value === undefined) return defaultValue
      if (value === "All") return "All"

      // Check for duration-only format (anchored to present): "3y", "3y6m", "6m"
      if (/^\d+y(\d+m)?$/.test(value) || /^\d+m$/.test(value)) {
        return { duration: value }
      }

      // Check for new format: "YYMM-duration" (e.g., "2508-3y", "2508-3y6m")
      // YYMM is inclusive endpoint, add 1 month for exclusive internal end
      const newFormatMatch = value.match(/^(\d{4})-(\d+y(?:\d+m)?|\d+m)$/)
      if (newFormatMatch) {
        const [, endStr, duration] = newFormatMatch
        const inclusiveEnd = Query2Date(endStr)
        return { duration, end: addMonths(inclusiveEnd, 1) }
      }

      // Legacy format: "YYMM-YYMM" [start, end) with exclusive end
      // End is already exclusive, matching internal representation
      const legacyMatch = value.match(/^(\d{4})-(\d{4})$/)
      if (legacyMatch) {
        const [, startStr, endStr] = legacyMatch
        const start = Query2Date(startStr)
        const end = Query2Date(endStr)
        const durationMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())
        return { duration: formatDuration(durationMonths), end }
      }

      // Fallback - treat as duration anchored to present
      console.warn(`Unknown date range format: ${value}, treating as duration`)
      return { duration: value }
    },
  }
}
