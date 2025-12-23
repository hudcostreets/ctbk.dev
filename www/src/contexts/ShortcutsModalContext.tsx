import { createContext, useContext, useState, useCallback, ReactNode } from 'react'

interface ShortcutsModalContextType {
  isOpen: boolean
  open: () => void
  close: () => void
}

const ShortcutsModalContext = createContext<ShortcutsModalContextType | null>(null)

export function ShortcutsModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
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
