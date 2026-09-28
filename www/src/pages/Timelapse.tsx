/**
 * `/timelapse` (`specs/timelapse-map.md`, P1): every station, one `1d` bin
 * per frame, on the shared `GLMap`. One `ScatterplotLayer` with binary
 * per-frame attributes (`flow` preset: radius ∝ √(starts + ends), diverging
 * color on damped net share), frames lerped in JS from a continuous playhead
 * `t` (frame index + φ) driven by one rAF loop that stalls (badge) while the
 * next chunk isn't cached. Chunks come from `query/timelapse.ts` (interim
 * sources, see there); station positions/names from the static assets
 * (`stations-regional.json` + `station-luc.json`) until the `tl-stations.json`
 * sidecar exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ScatterplotLayer } from '@deck.gl/layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { useAction } from 'use-kbd'
import { boolParam, codeParam, intParam, llzParam, useUrlState, type LLZ, type Param } from 'use-prms'
import GLMap from '../components/GLMap'
import { cachedChunks, useTlFrames, useTlTotals, type SourceMode } from '../query/timelapse'
import {
  accumulateFrame, buildStationTable, chunkIndexMap, chunksCovering, flowAttributes, formatYmd, frameIndex,
  frameStartMs, parseYmd, snapToCached, type Bin, type Chunk, type StationTable, DAY_MS, FLOW,
} from '../query/timelapseFrames'
import stationsCss from '../stations.module.css'
import css from '../timelapse.module.css'

const { floor, max, min } = Math

/** Only `1d` is wired in P1 (`b` stays URL-addressable for P2's ladder). */
const BIN: Bin = '1d'
const binParam = codeParam<Bin>('1d', [['1d', '1d']])
const SPEEDS = [1, 2, 4, 8, 16, 32]
const SYSTEM_LLZ: LLZ = { lat: 40.735, lng: -73.975, zoom: 11 }
const viewParam = llzParam({ default: SYSTEM_LLZ, latLngDecimals: 3 })
const styleParam = codeParam<'flow'>('flow', [['flow', 'f']])
const srcParam = codeParam<SourceMode>('auto', [['auto', 'a'], ['shard', 'sh'], ['synth', 'sy']])

/** Today's local calendar date as a local-as-UTC midnight. */
function todayMs(): number {
  const d = new Date()
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Default range: the trailing full year ending yesterday. */
const DEFAULT_RANGE: [number, number] = [todayMs() - 365 * DAY_MS, todayMs() - DAY_MS]

/** `?d=YYMMDD-YYMMDD`: inclusive local day range. */
const rangeParam: Param<[number, number]> = {
  encode: (v) => (v[0] === DEFAULT_RANGE[0] && v[1] === DEFAULT_RANGE[1] ? undefined : `${formatYmd(v[0])}-${formatYmd(v[1])}`),
  decode: (raw) => {
    const m = raw ? /^(\d{6})-(\d{6})$/.exec(raw) : null
    const a = m ? parseYmd(m[1]) : null
    const b = m ? parseYmd(m[2]) : null
    return a !== null && b !== null && a <= b ? [a, b] : DEFAULT_RANGE
  },
}

/** `?t=YYMMDD`: playhead day; absent = range start. */
const tParam: Param<number | undefined> = {
  encode: (v) => (v === undefined ? undefined : formatYmd(v)),
  decode: (raw) => (raw ? parseYmd(raw) ?? undefined : undefined),
}

type StationMeta = { name?: string; lat: number; lng: number }
type Regional = Record<string, { lat: number; lng: number; name?: string }>
type Luc = { by_short_name: Record<string, { lat: number; lng: number }> }

/** Station positions + names from the static assets. `stations-regional`
 *  (named, current) wins; `station-luc` fills in retired ids so old frames
 *  still place every station. GAP: the spec's `tl-stations.json` sidecar
 *  (`first`/`last` per station, positions by construction) doesn't exist
 *  yet; ids the frames carry that neither asset places are counted as
 *  "unmapped" in the clock badge. */
function useStationTable(): StationTable | null {
  const q = useQuery<StationTable>({
    queryKey: ['tl-stations'],
    staleTime: Infinity,
    queryFn: async () => {
      const [regional, luc] = await Promise.all([
        fetch('/assets/stations-regional.json').then((r) => r.json() as Promise<Regional>),
        fetch('/assets/station-luc.json').then((r) => r.json() as Promise<Luc>),
      ])
      const out: Record<string, StationMeta> = {}
      for (const [id, s] of Object.entries(luc.by_short_name)) {
        if (typeof s.lat === 'number' && typeof s.lng === 'number') out[id] = { lat: s.lat, lng: s.lng }
      }
      for (const [id, s] of Object.entries(regional)) out[id] = { name: s.name, lat: s.lat, lng: s.lng }
      return buildStationTable(out)
    },
  })
  return q.data ?? null
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export default function Timelapse() {
  const qc = useQueryClient()
  // `b` / `st` are registered (URL round-trip) but fixed in P1.
  useUrlState('b', binParam)
  const [range] = useUrlState('d', rangeParam)
  const [tUrl, setTUrl] = useUrlState('t', tParam)
  const [sp, setSp] = useUrlState('sp', intParam(8))
  const [view, setView] = useUrlState('ll', viewParam)
  useUrlState('st', styleParam)
  const [loop, setLoop] = useUrlState('lp', boolParam)
  const [src] = useUrlState('src', srcParam)

  const iStart = frameIndex(BIN, range[0])
  const iEnd = frameIndex(BIN, range[1])
  const clampI = useCallback((i: number) => max(iStart, min(iEnd, i)), [iStart, iEnd])

  // Continuous playhead (frame index + φ). The ref is the source of truth for
  // the rAF loop; the state mirrors it for rendering.
  const tRef = useRef(clampI(tUrl === undefined ? iStart : frameIndex(BIN, tUrl)))
  const [t, setT] = useState(tRef.current)
  const [playing, setPlaying] = useState(false)

  // Normalize a URL `t` that fell outside the range (it was clamped above).
  useEffect(() => {
    if (tUrl !== undefined && frameIndex(BIN, tUrl) !== tRef.current) commitT(tRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const table = useStationTable()
  const frames = useTlFrames(src, BIN, t, 1)
  const readyRef = useRef(frames.ready)
  readyRef.current = frames.ready

  // Write `t` (replace) only on pause/step/scrub — never per frame.
  const commitT = useCallback((i: number) => {
    const c = clampI(i)
    tRef.current = c
    setT(c)
    setTUrl(c === iStart ? undefined : frameStartMs(BIN, c))
  }, [clampI, iStart, setTUrl])

  const play = useCallback(() => {
    if (floor(tRef.current) >= iEnd) commitT(iStart)
    setPlaying(true)
  }, [iEnd, iStart, commitT])
  const pause = useCallback(() => {
    setPlaying(false)
    commitT(floor(tRef.current))
  }, [commitT])
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play])
  const step = useCallback((n: number) => {
    setPlaying(false)
    commitT(floor(tRef.current) + n)
  }, [commitT])

  // One rAF driver: advance `t` by `sp × dt` (bins/s), stalling while the
  // frame pair under the playhead isn't cached; pause (or loop) at the end.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (readyRef.current) {
        let next = tRef.current + sp * dt
        if (next >= iEnd) {
          if (loop) next = iStart
          else {
            tRef.current = iEnd
            setT(iEnd)
            setPlaying(false)
            setTUrl(frameStartMs(BIN, iEnd))
            return
          }
        }
        tRef.current = next
        setT(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, sp, iStart, iEnd, loop, setTUrl])

  // Keyboard (`use-kbd`): all show up in the ShortcutsModal / Omnibar.
  useAction('tl:play', { label: 'Play / pause', group: 'Timelapse', defaultBindings: ['space'], handler: toggle })
  useAction('tl:prev', { label: 'Previous day', group: 'Timelapse', defaultBindings: ['arrowleft'], handler: () => step(-1) })
  useAction('tl:next', { label: 'Next day', group: 'Timelapse', defaultBindings: ['arrowright'], handler: () => step(1) })
  useAction('tl:prev-week', { label: 'Back one week', group: 'Timelapse', defaultBindings: ['shift+arrowleft'], handler: () => step(-7) })
  useAction('tl:next-week', { label: 'Forward one week', group: 'Timelapse', defaultBindings: ['shift+arrowright'], handler: () => step(7) })
  useAction('tl:slower', { label: 'Slower', group: 'Timelapse', defaultBindings: ['['], handler: () => setSp(SPEEDS[max(0, SPEEDS.indexOf(sp) - 1)] ?? SPEEDS[0]) })
  useAction('tl:faster', { label: 'Faster', group: 'Timelapse', defaultBindings: [']'], handler: () => setSp(SPEEDS[min(SPEEDS.length - 1, SPEEDS.indexOf(sp) + 1)] ?? SPEEDS[SPEEDS.length - 1]) })
  useAction('tl:home', { label: 'Jump to range start', group: 'Timelapse', defaultBindings: ['home'], handler: () => { setPlaying(false); commitT(iStart) } })
  useAction('tl:end', { label: 'Jump to range end', group: 'Timelapse', defaultBindings: ['end'], handler: () => { setPlaying(false); commitT(iEnd) } })
  useAction('tl:loop', { label: 'Toggle loop', group: 'Timelapse', defaultBindings: ['l'], handler: () => setLoop(!loop) })

  // Jumps land on the nearest cached frame while the real chunk loads.
  const rangeChunks = useMemo(() => chunksCovering(BIN, iStart, iEnd), [iStart, iEnd])
  const shown = useMemo(() => {
    if (frames.ready) return t
    const cached = cachedChunks(qc, src, BIN, rangeChunks)
    return snapToCached(cached, BIN, floor(t), 1) ?? t
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, t, qc, src, rangeChunks])
  const shownFrames = useTlFrames(src, BIN, shown, 0)

  // Per-frame attributes: lerp starts/ends between frames ⌊t⌋ and ⌊t⌋+1,
  // then the `flow` preset's radius/color. Fresh typed arrays per frame so
  // deck re-uploads them (same-instance binary values are skipped).
  const mapCache = useRef(new WeakMap<Chunk, Int32Array>())
  const frame = useMemo(() => {
    if (!table) return null
    const n = table.ids.length
    const starts = new Float32Array(n)
    const ends = new Float32Array(n)
    const phi = shown - floor(shown)
    let unmapped = 0
    const map = (c: Chunk) => {
      let m = mapCache.current.get(c)
      if (!m) { m = chunkIndexMap(c, table); mapCache.current.set(c, m) }
      return m
    }
    const add = (out: Float32Array, c: Chunk | undefined, slice: Uint32Array | null, w: number) => {
      if (c && slice && w > 0) unmapped += accumulateFrame(out, slice, map(c), w)
    }
    const f = shownFrames
    add(starts, f.chunkA.start, f.startA, 1 - phi)
    add(ends, f.chunkA.end, f.endA, 1 - phi)
    if (phi > 0) {
      add(starts, f.chunkB.start, f.startB, phi)
      add(ends, f.chunkB.end, f.endB, phi)
    }
    const { radius, color } = flowAttributes(starts, ends, BIN)
    return { starts, ends, radius, color, unmapped, source: f.chunkA.start?.source }
  }, [table, shown, shownFrames])

  const [hover, setHover] = useState<number | null>(null)
  const layers = useMemo<Layer[]>(() => {
    if (!table || !frame) return []
    return [
      new ScatterplotLayer({
        id: 'tl-stations',
        data: {
          length: table.ids.length,
          attributes: {
            getPosition: { value: table.positions, size: 2 },
            getRadius: { value: frame.radius, size: 1 },
            getFillColor: { value: frame.color, size: 4 },
          },
        },
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        radiusMaxPixels: FLOW.rMax,
        pickable: true,
        onHover: (info: PickingInfo) => setHover(info.index >= 0 ? info.index : null),
      }),
    ]
  }, [table, frame])

  const totals = useTlTotals(src, BIN, iStart, iEnd)
  const i = floor(shown)
  const stalled = playing && !frames.ready
  const dateStr = DATE_FMT.format(new Date(frameStartMs(BIN, i)))
  const fmt = (n: number) => Math.round(n).toLocaleString()

  return (
    <div className={css.page} data-tl-frame={i} onMouseLeave={() => setHover(null)}>
      <GLMap
        layers={layers}
        center={[view.lat, view.lng]}
        zoom={view.zoom}
        onMove={(la, ln, z) => setView({ lat: la, lng: ln, zoom: z })}
        cursor={hover !== null ? 'pointer' : 'grab'}
        className={css.map}
      >
        <div className={css.clock}>
          <span className={css.clockDate} data-testid="tl-clock">{dateStr}</span>
          <span className={css.clockSub}>
            {formatYmd(range[0])} – {formatYmd(range[1])} · day {i - iStart + 1} of {iEnd - iStart + 1}
            {frame && <> · {fmt(frame.starts.reduce((a, b) => a + b, 0))} starts</>}
          </span>
          <div className={css.badges}>
            {stalled && <span className={`${css.badge} ${css.badgeWarn}`}>buffering…</span>}
            {!frames.ready && !playing && !frames.error && <span className={css.badge}>loading…</span>}
            {frames.error && <span className={`${css.badge} ${css.badgeError}`} title={frames.error.message}>error: {frames.error.message}</span>}
            {frame?.source === 'synth' && <span className={`${css.badge} ${css.badgeWarn}`} title="No small-enough rides shard covers this day; frames are synthesized from monthly station totals (interim, P1)">synthetic</span>}
            {frame?.source === 'shard' && <span className={css.badge} title="Read from the live rides pyramid shards (interim tail-read)">live shard</span>}
            {frame && frame.unmapped > 0 && <span className={css.badge} title="Rides at station ids with no known position">{fmt(frame.unmapped)} unmapped</span>}
          </div>
        </div>
        <div className={css.legend}>
          <div className={css.legendTitle}>Rides per day, by station</div>
          <div className={css.legendBar} />
          <div className={css.legendLabels}>
            <span>net arrivals</span>
            <span>balanced</span>
            <span>net departures</span>
          </div>
          <div className={css.legendNote}>size = √(starts + ends), fixed scale (max {FLOW.scaleMax[BIN]}); faint dot = no rides that day</div>
        </div>
        {hover !== null && table && frame && (
          <div className={stationsCss.hoverDrawer} style={{ top: 120 }}>
            <span className={stationsCss.hoverDrawerName}>{table.names[hover]}</span>
            <span className={stationsCss.hoverDrawerStat}>{fmt(frame.starts[hover])} starts · {fmt(frame.ends[hover])} ends</span>
            <span className={stationsCss.hoverDrawerFlow}>net {frame.starts[hover] - frame.ends[hover] >= 0 ? '+' : ''}{fmt(frame.starts[hover] - frame.ends[hover])}</span>
          </div>
        )}
        {!table && <div className={css.loading}>Loading stations…</div>}
        <div className={css.controls}>
          <button type="button" className={css.btn} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title="Space">
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" className={css.btn} onClick={() => step(-1)} aria-label="Previous day" title="←">◀</button>
          <button type="button" className={css.btn} onClick={() => step(1)} aria-label="Next day" title="→">▶</button>
          <select className={css.select} value={sp} onChange={(e) => setSp(Number(e.target.value))} aria-label="Speed" title="[ / ]">
            {SPEEDS.map((s) => <option key={s} value={s}>{s} d/s</option>)}
          </select>
          <label className={css.check}>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
          </label>
          <Scrubber iStart={iStart} iEnd={iEnd} i={floor(t)} totals={totals} onScrub={(v) => { tRef.current = v; setT(v) }} onCommit={commitT} />
          <span className={css.rangeLabel}>{formatYmd(frameStartMs(BIN, i))}</span>
        </div>
      </GLMap>
    </div>
  )
}

/** Range input over the frame range with the totals strip behind it. */
function Scrubber({
  iStart,
  iEnd,
  i,
  totals,
  onScrub,
  onCommit,
}: {
  iStart: number
  iEnd: number
  i: number
  totals: Float64Array
  onScrub: (i: number) => void
  onCommit: (i: number) => void
}) {
  const W = 1000
  const H = 34
  const path = useMemo(() => {
    const n = totals.length
    if (!n) return ''
    let peak = 0
    for (const v of totals) if (v === v && v > peak) peak = v
    if (!peak) return ''
    const parts: string[] = []
    let pen = false
    for (let f = 0; f < n; f++) {
      const v = totals[f]
      if (v !== v) { pen = false; continue }
      const x = ((f + 0.5) / n) * W
      const y = H - 2 - (v / peak) * (H - 6)
      parts.push(`${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
      pen = true
    }
    return parts.join(' ')
  }, [totals])
  return (
    <div className={css.scrub}>
      <svg className={css.strip} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <rect x={0} y={0} width={W} height={H} fill="rgba(255,255,255,0.06)" />
        {path && <path d={path} fill="none" stroke="#7fb3ff" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      </svg>
      <input
        type="range"
        className={css.range}
        min={iStart}
        max={iEnd}
        step={1}
        value={i}
        aria-label="Scrub"
        onChange={(e) => onScrub(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  )
}
