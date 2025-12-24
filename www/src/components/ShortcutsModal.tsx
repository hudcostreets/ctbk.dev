import { useKeyboardShortcutsContext, useRecordHotkey, formatCombination } from '@rdub/use-hotkeys'
import type { KeyCombinationDisplay } from '@rdub/use-hotkeys'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

  // Ref to track if we're switching to another action (to prevent cancel)
  const switchingToActionRef = useRef<string | null>(null)

  // Ref to track the current editing action for capture callbacks
  // (avoids closure capture issues with useEventCallback)
  const editingActionRef = useRef<string | null>(null)

  // Get route-specific shortcuts (computed early for conflict detection)
  const { descriptions, groups } = useMemo(() => getRouteShortcuts(pathname), [pathname])

  // Build flat list of actions in display order (for Tab navigation)
  const actionList = useMemo(() => {
    const groupedShortcuts: Record<string, string[]> = {}

    for (const action of Object.keys(descriptions)) {
      const prefix = action.split(':')[0]
      const groupName = groups[prefix] || 'Other'
      if (!groupedShortcuts[groupName]) {
        groupedShortcuts[groupName] = []
      }
      groupedShortcuts[groupName].push(action)
    }

    // Flatten in display order (Other last)
    const orderedGroups = Object.keys(groupedShortcuts).sort((a, b) => {
      if (a === 'Other') return 1
      if (b === 'Other') return -1
      return 0
    })

    return orderedGroups.flatMap(g => groupedShortcuts[g])
  }, [descriptions, groups])

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
      // Read from ref to avoid closure capture issues with useEventCallback
      const action = editingActionRef.current
      if (action) {
        // Use setBinding to replace (not add) - enforces max one sequence per action
        shortcutsState.setBinding(action, display.id)
        // Only clear editing if we're not switching to another action
        if (!switchingToActionRef.current) {
          editingActionRef.current = null
          setEditingAction(null)
        }
      }
    },
    [shortcutsState],
  )

  const handleCancel = useCallback(() => {
    // Only clear if we're not switching to another action
    if (!switchingToActionRef.current) {
      editingActionRef.current = null
      setEditingAction(null)
    }
  }, [])

  // Handle Tab: advance to next action
  const handleTab = useCallback(() => {
    if (!editingAction) return

    const currentIdx = actionList.indexOf(editingAction)
    if (currentIdx === -1) return

    const nextIdx = (currentIdx + 1) % actionList.length
    const nextAction = actionList[nextIdx]

    // Mark that we're switching (to prevent cancel from clearing)
    switchingToActionRef.current = nextAction
    editingActionRef.current = nextAction
    setEditingAction(nextAction)

    // Clear the switching flag after a tick
    setTimeout(() => {
      switchingToActionRef.current = null
    }, 0)
  }, [editingAction, actionList])

  // Handle Shift+Tab: go to previous action
  const handleShiftTab = useCallback(() => {
    if (!editingAction) return

    const currentIdx = actionList.indexOf(editingAction)
    if (currentIdx === -1) return

    const prevIdx = (currentIdx - 1 + actionList.length) % actionList.length
    const prevAction = actionList[prevIdx]

    // Mark that we're switching (to prevent cancel from clearing)
    switchingToActionRef.current = prevAction
    editingActionRef.current = prevAction
    setEditingAction(prevAction)

    // Clear the switching flag after a tick
    setTimeout(() => {
      switchingToActionRef.current = null
    }, 0)
  }, [editingAction, actionList])

  const { isRecording, startRecording, cancel, commit, pendingKeys, activeKeys } = useRecordHotkey({
    onCapture: handleCapture,
    onCancel: handleCancel,
    onTab: handleTab,
    onShiftTab: handleShiftTab,
  })

  const startEditing = useCallback(
    (action: string) => {
      editingActionRef.current = action
      setEditingAction(action)
      startRecording()
    },
    [startRecording],
  )

  // Handle clicking another entry during recording
  const handleEntryClick = useCallback(
    (action: string) => {
      if (isRecording && editingAction && action !== editingAction) {
        // Commit current edit (if pending keys) and switch to new action
        switchingToActionRef.current = action
        // The pending keys will be submitted by the timeout, or we cancel
        cancel() // This triggers handleCancel but switchingToActionRef prevents clearing
        editingActionRef.current = action
        setEditingAction(action)
        startRecording()
        setTimeout(() => {
          switchingToActionRef.current = null
        }, 0)
      } else if (!isRecording) {
        startEditing(action)
      }
    },
    [isRecording, editingAction, cancel, startRecording, startEditing],
  )

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
          // Commit/cancel editing if clicking on empty space (not on a kbd or button)
          // If there are pending keys, commit them; otherwise cancel
          if (isRecording && !(e.target as HTMLElement).closest('kbd, button')) {
            commit()
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
                            <kbd className={`${css.kbd} ${css.editing}`} onClick={commit}>
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
                              className={`${css.kbd} ${css.clickable} ${css.empty}`}
                              onClick={() => handleEntryClick(action)}
                              title="Click to set keybinding"
                            >
                              ∅
                            </kbd>
                          ) : (
                            keys.map((key, i) => {
                              const isConflict = hasConflict(key)
                              const classes = [css.kbd, css.clickable, isConflict && css.conflict].filter(Boolean).join(' ')
                              return (
                                <kbd
                                  key={i}
                                  className={classes}
                                  onClick={() => handleEntryClick(action)}
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
