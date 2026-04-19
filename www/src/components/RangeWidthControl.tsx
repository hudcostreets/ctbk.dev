/**
 * Availability time-range picker: preset duration buttons + a "Latest" toggle.
 *
 * A pinned timestamp (from URL `?r=YYMMDD-...`) isn't directly settable here
 * yet — clear to Latest via the ▶| button. Drag-zoom on the chart will
 * eventually drive this (see `specs/station-zoom-subdaily.md`).
 */
import css from './RangeWidthControl.module.css'
import type { TimeRange } from '../time-range'

const DAY_MS = 24 * 60 * 60 * 1000

export type DurationPreset = { label: string; ms: number }

export const DEFAULT_PRESETS: readonly DurationPreset[] = [
  { label: '1d',  ms: DAY_MS },
  { label: '3d',  ms: 3 * DAY_MS },
  { label: '7d',  ms: 7 * DAY_MS },
  { label: '14d', ms: 14 * DAY_MS },
  { label: '1mo', ms: 31 * DAY_MS },
]

interface Props {
  value: TimeRange
  onChange: (next: TimeRange) => void
  presets?: readonly DurationPreset[]
}

export function RangeWidthControl({ value, onChange, presets = DEFAULT_PRESETS }: Props) {
  const isLatest = value.timestamp === null
  const activeMs = presets.find(p => p.ms === value.duration)?.ms

  return (
    <div className={css.row}>
      <span className={css.label}>Range:</span>
      <div className={css.presets} role="group" aria-label="Duration">
        {presets.map(p => (
          <button
            key={p.label}
            type="button"
            className={`${css.preset} ${p.ms === activeMs ? css.active : ''}`}
            onClick={() => onChange({ ...value, duration: p.ms })}
            aria-pressed={p.ms === activeMs}
          >
            {p.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`${css.latest} ${isLatest ? css.active : ''}`}
        onClick={() => { if (!isLatest) onChange({ ...value, timestamp: null }) }}
        title={isLatest ? 'Tracking latest data' : 'Jump to latest'}
        aria-pressed={isLatest}
      >
        <span aria-hidden>▶|</span> Latest
      </button>
    </div>
  )
}
