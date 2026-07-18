import { Box, Typography } from "@mui/material"
import { Link, useLocation } from "react-router-dom"
import { Footer } from "../components/Footer"

export default function NotFound() {
  const { pathname } = useLocation()
  return (
    <Box sx={{ p: 4, maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h3" component="h1" sx={{ mt: 6, mb: 2 }}>404</Typography>
      <Typography sx={{ mb: 3 }}>
        No page at <code>{pathname}</code>.
      </Typography>
      <Typography sx={{ mb: 6 }}>
        Try the <Link to="/">dashboard</Link>, the{' '}
        <Link to="/stations">stations map</Link>, or{' '}
        <Link to="/health">system health</Link>.
      </Typography>
      <Footer showHome />
    </Box>
  )
}
