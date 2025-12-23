export function S3Icon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={style}
    >
      <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18l6.9 3.45L12 11.09 5.1 7.63 12 4.18zM4 8.81l7 3.5v7.38l-7-3.5V8.81zm9 10.88v-7.38l7-3.5v7.38l-7 3.5z" />
    </svg>
  )
}
