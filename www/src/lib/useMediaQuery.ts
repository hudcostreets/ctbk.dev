import { useEffect, useState } from 'react'

/** Live `matchMedia(query).matches` (false where `matchMedia` is missing). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

/** A pointer that can hover (mouse / trackpad): hover tooltips make sense. */
export const useCanHover = () => useMediaQuery('(hover: hover)')

/** Wide enough for docked / always-expanded map chrome (vs. phone layouts
 *  that collapse it). Shared by `/timelapse` and `/stations`. */
export const WIDE = '(min-width: 768px)'
export const useWide = () => useMediaQuery(WIDE)
