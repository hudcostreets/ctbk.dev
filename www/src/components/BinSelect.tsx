/**
 * Bin-size picker for multi-scale time-series plots (see
 * `specs/multiscale-timeseries-backend.md`).
 *
 * Presets span minute → year. "Auto" (value `undefined`) is the default and
 * lets the Worker / consumer pick a bin size that fits the plot width.
 * Styling matches `RangeWidthControl` so the two controls sit side-by-side.
 */
import css from './RangeWidthControl.module.css'

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS
// Calendar-month/year binning happens in the Worker; these ms values are only
// used for query-key identity + presentation. 30d / 365d are good-enough
// magnitudes for that purpose — actual bin boundaries land on calendar edges.
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

export interface BinOption { label: string; ms: number }

export const BIN_PRESETS: readonly BinOption[] = [
  { label: '1m',  ms: 1 * MIN_MS },
  { label: '2m',  ms: 2 * MIN_MS },
  { label: '5m',  ms: 5 * MIN_MS },
  { label: '10m', ms: 10 * MIN_MS },
  { label: '15m', ms: 15 * MIN_MS },
  { label: '20m', ms: 20 * MIN_MS },
  { label: '30m', ms: 30 * MIN_MS },
  { label: '1h',  ms: 1 * HOUR_MS },
  { label: '2h',  ms: 2 * HOUR_MS },
  { label: '3h',  ms: 3 * HOUR_MS },
  { label: '4h',  ms: 4 * HOUR_MS },
  { label: '6h',  ms: 6 * HOUR_MS },
  { label: '8h',  ms: 8 * HOUR_MS },
  { label: '12h', ms: 12 * HOUR_MS },
  { label: '1d',  ms: 1 * DAY_MS },
  { label: '2d',  ms: 2 * DAY_MS },
  { label: '3d',  ms: 3 * DAY_MS },
  { label: '7d',  ms: 7 * DAY_MS },
  { label: '14d', ms: 14 * DAY_MS },
  { label: '1mo', ms: 1 * MONTH_MS },
  { label: '2mo', ms: 2 * MONTH_MS },
  { label: '3mo', ms: 3 * MONTH_MS },
  { label: '6mo', ms: 6 * MONTH_MS },
  { label: '1y',  ms: 1 * YEAR_MS },
]

const AUTO = 'auto'

interface Props {
  /** Bin size in ms, or `undefined` for auto-selection. */
  value: number | undefined
  onChange: (ms: number | undefined) => void
  className?: string
  /** Subset of `BIN_PRESETS` (by `ms`) to render — defaults to all. Use to
   *  scope the dropdown to bins that make sense for a particular chart. */
  presets?: readonly BinOption[]
  /** Bin sizes (in ms) to grey out + disable. Use for capability gates that
   *  the parent knows about — e.g. "sub-hour bins not available for ranges
   *  longer than 24h yet" (pending unified-API work). */
  disabledMs?: ReadonlySet<number>
  /** Tooltip to attach to disabled options, explaining why. */
  disabledTitle?: string
}

export function BinSelect({ value, onChange, className, presets = BIN_PRESETS, disabledMs, disabledTitle }: Props) {
  const selectValue = value === undefined
    ? AUTO
    : (presets.find(p => p.ms === value)?.label ?? AUTO)

  return (
    <div className={`${css.row}${className ? ` ${className}` : ''}`}>
      <label className={css.label} htmlFor="bin-select">Bin:</label>
      <select
        id="bin-select"
        className={css.select}
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value
          if (next === AUTO) { onChange(undefined); return }
          const p = presets.find(pp => pp.label === next)
          if (p) onChange(p.ms)
        }}
      >
        <option value={AUTO}>Auto</option>
        {presets.map(p => {
          const disabled = disabledMs?.has(p.ms) ?? false
          return (
            <option
              key={p.label}
              value={p.label}
              disabled={disabled}
              title={disabled ? disabledTitle : undefined}
            >
              {p.label}{disabled ? ' (n/a)' : ''}
            </option>
          )
        })}
      </select>
    </div>
  )
}
