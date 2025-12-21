import { ReactNode } from "react"
import css from "../controls.module.css"

type CheckboxData<T> = {
  name: string
  data: T
  checked?: boolean
  disabled?: boolean
}

export function Checklist<T>({
  label,
  data,
  cb,
  nowrap = true,
  children,
}: {
  label: string | ReactNode
  data: CheckboxData<T>[]
  cb: (ts: T[]) => void
  nowrap?: boolean
  children?: ReactNode
}) {
  const state: { [name: string]: { data: T; checked: boolean } } = Object.fromEntries(
    data.map(({ name, data, checked }) => [
      name,
      { data, checked: checked || false },
    ])
  )

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const name = e.target.value
    const checked = e.target.checked
    const { checked: cur, data: datum } = state[name]
    if (cur === checked) {
      console.warn("Checkbox", name, "already has value", checked)
    } else {
      const newState = { ...state }
      newState[name] = { data: datum, checked }
      const checkeds = Object.keys(newState)
        .filter((name) => newState[name].checked)
        .map((name) => newState[name].data)
      cb(checkeds)
    }
  }

  const labels = data.map((d) => {
    const { name, disabled } = d
    const checked = state[name].checked
    return (
      <label key={name} className={nowrap ? css.nowrap : ""}>
        <input
          type="checkbox"
          name={name}
          value={name}
          checked={checked}
          disabled={disabled}
          onChange={onChange}
        />
        {name}
      </label>
    )
  })

  return (
    <div className={css.control}>
      <div className={css.controlHeader}>{label}</div>
      <div className={css.subControl}>{labels}</div>
      {children}
    </div>
  )
}
