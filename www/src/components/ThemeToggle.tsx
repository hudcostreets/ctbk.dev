import { useState, useEffect, useRef } from 'react'
import { FaKeyboard } from 'react-icons/fa'
import { MdBrightnessAuto, MdLightMode, MdDarkMode } from 'react-icons/md'
import { useTheme } from '../contexts/ThemeContext'
import css from './ThemeToggle.module.css'

interface ThemeToggleProps {
  onOpenShortcuts?: () => void
}

export function ThemeToggle({ onOpenShortcuts }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme()
  const [isVisible, setIsVisible] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const lastScrollY = useRef(0)
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Detect mobile on mount
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY
      const scrollingDown = currentScrollY > lastScrollY.current
      const nearBottom = (window.innerHeight + currentScrollY) >= (document.body.scrollHeight - 100)

      // Clear any pending hide timeout
      if (hideTimeout.current) {
        clearTimeout(hideTimeout.current)
        hideTimeout.current = null
      }

      // Show when scrolling down past 30px OR near bottom
      if ((scrollingDown && currentScrollY > 30) || nearBottom) {
        setIsVisible(true)
        // Auto-hide after 2.5 seconds of no scrolling
        hideTimeout.current = setTimeout(() => setIsVisible(false), 2500)
      } else if (!scrollingDown) {
        // Hide when scrolling up
        setIsVisible(false)
      }

      lastScrollY.current = currentScrollY
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (hideTimeout.current) clearTimeout(hideTimeout.current)
    }
  }, [])

  const cycleTheme = () => {
    if (theme === 'light') setTheme('dark')
    else if (theme === 'dark') setTheme('system')
    else setTheme('light')
  }

  const getThemeIcon = () => {
    switch (theme) {
      case 'light': return <MdLightMode />
      case 'dark': return <MdDarkMode />
      case 'system': return <MdBrightnessAuto />
    }
  }

  const getThemeLabel = () => {
    switch (theme) {
      case 'light': return 'Light'
      case 'dark': return 'Dark'
      case 'system': return 'System'
    }
  }

  const showControls = isVisible || isHovering

  return (
    <div
      className={css.container}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div className={`${css.controls} ${showControls ? css.visible : ''}`}>
        {onOpenShortcuts && !isMobile && (
          <button
            className={css.button}
            onClick={onOpenShortcuts}
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
          >
            <FaKeyboard />
          </button>
        )}
        <button
          className={css.button}
          onClick={cycleTheme}
          title={`Theme: ${getThemeLabel()}`}
          aria-label={`Current theme: ${getThemeLabel()}. Click to cycle themes.`}
        >
          <span className={css.icon}>{getThemeIcon()}</span>
        </button>
      </div>
    </div>
  )
}
