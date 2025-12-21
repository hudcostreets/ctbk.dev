// TODO: Full migration from pages/index.tsx
// This is a placeholder to verify Vite setup works

import { useUrlParam, boolParam } from '@rdub/use-url-params'
import css from "../../pages/index.module.css"

export default function Home() {
  const [showLegend, setShowLegend] = useUrlParam('legend', boolParam)

  return (
    <div className={css.container}>
      <main className={css.main}>
        <h1 className={css.title}>ctbk.dev - Citi Bike Dashboard</h1>
        <p>Vite migration in progress...</p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={showLegend}
              onChange={e => setShowLegend(e.target.checked)}
            />
            Show Legend (URL param test)
          </label>
        </p>
      </main>
    </div>
  )
}
