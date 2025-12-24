import 'bootstrap/dist/css/bootstrap.css'
import '../styles/globals.css'
import { KeyboardShortcutsProvider } from '@rdub/use-hotkeys'
import { ThemeProvider as MuiThemeProvider, createTheme } from "@mui/material"
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { ThemeProvider, useTheme } from "./contexts/ThemeContext"
import { ShortcutsModalProvider, useShortcutsModal } from "./contexts/ShortcutsModalContext"
import { ThemeToggle } from "./components/ThemeToggle"
import { TileStyleButton } from "./components/TileStyleButton"
import { ShortcutsModal } from "./components/ShortcutsModal"
import { DEFAULT_HOTKEY_MAP } from "./hooks/useKeyboardShortcuts"
import { STATIONS_HOTKEY_MAP } from "./hooks/useStationsKeyboardShortcuts"
import type { HotkeyMap } from "@rdub/use-hotkeys"

// Merge hotkey maps, combining conflicting keys into arrays
function mergeHotkeyMaps(...maps: HotkeyMap[]): HotkeyMap {
  const result: HotkeyMap = {}
  for (const map of maps) {
    for (const [key, action] of Object.entries(map)) {
      if (result[key]) {
        // Key already exists - merge actions
        const existing = result[key]
        const existingActions = Array.isArray(existing) ? existing : [existing]
        const newActions = Array.isArray(action) ? action : [action]
        // Combine unique actions
        const combined = [...new Set([...existingActions, ...newActions])]
        result[key] = combined.length === 1 ? combined[0] : combined
      } else {
        result[key] = action
      }
    }
  }
  return result
}

// Merge all page hotkey maps for the global provider
const ALL_HOTKEY_MAP = mergeHotkeyMaps(DEFAULT_HOTKEY_MAP, STATIONS_HOTKEY_MAP)
import Home from "./pages/Home"
import Stations from "./pages/Stations"
import PipelineMdx from "./pages/Pipeline.mdx"
import { Box } from "@mui/material"
import { Footer } from "./components/Footer"

function Pipeline() {
  return (
    <Box sx={{ p: 4, maxWidth: 900, mx: 'auto' }}>
      <PipelineMdx />
      <Footer showHome showPipeline={false} />
    </Box>
  )
}

function AppContent() {
  const { isOpen, open, close } = useShortcutsModal()
  const { pathname } = useLocation()
  const isStationsPage = pathname === '/stations'

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/stations" element={<Stations />} />
        <Route path="/pipeline" element={<Pipeline />} />
      </Routes>
      <ThemeToggle onOpenShortcuts={open}>
        {isStationsPage && <TileStyleButton />}
      </ThemeToggle>
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
