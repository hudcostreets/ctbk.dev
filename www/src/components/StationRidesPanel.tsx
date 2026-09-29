/**
 * Bottom-sheet rides panel for the `/stations` map's selected-station set
 * (`?sel=`): multiscale starts/ends time series via `/api/rides`
 * `s:`-identity keys (`useMultiStationRides`).
 *
 * URL state (own params, only present while a selection exists):
 *   - `rr`: `TimeRange` (default 1y, Latest-anchored)
 *   - `rb`: bin override ms (0/absent = Auto)
 *
 * Range/bin controls mirror the StationDetail avail chart
 * (`RangeWidthControl` + `BinSelect` + drag-pan). Calendar bins (1mo+) are
 * greyed out until pyrmts #122 lands (`specs/rides-v5.md`).
 *
 * `compact` (phones, as on `/timelapse`): one bar — chevron (collapse the
 * whole sheet to just the bar), the station chips (one scrolling line),
 * clear, and ⚙ (the view / range / bin controls, hidden by default) — over
 * the chart. `onHeight` reports the sheet's height (so the page can lift the
 * SpeedDial clear of it).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { codeParam, intParam, useUrlState } from 'use-prms'
import { BIN_PRESETS, BinSelect } from './BinSelect'
import { RangeWidthControl, type DurationPreset } from './RangeWidthControl'
import StationRidesChart, { ENDS_COLOR, STARTS_COLOR } from './StationRidesChart'
import SmgPanel from './SmgPanel'
import { BrushProvider } from './smgBrush'
import { useCanHover } from '../lib/useMediaQuery'
import { useMultiStationRides } from '../query/ridesMulti'
import { SMG_GENESIS_S, smgCellsFor } from '../query/smg'
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
  /** The map's multi-select mode (`lib/mapSelection`) is on: show it, with a
   *  Done button (keep the set, leave the mode). */
  multi?: boolean
  onDone?: () => void
  /** Phone layout: collapsible bar + ⚙-gated controls. */
  compact?: boolean
  /** The sheet's rendered height (px), on every resize; 0 on unmount. */
  onHeight?: (px: number) => void
}

/** Which series the sheet shows for the set: rides (starts/ends) or the
 *  station-minute state partition (`smg-v1`). One at a time keeps the
 *  sheet's height; both share the window (`rr`). */
type PanelView = 'rides' | 'states'
const PANEL_VIEWS: [PanelView, string][] = [['rides', 'r'], ['states', 's']]

export default function StationRidesPanel({ shortNames, stations, onRemove, onClear, multi = false, onDone, compact = false, onHeight }: Props) {
  const canHover = useCanHover()
  const [range, setRange] = useUrlState('rr', timeRangeParam(YEAR_MS))
  const [binMs, setBinMs] = useUrlState('rb', intParam(0))
  const [view, setView] = useUrlState('rv', codeParam<PanelView>('rides', PANEL_VIEWS))
  const showStates = view === 'states'
  const [collapsed, setCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const onHeightRef = useRef(onHeight)
  onHeightRef.current = onHeight
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const report = () => onHeightRef.current?.(el.offsetHeight)
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => { ro.disconnect(); onHeightRef.current?.(0) }
  }, [])

  // Chart viewport width → auto bin + bin_budget.
  const chartWrapRef = useRef<HTMLDivElement>(null)
  const [viewportPx, setViewportPx] = useState(0)
  useEffect(() => {
    const el = chartWrapRef.current
    if (!el) return
    // Skip 0 (the sheet collapsed / chart hidden): keeps the last width, so
    // collapsing doesn't change the query key.
    const on = () => { if (el.clientWidth > 0) setViewportPx(el.clientWidth) }
    const ro = new ResizeObserver(on)
    ro.observe(el)
    on()
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
    showStates ? [] : shortNames,
    fromS,
    toS,
    viewportPx,
    binMs > 0 ? binMs / 1000 : undefined,
  )
  const smgSel = useMemo(() => (showStates ? smgCellsFor(shortNames) : null), [showStates, shortNames])

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

  const chipEls = chips.map(({ id, label }) => (
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
  ))
  const clearBtn = <button type="button" className={css.clearBtn} onClick={onClear}>clear</button>
  const modeEls = multi && (
    <>
      <span className={css.modeTag} data-testid="multi-mode">multi-select: {canHover ? 'click' : 'tap'} stations to add / remove</span>
      {onDone && <button type="button" className={css.doneBtn} onClick={onDone} data-testid="multi-done">Done</button>}
    </>
  )
  const controls = (
    <div className={css.controls} data-testid="rides-controls">
      <span className={css.viewToggle} role="group" aria-label="Panel view">
        {PANEL_VIEWS.map(([v]) => (
          <button
            key={v}
            type="button"
            className={`${css.viewBtn} ${view === v ? css.viewBtnActive : ''}`}
            onClick={() => setView(v)}
          >
            {v}
          </button>
        ))}
      </span>
      {!showStates && (
        <span className={css.legend}>
          <span className={css.swatch} style={{ background: STARTS_COLOR }} />
          starts
          <span className={css.swatch} style={{ background: ENDS_COLOR }} />
          ends
        </span>
      )}
      <RangeWidthControl value={range} onChange={setRange} presets={RANGE_PRESETS} />
      {!showStates && (
        <>
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
        </>
      )}
    </div>
  )
  // Phone: the chart body hides (stays mounted) while collapsed.
  const bodyHidden = compact && collapsed

  return (
    <div ref={panelRef} className={`${css.panel} ${compact ? css.panelCompact : ''}`} data-testid="rides-panel">
      {compact ? (
        <>
          <div className={css.bar}>
            <button
              type="button"
              className={css.roundBtn}
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand rides panel' : 'Collapse rides panel'}
              data-testid="rides-collapse"
            >
              <Chevron dir={collapsed ? 'up' : 'down'} />
            </button>
            <div className={css.chipsScroll}>{chipEls}</div>
            {clearBtn}
            <button
              type="button"
              className={`${css.roundBtn} ${settingsOpen && !collapsed ? css.gearOn : ''}`}
              onClick={() => { setSettingsOpen(!settingsOpen); setCollapsed(false) }}
              aria-expanded={settingsOpen && !collapsed}
              aria-label="Chart settings"
              data-testid="rides-gear"
            >
              <GearIcon />
            </button>
          </div>
          {multi && <div className={css.chips}>{modeEls}</div>}
          {settingsOpen && !collapsed && controls}
        </>
      ) : (
        <div className={css.header}>
          <div className={css.chips}>
            {chipEls}
            {clearBtn}
            {modeEls}
          </div>
          {controls}
        </div>
      )}
      {showStates && !bodyHidden && (
        <BrushProvider>
          <SmgPanel
            sel={smgSel}
            fromS={max(fromS, SMG_GENESIS_S)}
            toS={toS}
            onPan={onPan}
            clampMinS={SMG_GENESIS_S}
            clampMaxS={nowS}
            height={compact ? 160 : 200}
          />
        </BrushProvider>
      )}
      <div ref={chartWrapRef} hidden={showStates || bodyHidden}>
        {rows.length > 0 && binS != null && (
          <StationRidesChart
            rows={rows}
            fromS={fromS}
            toS={toS}
            binS={binS}
            onPan={onPan}
            clampMinS={RIDES_GENESIS_S}
            clampMaxS={nowS}
            height={compact ? 140 : undefined}
          />
        )}
        {rows.length === 0 && !rides.isFetching && !rides.isError && (
          <span className={css.status}>no rides in window</span>
        )}
      </div>
    </div>
  )
}

function Chevron({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <path d={dir === 'up' ? 'M2 9 L7 4 L12 9' : 'M2 5 L7 10 L12 5'} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1L11 21h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
        transform="translate(-1 0)"
      />
    </svg>
  )
}
