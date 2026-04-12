/**
 * Pick an arbitrary start→end month range.
 * Uses native `<input type="month">` for simplicity + good mobile UX.
 * Parent owns state (start/end Dates or undefined for "present").
 */

interface Props {
  start: Date | undefined
  end: Date | undefined
  minDate?: Date
  maxDate?: Date
  onChange: (start: Date | undefined, end: Date | undefined) => void
  className?: string
}

function toMonthValue(d: Date | undefined): string {
  if (!d) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fromMonthValue(s: string): Date | undefined {
  if (!s) return undefined
  const [y, m] = s.split('-').map(Number)
  return new Date(y, m - 1, 1)
}

export default function MonthRangePicker({
  start,
  end,
  minDate,
  maxDate,
  onChange,
  className,
}: Props) {
  const minStr = minDate ? toMonthValue(minDate) : undefined
  const maxStr = maxDate ? toMonthValue(maxDate) : undefined

  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        type="month"
        value={toMonthValue(start)}
        min={minStr}
        max={end ? toMonthValue(end) : maxStr}
        onChange={(e) => onChange(fromMonthValue(e.target.value), end)}
        aria-label="Start month"
      />
      <span style={{ opacity: 0.6 }}>→</span>
      <input
        type="month"
        value={toMonthValue(end)}
        min={start ? toMonthValue(start) : minStr}
        max={maxStr}
        onChange={(e) => onChange(start, fromMonthValue(e.target.value))}
        aria-label="End month"
      />
    </span>
  )
}
