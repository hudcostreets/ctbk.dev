import { useState, useSyncExternalStore } from 'react'
import { useAction } from 'use-kbd'
import { useQuery } from '@tanstack/react-query'
import { Box, Button, Chip, Dialog, DialogContent, DialogTitle, IconButton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material'
import { dbgClear, dbgReqs, dbgSubscribe, dbgVersion, type DbgReq } from '../lib/dbg'
import { FLAGS, useFlagsController } from '../contexts/FlagsContext'
import { stationsApi } from '../query/stations'

const { round } = Math

interface HealthPyramid {
  name: string
  allComplete: boolean
  totalMissing: number
  totalStale: number
  now: string
}
interface HealthSnapshot {
  generatedAt: number
  pyramids: HealthPyramid[]
  defaultPyramid?: string
}

function fmtT(atMs: number): string {
  return new Date(atMs).toISOString().slice(11, 19)
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[i]
}

/** Per-path latency rollup over the ring buffer. */
function summarize(reqs: readonly DbgReq[]): { path: string, n: number, p50: number, p95: number, hits: number }[] {
  const byPath = new Map<string, DbgReq[]>()
  for (const r of reqs) {
    const arr = byPath.get(r.path)
    if (arr) arr.push(r)
    else byPath.set(r.path, [r])
  }
  return [...byPath.entries()].map(([path, rs]) => {
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b)
    return {
      path,
      n: rs.length,
      p50: quantile(ms, 0.5),
      p95: quantile(ms, 0.95),
      hits: rs.filter((r) => r.xCache === 'HIT').length,
    }
  }).sort((a, b) => b.n - a.n)
}

const cellSx = { px: 1, py: 0.4, fontSize: '0.8em', whiteSpace: 'nowrap' as const }

/** Hidden debug/metrics panel (shift+d): which pyramids are live (from
 *  /api/health) + the dbgFetch request log with latencies and cache/pyramid
 *  attribution. Collection is always on (see lib/dbg.ts); this dialog is
 *  just the viewer. */
export function DbgPanel() {
  const [open, setOpen] = useState(false)

  useAction('dbg:open', {
    label: 'Open API debug/metrics panel',
    group: 'Debug',
    defaultBindings: ['shift+d', 'cmd+shift+d'],
    handler: () => setOpen(true),
  })

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        API debug / metrics
        <IconButton onClick={() => setOpen(false)} size="small" aria-label="Close">×</IconButton>
      </DialogTitle>
      <DialogContent>
        {open && <DbgBody />}
      </DialogContent>
    </Dialog>
  )
}

function DbgBody() {
  useSyncExternalStore(dbgSubscribe, dbgVersion)
  const reqs = dbgReqs()
  const { flags, setFlag, resetFlag } = useFlagsController()
  const availPyramid = flags.availPyramid
  const pyramidOptions = FLAGS.availPyramid.options as readonly string[]
  const healthQ = useQuery<HealthSnapshot>({
    queryKey: ['dbg-health'],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`${stationsApi.API_BASE}/api/health`)
      if (!res.ok) throw new Error(`health: ${res.status}`)
      return res.json()
    },
  })
  const h = healthQ.data
  const summary = summarize(reqs)
  return (
    <>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Pyramids{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (click to pin the avail chart to a pyramid; click again to unpin —
          pinned: {availPyramid === 'default' ? 'none (server default)' : availPyramid})
        </Typography>
      </Typography>
      {h ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
          {[...h.pyramids].sort((a, b) => b.name.localeCompare(a.name)).map((p) => {
            // Only vocab pyramids (availPyramid flag options) are pinnable:
            // the chart queries `s:` identity keys, which legacy `avail`
            // (LUC-cell-keyed) doesn't store.
            const pinnable = pyramidOptions.includes(p.name)
            const pinned = availPyramid === p.name
            return (
              <Chip
                key={p.name}
                size="small"
                variant={pinned || (availPyramid === 'default' && p.name === h.defaultPyramid) ? 'filled' : 'outlined'}
                color={p.allComplete ? 'success' : 'warning'}
                onClick={pinnable
                  ? () => (pinned ? resetFlag('availPyramid') : setFlag('availPyramid', p.name as typeof availPyramid))
                  : undefined}
                label={
                  `${p.name}${p.name === h.defaultPyramid ? ' (default)' : ''}${pinned ? ' 📌' : ''} · `
                  + (p.allComplete ? 'complete' : `${p.totalMissing} missing`)
                  + (p.totalStale > 0 ? ` · ${p.totalStale} stale` : '')
                }
              />
            )
          })}
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {healthQ.isError ? `health fetch failed: ${String(healthQ.error)}` : 'loading /api/health…'}
        </Typography>
      )}

      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Latency by route <Typography component="span" variant="caption" color="text.secondary">(this tab, last {reqs.length} requests)</Typography>
      </Typography>
      <Table size="small" sx={{ mb: 2, width: 'auto' }}>
        <TableHead>
          <TableRow>
            <TableCell sx={cellSx}>path</TableCell>
            <TableCell sx={cellSx} align="right">n</TableCell>
            <TableCell sx={cellSx} align="right">p50</TableCell>
            <TableCell sx={cellSx} align="right">p95</TableCell>
            <TableCell sx={cellSx} align="right">edge hits</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {summary.map((s) => (
            <TableRow key={s.path}>
              <TableCell sx={cellSx}><code>{s.path}</code></TableCell>
              <TableCell sx={cellSx} align="right">{s.n}</TableCell>
              <TableCell sx={cellSx} align="right">{s.p50}ms</TableCell>
              <TableCell sx={cellSx} align="right">{s.p95}ms</TableCell>
              <TableCell sx={cellSx} align="right">{s.hits}/{s.n}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
        <Typography variant="subtitle2">Requests</Typography>
        <Button size="small" onClick={dbgClear}>Clear</Button>
      </Box>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={cellSx}>t (UTC)</TableCell>
              <TableCell sx={cellSx}>path</TableCell>
              <TableCell sx={cellSx}>pyramid</TableCell>
              <TableCell sx={cellSx} align="right">ms</TableCell>
              <TableCell sx={cellSx} align="right">worker ms</TableCell>
              <TableCell sx={cellSx}>cache</TableCell>
              <TableCell sx={cellSx} align="right">status</TableCell>
              <TableCell sx={{ ...cellSx, whiteSpace: 'normal' }}>params</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {reqs.map((r, i) => (
              <TableRow key={`${r.at}-${i}`}>
                <TableCell sx={cellSx}>{fmtT(r.at)}</TableCell>
                <TableCell sx={cellSx}><code>{r.path}</code></TableCell>
                <TableCell sx={cellSx}>{r.pyramid ?? '—'}</TableCell>
                <TableCell sx={cellSx} align="right">{round(r.ms)}</TableCell>
                <TableCell sx={cellSx} align="right">{r.serverMs ?? '—'}</TableCell>
                <TableCell sx={cellSx}>{r.xCache ?? 'MISS'}</TableCell>
                <TableCell sx={{ ...cellSx, color: r.status >= 400 || r.status === 0 ? 'salmon' : undefined }} align="right">{r.status || 'ERR'}</TableCell>
                <TableCell sx={{ ...cellSx, whiteSpace: 'normal', opacity: 0.7 }}>{r.params}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </>
  )
}
