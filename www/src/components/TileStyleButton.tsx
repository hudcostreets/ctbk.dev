import { FaHome, FaMap } from 'react-icons/fa'
import { MdLightMode, MdDarkMode } from 'react-icons/md'
import { Link } from 'react-router-dom'
import { useUrlParam, stringParam } from '@rdub/use-url-params'
import { useTheme } from '../contexts/ThemeContext'
import { buttonClass } from './ThemeToggle'

// Tile styles: 'a' = auto (follows theme), 'o' = OSM override
const TILE_NAMES: Record<string, string> = {
  a: 'Auto',
  o: 'OSM',
}

// Combined theme + tile toggle button
// Cycles: Light → Dark → OSM → Light...
export function ThemeTileToggle() {
  const { actualTheme, setTheme } = useTheme()
  const [tileCode, setTileCode] = useUrlParam('t', stringParam('a'))

  // Determine current state: light, dark, or osm
  const isOsm = tileCode === 'o'
  const currentState = isOsm ? 'osm' : actualTheme

  const cycle = () => {
    if (currentState === 'light') {
      // Light → Dark
      setTheme('dark')
      setTileCode('a')
    } else if (currentState === 'dark') {
      // Dark → OSM (keep current theme)
      setTileCode('o')
    } else {
      // OSM → Light
      setTheme('light')
      setTileCode('a')
    }
  }

  const getIcon = () => {
    switch (currentState) {
      case 'light': return <MdLightMode />
      case 'dark': return <MdDarkMode />
      case 'osm': return <FaMap />
    }
  }

  const getLabel = () => {
    switch (currentState) {
      case 'light': return 'Light'
      case 'dark': return 'Dark'
      case 'osm': return 'OSM'
    }
  }

  return (
    <button
      className={buttonClass}
      onClick={cycle}
      title={`Theme: ${getLabel()}`}
      aria-label={`Current theme: ${getLabel()}. Click to cycle.`}
    >
      {getIcon()}
    </button>
  )
}

// Standalone tile toggle (for backwards compatibility or separate use)
export function TileStyleButton() {
  const [tileCode, setTileCode] = useUrlParam('t', stringParam('a'))
  const isOsm = tileCode === 'o'

  const toggle = () => setTileCode(isOsm ? 'a' : 'o')
  const currentName = TILE_NAMES[tileCode || 'a'] || 'Auto'

  return (
    <button
      className={buttonClass}
      onClick={toggle}
      title={`Map: ${currentName}`}
      aria-label={`Current map style: ${currentName}. Click to toggle OSM.`}
    >
      <FaMap />
    </button>
  )
}

// Home button linking back to main page
export function HomeButton() {
  return (
    <Link
      to="/"
      className={buttonClass}
      title="Home"
      aria-label="Go to home page"
    >
      <FaHome />
    </Link>
  )
}
