import { useKeyboardShortcutsContext, useRecordHotkey, formatCombination } from '@rdub/use-hotkeys'
import type { KeyCombinationDisplay } from '@rdub/use-hotkeys'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { HOTKEY_DESCRIPTIONS, HOTKEY_GROUPS } from '../hooks/useKeyboardShortcuts'
import { STATIONS_HOTKEY_DESCRIPTIONS, STATIONS_HOTKEY_GROUPS } from '../hooks/useStationsKeyboardShortcuts'
import { ShiftIcon, CommandIcon } from './icons'
import css from './ShortcutsModal.module.css'

// Get descriptions and groups for a specific route
function getRouteShortcuts(pathname: string) {
  // Home page
  if (pathname === '/') {
    return { descriptions: HOTKEY_DESCRIPTIONS, groups: HOTKEY_GROUPS }
  }

  // Stations page
  if (pathname === '/stations') {
    return { descriptions: STATIONS_HOTKEY_DESCRIPTIONS, groups: STATIONS_HOTKEY_GROUPS }
  }

  // For unknown routes (like /pipeline), don't show any shortcuts
  return { descriptions: {}, groups: {} }
}

interface ShortcutsModalProps {
  isOpen: boolean
  onClose: () => void
}

// Sequence timeout from useRecordHotkey
const SEQUENCE_TIMEOUT_MS = 1000

export function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  const shortcutsState = useKeyboardShortcutsContext()
  const { pathname } = useLocation()
  const [editingAction, setEditingAction] = useState<string | null>(null)
  const [timeoutAnimKey, setTimeoutAnimKey] = useState(0)

  // Get route-specific shortcuts (computed early for conflict detection)
  const { descriptions, groups } = useMemo(() => getRouteShortcuts(pathname), [pathname])

  // Compute route-specific conflicts (only flag conflicts between actions on THIS route)
  const routeConflicts = useMemo(() => {
    const conflicts = new Map<string, string[]>()
    const routeActions = new Set(Object.keys(descriptions))

    // For each key in the global conflicts map, check if MULTIPLE actions are on this route
    for (const [key, actions] of shortcutsState.conflicts) {
      const routeActionsForKey = actions.filter(a => routeActions.has(a))
      if (routeActionsForKey.length > 1) {
        conflicts.set(key, routeActionsForKey)
      }
    }
    return conflicts
  }, [shortcutsState.conflicts, descriptions])

  const hasRouteConflicts = routeConflicts.size > 0

  const handleCapture = useCallback(
    (_sequence: unknown, display: KeyCombinationDisplay) => {
      if (editingAction) {
        shortcutsState.setBinding(editingAction, display.id)
        setEditingAction(null)
      }
    },
    [editingAction, shortcutsState],
  )

  const handleCancel = useCallback(() => {
    setEditingAction(null)
  }, [])

  const { isRecording, startRecording, cancel, pendingKeys, activeKeys } = useRecordHotkey({
    onCapture: handleCapture,
    onCancel: handleCancel,
  })

  const startEditing = useCallback(
    (action: string) => {
      setEditingAction(action)
      startRecording()
    },
    [startRecording],
  )

  const cancelEditing = useCallback(() => {
    cancel()
    setEditingAction(null)
  }, [cancel])

  // Restart timeout animation when pendingKeys changes
  useEffect(() => {
    if (pendingKeys.length > 0) {
      setTimeoutAnimKey(k => k + 1)
    }
  }, [pendingKeys.length])

  // Check if a key has a route-specific conflict
  const hasConflict = (key: string) => routeConflicts.has(key)

  if (!isOpen) return null

  // Group shortcuts by prefix (include all actions, even those without bindings)
  const groupedShortcuts: Record<string, Array<{ action: string; description: string; keys: string[] }>> = {}

  // Debug: log bindings for relevant actions
  const stackNoneKeys = shortcutsState.getBindingsForAction('stack:none')
  const regionNycKeys = shortcutsState.getBindingsForAction('region:nyc')
  console.log('ShortcutsModal bindings:', { 'stack:none': stackNoneKeys, 'region:nyc': regionNycKeys })

  for (const [action, description] of Object.entries(descriptions)) {
    const keys = shortcutsState.getBindingsForAction(action)
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

  // Format keys being recorded
  const getRecordingDisplay = () => {
    if (pendingKeys.length === 0 && (!activeKeys || !activeKeys.key)) {
      return '...'
    }
    // Format pending keys (already pressed and released)
    let display = pendingKeys.length > 0 ? formatCombination(pendingKeys).display : ''
    // Add currently held keys
    if (activeKeys && activeKeys.key) {
      if (display) display += ' '
      display += formatCombination([activeKeys]).display
    }
    return display + '...'
  }

  return (
    <div className={css.backdrop} onClick={onClose}>
      <div
        className={css.modal}
        onClick={(e) => {
          e.stopPropagation() // Prevent closing modal
          // Cancel editing if clicking on empty space (not on a kbd or button)
          if (isRecording && !(e.target as HTMLElement).closest('kbd, button')) {
            cancelEditing()
          }
        }}
        role="dialog"
        aria-modal="true"
      >
        <div className={css.header}>
          <h2>Keyboard Shortcuts</h2>
          <button onClick={onClose} aria-label="Close" className={css.closeBtn}>&times;</button>
        </div>

        {hasRouteConflicts && (
          <div className={css.conflictWarning}>
            <span className={css.warningIcon}>⚠</span>
            Some shortcuts have conflicts and are disabled. Click to reassign.
          </div>
        )}

        <div className={css.content}>
          {Object.entries(groupedShortcuts)
            .sort(([a], [b]) => {
              // "Other" should come last
              if (a === 'Other') return 1
              if (b === 'Other') return -1
              return 0
            })
            .map(([groupName, shortcuts]) => (
            <div key={groupName} className={css.group}>
              <h3>{groupName}</h3>
              <table className={css.table}>
                <tbody>
                  {shortcuts.map(({ action, description, keys }) => {
                    const isEditing = editingAction === action
                    const showTimeoutBar = isEditing && pendingKeys.length > 0
                    return (
                      <tr key={action}>
                        <td className={css.description}>{description}</td>
                        <td className={css.keys}>
                          {isEditing ? (
                            <kbd className={`${css.kbd} ${css.editing}`} onClick={cancelEditing}>
                              {getRecordingDisplay()}
                              {showTimeoutBar && (
                                <span
                                  key={timeoutAnimKey}
                                  className={css.timeoutBar}
                                  style={{ animationDuration: `${SEQUENCE_TIMEOUT_MS}ms` }}
                                />
                              )}
                            </kbd>
                          ) : keys.length === 0 ? (
                            <kbd
                              className={`${css.kbd} ${css.clickable}`}
                              onClick={() => startEditing(action)}
                              title="Click to set keybinding"
                            >
                              -
                            </kbd>
                          ) : (
                            keys.map((key, i) => {
                              const isConflict = hasConflict(key)
                              const classes = [css.kbd, css.clickable, isConflict && css.conflict].filter(Boolean).join(' ')
                              return (
                                <kbd
                                  key={i}
                                  className={classes}
                                  onClick={() => !isRecording && startEditing(action)}
                                  title={isConflict ? 'Conflict! Click to change' : 'Click to change'}
                                >
                                  {renderKey(key)}
                                </kbd>
                              )
                            })
                          )}
                        </td>
                      </tr>
                    )
                  })}
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
