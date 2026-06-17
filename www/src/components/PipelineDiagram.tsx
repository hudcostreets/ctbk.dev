import { Box } from '@mui/material'

interface StageNode {
  key: string
  label: string
  color: string
  x: number
  y: number
  section: string
}

const STAGES: StageNode[] = [
  { key: 'zip', label: 'zip', color: '#795548', x: 40, y: 30, section: 'source-data' },
  { key: 'norm', label: 'norm', color: '#4CAF50', x: 120, y: 30, section: 'normalization' },
  { key: 'cons', label: 'cons', color: '#2196F3', x: 200, y: 30, section: 'consolidation' },
  { key: 'agg', label: 'agg', color: '#FF9800', x: 300, y: 30, section: 'aggregation' },
  { key: 'smh', label: 'smh', color: '#9C27B0', x: 300, y: 70, section: 'station-meta-histograms' },
  { key: 'sm', label: 'sm', color: '#E91E63', x: 370, y: 70, section: 'station-modes' },
  { key: 'spj', label: 'spj', color: '#00BCD4', x: 430, y: 70, section: 'station-pair-jsons' },
]

const EDGES: [string, string][] = [
  ['zip', 'norm'],
  ['norm', 'cons'],
  ['cons', 'agg'],
  ['cons', 'smh'],
  ['smh', 'sm'],
  ['agg', 'sm'],
  ['sm', 'spj'],
  ['agg', 'spj'],
]

function Badge({ stage, onClick }: { stage: StageNode; onClick: () => void }) {
  const width = stage.label.length * 8 + 16
  return (
    <g
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      tabIndex={0}
      role="button"
      aria-label={`Go to ${stage.label} section`}
    >
      <rect
        x={stage.x - width / 2}
        y={stage.y - 10}
        width={width}
        height={20}
        rx={4}
        fill={stage.color}
      />
      <text
        x={stage.x}
        y={stage.y + 4}
        textAnchor="middle"
        fill="white"
        fontSize="11"
        fontFamily="monospace"
        fontWeight="500"
      >
        {stage.label}
      </text>
    </g>
  )
}

function Arrow({ from, to }: { from: StageNode; to: StageNode }) {
  const fromWidth = from.label.length * 8 + 16
  const toWidth = to.label.length * 8 + 16

  // Calculate edge points
  let x1 = from.x + fromWidth / 2
  let y1 = from.y
  let x2 = to.x - toWidth / 2
  let y2 = to.y

  // Handle vertical connections
  if (from.y !== to.y) {
    if (from.x === to.x || Math.abs(from.x - to.x) < 50) {
      // Vertical arrow
      x1 = from.x
      y1 = from.y + 10
      x2 = to.x
      y2 = to.y - 10
    } else if (from.y < to.y) {
      // Diagonal down
      y1 = from.y + 10
      y2 = to.y - 10
    } else {
      // Diagonal up
      y1 = from.y - 10
      y2 = to.y + 10
    }
  }

  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2 - 4}
      y2={y2}
      stroke="currentColor"
      strokeWidth="1.5"
      markerEnd="url(#arrowhead)"
      opacity={0.4}
    />
  )
}

export function PipelineDiagram() {
  const stageMap = Object.fromEntries(STAGES.map(s => [s.key, s]))

  const scrollToSection = (section: string) => {
    const el = document.getElementById(section)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <Box sx={{ my: 4, display: 'flex', justifyContent: 'center' }}>
      <svg
        viewBox="0 0 500 100"
        width="100%"
        style={{ maxWidth: 500, height: 'auto' }}
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" opacity={0.4} />
          </marker>
        </defs>

        {/* Draw edges first (behind badges) */}
        {EDGES.map(([fromKey, toKey]) => {
          const from = stageMap[fromKey]
          const to = stageMap[toKey]
          if (!from || !to) return null
          return <Arrow key={`${fromKey}-${toKey}`} from={from} to={to} />
        })}

        {/* Draw badges on top */}
        {STAGES.map(stage => (
          <Badge
            key={stage.key}
            stage={stage}
            onClick={() => scrollToSection(stage.section)}
          />
        ))}
      </svg>
    </Box>
  )
}
