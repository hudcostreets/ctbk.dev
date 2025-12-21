import css from "../controls.module.css"

type Props = {
  id?: string
  className?: string
  label: string | React.ReactNode
  checked: boolean
  nowrap?: boolean
  cb: (checked: boolean) => void
}

export function Checkbox({ id, className = css.checkbox, label, checked, nowrap = true, cb }: Props) {
  return (
    <div id={id} className={`${css.subControl} ${className || ""}`}>
      <label className={nowrap ? css.nowrap : ""}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => cb(e.target.checked)}
        />
        {label}
      </label>
    </div>
  )
}
