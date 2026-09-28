/**
 * `/timelapse` (`specs/timelapse-map.md`, P1–P2): every station, one bin
 * (`1d` or `1h`) per frame, on the shared `GLMap`. One `ScatterplotLayer`
 * with binary per-frame attributes (`flow` preset: radius ∝ √(starts + ends),
 * diverging color on damped net share), frames lerped in JS from a continuous
 * playhead `t` (frame index + φ) driven by one rAF loop that stalls (badge)
 * while the next chunk isn't cached. Chunks come from `query/timelapse.ts`
 * (`/api/tl` first, interim sources where it has no coverage yet); station
 * positions/names from the static assets (`stations-regional.json` +
 * `station-luc.json`) until the `tl-stations.json` sidecar exists.
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
  accumulateFrame, buildStationTable, chunkIndexMap, chunksCovering, flowAttributes, formatT, formatYmd, frameIndex,
  frameStartMs, parseT, parseYmd, snapToCached, type Bin, type Chunk, type StationTable, BINS, DAY_MS, FLOW,
} from '../query/timelapseFrames'
import stationsCss from '../stations.module.css'
import css from '../timelapse.module.css'

const { floor, max, min } = Math

const binParam = codeParam<Bin>('1d', [['1d', '1d'], ['1h', '1h']])
const SPEEDS = [1, 2, 4, 8, 16, 32]
const SYSTEM_LLZ: LLZ = { lat: 40.735, lng: -73.975, zoom: 11 }
const viewParam = llzParam({ default: SYSTEM_LLZ, latLngDecimals: 3 })
const styleParam = codeParam<'flow'>('flow', [['flow', 'f']])
const srcParam = codeParam<SourceMode>('auto', [['auto', 'a'], ['api', 'api'], ['shard', 'sh'], ['synth', 'sy']])

/** Today's local calendar date as a local-as-UTC midnight. */
function todayMs(): number {
  const d = new Date()
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Default range: the trailing full year (`1d`) or full week (`1h`) ending yesterday. */
function defaultRange(bin: Bin): [number, number] {
  const days = bin === '1h' ? 7 : 365
  return [todayMs() - days * DAY_MS, todayMs() - DAY_MS]
}

/** `?d=YYMMDD-YYMMDD`: inclusive local day range. */
function rangeParam(bin: Bin): Param<[number, number]> {
  const def = defaultRange(bin)
  return {
    encode: (v) => (v[0] === def[0] && v[1] === def[1] ? undefined : `${formatYmd(v[0])}-${formatYmd(v[1])}`),
    decode: (raw) => {
      const m = raw ? /^(\d{6})-(\d{6})$/.exec(raw) : null
      const a = m ? parseYmd(m[1]) : null
      const b = m ? parseYmd(m[2]) : null
      return a !== null && b !== null && a <= b ? [a, b] : def
    },
  }
}

/** `?t=YYMMDD[THH]`: playhead instant (local-as-UTC ms); absent = range start.
 *  Bin-independent, so switching bins keeps the same instant. */
const tParam: Param<number | undefined> = {
  encode: (v) => (v === undefined ? undefined : formatT(v)),
  decode: (raw) => (raw ? parseT(raw) ?? undefined : undefined),
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
const HOUR_FMT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
const UNIT: Record<Bin, string> = { '1h': 'hour', '1d': 'day' }
/** shift+←/→: a day (`1h`) or a week (`1d`), in frames. */
const BIG_STEP: Record<Bin, number> = { '1h': 24, '1d': 7 }

export default function Timelapse() {
  const qc = useQueryClient()
  const [bin, setBin] = useUrlState('b', binParam)
  const rangeP = useMemo(() => rangeParam(bin), [bin])
  const [range] = useUrlState('d', rangeP)
  const [tUrl, setTUrl] = useUrlState('t', tParam)
  const [sp, setSp] = useUrlState('sp', intParam(8))
  const [view, setView] = useUrlState('ll', viewParam)
  useUrlState('st', styleParam)  // registered (URL round-trip) but fixed until the other presets land
  const [loop, setLoop] = useUrlState('lp', boolParam)
  const [src] = useUrlState('src', srcParam)

  const iStart = frameIndex(bin, range[0])
  // Inclusive last frame: the last day, or its last hour.
  const iEnd = bin === '1h' ? frameIndex(bin, range[1] + DAY_MS) - 1 : frameIndex(bin, range[1])
  const clampI = useCallback((i: number) => max(iStart, min(iEnd, i)), [iStart, iEnd])
  const tToI = useCallback((ms: number | undefined) => clampI(ms === undefined ? iStart : frameIndex(bin, ms)), [bin, clampI, iStart])

  // Continuous playhead (frame index + φ). The ref is the source of truth for
  // the rAF loop; the state mirrors it for rendering.
  const tRef = useRef(tToI(tUrl))
  const [t, setT] = useState(tRef.current)
  const [playing, setPlaying] = useState(false)

  // Write `t` (replace) only on pause/step/scrub — never per frame.
  const commitT = useCallback((i: number) => {
    const c = clampI(i)
    tRef.current = c
    setT(c)
    setTUrl(c === iStart ? undefined : frameStartMs(bin, c))
  }, [bin, clampI, iStart, setTUrl])

  // On mount and on a bin switch: re-derive the frame under the URL's
  // instant (`t` is bin-independent) and normalize it (clamped to the
  // range, floored to the bin).
  useEffect(() => {
    setPlaying(false)
    const i = tToI(tUrl)
    tRef.current = i
    setT(i)
    if (tUrl !== undefined && frameStartMs(bin, i) !== tUrl) commitT(i)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin])

  const table = useStationTable()
  const frames = useTlFrames(src, bin, t, 1)
  const readyRef = useRef(frames.ready)
  readyRef.current = frames.ready

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
            setTUrl(frameStartMs(bin, iEnd))
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
  }, [playing, sp, iStart, iEnd, loop, setTUrl, bin])

  // Keyboard (`use-kbd`): all show up in the ShortcutsModal / Omnibar.
  const unit = UNIT[bin]
  const bigUnit = bin === '1h' ? 'day' : 'week'
  useAction('tl:play', { label: 'Play / pause', group: 'Timelapse', defaultBindings: ['space'], handler: toggle })
  useAction('tl:prev', { label: `Previous ${unit}`, group: 'Timelapse', defaultBindings: ['arrowleft'], handler: () => step(-1) })
  useAction('tl:next', { label: `Next ${unit}`, group: 'Timelapse', defaultBindings: ['arrowright'], handler: () => step(1) })
  useAction('tl:prev-week', { label: `Back one ${bigUnit}`, group: 'Timelapse', defaultBindings: ['shift+arrowleft'], handler: () => step(-BIG_STEP[bin]) })
  useAction('tl:next-week', { label: `Forward one ${bigUnit}`, group: 'Timelapse', defaultBindings: ['shift+arrowright'], handler: () => step(BIG_STEP[bin]) })
  useAction('tl:slower', { label: 'Slower', group: 'Timelapse', defaultBindings: ['['], handler: () => setSp(SPEEDS[max(0, SPEEDS.indexOf(sp) - 1)] ?? SPEEDS[0]) })
  useAction('tl:faster', { label: 'Faster', group: 'Timelapse', defaultBindings: [']'], handler: () => setSp(SPEEDS[min(SPEEDS.length - 1, SPEEDS.indexOf(sp) + 1)] ?? SPEEDS[SPEEDS.length - 1]) })
  useAction('tl:home', { label: 'Jump to range start', group: 'Timelapse', defaultBindings: ['home'], handler: () => { setPlaying(false); commitT(iStart) } })
  useAction('tl:end', { label: 'Jump to range end', group: 'Timelapse', defaultBindings: ['end'], handler: () => { setPlaying(false); commitT(iEnd) } })
  useAction('tl:bin', { label: 'Cycle bin (hour / day)', group: 'Timelapse', defaultBindings: ['b'], handler: () => setBin(BINS[(BINS.indexOf(bin) + 1) % BINS.length]) })
  useAction('tl:loop', { label: 'Toggle loop', group: 'Timelapse', defaultBindings: ['l'], handler: () => setLoop(!loop) })

  // Jumps land on the nearest cached frame while the real chunk loads.
  const rangeChunks = useMemo(() => chunksCovering(bin, iStart, iEnd), [bin, iStart, iEnd])
  const shown = useMemo(() => {
    if (frames.ready) return t
    const cached = cachedChunks(qc, src, bin, rangeChunks)
    return snapToCached(cached, bin, floor(t), 1) ?? t
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, t, qc, src, bin, rangeChunks])
  const shownFrames = useTlFrames(src, bin, shown, 0)

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
    const { radius, color } = flowAttributes(starts, ends, bin)
    return { starts, ends, radius, color, unmapped, source: f.chunkA.start?.source }
  }, [table, shown, shownFrames, bin])

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

  const totals = useTlTotals(src, bin, iStart, iEnd)
  const i = floor(shown)
  const stalled = playing && !frames.ready
  const iMs = frameStartMs(bin, i)
  const dateStr = bin === '1h' ? `${DATE_FMT.format(new Date(iMs))} · ${HOUR_FMT.format(new Date(iMs))}` : DATE_FMT.format(new Date(iMs))
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
            {formatYmd(range[0])} – {formatYmd(range[1])} · {unit} {i - iStart + 1} of {iEnd - iStart + 1}
            {frame && <> · {fmt(frame.starts.reduce((a, b) => a + b, 0))} starts</>}
          </span>
          <div className={css.badges}>
            {stalled && <span className={`${css.badge} ${css.badgeWarn}`}>buffering…</span>}
            {!frames.ready && !playing && !frames.error && <span className={css.badge}>loading…</span>}
            {frames.error && <span className={`${css.badge} ${css.badgeError}`} title={frames.error.message}>error: {frames.error.message}</span>}
            {frame?.source === 'api' && <span className={css.badge} title="Frames from /api/tl over the time-first rides-tl pyramid">rides-tl</span>}
            {frame?.source === 'synth' && <span className={`${css.badge} ${css.badgeWarn}`} title="rides-tl doesn't cover this range yet and no small-enough rides shard does either; frames are synthesized from monthly station totals (interim)">synthetic</span>}
            {frame?.source === 'shard' && <span className={css.badge} title="rides-tl doesn't cover this range yet; read from the live rides pyramid shards (interim tail-read)">live shard</span>}
            {frame && frame.unmapped > 0 && <span className={css.badge} title="Rides at station ids with no known position">{fmt(frame.unmapped)} unmapped</span>}
          </div>
        </div>
        <div className={css.legend}>
          <div className={css.legendTitle}>Rides per {unit}, by station</div>
          <div className={css.legendBar} />
          <div className={css.legendLabels}>
            <span>net arrivals</span>
            <span>balanced</span>
            <span>net departures</span>
          </div>
          <div className={css.legendNote}>size = √(starts + ends), fixed scale (max {FLOW.scaleMax[bin]}); faint dot = no rides that {unit}</div>
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
          <button type="button" className={css.btn} onClick={() => step(-1)} aria-label={`Previous ${unit}`} title="←">◀</button>
          <button type="button" className={css.btn} onClick={() => step(1)} aria-label={`Next ${unit}`} title="→">▶</button>
          <select className={css.select} value={bin} onChange={(e) => setBin(e.target.value as Bin)} aria-label="Bin" title="b">
            <option value="1h">hourly</option>
            <option value="1d">daily</option>
          </select>
          <select className={css.select} value={sp} onChange={(e) => setSp(Number(e.target.value))} aria-label="Speed" title="[ / ]">
            {SPEEDS.map((s) => <option key={s} value={s}>{s} {bin === '1h' ? 'h' : 'd'}/s</option>)}
          </select>
          <label className={css.check}>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
          </label>
          <Scrubber iStart={iStart} iEnd={iEnd} i={floor(t)} totals={totals} onScrub={(v) => { tRef.current = v; setT(v) }} onCommit={commitT} />
          <span className={css.rangeLabel}>{formatT(iMs)}</span>
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
