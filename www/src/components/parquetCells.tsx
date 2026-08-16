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
 *  Alignment note: the viewer's `<td>` styling is fixed upstream (no
 *  className / style hook), so right-justification goes through a
 *  block wrapper that fills the cell rather than `text-align` on the
 *  cell itself. Asked for upstream in file-tree's
 *  `specs/column-hooks.md`. */
import type { ReactNode } from 'react'
import {
  formatTemporal, inferTemporalFormat,
  type ParquetCellCtx, type ParquetColumn,
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

export function renderCell({ value, column, row, defaultNode }: ParquetCellCtx): ReactNode {
  const numeric = NUMERIC_PHYSICAL.has(column.physicalType ?? '')

  // Nulls keep the upstream faded `·`, but adopt the column's
  // justification so a sparse numeric column stays in one rail.
  if (value === null || value === undefined) return numeric ? <Rj>{defaultNode}</Rj> : defaultNode

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

/** Right-justify inside the cell. The viewer's `<td>` has no style
 *  hook, so this block wrapper stretches to the cell's content box and
 *  aligns within it — equivalent to `text-align: right` on the cell for
 *  every column wider than its narrowest row. */
function Rj({ children }: { children: ReactNode }) {
  return <div className={css.rj}>{children}</div>
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

  const body = <div className={derived ? `${css.rj} ${css.derived}` : css.rj}>{shown}</div>
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
      <div className={`${css.rj} ${css.derived}`}>{shown}</div>
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
