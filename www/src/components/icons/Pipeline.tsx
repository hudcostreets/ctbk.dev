export function PipelineIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={style}
    >
      {/* Three connected nodes representing a pipeline flow */}
      <circle cx="4" cy="12" r="3" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="20" cy="12" r="3" />
      <rect x="7" y="11" width="2" height="2" />
      <rect x="15" y="11" width="2" height="2" />
    </svg>
  )
}
