import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'

const STORAGE_KEY = 'ctbk-shortcuts-modal-open'

interface ShortcutsModalContextType {
  isOpen: boolean
  open: () => void
  close: () => void
}

const ShortcutsModalContext = createContext<ShortcutsModalContextType | null>(null)

export function ShortcutsModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      if (isOpen) {
        sessionStorage.setItem(STORAGE_KEY, 'true')
      } else {
        sessionStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      // Ignore storage errors
    }
  }, [isOpen])

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  return (
    <ShortcutsModalContext.Provider value={{ isOpen, open, close }}>
      {children}
    </ShortcutsModalContext.Provider>
  )
}

export function useShortcutsModal() {
  const context = useContext(ShortcutsModalContext)
  if (!context) {
    throw new Error('useShortcutsModal must be used within a ShortcutsModalProvider')
  }
  return context
}
