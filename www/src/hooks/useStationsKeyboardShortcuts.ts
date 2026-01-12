import { useAction } from 'use-kbd'

interface UseStationsKeyboardShortcutsProps {
  month: string | undefined
  setMonth: (month: string) => void
  availableMonths: string[]
  setSelectedId: (id: string | undefined) => void
  openSearch: () => void
  toggleTheme: () => void
  monthSelectRef: React.RefObject<HTMLSelectElement | null>
}

export function useStationsKeyboardShortcuts({
  month,
  setMonth,
  availableMonths,
  setSelectedId,
  openSearch,
  toggleTheme,
  monthSelectRef,
}: UseStationsKeyboardShortcutsProps) {
  // Month navigation
  useAction('month:prev', {
    label: 'Previous month',
    group: 'Month',
    defaultBindings: ['arrowleft'],
    handler: () => {
      if (!month || availableMonths.length === 0) return
      const currentIdx = availableMonths.indexOf(month)
      // availableMonths is sorted newest first, so "prev" means older = higher index
      if (currentIdx < availableMonths.length - 1) {
        setMonth(availableMonths[currentIdx + 1])
      }
    },
  })

  useAction('month:next', {
    label: 'Next month',
    group: 'Month',
    defaultBindings: ['arrowright'],
    handler: () => {
      if (!month || availableMonths.length === 0) return
      const currentIdx = availableMonths.indexOf(month)
      // availableMonths is sorted newest first, so "next" means newer = lower index
      if (currentIdx > 0) {
        setMonth(availableMonths[currentIdx - 1])
      }
    },
  })

  useAction('month:focus', {
    label: 'Focus month selector',
    group: 'Month',
    defaultBindings: ['m'],
    handler: () => {
      // Focus the month selector - MUI Select uses a hidden input
      const selectElement = monthSelectRef.current
      if (selectElement) {
        selectElement.focus()
        // Trigger click to open the dropdown
        selectElement.click()
      }
    },
  })

  // Station actions
  useAction('station:deselect', {
    label: 'Deselect station',
    group: 'Station',
    defaultBindings: ['escape'],
    handler: () => setSelectedId(undefined),
  })

  useAction('station:search', {
    label: 'Search stations',
    group: 'Station',
    defaultBindings: ['/'],
    handler: openSearch,
  })

  // Other
  useAction('stations:theme', {
    label: 'Theme (system/light/dark)',
    group: 'Other',
    defaultBindings: ['t'],
    handler: toggleTheme,
  })
}
