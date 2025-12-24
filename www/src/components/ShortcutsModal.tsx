import { useKeyboardShortcutsContext } from '@rdub/use-hotkeys'
import { useLocation } from 'react-router-dom'
import { HOTKEY_DESCRIPTIONS, HOTKEY_GROUPS } from '../hooks/useKeyboardShortcuts'
import { STATIONS_HOTKEY_DESCRIPTIONS, STATIONS_HOTKEY_GROUPS } from '../hooks/useStationsKeyboardShortcuts'
import { ShiftIcon, CommandIcon } from './icons'
import css from './ShortcutsModal.module.css'

// Map routes to their action prefixes (modal:* is shared)
const ROUTE_ACTION_PREFIXES: Record<string, string[]> = {
  '/': ['date', 'stack', 'yaxis', 'toggle', 'region', 'user', 'gender', 'bike', 'modal'],
  '/stations': ['month', 'station', 'modal'],
}

// Get descriptions and groups for a specific route
function getRouteShortcuts(pathname: string) {
  const prefixes = ROUTE_ACTION_PREFIXES[pathname]
  if (!prefixes) {
    // For unknown routes (like /pipeline), don't show any shortcuts
    return { descriptions: {}, groups: {} }
  }

  const descriptions: Record<string, string> = {}
  const groups: Record<string, string> = {}

  // Add Home page shortcuts if applicable
  if (pathname === '/') {
    Object.assign(descriptions, HOTKEY_DESCRIPTIONS)
    Object.assign(groups, HOTKEY_GROUPS)
  }

  // Add Stations page shortcuts if applicable
  if (pathname === '/stations') {
    Object.assign(descriptions, STATIONS_HOTKEY_DESCRIPTIONS)
    Object.assign(groups, STATIONS_HOTKEY_GROUPS)
  }

  return { descriptions, groups }
}

interface ShortcutsModalProps {
  isOpen: boolean
  onClose: () => void
}

export function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  const shortcutsState = useKeyboardShortcutsContext()
  const { pathname } = useLocation()

  if (!isOpen) return null

  // Get route-specific shortcuts
  const { descriptions, groups } = getRouteShortcuts(pathname)

  // Group shortcuts by prefix
  const groupedShortcuts: Record<string, Array<{ action: string; description: string; keys: string[] }>> = {}

  for (const [action, description] of Object.entries(descriptions)) {
    const keys = shortcutsState.getBindingsForAction(action)
    if (keys.length === 0) continue
    const prefix = action.split(':')[0]
    const groupName = groups[prefix] || 'Other'
    if (!groupedShortcuts[groupName]) {
      groupedShortcuts[groupName] = []
    }
    groupedShortcuts[groupName].push({ action, description, keys })
  }

  // Render a key combination nicely
  const renderKey = (key: string) => {
    if (key.startsWith('meta+') || key.startsWith('META+')) {
      return <><CommandIcon className={css.modifierIcon} />{key.slice(5).toUpperCase()}</>
    }
    if (key.startsWith('shift+') || key.startsWith('SHIFT+')) {
      return <><ShiftIcon className={css.modifierIcon} />{key.slice(6).toUpperCase()}</>
    }
    // Single uppercase letter = shift modifier needed
    if (key.length === 1 && key >= 'A' && key <= 'Z') {
      return <><ShiftIcon className={css.modifierIcon} />{key}</>
    }
    return key.toUpperCase()
  }

  return (
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.modal} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={css.header}>
          <h2>Keyboard Shortcuts</h2>
          <button onClick={onClose} aria-label="Close" className={css.closeBtn}>&times;</button>
        </div>

        <div className={css.content}>
          {Object.entries(groupedShortcuts).map(([groupName, shortcuts]) => (
            <div key={groupName} className={css.group}>
              <h3>{groupName}</h3>
              <table className={css.table}>
                <tbody>
                  {shortcuts.map(({ action, description, keys }) => (
                    <tr key={action}>
                      <td className={css.description}>{description}</td>
                      <td className={css.keys}>
                        {keys.length === 0 ? (
                          <kbd className={css.kbd}>-</kbd>
                        ) : (
                          keys.map((key, i) => (
                            <kbd key={i} className={css.kbd}>{renderKey(key)}</kbd>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div className={css.footer}>
          <button onClick={() => shortcutsState.reset()} className={css.resetBtn}>Reset to defaults</button>
        </div>
      </div>
    </div>
  )
}
