import 'bootstrap/dist/css/bootstrap.css'
import '../styles/globals.css'
import { KeyboardShortcutsProvider } from '@rdub/use-hotkeys'
import { ThemeProvider as MuiThemeProvider } from "@mui/material"
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import muiTheme from "./theme"
import { ThemeProvider } from "./contexts/ThemeContext"
import { ShortcutsModalProvider, useShortcutsModal } from "./contexts/ShortcutsModalContext"
import { ThemeToggle } from "./components/ThemeToggle"
import { ShortcutsModal } from "./components/ShortcutsModal"
import { DEFAULT_HOTKEY_MAP } from "./hooks/useKeyboardShortcuts"
import Home from "./pages/Home"
import Stations from "./pages/Stations"

function AppContent() {
  const { isOpen, open, close } = useShortcutsModal()

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/stations" element={<Stations />} />
      </Routes>
      <ThemeToggle onOpenShortcuts={open} />
      <ShortcutsModal isOpen={isOpen} onClose={close} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <KeyboardShortcutsProvider defaults={DEFAULT_HOTKEY_MAP} storageKey="ctbk-hotkeys">
        <MuiThemeProvider theme={muiTheme}>
          <ShortcutsModalProvider>
            <BrowserRouter>
              <AppContent />
            </BrowserRouter>
          </ShortcutsModalProvider>
        </MuiThemeProvider>
      </KeyboardShortcutsProvider>
    </ThemeProvider>
  </StrictMode>,
)
