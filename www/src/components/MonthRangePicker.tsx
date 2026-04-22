/**
 * Pick an arbitrary start→end month range.
 * Compact YY-MM text inputs (e.g. "13-06" → "25-12") to stay small on
 * mobile. Parent owns state as Date objects (undefined = unset).
 */
import { useEffect, useState } from 'react'

interface Props {
  start: Date | undefined
  end: Date | undefined
  minDate?: Date
  maxDate?: Date
  onChange: (start: Date | undefined, end: Date | undefined) => void
  className?: string
}

/** Format a Date as "YY-MM". */
function toYymm(d: Date | undefined): string {
  if (!d) return ''
  const yy = String(d.getFullYear() % 100).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${yy}-${mm}`
}

/** Parse "YYMM" or "YY-MM" → Date (first of month). Returns null on invalid. */
function fromYymm(s: string): Date | null {
  const m = s.replace(/\D/g, '')
  if (m.length !== 4) return null
  const yy = parseInt(m.slice(0, 2), 10)
  const mm = parseInt(m.slice(2, 4), 10)
  if (isNaN(yy) || isNaN(mm) || mm < 1 || mm > 12) return null
  return new Date(2000 + yy, mm - 1, 1)
}

function Field({
  value, onCommit, min, max, label,
}: {
  value: Date | undefined
  onCommit: (d: Date | undefined) => void
  min?: Date
  max?: Date
  label: string
}) {
  const [text, setText] = useState(toYymm(value))

  // Keep local text in sync with external value changes
  useEffect(() => { setText(toYymm(value)) }, [value])

  const commit = () => {
    const s = text.trim()
    if (!s) { onCommit(undefined); return }
    const d = fromYymm(s)
    if (!d) { setText(toYymm(value)); return }  // revert on invalid
    if (min && d < min) { setText(toYymm(value)); return }
    if (max && d > max) { setText(toYymm(value)); return }
    onCommit(d)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={text}
      placeholder="YY-MM"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      style={{
        width: '4.5em',
        fontFamily: 'monospace',
        fontSize: '0.95em',
        padding: '2px 4px',
        textAlign: 'center',
        border: '1px solid var(--border-secondary, #888)',
        borderRadius: 3,
        background: 'transparent',
        color: 'inherit',
      }}
    />
  )
}

export default function MonthRangePicker({
  start, end, minDate, maxDate, onChange, className,
}: Props) {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Field
        label="Start month"
        value={start}
        onCommit={(d) => onChange(d, end)}
        min={minDate}
        max={end ?? maxDate}
      />
      <span style={{ opacity: 0.6 }}>→</span>
      <Field
        label="End month"
        value={end}
        onCommit={(d) => onChange(start, d)}
        min={start ?? minDate}
        max={maxDate}
      />
    </span>
  )
}
