import { ReactNode, Fragment } from 'react'

interface HotkeyLabelProps {
  /** The label text */
  text: string
  /** The hotkey character to underline (case-insensitive) */
  hotkey?: string
  /** Optional children to render after the text */
  children?: ReactNode
}

/**
 * Renders a label with the hotkey character underlined.
 * Example: <HotkeyLabel text="Region" hotkey="r" /> renders "Region" with "R" underlined
 */
export function HotkeyLabel({ text, hotkey, children }: HotkeyLabelProps) {
  if (!hotkey) {
    return <>{text}{children}</>
  }

  // Find the position of the hotkey character (case-insensitive)
  const lowerText = text.toLowerCase()
  const lowerHotkey = hotkey.toLowerCase()
  const idx = lowerText.indexOf(lowerHotkey)

  if (idx === -1) {
    return <>{text}{children}</>
  }

  return (
    <>
      {text.slice(0, idx)}
      <u style={{ textDecorationStyle: 'dotted' }}>{text[idx]}</u>
      {text.slice(idx + 1)}
      {children}
    </>
  )
}

/**
 * Formats a hotkey sequence for display
 * Example: "r j" -> "R J", "s r" -> "S R"
 */
export function formatHotkey(hotkey: string): string {
  return hotkey.split(' ').map(k => k.toUpperCase()).join(' ')
}

/**
 * Renders hotkey hint text for tooltips
 */
export function HotkeyHint({ prefix, items }: { prefix: string; items: { key: string; label: string }[] }) {
  return (
    <div style={{ fontSize: '0.85em', lineHeight: 1.4 }}>
      {items.map(({ key, label }, i) => (
        <Fragment key={key}>
          {i > 0 && <br />}
          <kbd style={{ background: 'rgba(255,255,255,0.2)', padding: '0 3px', borderRadius: 2 }}>{prefix ? `${prefix} ${key.toUpperCase()}` : key.toUpperCase()}</kbd>
          {' '}{label}
        </Fragment>
      ))}
    </div>
  )
}
