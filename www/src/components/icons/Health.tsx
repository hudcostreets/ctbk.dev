export function HealthIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {/* Pulse / heartbeat trace */}
      <polyline points="2,12 7,12 10,5 14,19 17,12 22,12" />
    </svg>
  )
}
