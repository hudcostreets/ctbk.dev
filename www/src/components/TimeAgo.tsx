/**
 * Inline "Xs/m/h ago" that ticks every 15s. `at` is unix seconds.
 * Hovering shows the full local timestamp via `title`.
 */
import { useEffect, useState } from 'react'

export function formatAgo(s: number): string {
  if (s < 0) s = 0
  if (s < 10) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

interface Props {
  /** Unix seconds. */
  at: number
  /** Prefix label (e.g. "Updated"). */
  prefix?: string
}

export function TimeAgo({ at, prefix }: Props) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000))
    tick()
    const id = setInterval(tick, 15_000)
    return () => clearInterval(id)
  }, [])
  const full = new Date(at * 1000).toLocaleString()
  return (
    <span title={full}>
      {prefix ? `${prefix} ` : ''}{formatAgo(now - at)}
    </span>
  )
}
