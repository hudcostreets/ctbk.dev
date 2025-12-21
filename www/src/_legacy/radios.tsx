import React, { ReactNode } from "react"
import css from "./controls.module.css"

type Option<T> = {
    label?: string | ReactNode
    data: T
    disabled?: boolean
}

export function Radios<T extends string>(
  { label, options, choice, cb, nowrap = true, children }: {
        label: string
        options: (Option<T> | T)[]
        choice: T
        cb: (choice: T) => void
        nowrap?: boolean
        children?: ReactNode
    }
) {
  const labels = options.map(option => {
    const { label: text, data: name, disabled } =
            typeof option === 'string'
              ? { label: option, data: option, disabled: false }
              : option
    return (
      <label key={name} className={nowrap ? css.nowrap : ""}>
        <input
          type="radio"
          name={label + '-' + name}
          value={name}
          checked={name == choice}
          disabled={disabled}
          onChange={() => {}}  // Prevent React warning
        />
        {text}
      </label>
    )
  })
  return <div className={css.control}>
    <div className={css.controlHeader}>{label}</div>
    <div id={label} className={css.subControl} onChange={(e: any) => cb(e.target.value)}>{labels}</div>
    {children}
  </div>
}
