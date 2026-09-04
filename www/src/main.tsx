import 'bootstrap/dist/css/bootstrap.css'
import 'use-kbd/styles.css'
import '../styles/globals.css'
import { HotkeysProvider, ShortcutsModal, Omnibar, LookupModal, SequenceModal, useHotkeysContext } from 'use-kbd'
import { ThemeProvider as MuiThemeProvider, createTheme } from "@mui/material"
import { StrictMode, Suspense, lazy, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { PlotlyProvider } from 'pltly/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from "./query/client"
import { ThemeProvider, useTheme } from "./contexts/ThemeContext"
import { FlagsProvider } from "./contexts/FlagsContext"
import { FlagsPanel } from "./components/FlagsPanel"
import { DbgPanel } from "./components/DbgPanel"
import { ThemeToggle } from "./components/ThemeToggle"
import { HomeButton, ThemeTileToggle } from "./components/TileStyleButton"
import { useScrollToHash } from "./hooks/useScrollToHash"
import { useGlobalStationsOmnibar } from "./hooks/useGlobalStationsOmnibar"
import Home from "./pages/Home"
import NotFound from "./pages/NotFound"
import { Box } from "@mui/material"
import { Footer } from "./components/Footer"

// Cloudflare Web Analytics (RUM: page views + Core Web Vitals). Manual
// mode — the beacon reports directly to CF's collector (predates the
// Workers-Assets hosting; still fine under it). Prod-only: the RUM endpoint
// rejects CORS preflight from origins not in the token's allowed-domains
// list, which would spam the console on `localhost` dev.
if (import.meta.env.PROD) {
  const s = document.createElement('script')
  s.defer = true
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js'
  s.setAttribute('data-cf-beacon', '{"token": "4bd00e4ade70447c89813154f57c6260"}')
  document.head.appendChild(s)
}

// Other routes are lazy so leaflet / station-detail / MDX stay off Home's
// critical path. Home itself is eagerly imported since it's the common
// landing page.
const Stations = lazy(() => import("./pages/Stations"))
const StationDetail = lazy(() => import("./pages/StationDetail"))
const PipelineMdx = lazy(() => import("./pages/Pipeline.mdx"))
const Files = lazy(() => import("./pages/Files"))
const Health = lazy(() => import("./pages/Health"))
const FeedHealth = lazy(() => import("./pages/FeedHealth"))
const CellsDebug = lazy(() => import("./pages/CellsDebug"))

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
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          {/* `/v2` alias preserves bookmarks from the pre-cutover canary phase
              (see #71). Can be removed after a deprecation window. */}
          <Route path="/v2" element={<Home />} />
          <Route path="/stations" element={<Stations />} />
          <Route path="/s/:id" element={<StationDetail />} />
          {/* Back-compat: redirect old /stations/:id form to /s/:id */}
          <Route path="/stations/:id" element={<StationDetail />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/files" element={<Files />} />
          <Route path="/files/*" element={<Files />} />
          <Route path="/health" element={<Health />} />
          <Route path="/health/feed" element={<FeedHealth />} />
          <Route path="/cells-debug" element={<CellsDebug />} />
          {/* Catch-all: the CFW assets router SPA-fallbacks unknown paths
              to index.html with a 200 (specs/done/www-cfw-migration.md),
              so the router must render a real 404 page, not an empty
              outlet. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
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
      <FlagsPanel />
      <DbgPanel />
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
      <FlagsProvider>
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
      </FlagsProvider>
    </QueryClientProvider>
  </StrictMode>,
)
