export function HomeIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={style}
    >
      {/* House shape */}
      <path d="M12 2L2 9h3v11h6v-6h2v6h6V9h3L12 2z" />
    </svg>
  )
}
