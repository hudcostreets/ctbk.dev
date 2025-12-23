import { Tooltip } from "@mui/material"
import { ReactNode } from "react"
import css from "../controls.module.css"

type Option<T> = {
  label?: string | ReactNode
  data: T
  disabled?: boolean
}

export function Radios<T extends string>({
  label,
  tooltip,
  options,
  choice,
  cb,
  nowrap = true,
  children,
}: {
  label: string | ReactNode
  tooltip?: ReactNode
  options: (Option<T> | T)[]
  choice: T
  cb: (choice: T) => void
  nowrap?: boolean
  children?: ReactNode
}) {
  const labels = options.map((option) => {
    const { label: text, data: name, disabled } =
      typeof option === "string"
        ? { label: option, data: option, disabled: false }
        : option
    return (
      <label key={name} className={nowrap ? css.nowrap : ""}>
        <input
          type="radio"
          name={typeof label === 'string' ? label + "-" + name : name}
          value={name}
          checked={name === choice}
          disabled={disabled}
          onChange={() => {}}
        />
        {text}
      </label>
    )
  })

  const header = tooltip ? (
    <Tooltip title={tooltip} placement="top" arrow>
      <span style={{ cursor: 'help' }}>{label}</span>
    </Tooltip>
  ) : label

  return (
    <div className={css.control}>
      <div className={css.controlHeader}>{header}</div>
      <div
        id={typeof label === 'string' ? label : undefined}
        className={css.subControl}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => cb(e.target.value as T)}
      >
        {labels}
      </div>
      {children}
    </div>
  )
}
