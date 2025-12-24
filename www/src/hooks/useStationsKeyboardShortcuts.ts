import { useRegisteredHotkeys, type HotkeyMap } from '@rdub/use-hotkeys'
import { useMemo } from 'react'

interface UseStationsKeyboardShortcutsProps {
  month: string | undefined
  setMonth: (month: string) => void
  availableMonths: string[]
  setSelectedId: (id: string | undefined) => void
  openShortcutsModal: () => void
  openSearch: () => void
  toggleTheme: () => void
  monthSelectRef: React.RefObject<HTMLSelectElement | null>
}

// Hotkey map for Stations page
export const STATIONS_HOTKEY_MAP: HotkeyMap = {
  'ArrowLeft': 'month:prev',
  'ArrowRight': 'month:next',
  'Escape': 'station:deselect',
  '/': 'station:search',
  'm': 'month:focus',
  't': 'other:theme',
  '?': 'modal:shortcuts',
  'meta+/': 'modal:shortcuts',
} as const

// Descriptions for keyboard shortcuts modal
export const STATIONS_HOTKEY_DESCRIPTIONS: Record<string, string> = {
  'month:prev': 'Previous month',
  'month:next': 'Next month',
  'station:deselect': 'Deselect station',
  'station:search': 'Search stations',
  'month:focus': 'Focus month selector',
  'other:theme': 'Theme (system/light/dark)',
  'modal:shortcuts': 'This dialog',
}

// Group names for shortcuts modal
export const STATIONS_HOTKEY_GROUPS: Record<string, string> = {
  'month': 'Month',
  'station': 'Station',
  'modal': 'Other',
  'other': 'Other',
}

export function useStationsKeyboardShortcuts({
  month,
  setMonth,
  availableMonths,
  setSelectedId,
  openShortcutsModal,
  openSearch,
  toggleTheme,
  monthSelectRef,
}: UseStationsKeyboardShortcutsProps) {
  const handlers = useMemo(() => ({
    'month:prev': () => {
      if (!month || availableMonths.length === 0) return
      const currentIdx = availableMonths.indexOf(month)
      // availableMonths is sorted newest first, so "prev" means older = higher index
      if (currentIdx < availableMonths.length - 1) {
        setMonth(availableMonths[currentIdx + 1])
      }
    },
    'month:next': () => {
      if (!month || availableMonths.length === 0) return
      const currentIdx = availableMonths.indexOf(month)
      // availableMonths is sorted newest first, so "next" means newer = lower index
      if (currentIdx > 0) {
        setMonth(availableMonths[currentIdx - 1])
      }
    },
    'station:deselect': () => {
      setSelectedId(undefined)
    },
    'station:search': openSearch,
    'month:focus': () => {
      // Focus the month selector - MUI Select uses a hidden input
      const selectElement = monthSelectRef.current
      if (selectElement) {
        selectElement.focus()
        // Trigger click to open the dropdown
        selectElement.click()
      }
    },
    'other:theme': toggleTheme,
    'modal:shortcuts': openShortcutsModal,
  }), [month, setMonth, availableMonths, setSelectedId, openShortcutsModal, openSearch, toggleTheme, monthSelectRef])

  return useRegisteredHotkeys(handlers, { sequenceTimeout: 1000 })
}
