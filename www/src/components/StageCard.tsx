import { useState } from 'react'
import { Box, Typography, Paper, Collapse, IconButton, Chip, LinearProgress } from '@mui/material'
import { FiChevronDown, FiChevronRight } from 'react-icons/fi'
import { dvcUrl } from '../lib/dataBase'

export interface StageFile {
  path: string
  size: number
  md5?: string
  mtime?: string
  cmd?: string
  params?: { groupBy?: string; aggBy?: string }
}
export interface Stage {
  key: string
  name: string
  icon: string
  color: string
  fileCount: number
  totalSize: number
  monthRange: string | null
  files: StageFile[]
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export function formatYM(ym: string): string {
  const year = ym.slice(0, 4)
  const month = ym.slice(4, 6)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[parseInt(month, 10) - 1]} ${year}`
}

interface StageCardProps {
  stage: Stage
  maxSize: number
}

export function StageCard({ stage, maxSize }: StageCardProps) {
  const [expanded, setExpanded] = useState(false)
  const sizePercent = (stage.totalSize / maxSize) * 100

  const monthRange = stage.monthRange
    ? stage.monthRange.split('-').map(formatYM).join(' → ')
    : null

  const hasMtime = stage.files.some(f => f.mtime)

  return (
    <Paper
      elevation={0}
      sx={{
        mb: 2,
        overflow: 'hidden',
        bgcolor: 'transparent',
        border: '1px solid',
        borderColor: 'divider',
        borderLeftWidth: 4,
        borderLeftColor: stage.color,
      }}
    >
      <Box
        sx={{
          p: 2,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          '&:hover': { bgcolor: 'action.hover' },
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <IconButton size="small" sx={{ p: 0, color: 'text.secondary' }}>
          {expanded ? <FiChevronDown /> : <FiChevronRight />}
        </IconButton>
        <Typography variant="h5" component="span" sx={{ fontSize: '1.5rem' }}>
          {stage.icon}
        </Typography>
        <Box sx={{ flex: 1, color: 'text.primary' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <Typography variant="h6" component="span" sx={{ color: 'text.primary' }}>
              {stage.name}
            </Typography>
            <Chip
              label={stage.key}
              size="small"
              sx={{ bgcolor: stage.color, color: 'white', fontFamily: 'monospace' }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, color: 'text.secondary', fontSize: '0.875rem' }}>
            <span>{stage.fileCount} files</span>
            <span>{formatBytes(stage.totalSize)}</span>
            {monthRange && <span>{monthRange}</span>}
          </Box>
          <Box sx={{ mt: 1 }}>
            <LinearProgress
              variant="determinate"
              value={sizePercent}
              sx={{
                height: 6,
                borderRadius: 3,
                bgcolor: 'action.disabledBackground',
                '& .MuiLinearProgress-bar': { bgcolor: stage.color },
              }}
            />
          </Box>
        </Box>
      </Box>

      <Collapse in={expanded}>
        <Box sx={{ px: 2, pb: 2, maxHeight: 400, overflow: 'auto' }}>
          <Box
            component="table"
            sx={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              color: 'text.primary',
              '& th, & td': { p: 0.5, textAlign: 'left', borderBottom: '1px solid', borderColor: 'divider' },
              '& th': { fontWeight: 600, color: 'text.secondary' },
              '& td': { color: 'text.primary' },
            }}
          >
            <thead>
              <tr>
                <th>Path</th>
                <th style={{ textAlign: 'right', whiteSpace: 'nowrap', paddingLeft: 16 }}>Size</th>
                {hasMtime && <th style={{ whiteSpace: 'nowrap', paddingLeft: 16 }}>Modified</th>}
                {stage.key === 'agg' && <th>Params</th>}
              </tr>
            </thead>
            <tbody>
              {stage.files.slice(0, 50).map((file) => {
                const displayPath = file.path.replace('s3/ctbk/', '')
                const s3Url = file.md5 ? dvcUrl(file.md5) : null
                return (
                  <tr key={file.path}>
                    <td>
                      {s3Url ? (
                        <a
                          href={s3Url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'inherit', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                        >
                          {displayPath}
                        </a>
                      ) : displayPath}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', paddingLeft: 16 }}>{formatBytes(file.size)}</td>
                    {hasMtime && <td style={{ whiteSpace: 'nowrap', paddingLeft: 16 }}>{file.mtime || ''}</td>}
                    {stage.key === 'agg' && file.params && (
                      <td>
                        <Chip
                          label={`-g ${file.params.groupBy} -a ${file.params.aggBy}`}
                          size="small"
                          sx={{ fontFamily: 'monospace', fontSize: '0.7rem', height: 20 }}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
              {stage.files.length > 50 && (
                <tr>
                  <td colSpan={hasMtime ? 4 : 3} style={{ textAlign: 'center', fontStyle: 'italic' }}>
                    ... and {stage.files.length - 50} more files
                  </td>
                </tr>
              )}
            </tbody>
          </Box>
        </Box>
      </Collapse>
    </Paper>
  )
}
