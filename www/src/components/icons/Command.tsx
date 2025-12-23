export function CommandIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {/* Command/Clover symbol - four loops */}
      <path d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6v6a3 3 0 1 0 0 6 3 3 0 0 0 0-6" />
      <path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6v6a3 3 0 1 0 0 6 3 3 0 0 0 0-6" />
      <path d="M9 9h6v6H9z" />
    </svg>
  )
}
