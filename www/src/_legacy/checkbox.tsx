import React, { Component } from "react"
import css from "./controls.module.css"

type Props = {
    id?: string
    className?: string
    label: string
    checked: boolean
    nowrap?: boolean
    cb: (checked: boolean) => void
}

export class Checkbox extends Component<Props, {}> {
  render() {
    const { id, className = css.checkbox, label, checked, nowrap = true, cb } = this.props
    return <div id={id} className={`${css.subControl} ${className || ""}`}>
      <label className={nowrap ? css.nowrap : ""}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => cb(e.target.checked)}
        />
        {label}
      </label>
    </div>
  }
}
