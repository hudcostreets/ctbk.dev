/** ctbk's `renderCell` for `@rdub/file-tree`'s parquet viewer (`/files/*`).
 *
 *  The upstream default renders every non-temporal value as bare
 *  `String(v)` — left-justified, no thousands separators. That's the
 *  right default for an unknown schema, but ctbk's shards have a known
 *  shape (pyramid metric triples, GBFS availability histograms, S2
 *  vocabulary keys), so we can do considerably better.
 *
 *  House rules, applied uniformly:
 *  - Anything we reformat keeps the raw value one hover away, and is
 *    marked with a dotted underline so you know the hover exists.
 *    Without the cue there's no way to tell a rendered value from a
 *    literal one. The cue is keyed on *display differing from raw*,
 *    not on "has a tooltip" — underlining every cell that happens to
 *    carry derived stats turns whole columns into hatching and stops
 *    meaning anything.
 *  - Numerics are right-justified with tabular figures, so digits line
 *    up column-wise and magnitudes are comparable at a glance.
 *  - Nothing is *hidden*: every transform is reversible from the
 *    tooltip, because the raw value is what you'd paste into a query.
 *
 *  Alignment is the viewer's own (`alignNumeric`, on by default) since
 *  file-tree's `specs/done/column-hooks.md` landed — numeric columns
 *  right-align on `<td>` AND `<th>` with no wrapper here. The one
 *  exception is the GBFS histogram columns, which are `BYTE_ARRAY`
 *  physically but numeric to a reader, so they opt in by hand.
 *
 *  `renderHeader` carries a per-column raw/formatted toggle. The
 *  inference is a guess and the formatting is opinionated, so the
 *  honest complement is flipping any column back to its literal bytes
 *  in place. State lives here (URL-bound in `pages/Files.tsx`) and
 *  reaches the cells through context rather than through the options
 *  bag — rebinding `makeParquetViewer` per toggle would remount the
 *  viewer and drop its row-group cache. */
import { createContext, useContext, type ReactNode } from 'react'
import {
  formatTemporal, inferTemporalFormat,
  type ParquetCellCtx, type ParquetColumn, type ParquetColumnStats, type ParquetHeaderCtx,
} from '@rdub/file-tree/renderers/parquet'
import { Tip, TipRows } from './Tip'
import { CellValue, isVocabValue } from './S2CellTip'
import css from './parquetCells.module.css'

const { abs, max, sqrt } = Math

/** Parquet physical types we right-justify + format as numbers. */
const NUMERIC_PHYSICAL = new Set(['INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE'])

/** `Subscriber`/`Customer` are Citi Bike's wire values; the rest of
 *  ctbk (charts, legends, `USER_TYPE_MAP` in `query/ridesV1.ts`) says
 *  `Annual`/`Daily`. Showing the wire value here made the file viewer
 *  contradict every other surface. */
const USER_TYPE: Record<string, string> = { Subscriber: 'Annual', Customer: 'Daily' }

/** Abbreviations rather than icons: the table is 0.82em and these
 *  columns are narrow, where glyphs turn to mush. */
const BIKE_TYPE: Record<string, string> = {
  classic_bike: 'C',
  electric_bike: '⚡E',
  docked_bike: 'D',
}

/** Columns holding the pyramid's frozen vocabulary (S2 tokens +
 *  `s:<short_name>` identity keys); see `S2CellTip`. */
const CELL_COLUMNS = new Set(['cell', 's2_cell'])

/** GBFS availability histogram columns. Named (not value-sniffed) only
 *  because alignment is a per-COLUMN decision the viewer makes before
 *  any row is read; the rendering itself still detects structurally. */
const HISTOGRAM_COLUMNS = new Set(['bikes', 'ebikes', 'docks', 'disabled', 'pending'])

/** Columns the reader has flipped back to raw, and the flip itself.
 *  Defaults to a no-op so the renderers work outside a provider. */
export interface RawCols { raw: Set<string>; toggle: (col: string) => void }
const RawColsCtx = createContext<RawCols>({ raw: new Set(), toggle: () => {} })
export const RawColsProvider = RawColsCtx.Provider

export function renderCell(ctx: ParquetCellCtx): ReactNode {
  return <CtbkCell {...ctx} />
}

export function renderHeader(ctx: ParquetHeaderCtx): ReactNode {
  return <CtbkHeader {...ctx} />
}

/** Histogram columns read as quantities but are `BYTE_ARRAY`, so the
 *  viewer's type-driven alignment (correctly) leaves them alone. */
export function cellProps(col: ParquetColumn) {
  return HISTOGRAM_COLUMNS.has(col.name) ? { className: css.rj } : undefined
}
export function headerProps(col: ParquetColumn) {
  return HISTOGRAM_COLUMNS.has(col.name) ? { className: css.rj } : undefined
}

function CtbkCell(ctx: ParquetCellCtx) {
  const { raw: rawCols } = useContext(RawColsCtx)
  return <>{cellNode(ctx, rawCols)}</>
}

function cellNode({ value, column, row, defaultNode }: ParquetCellCtx, rawCols: Set<string>): ReactNode {
  const numeric = NUMERIC_PHYSICAL.has(column.physicalType ?? '')

  if (value === null || value === undefined) return defaultNode

  // Raw mode bypasses the viewer's formatting too, not just ours —
  // `defaultNode` would still render an inferred timestamp, and "raw"
  // that isn't the literal value is worse than no toggle at all.
  if (rawCols.has(column.name)) return raw(value)

  // Timestamps: same inference the viewer does, re-rendered with a real
  // tooltip instead of `title=`.
  const temporal = inferTemporalFormat(column, [value])
  if (temporal) {
    const s = formatTemporal(value, temporal)
    if (s !== null) {
      return (
        <Tip content={<TipRows rows={[
          ['raw', raw(value)],
          ['unit', `epoch ${temporal.unit.toLowerCase()}`],
          ['source', temporal.source],
        ]} />}>
          <span className={css.derived}>{s}</span>
        </Tip>
      )
    }
  }

  if (numeric && (typeof value === 'number' || typeof value === 'bigint')) {
    return <Metric value={value} column={column} row={row} />
  }

  if (typeof value === 'string') {
    if (column.name === 'user_type' && USER_TYPE[value]) return <Chip label={USER_TYPE[value]} raw={value} />
    if (column.name === 'bike_type' && BIKE_TYPE[value]) return <Chip label={BIKE_TYPE[value]} raw={value} />
    if (CELL_COLUMNS.has(column.name) && isVocabValue(value)) return <CellValue value={value} />
    const hist = parseHistogram(value)
    if (hist) return <Histogram entries={hist} raw={value} />
  }

  return defaultNode
}

// ----------------------------------------------------------------- header

/** Column header: name + row-group stats on hover + a raw/formatted
 *  toggle. The toggle is hover-revealed (and pinned visible while the
 *  column is raw) — a control on all 17 headers at once reads as
 *  chrome, and the columns worth flipping aren't knowable up front. */
function CtbkHeader({ column, stats }: ParquetHeaderCtx) {
  const { raw: rawCols, toggle } = useContext(RawColsCtx)
  const isRaw = rawCols.has(column.name)
  const rows = statRows(column, stats)
  const label = rows.length
    ? <Tip content={<TipRows rows={rows} />} placement="bottom"><span>{column.name}</span></Tip>
    : <span>{column.name}</span>
  return (
    <span className={css.header}>
      {label}
      <button
        type="button"
        className={isRaw ? `${css.fmtToggle} ${css.fmtToggleOn}` : css.fmtToggle}
        title={isRaw ? `show formatted ${column.name}` : `show raw ${column.name}`}
        onClick={() => toggle(column.name)}
      >{isRaw ? 'raw' : '⌗'}</button>
    </span>
  )
}

/** Row-group stats, formatted the same way the column's cells are — a
 *  `duration_sum` range reads as intervals, a `dt` range as timestamps.
 *  Parquet stats are raw per-type, so byte arrays are decoded first. */
function statRows(column: ParquetColumn, stats?: ParquetColumnStats): [string, ReactNode][] {
  if (!stats) return []
  const rows: [string, ReactNode][] = []
  const lo = fmtStat(stats.min, column), hi = fmtStat(stats.max, column)
  if (lo !== null && hi !== null) rows.push(lo === hi ? ['value', lo] : ['range', `${lo} … ${hi}`])
  if (stats.nullCount) rows.push(['nulls', fmtNum(stats.nullCount)])
  rows.push(['type', column.physicalType ?? '?'])
  return rows
}

function fmtStat(v: unknown, column: ParquetColumn): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Uint8Array) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(v) } catch { return null }
  }
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'bigint') {
    const temporal = inferTemporalFormat(column, [v])
    if (temporal) {
      const s = formatTemporal(v, temporal)
      if (s !== null) return s
    }
    const met = parseMetric(column.name)
    const n = Number(v)
    return met?.stat === 'sum' && SECONDS_BASES.has(met.base) ? fmtDuration(n) : fmtNum(n)
  }
  return null
}

// ---------------------------------------------------------------- metrics

type Stat = 'n' | 'sum' | 'sumsq'

/** Pyramid metric columns come in triples: `<base>_n` (observations),
 *  `<base>_sum`, `<base>_sumsq`. Both `_sumsq` and `_sum_sq` spellings
 *  are in the wild (rides-v5 vs. the older avail aggregates). */
function parseMetric(name: string): { base: string; stat: Stat } | null {
  let m = /^(.+)_(?:sumsq|sum_sq)$/.exec(name)
  if (m) return { base: m[1], stat: 'sumsq' }
  m = /^(.+)_sum$/.exec(name)
  if (m) return { base: m[1], stat: 'sum' }
  m = /^(.+)_n$/.exec(name)
  if (m) return { base: m[1], stat: 'n' }
  return null
}

/** Bases whose `_sum` is in seconds, so it can be read as an interval.
 *  Deliberately narrow: `_sumsq` is *seconds squared* and must never be
 *  interval-formatted — that would be a category error, not a rounding
 *  one. */
const SECONDS_BASES = new Set(['duration'])

function Metric({ value, column, row }: { value: number | bigint; column: ParquetColumn; row: Record<string, unknown> }) {
  const n = Number(value)
  const met = parseMetric(column.name)
  const seconds = !!met && met.stat === 'sum' && SECONDS_BASES.has(met.base)
  const stats = met && met.stat !== 'n' ? momentStats(row, met.base) : null

  const shown = seconds ? fmtDuration(n) : fmtNum(n)
  const rawStr = raw(value)
  const derived = shown !== rawStr

  const rows: [string, ReactNode][] = []
  if (derived) rows.push([seconds ? 'exact' : 'raw', seconds ? `${fmtNum(n)} s` : rawStr])
  if (stats) {
    const f = seconds ? fmtDuration : fmtNum
    rows.push(['n', fmtNum(stats.n)])
    if (stats.mean !== null) rows.push(['mean', f(stats.mean)])
    if (stats.sd !== null) rows.push(['sd', f(stats.sd)])
  }
  if (met?.stat === 'sumsq' && SECONDS_BASES.has(met.base)) rows.push(['units', 's²'])

  const body = <span className={derived ? css.derived : undefined}>{shown}</span>
  // No tooltip when there's nothing the cell doesn't already say.
  if (!rows.length) return body
  return <Tip content={<TipRows rows={rows} />}>{body}</Tip>
}

/** Recover mean / sd from the `(n, sum, sumsq)` monoid triple, when all
 *  three siblings are present in the row. */
function momentStats(row: Record<string, unknown>, base: string): { n: number; mean: number | null; sd: number | null } | null {
  const num = (k: string): number | null => {
    const v = row[k]
    return typeof v === 'number' || typeof v === 'bigint' ? Number(v) : null
  }
  const n = num(`${base}_n`)
  if (n === null || n <= 0) return null
  const sum = num(`${base}_sum`)
  const sumsq = num(`${base}_sumsq`) ?? num(`${base}_sum_sq`)
  const mean = sum === null ? null : sum / n
  // `sumsq/n − mean²` is the textbook shortcut and is catastrophically
  // cancellation-prone; clamp at 0 rather than emitting NaN from a
  // sqrt of a tiny negative.
  const sd = mean === null || sumsq === null ? null : sqrt(max(0, sumsq / n - mean * mean))
  return { n, mean, sd }
}

// ------------------------------------------------------------- histograms

/** GBFS availability columns (`bikes`, `ebikes`, `docks`, `disabled`,
 *  `pending`) hold a JSON value→observation-count map as a string.
 *  Detected structurally rather than by column name, so it survives
 *  schema churn across avail-v3/v5/v6. */
function parseHistogram(s: string): [number, number][] | null {
  if (s.length < 2 || s[0] !== '{') return null
  let o: unknown
  try { o = JSON.parse(s) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const entries = Object.entries(o as Record<string, unknown>)
  if (!entries.length) return null
  const out: [number, number][] = []
  for (const [k, v] of entries) {
    const kn = Number(k), vn = Number(v)
    if (!Number.isFinite(kn) || !Number.isFinite(vn)) return null
    out.push([kn, vn])
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/** `{"14":1}` → `14`; `{"14":2,"15":1}` → `14×2 15`. The single-value
 *  case is overwhelmingly the common one and deserves to read as a
 *  plain number, not a JSON blob. */
function Histogram({ entries, raw: rawStr }: { entries: [number, number][]; raw: string }) {
  const total = entries.reduce((a, [, c]) => a + c, 0)
  const mean = entries.reduce((a, [v, c]) => a + v * c, 0) / total
  const shown = entries.map(([v, c]) => (c === 1 ? `${v}` : `${v}×${c}`)).join(' ')
  const rows: [string, ReactNode][] = [
    ['raw', rawStr],
    ['obs', fmtNum(total)],
  ]
  if (entries.length > 1) {
    rows.push(['mean', fmtNum(mean)])
    rows.push(['range', `${entries[0][0]}–${entries[entries.length - 1][0]}`])
  }
  return (
    <Tip content={<TipRows rows={rows} />}>
      <span className={css.derived}>{shown}</span>
    </Tip>
  )
}

// ------------------------------------------------------------------ chips

function Chip({ label, raw: rawStr }: { label: string; raw: string }) {
  return (
    <Tip content={<TipRows rows={[['raw', rawStr]]} />}>
      <span className={`${css.chip} ${css.derived}`}>{label}</span>
    </Tip>
  )
}

// ------------------------------------------------------------- formatting

function raw(v: unknown): string {
  return typeof v === 'bigint' ? v.toString() : String(v)
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (Number.isInteger(n)) return n.toLocaleString()
  const a = abs(n)
  // Keep small magnitudes readable without letting big floats sprout a
  // meaningless decimal tail.
  const digits = a >= 1000 ? 0 : a >= 1 ? 2 : 4
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

const UNITS: [number, string][] = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']]

/** Two most-significant units: `2d 7h`, `4h 32m`, `32m 10s`, `9.4s`.
 *  Beyond two the tail is noise at these magnitudes, and the exact
 *  seconds are in the tooltip anyway. */
function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return String(sec)
  const neg = sec < 0
  let s = abs(sec)
  if (s < 60) return `${neg ? '-' : ''}${fmtNum(s)}s`
  const parts: string[] = []
  for (const [size, label] of UNITS) {
    if (parts.length === 2) break
    const q = Math.floor(s / size)
    if (q === 0 && !parts.length) continue
    if (q > 0) parts.push(`${q}${label}`)
    s -= q * size
  }
  return `${neg ? '-' : ''}${parts.join(' ')}`
}
