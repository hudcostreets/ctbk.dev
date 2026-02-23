import 'bootstrap/dist/css/bootstrap.css'
import '../styles/globals.css'
import { ThemeProvider as MuiThemeProvider, createTheme } from "@mui/material"
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { ThemeProvider, useTheme } from "./contexts/ThemeContext"
import { ThemeToggle } from "./components/ThemeToggle"
import { HomeButton, ThemeTileToggle } from "./components/TileStyleButton"
import { useScrollToHash } from "./hooks/useScrollToHash"
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
  const { pathname } = useLocation()
  const isStationsPage = pathname === '/stations'
  useScrollToHash()

  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/stations" element={<Stations />} />
        <Route path="/pipeline" element={<Pipeline />} />
      </Routes>
      <ThemeToggle hideThemeButton={isStationsPage}>
        {isStationsPage && (
          <>
            <HomeButton />
            <ThemeTileToggle />
          </>
        )}
      </ThemeToggle>
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
      <MuiThemeWrapper>
        <BrowserRouter>
          <AppContent />
        </BrowserRouter>
      </MuiThemeWrapper>
    </ThemeProvider>
  </StrictMode>,
)
