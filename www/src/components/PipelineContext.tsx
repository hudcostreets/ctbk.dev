import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { Box, Typography, LinearProgress } from '@mui/material'
import { StageCard } from './StageCard'

interface StageFile {
  path: string
  size: number
  md5?: string
  mtime?: string
  cmd?: string
  params?: { groupBy?: string; aggBy?: string }
}

interface Stage {
  key: string
  name: string
  icon: string
  color: string
  fileCount: number
  totalSize: number
  monthRange: string | null
  files: StageFile[]
}

interface DagData {
  stages: Stage[]
  stageEdges: { from: string; to: string }[]
  totalNodes: number
  totalEdges: number
}

const PipelineContext = createContext<DagData | null>(null)

export function usePipeline() {
  const ctx = useContext(PipelineContext)
  if (!ctx) throw new Error('usePipeline must be used within PipelineProvider')
  return ctx
}

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [dag, setDag] = useState<DagData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/assets/dag.json')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load: ${res.status}`)
        return res.json()
      })
      .then(setDag)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', my: 4 }}>
        <LinearProgress />
        <Typography sx={{ mt: 2 }}>Loading pipeline data...</Typography>
      </Box>
    )
  }

  if (error || !dag) {
    return (
      <Box sx={{ color: 'error.main', my: 4 }}>
        <Typography>Error: {error || 'No data'}</Typography>
      </Box>
    )
  }

  return (
    <PipelineContext.Provider value={dag}>
      {children}
    </PipelineContext.Provider>
  )
}

export function PipelineStats() {
  const dag = usePipeline()
  return (
    <Typography component="span">
      {dag.totalNodes.toLocaleString()} files and {dag.totalEdges.toLocaleString()} dependencies
    </Typography>
  )
}

export function StageByKey({ stageKey }: { stageKey: string }) {
  const dag = usePipeline()
  const stage = dag.stages.find(s => s.key === stageKey)
  if (!stage) return null
  const maxSize = Math.max(...dag.stages.map(s => s.totalSize))
  return <StageCard stage={stage} maxSize={maxSize} />
}

