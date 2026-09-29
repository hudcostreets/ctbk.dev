/**
 * Multi-select mode bar for the GL station maps (`lib/mapSelection`): shown
 * over the map while the mode is on, with the set's size, Done (keep the
 * set, leave the mode) and Clear. Rendered as map chrome, outside the
 * gesture surface, so its taps never reach the map.
 */
import { useCanHover } from '../lib/useMediaQuery'
import css from '../stations.module.css'

export default function MultiSelectBar({ n, onDone, onClear }: {
  n: number
  onDone: () => void
  onClear: () => void
}) {
  const canHover = useCanHover()
  return (
    <div className={css.multiBar} data-testid="multi-bar">
      <span data-testid="multi-count">{n} selected</span>
      <span className={css.multiBarHint}>
        {canHover ? 'click to add / remove' : 'tap to add / remove · long-press + drag to box-select'}
      </span>
      <button type="button" onClick={onClear}>Clear</button>
      <button type="button" className={css.multiBarDone} onClick={onDone} data-testid="multi-done">Done</button>
    </div>
  )
}
