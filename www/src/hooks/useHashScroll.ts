import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * Scroll `#<hash>` into view, and keep it there while content above it is
 * still loading in (charts, lazy panels) and pushing it down. The browser's
 * own hash scroll fires once, before that layout settles. Re-scrolls whenever
 * the target drifts from the top for `settleMs` after mount, or until the
 * user scrolls themselves.
 */
export function useHashScroll(settleMs = 10_000) {
  const { hash } = useLocation()
  useEffect(() => {
    const id = hash.slice(1)
    if (!id) return
    let active = true
    const stop = () => { active = false; window.clearInterval(timer) }
    const until = performance.now() + settleMs
    const tick = () => {
      if (!active) return
      // The target may not exist yet (lazy sections), and can't reach the top
      // until enough content below it has loaded: keep trying.
      const target = document.getElementById(id)
      if (target && Math.abs(target.getBoundingClientRect().top) > 1) target.scrollIntoView({ block: 'start' })
      if (performance.now() >= until) stop()
    }
    // Polled, not rAF: rAF is paused in background tabs, and a hash link
    // is often opened into one.
    const timer = window.setInterval(tick, 100)
    tick()
    window.addEventListener('wheel', stop, { passive: true, once: true })
    window.addEventListener('touchmove', stop, { passive: true, once: true })
    return () => {
      stop()
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchmove', stop)
    }
  }, [hash, settleMs])
}
