/**
 * `<details>` multi-select with tri-state group checkboxes and "only"
 * (solo) links — a port of path's `StationDropdown`, generalized to any
 * string-valued facet. Local until `pltly/controls` ships `MultiSelect`
 * (pltly `specs/controls.md`), whose API this mirrors.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import css from './MultiSelect.module.css'

export interface Item<T extends string> { value: T; label?: string }
export interface Group<T extends string> { label: string; values: readonly T[] }

interface Props<T extends string> {
  items: readonly Item<T>[]
  selected: readonly T[]
  onChange: (next: T[]) => void
  groups?: readonly Group<T>[]
  noun: { one: string; many: string }
  /** Summary override, e.g. a group's label when exactly its values are selected. */
  summary?: (selected: readonly T[]) => string | undefined
}

const soloHandler = (fn: () => void) => (e: MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
  fn()
}

function GroupRow<T extends string>({ group, selected, onChange }: {
  group: Group<T>
  selected: readonly T[]
  onChange: (next: T[]) => void
}) {
  const n = group.values.filter((v) => selected.includes(v)).length
  const all = n === group.values.length
  const some = n > 0 && !all
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = some }, [some])
  const toggle = () => onChange(all
    ? selected.filter((v) => !group.values.includes(v))
    : [...new Set([...selected, ...group.values])])
  return (
    <div className={`${css.row} ${all ? css.groupActive : ''}`}>
      <label>
        <input ref={ref} type="checkbox" checked={all} onChange={toggle} />
        {group.label}
      </label>
      <span className={css.solo} onClick={soloHandler(() => onChange([...group.values]))}>only</span>
    </div>
  )
}

export default function MultiSelect<T extends string>({ items, selected, onChange, groups, noun, summary }: Props<T>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDetailsElement>(null)
  const labelOf = (v: T) => items.find((i) => i.value === v)?.label ?? v

  const all = selected.length === items.length
  const none = selected.length === 0
  const text = summary?.(selected)
    ?? (all ? `All ${noun.many}` : none ? `No ${noun.many}` : selected.length === 1 ? labelOf(selected[0]) : `${selected.length} ${noun.many}`)

  useEffect(() => {
    if (!open) return
    const close = () => { setOpen(false); if (ref.current) ref.current.open = false }
    const onClick = (e: globalThis.MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Keep the caller's item order, whatever order clicks produced.
  const ordered = (next: T[]) => items.map((i) => i.value).filter((v) => next.includes(v))
  const change = (next: T[]) => onChange(ordered(next))

  return (
    <details ref={ref} className={css.dropdown} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{text}</summary>
      <div className={css.list}>
        <label className={css.selectAll}>
          <input type="checkbox" checked={all} onChange={() => change(all ? [] : items.map((i) => i.value))} />
          {all ? 'Deselect all' : 'Select all'}
        </label>
        {groups && groups.length > 0 && (
          <div className={css.section}>
            {groups.map((g) => <GroupRow key={g.label} group={g} selected={selected} onChange={change} />)}
          </div>
        )}
        <div className={css.section}>
          {items.map((i) => (
            <div key={i.value} className={css.row}>
              <label>
                <input type="checkbox" checked={selected.includes(i.value)} onChange={() => change(selected.includes(i.value) ? selected.filter((s) => s !== i.value) : [...selected, i.value])} />
                {i.label ?? i.value}
              </label>
              <span className={css.solo} onClick={soloHandler(() => change([i.value]))}>only</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}
