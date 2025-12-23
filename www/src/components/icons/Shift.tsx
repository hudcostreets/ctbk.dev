export function ShiftIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
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
      {/* Upward arrow outline (shift key symbol) */}
      <path d="M12 4L4 14h5v6h6v-6h5L12 4z" />
    </svg>
  )
}
