/**
 * Availability time-range picker: duration dropdown + a "Latest" toggle.
 * Drag-pan on the chart updates duration (via `roundDuration`) and
 * timestamp; when the current duration doesn't match a preset, a
 * "(custom)" option is added to the dropdown so selection state is
 * still meaningful.
 */
import { formatDuration } from '../time-range'
import css from './RangeWidthControl.module.css'
import type { TimeRange } from '../time-range'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
// Align with `time-range.ts`' month/year approximations so preset labels
// round-trip cleanly through `formatDuration` (1 month = 30d, 1 year = 365d).
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

export type DurationPreset = { label: string; ms: number }

export const DEFAULT_PRESETS: readonly DurationPreset[] = [
  { label: '6h',  ms: 6 * HOUR_MS },
  { label: '12h', ms: 12 * HOUR_MS },
  { label: '1d',  ms: DAY_MS },
  { label: '3d',  ms: 3 * DAY_MS },
  { label: '7d',  ms: 7 * DAY_MS },
  { label: '14d', ms: 14 * DAY_MS },
  { label: '1mo', ms: MONTH_MS },
  { label: '3mo', ms: 3 * MONTH_MS },
  { label: '1y',  ms: YEAR_MS },
]

interface Props {
  value: TimeRange
  onChange: (next: TimeRange) => void
  presets?: readonly DurationPreset[]
}

const CUSTOM = 'custom'

export function RangeWidthControl({ value, onChange, presets = DEFAULT_PRESETS }: Props) {
  const isLatest = value.timestamp === null
  const activePreset = presets.find(p => p.ms === value.duration)
  const selectValue = activePreset?.label ?? CUSTOM
  const customLabel = activePreset ? null : formatDuration(value.duration)

  return (
    <div className={css.row}>
      <label className={css.label} htmlFor="range-width-select">Range:</label>
      <select
        id="range-width-select"
        className={css.select}
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value
          if (next === CUSTOM) return  // display-only option
          const p = presets.find(pp => pp.label === next)
          if (p) onChange({ ...value, duration: p.ms })
        }}
      >
        {!activePreset && (
          <option value={CUSTOM}>{customLabel ?? 'custom'}</option>
        )}
        {presets.map(p => (
          <option key={p.label} value={p.label}>{p.label}</option>
        ))}
      </select>
      <button
        type="button"
        className={`${css.latest} ${isLatest ? css.active : ''}`}
        onClick={() => onChange({ ...value, timestamp: null })}
        title={isLatest ? 'Tracking latest data' : 'Jump to latest'}
        aria-pressed={isLatest}
      >
        <span aria-hidden>▶|</span> Latest
      </button>
    </div>
  )
}
