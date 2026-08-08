/**
 * Bottom-sheet rides panel for the `/stations` map's selected-station set
 * (`?sel=`): multiscale starts/ends time series via `/api/rides-v5`
 * `s:`-identity keys (`useMultiStationRides`).
 *
 * URL state (own params, only present while a selection exists):
 *   - `rr`: `TimeRange` (default 1y, Latest-anchored)
 *   - `rb`: bin override ms (0/absent = Auto)
 *
 * Range/bin controls mirror the StationDetail avail chart
 * (`RangeWidthControl` + `BinSelect` + drag-pan). Calendar bins (1mo+) are
 * greyed out until pyrmts #122 lands (`specs/rides-v5.md`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { intParam, useUrlState } from 'use-prms'
import { BIN_PRESETS, BinSelect } from './BinSelect'
import { RangeWidthControl, type DurationPreset } from './RangeWidthControl'
import StationRidesChart, { ENDS_COLOR, STARTS_COLOR } from './StationRidesChart'
import { useMultiStationRides } from '../query/ridesMulti'
import { formatDuration, rangeToUnixSeconds, roundDuration, timeRangeParam } from '../time-range'
import type { Stations } from './StationMap'
import css from './StationRidesPanel.module.css'

const { ceil, floor, max } = Math

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

/** Earliest tripdata: 2013-06 (`RIDES_GENESIS` in the worker). */
const RIDES_GENESIS_S = Date.UTC(2013, 5, 1) / 1000

const RANGE_PRESETS: readonly DurationPreset[] = [
  { label: '7d', ms: 7 * DAY_MS },
  { label: '1mo', ms: MONTH_MS },
  { label: '3mo', ms: 3 * MONTH_MS },
  { label: '1y', ms: YEAR_MS },
  { label: '3y', ms: 3 * YEAR_MS },
  { label: '5y', ms: 5 * YEAR_MS },
  { label: 'All', ms: 14 * YEAR_MS },
]

/** Bin presets the rides pyramid can serve today: the 1h..14d fixed tiers.
 *  Calendar bins render greyed-out (pyrmts #122). */
const RIDES_BIN_PRESETS = BIN_PRESETS.filter((p) => p.ms >= HOUR_MS)
const CALENDAR_BIN_MS: ReadonlySet<number> = new Set(
  BIN_PRESETS.filter((p) => p.ms >= MONTH_MS).map((p) => p.ms),
)

interface Props {
  shortNames: readonly string[]
  stations: Stations
  onRemove: (id: string) => void
  onClear: () => void
}

export default function StationRidesPanel({ shortNames, stations, onRemove, onClear }: Props) {
  const [range, setRange] = useUrlState('rr', timeRangeParam(YEAR_MS))
  const [binMs, setBinMs] = useUrlState('rb', intParam(0))

  // Chart viewport width → auto bin + bin_budget.
  const chartWrapRef = useRef<HTMLDivElement>(null)
  const [viewportPx, setViewportPx] = useState(0)
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportPx(el.clientWidth))
    ro.observe(el)
    setViewportPx(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Quantize "now" to 15 min so Latest-mode `[fromS, toS)` — and with
  // them the TSQ query key — stay stable across re-renders (hover churn on
  // the map re-renders the page constantly; an un-quantized `Date.now()`
  // here would refetch forever). Coarse quantization also keeps the URL
  // cache-key stable for the worker's edge cache: rides data lands
  // monthly, so a fresher "now" buys nothing but cold refetches of the
  // expensive wide-window queries.
  const nowS = floor(Date.now() / 900_000) * 900
  const [rawFromS, rawToS] = range.timestamp === null
    ? [nowS - floor(range.duration / 1000), nowS]
    : rangeToUnixSeconds(range)
  const toS = rawToS
  const fromS = max(rawFromS, RIDES_GENESIS_S)

  const rides = useMultiStationRides(
    shortNames,
    fromS,
    toS,
    viewportPx,
    binMs > 0 ? binMs / 1000 : undefined,
  )

  const onPan = useCallback((minS: number, maxS: number) => {
    const duration = roundDuration((maxS - minS) * 1000)
    // Snap back to Latest mode when the pan lands within 10 min of now.
    const timestamp = maxS >= floor(Date.now() / 1000) - 600 ? null : new Date(ceil(maxS) * 1000)
    setRange({ timestamp, duration })
  }, [setRange])

  const chips = useMemo(() => shortNames.map((id) => ({
    id,
    label: stations[id]?.name ?? id,
  })), [shortNames, stations])

  const binS = rides.data?.binS
  const rows = rides.data?.rows ?? []

  return (
    <div className={css.panel}>
      <div className={css.header}>
        <div className={css.chips}>
          {chips.map(({ id, label }) => (
            <span key={id} className={css.chip}>
              {label}
              <button
                type="button"
                className={css.chipX}
                onClick={() => onRemove(id)}
                title={`Remove ${label}`}
                aria-label={`Remove ${label}`}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className={css.clearBtn} onClick={onClear}>clear</button>
        </div>
        <div className={css.controls}>
          <span className={css.legend}>
            <span className={css.swatch} style={{ background: STARTS_COLOR }} />
            starts
            <span className={css.swatch} style={{ background: ENDS_COLOR }} />
            ends
          </span>
          <RangeWidthControl value={range} onChange={setRange} presets={RANGE_PRESETS} />
          <BinSelect
            value={binMs > 0 ? binMs : undefined}
            onChange={(ms) => setBinMs(ms ?? 0)}
            presets={RIDES_BIN_PRESETS}
            disabledMs={CALENDAR_BIN_MS}
            disabledTitle="Calendar bins pending (pyrmts #122)"
          />
          {binS != null && <span className={css.binLabel}>served: {formatDuration(binS * 1000)}</span>}
          {rides.isFetching && <span className={css.status}>loading…</span>}
          {rides.isError && <span className={css.error}>rides fetch failed</span>}
        </div>
      </div>
      <div ref={chartWrapRef}>
        {rows.length > 0 && binS != null && (
          <StationRidesChart
            rows={rows}
            fromS={fromS}
            toS={toS}
            binS={binS}
            onPan={onPan}
            clampMinS={RIDES_GENESIS_S}
            clampMaxS={nowS}
          />
        )}
        {rows.length === 0 && !rides.isFetching && !rides.isError && (
          <span className={css.status}>no rides in window</span>
        )}
      </div>
    </div>
  )
}
