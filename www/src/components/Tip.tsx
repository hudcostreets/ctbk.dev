/** Shared `@floating-ui/react` tooltip.
 *
 *  Native `title=` is unusable for this: ~1s delay, unstyleable, and it
 *  can't render structure (the parquet cells want a small key/value
 *  table, not a string). This is the one hover primitive for the app —
 *  reach for it instead of `title` anywhere a hover explanation is
 *  worth showing.
 *
 *  Portals to `document.body`, so it escapes ancestors that clip
 *  (`overflow: hidden` on the parquet viewer's `<td>`, `<details>`
 *  panels, scroll containers). */
import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from 'react'
import {
  autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating,
  useFocus, useHover, useInteractions, useRole, safePolygon,
} from '@floating-ui/react'
import css from './Tip.module.css'

export interface TipProps {
  /** Tooltip body. Falsy → the child renders bare, no listeners. */
  content: ReactNode
  /** Single element that gets the reference ref + hover/focus props. */
  children: ReactElement
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** Let the pointer travel into the tooltip (for selectable/copyable
   *  content). Off by default — most tips are read-only. */
  interactive?: boolean
  delay?: number
}

export function Tip({ content, children, placement = 'top', interactive = false, delay = 120 }: TipProps) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const hover = useHover(context, {
    move: false,
    delay: { open: delay, close: 0 },
    ...(interactive ? { handleClose: safePolygon() } : {}),
  })
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    useFocus(context),
    useDismiss(context),
    useRole(context, { role: 'tooltip' }),
  ])

  if (!content || !isValidElement(children)) return children

  return (
    <>
      {cloneElement(children, getReferenceProps({
        ref: refs.setReference,
        ...(children.props as Record<string, unknown>),
      }))}
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, ...(interactive ? null : { pointerEvents: 'none' as const }) }}
            className={css.tip}
            {...getFloatingProps()}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

/** Two-column key/value body — the common tooltip shape (raw value,
 *  derived stats, units). */
export function TipRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className={css.rows}>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
