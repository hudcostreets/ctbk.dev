import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// Scroll to hash anchor on navigation
export function useScrollToHash() {
  const { hash, pathname } = useLocation()
  useEffect(() => {
    if (hash) {
      // Small delay to ensure DOM is rendered
      const timer = setTimeout(() => {
        const el = document.getElementById(hash.slice(1))
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }, 100)
      return () => clearTimeout(timer)
    } else {
      // Scroll to top on navigation without hash
      window.scrollTo(0, 0)
    }
  }, [hash, pathname])
}
