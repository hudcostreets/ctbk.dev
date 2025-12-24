import 'bootstrap/dist/css/bootstrap.css'
import '../styles/globals.css'
import { KeyboardShortcutsProvider } from '@rdub/use-hotkeys'
import { ThemeProvider as MuiThemeProvider, createTheme } from "@mui/material"
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider, useTheme } from "./contexts/ThemeContext"
import { ShortcutsModalProvider, useShortcutsModal } from "./contexts/ShortcutsModalContext"
import { ThemeToggle } from "./components/ThemeToggle"
import { ShortcutsModal } from "./components/ShortcutsModal"
import { DEFAULT_HOTKEY_MAP } from "./hooks/useKeyboardShortcuts"
import { STATIONS_HOTKEY_MAP } from "./hooks/useStationsKeyboardShortcuts"

// Merge all page hotkey maps for the global provider
const ALL_HOTKEY_MAP = {
  ...DEFAULT_HOTKEY_MAP,
  ...STATIONS_HOTKEY_MAP,
}
import Home from "./pages/Home"
import Stations from "./pages/Stations"
import PipelineMdx from "./pages/Pipeline.mdx"
import { Box } from "@mui/material"

function Pipeline() {
  return (
    <Box sx={{ p: 4, maxWidth: 900, mx: 'auto' }}>
      <PipelineMdx />
    </Box>
  )
}

function AppContent() {
  const { isOpen, open, close } = useShortcutsModal()

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/stations" element={<Stations />} />
        <Route path="/pipeline" element={<Pipeline />} />
      </Routes>
      <ThemeToggle onOpenShortcuts={open} />
      <ShortcutsModal isOpen={isOpen} onClose={close} />
    </>
  )
}

function MuiThemeWrapper({ children }: { children: React.ReactNode }) {
  const { actualTheme } = useTheme()
  const muiTheme = useMemo(() => createTheme({
    palette: {
      mode: actualTheme,
    },
  }), [actualTheme])

  return (
    <MuiThemeProvider theme={muiTheme}>
      {children}
    </MuiThemeProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <KeyboardShortcutsProvider defaults={ALL_HOTKEY_MAP} storageKey="ctbk-hotkeys">
        <MuiThemeWrapper>
          <ShortcutsModalProvider>
            <BrowserRouter>
              <AppContent />
            </BrowserRouter>
          </ShortcutsModalProvider>
        </MuiThemeWrapper>
      </KeyboardShortcutsProvider>
    </ThemeProvider>
  </StrictMode>,
)
