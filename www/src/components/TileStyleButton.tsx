import { FaMap } from 'react-icons/fa'
import { useUrlParam, stringParam } from '@rdub/use-url-params'
import { buttonClass } from './ThemeToggle'

// Tile styles in order for cycling
const TILE_CYCLE = ['d', 'l', 'o'] as const
const TILE_NAMES: Record<string, string> = {
  d: 'Dark',
  l: 'Light',
  o: 'OSM',
}

export function TileStyleButton() {
  const [tileCode, setTileCode] = useUrlParam('t', stringParam('d'))

  const cycleTileStyle = () => {
    const currentIdx = TILE_CYCLE.indexOf(tileCode as typeof TILE_CYCLE[number])
    const nextIdx = (currentIdx + 1) % TILE_CYCLE.length
    setTileCode(TILE_CYCLE[nextIdx])
  }

  const currentName = TILE_NAMES[tileCode || 'd'] || 'Dark'

  return (
    <button
      className={buttonClass}
      onClick={cycleTileStyle}
      title={`Map: ${currentName}`}
      aria-label={`Current map style: ${currentName}. Click to cycle styles.`}
    >
      <FaMap />
    </button>
  )
}
