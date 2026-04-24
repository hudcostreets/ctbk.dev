/**
 * Minute-granularity time range: `[YYMMDD[THHMMSS]][-duration]`
 *
 * Examples:
 *   `251123-3d`         → 2025-11-23 00:00:00, 3-day lookback
 *   `251123T0432-1d3h`  → 2025-11-23 04:32:00, 1-day-3-hour lookback
 *   `-3d`               → Latest mode, 3-day lookback
 *   (absent)            → Latest mode, default duration
 *
 * Ported from awair (`$c/awair/www/src/lib/timeRangeCodec.ts`); factor into
 * `use-prms/time-range` after it stabilizes across both projects
 * (see `specs/multi-scale-ts-library.md`).
 */
import type { Param } from 'use-prms'

const { floor } = Math

export type TimeRange = {
  /** End timestamp (null = Latest mode — follow newest data). */
  timestamp: Date | null
  /** Lookback duration in ms. */
  duration: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MIN_MS = 60 * 1000
// Calendar-month/year units are approximations for duration display only —
// actual bin boundaries are resolved on the server when needed. Keeps the
// URL codec tidy (`1y` beats `365d`) and round-trips cleanly for presets.
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

const { round } = Math

/**
 * Round a duration to sensible precision based on magnitude, so drag-pan
 * gestures don't produce `2d23h58m`-style oddness and presets remain
 * highlightable. Ported from awair's `useTimeRangeParam.roundDuration`.
 */
export function roundDuration(ms: number): number {
  if (ms < 2 * HOUR_MS) return round(ms / (5 * MIN_MS)) * (5 * MIN_MS)
  if (ms < 12 * HOUR_MS) return round(ms / (15 * MIN_MS)) * (15 * MIN_MS)
  if (ms < 3 * DAY_MS) return round(ms / HOUR_MS) * HOUR_MS
  if (ms < 14 * DAY_MS) return round(ms / (6 * HOUR_MS)) * (6 * HOUR_MS)
  return round(ms / DAY_MS) * DAY_MS
}

/**
 * Given a visible `[fromS, toS]` window (unix seconds), return buffered bounds
 * that include ~`bufferFactor` * duration of extra data on each side, rounded
 * to a stable quantum based on duration. The rounding keeps the TSQ query key
 * stable across small drags/shifts — we want the buffer to be a cacheable
 * superset, not a different window per pixel of drag.
 */
export function bufferedBounds(
  fromS: number,
  toS: number,
  bufferFactor: number = 0.5,
): [bufferedFromS: number, bufferedToS: number] {
  const durationS = toS - fromS
  const padS = durationS * bufferFactor
  const HOUR_S = 3600
  const DAY_S = 86400
  let quantumS: number
  if (durationS < 2 * HOUR_S) quantumS = 5 * 60
  else if (durationS < 12 * HOUR_S) quantumS = 15 * 60
  else if (durationS < 3 * DAY_S) quantumS = HOUR_S
  else if (durationS < 14 * DAY_S) quantumS = 6 * HOUR_S
  else quantumS = DAY_S
  const bufFrom = Math.floor((fromS - padS) / quantumS) * quantumS
  const bufTo = Math.ceil((toS + padS) / quantumS) * quantumS
  return [bufFrom, bufTo]
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Parse `YYMMDD[THHMMSS]`; pads missing date/time parts with zeros. */
function parseCompactTimestamp(compact: string): Date {
  const [datePart = '', timePart = ''] = compact.split('T')
  const d = datePart.padEnd(6, '0')
  const t = timePart.padEnd(6, '0')
  const year = 2000 + parseInt(d.slice(0, 2), 10)
  const month = (parseInt(d.slice(2, 4), 10) || 1) - 1
  const day = parseInt(d.slice(4, 6), 10) || 1
  const hh = parseInt(t.slice(0, 2), 10)
  const mm = parseInt(t.slice(2, 4), 10)
  const ss = parseInt(t.slice(4, 6), 10)
  return new Date(year, month, day, hh, mm, ss)
}

/** Encode `YYMMDD[THHMMSS]`; omits time suffix when at midnight; trims trailing `00`s. */
function encodeCompactTimestamp(date: Date): string {
  const yy = pad2(date.getFullYear() % 100)
  const mm = pad2(date.getMonth() + 1)
  const dd = pad2(date.getDate())
  const HH = pad2(date.getHours())
  const MIN = pad2(date.getMinutes())
  const SS = pad2(date.getSeconds())
  const datePart = `${yy}${mm}${dd}`
  if (HH === '00' && MIN === '00' && SS === '00') return datePart
  return `${datePart}T${`${HH}${MIN}${SS}`.replace(/(?:00)+$/, '')}`
}

/** Parse duration: `1y2mo3d4h5m` → ms. `mo` must precede `m`. */
function parseDuration(s: string): number {
  let total = 0
  // Match `y`, `mo`, `d`, `h`, `m` in order — `mo` before `m` to avoid the
  // minute suffix gobbling month-suffixed tokens.
  for (const m of s.matchAll(/(\d+)(mo|[ydhm])/g)) {
    const v = parseInt(m[1], 10)
    const unit = m[2]
    if (unit === 'y') total += v * YEAR_MS
    else if (unit === 'mo') total += v * MONTH_MS
    else if (unit === 'd') total += v * DAY_MS
    else if (unit === 'h') total += v * HOUR_MS
    else total += v * MIN_MS
  }
  return total
}

/** Encode ms → `1y2mo3d4h5m`; omits zero components. */
export function formatDuration(ms: number): string {
  return encodeDuration(ms)
}

function encodeDuration(ms: number): string {
  // Only emit `y` / `mo` when the duration decomposes cleanly — otherwise
  // fall through to `d`/`h`/`m` so drag-pan results (e.g. 47d23h) stay readable.
  const parts: string[] = []
  if (ms > 0 && ms % YEAR_MS === 0) {
    parts.push(`${ms / YEAR_MS}y`)
    return parts.join('')
  }
  if (ms > 0 && ms % MONTH_MS === 0) {
    parts.push(`${ms / MONTH_MS}mo`)
    return parts.join('')
  }
  const days = floor(ms / DAY_MS); ms -= days * DAY_MS
  const hours = floor(ms / HOUR_MS); ms -= hours * HOUR_MS
  const minutes = floor(ms / MIN_MS)
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.length ? parts.join('') : '0m'
}

export function encodeTimeRange(range: TimeRange, defaultDuration: number): string | undefined {
  if (range.timestamp === null && range.duration === defaultDuration) return undefined
  if (range.timestamp === null) return `-${encodeDuration(range.duration)}`
  const ts = encodeCompactTimestamp(range.timestamp)
  return range.duration === defaultDuration ? ts : `${ts}-${encodeDuration(range.duration)}`
}

export function decodeTimeRange(encoded: string | undefined, defaultDuration: number): TimeRange {
  if (!encoded) return { timestamp: null, duration: defaultDuration }
  if (encoded.startsWith('-')) {
    return { timestamp: null, duration: parseDuration(encoded.slice(1)) }
  }
  const dash = encoded.indexOf('-')
  if (dash === -1) return { timestamp: parseCompactTimestamp(encoded), duration: defaultDuration }
  return {
    timestamp: parseCompactTimestamp(encoded.slice(0, dash)),
    duration: parseDuration(encoded.slice(dash + 1)),
  }
}

/**
 * Resolve a `TimeRange` to concrete `[fromS, toS]` unix seconds.
 *   - Latest mode (`timestamp === null`): `toS = now`, `fromS = now - duration`
 *   - Pinned: `toS = timestamp`, `fromS = timestamp - duration`
 */
export function rangeToUnixSeconds(range: TimeRange): [fromS: number, toS: number] {
  const toMs = range.timestamp?.getTime() ?? Date.now()
  const fromMs = toMs - range.duration
  return [Math.floor(fromMs / 1000), Math.floor(toMs / 1000)]
}

/** Human-readable `TimeRange` summary (e.g. "Latest · 3d" or "Nov 23, 2025 04:32 · 1d3h"). */
export function formatTimeRange(range: TimeRange): string {
  const dur = encodeDuration(range.duration)
  if (range.timestamp === null) return `Latest · ${dur}`
  const ts = range.timestamp
  const date = ts.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' })
  const midnight = ts.getHours() === 0 && ts.getMinutes() === 0 && ts.getSeconds() === 0
  if (midnight) return `${date} · ${dur}`
  const time = ts.toLocaleTimeString('default', { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time} · ${dur}`
}

/** `use-prms` codec for a `TimeRange`. Omits the URL param when value equals Latest + defaultDuration. */
export function timeRangeParam(defaultDuration: number = DAY_MS): Param<TimeRange> {
  return {
    encode: (v) => encodeTimeRange(v, defaultDuration),
    decode: (raw) => decodeTimeRange(raw, defaultDuration),
  }
}
