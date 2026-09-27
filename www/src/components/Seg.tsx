/** Segmented single-select (a radio group of buttons). Local until
 *  `pltly/controls` ships its `Seg` (pltly `specs/controls.md`). */
import css from './Seg.module.css'

export default function Seg<T extends string>({ label, options, value, set }: {
  label: string
  options: readonly (readonly [T, string])[]
  value: T
  set: (v: T) => void
}) {
  return (
    <div className={css.seg} role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? css.on : ''} onClick={() => set(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}
