/**
 * Paginated raw-rides table for `/s/:slug`. Scaffolding only — the Worker
 * `/api/rides` endpoint doesn't exist yet; `useRidesTable` returns a
 * `coming-soon` sentinel when the endpoint 404s, and this component
 * renders a placeholder row in that case.
 *
 * See `specs/multiscale-timeseries-backend.md` § "Paginated raw-rides
 * table per station".
 *
 * URL params (via `use-prms`):
 *   rt_page  int, 0-indexed page            (default 0)
 *   rt_sort  one of `SORTABLE_COLUMNS`       (default 'dt')
 *   rt_dir   'asc' | 'desc'                  (default 'desc')
 *
 * Not integrated into `StationDetail` yet — parent wiring is out of scope
 * for this scaffold.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { codeParam, intParam, useUrlState } from 'use-prms'
import {
  isComingSoon, SORTABLE_COLUMNS, useRidesTable,
  type RideRow, type SortableColumn, type SortDir,
} from '../query/ridesTable'
import css from './RidesTable.module.css'

const { floor, max, min, ceil } = Math

export interface RidesTableProps {
  /** Canonical short_name of the station this table belongs to. */
  station: string
  /** Pair-filter: only rides where the counterpart is this station. */
  counterpartStation?: string
  /** Restrict to rides where `station` is the start or the end. */
  side?: 'start' | 'end'
  /** Visible range start (unix seconds). */
  fromS: number
  /** Visible range end (unix seconds). */
  toS: number
  /** Rows per page. */
  pageSize?: number
  /**
   * Optional counterpart short_name → slug map, used to render
   * counterpart cells as links to `/s/<slug>`. When absent, counterparts
   * render as plain text (still shows the short_name).
   */
  slugBySlug?: Record<string, string>
}

const DEFAULT_PAGE_SIZE = 50
const DEFAULT_SORT: SortableColumn = 'dt'
const DEFAULT_DIR: SortDir = 'desc'

const sortColumnParam = codeParam<SortableColumn>(
  DEFAULT_SORT,
  SORTABLE_COLUMNS.map(c => [c, c] as [SortableColumn, string]),
)
const sortDirParam = codeParam<SortDir>(
  DEFAULT_DIR,
  [['desc', 'desc'], ['asc', 'asc']],
)

/** Human-readable gender codes. Matches `data.ts`'s legend conventions. */
const GENDER_LABELS: Record<number, string> = { 0: 'Unknown', 1: 'Male', 2: 'Female' }

function formatGender(g: number): string {
  return GENDER_LABELS[g] ?? String(g)
}

/** Render duration seconds as `Xh Ym` (≥1h), `Xm Ys` (<1h), or `Ns` (<1min). */
function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—'
  if (s < 60) return `${floor(s)}s`
  if (s < 3600) {
    const m = floor(s / 60)
    const sec = floor(s % 60)
    return `${m}m ${sec}s`
  }
  const h = floor(s / 3600)
  const m = floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

/** Format a unix-s timestamp as `YYYY-MM-DD HH:MM`. */
function formatDt(dt: number): string {
  const d = new Date(dt * 1000)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

interface ColumnDef {
  key: SortableColumn
  label: string
}

const COLUMNS: ColumnDef[] = [
  { key: 'dt', label: 'Date/time' },
  { key: 'side', label: 'Side' },
  { key: 'counterpart_short_name', label: 'Counterpart' },
  { key: 'gender', label: 'Gender' },
  { key: 'user_type', label: 'User type' },
  { key: 'rideable_type', label: 'Bike' },
  { key: 'duration_s', label: 'Duration' },
]

export default function RidesTable({
  station,
  counterpartStation,
  side,
  fromS,
  toS,
  pageSize = DEFAULT_PAGE_SIZE,
  slugBySlug,
}: RidesTableProps) {
  const [page, setPage] = useUrlState('rt_page', intParam(0))
  const [sortBy, setSortBy] = useUrlState('rt_sort', sortColumnParam)
  const [sortDir, setSortDir] = useUrlState('rt_dir', sortDirParam)

  const query = useRidesTable({
    station, counterpartStation, side,
    fromS, toS,
    page, pageSize,
    sortBy, sortDir,
  })

  const { data, isPending, isError, error, isPlaceholderData } = query

  const comingSoon = isComingSoon(data)
  const response = comingSoon ? null : (data ?? null)

  const totalPages = useMemo(() => {
    if (!response) return 0
    return max(1, ceil(response.totalRows / response.pageSize))
  }, [response])

  const clampedPage = response ? min(page, max(0, totalPages - 1)) : page

  const onHeaderClick = (col: SortableColumn) => {
    if (col === sortBy) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(col)
      // Numeric-ish columns → desc by default; string cols → asc.
      const numericDefault = col === 'dt' || col === 'duration_s' || col === 'gender'
      setSortDir(numericDefault ? 'desc' : 'asc')
    }
    setPage(0)
  }

  const prevDisabled = clampedPage <= 0 || !response
  const nextDisabled = !response || clampedPage >= totalPages - 1

  return (
    <div className={css.container}>
      <div className={css.tableWrap}>
        <table className={`${css.table} ${isPlaceholderData ? css.loading : ''}`}>
          <thead>
            <tr>
              {COLUMNS.map(col => {
                const active = col.key === sortBy
                const indicator = active ? (sortDir === 'asc' ? '▲' : '▼') : '▲'
                return (
                  <th
                    key={col.key}
                    className={css.th}
                    onClick={() => onHeaderClick(col.key)}
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <span className={css.thInner}>
                      <span>{col.label}</span>
                      <span className={`${css.sortIndicator} ${active ? '' : css.inactive}`}>
                        {indicator}
                      </span>
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {comingSoon && (
              <tr>
                <td className={css.stateRow} colSpan={COLUMNS.length}>
                  Rides table coming soon — the backend endpoint isn&apos;t deployed yet.
                </td>
              </tr>
            )}
            {!comingSoon && isPending && (
              <tr>
                <td className={css.stateRow} colSpan={COLUMNS.length}>
                  Loading rides…
                </td>
              </tr>
            )}
            {!comingSoon && isError && (
              <tr>
                <td className={css.stateRow} colSpan={COLUMNS.length}>
                  Error loading rides: {String(error)}
                </td>
              </tr>
            )}
            {!comingSoon && response && response.rows.length === 0 && (
              <tr>
                <td className={css.stateRow} colSpan={COLUMNS.length}>
                  No rides in this range.
                </td>
              </tr>
            )}
            {!comingSoon && response && response.rows.map((r, i) => (
              <Row key={`${r.dt}-${r.side}-${r.counterpart_short_name}-${i}`}
                row={r}
                slugBySlug={slugBySlug}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className={css.pagination}>
        <button
          type="button"
          className={css.pageButton}
          onClick={() => setPage(max(0, clampedPage - 1))}
          disabled={prevDisabled}
        >
          ← Prev
        </button>
        <span className={css.pageInfo}>
          {response
            ? `Page ${clampedPage + 1} of ${totalPages} (${response.totalRows.toLocaleString()} rides)`
            : '—'}
        </span>
        <button
          type="button"
          className={css.pageButton}
          onClick={() => response && setPage(min(totalPages - 1, clampedPage + 1))}
          disabled={nextDisabled}
        >
          Next →
        </button>
      </div>
    </div>
  )
}

function Row({
  row,
  slugBySlug,
}: {
  row: RideRow
  slugBySlug?: Record<string, string>
}) {
  const cpSlug = slugBySlug?.[row.counterpart_short_name]
  const counterpartCell = cpSlug ? (
    <Link to={`/s/${cpSlug}`} className={css.counterpartLink}>
      {row.counterpart_short_name}
    </Link>
  ) : (
    <span>{row.counterpart_short_name}</span>
  )
  return (
    <tr>
      <td>{formatDt(row.dt)}</td>
      <td>
        <span className={`${css.side} ${css[row.side]}`} title={row.side}>
          {row.side === 'start' ? '→' : '←'}
        </span>
      </td>
      <td>{counterpartCell}</td>
      <td>{formatGender(row.gender)}</td>
      <td>{row.user_type || '—'}</td>
      <td>{row.rideable_type || '—'}</td>
      <td>{formatDuration(row.duration_s)}</td>
    </tr>
  )
}
