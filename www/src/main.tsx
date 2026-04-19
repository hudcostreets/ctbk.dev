import 'bootstrap/dist/css/bootstrap.css'
import 'use-kbd/styles.css'
import '../styles/globals.css'
import { HotkeysProvider, ShortcutsModal, Omnibar, LookupModal, SequenceModal, useHotkeysContext } from 'use-kbd'
import { ThemeProvider as MuiThemeProvider, createTheme } from "@mui/material"
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { PlotlyProvider } from 'pltly/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from "./query/client"
import { ThemeProvider, useTheme } from "./contexts/ThemeContext"
import { ThemeToggle } from "./components/ThemeToggle"
import { HomeButton, ThemeTileToggle } from "./components/TileStyleButton"
import { useScrollToHash } from "./hooks/useScrollToHash"
import { useGlobalStationsOmnibar } from "./hooks/useGlobalStationsOmnibar"
import Home from "./pages/Home"
import Stations from "./pages/Stations"
import StationDetail from "./pages/StationDetail"
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
  const { isModalOpen, closeModal, openModal } = useHotkeysContext()
  const { pathname } = useLocation()
  const isStationsPage = pathname === '/stations'
  useScrollToHash()
  useGlobalStationsOmnibar()

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/stations" element={<Stations />} />
        <Route path="/s/:id" element={<StationDetail />} />
        {/* Back-compat: redirect old /stations/:id form to /s/:id */}
        <Route path="/stations/:id" element={<StationDetail />} />
        <Route path="/pipeline" element={<Pipeline />} />
      </Routes>
      <ThemeToggle onOpenShortcuts={openModal} hideThemeButton={isStationsPage}>
        {isStationsPage && (
          <>
            <HomeButton />
            <ThemeTileToggle />
          </>
        )}
      </ThemeToggle>
      <ShortcutsModal
        isOpen={isModalOpen}
        onClose={closeModal}
        editable
      />
      <Omnibar />
      <LookupModal />
      <SequenceModal />
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
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <HotkeysProvider>
          <MuiThemeWrapper>
            <PlotlyProvider loader={() => import('plotly.js/basic' as 'plotly.js').then(m => m.default ?? m)}>
              <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <AppContent />
              </BrowserRouter>
            </PlotlyProvider>
          </MuiThemeWrapper>
        </HotkeysProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
