/**
 * `/timelapse` (`specs/timelapse-map.md`, P1–P3): every station, one bin
 * (any `/api/tl` tier, `1h` … `1mo`) per frame, on the shared `GLMap`. `ScatterplotLayer`s with
 * binary per-frame attributes in one of three presets (`st=`: `flow` =
 * diverging color on damped net share, `act` = single-hue glow, `split` =
 * disk/ring for starts/ends), all sized against one per-bin scale frozen for
 * the session. Frames are lerped in JS from a continuous playhead `t` (frame
 * index + φ) driven by one rAF loop that stalls (badge) while the next chunk
 * isn't cached; an idle fill prefetches the rest of the range behind it.
 * Selection (`sel=`; `timelapseSelection.ts`): tap selects one station,
 * long-press enters multi-select mode, shift/⌘-click toggles, and a
 * long-press- or shift-drag rectangle adds (`lib/tlGesture.ts`, fed native
 * pointer events from the map's canvas container); selected stations get a
 * ring and a row in the selection panel (docked right on desktop, a bottom
 * sheet on phones). Mobile-first chrome: a header strip (date + color bar,
 * tap to expand the legend) and a control bar (prev / play / next +
 * scrubber, with a ⚙ panel for range, bin, speed, style, loop and circle
 * size `sz=`; always expanded on wide screens). The scrubber's totals
 * sparkline previews a frame on hover (click commits `t`).
 * Movie mode (`mv=1`): chrome and interaction off, `window.__tl.seek(i)` for
 * frame-by-frame capture (`scrns.timelapse.json`).
 *
 * Chunks come from `query/timelapse.ts` (`/api/tl` first, interim sources
 * where it has no coverage yet); station positions/names from the static
 * assets (`stations-regional.json` + `station-luc.json`) until the
 * `tl-stations.json` sidecar exists.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FloatingPortal, offset, shift, useFloating } from '@floating-ui/react'
import { Link } from 'react-router-dom'
import { ScatterplotLayer } from '@deck.gl/layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { MapboxOverlay } from '@deck.gl/mapbox'
import type { Map as MaplibreMapInstance } from 'maplibre-gl'
import { useAction } from 'use-kbd'
import { boolParam, codeParam, intParam, llzParam, stringParam, useUrlState, type LLZ, type Param } from 'use-prms'
import GLMap from '../components/GLMap'
import { rampRgb } from '../components/flowLens'
import { Tip, type TipProps } from '../components/Tip'
import { IDLE, LONG_PRESS_MS, step as gestureStep, type GestureEvent, type GestureState, type Pt, type Rect } from '../lib/tlGesture'
import { useCanHover, useMediaQuery } from '../lib/useMediaQuery'
import {
  cachedChunks, ensureChunk, useTlFrames, useTlLastDay, useTlPrefetch, useTlStationSeries, useTlTotals, type SourceMode,
} from '../query/timelapse'
import {
  BIG_STEP, BIN_LABEL, capRange, clockLabel, DEFAULT_SPAN, dayOf, editRange, fitRangeToBin, frameCount, isoDay,
  parseIsoDay, RANGE_PRESETS, rangeFrames, shortLabel, SOFT_FRAMES, spanEnding, spanRange, SPEEDS, speedLabel, stepSpeed,
  suggestBin, UNIT, type Range, type Span,
} from '../query/timelapseControls'
import {
  accumulateFrame, actAttributes, buildStationTable, chunkIndexMap, chunkOf, chunksCovering, flowAttributes, formatT,
  formatYmd, frameIndex, frameStartMs, parseT, parseYmd, scaleFromChunks, snapToCached, splitAttributes,
  type Bin, type Chunk, type Preset, type StationTable,
  ACT, ANCHORS, BINS, binMs, COOL, DAY_MS, DEFAULT_SCALE, GENESIS_MS, NEUTRAL, PRESETS, SIZE, SPLIT, WARM,
} from '../query/timelapseFrames'
import {
  factorLabel, parseSize, radiusFactor, reduceSel, SIZES, stationsInRect, zoomFactor, type SelAction,
} from '../query/timelapseSelection'
import css from '../timelapse.module.css'

const { floor, max, min, round } = Math

declare global {
  interface Window {
    /** Movie-mode seek API (`?mv=1`): `frames = nBins × fpb`; `seek(i)`
     *  resolves once frame `i` is on screen (chunks in, deck drawn, map idle). */
    __tl?: { frames: number; seek: (i: number) => Promise<void> }
  }
}

const binParam = codeParam<Bin>('1d', BINS.map((b) => [b, b]))
const SYSTEM_LLZ: LLZ = { lat: 40.735, lng: -73.975, zoom: 11 }
const viewParam = llzParam({ default: SYSTEM_LLZ, latLngDecimals: 3 })
const presetParam = codeParam<Preset>('flow', [['flow', 'flow'], ['act', 'act'], ['split', 'split']])
/** `?sel=`: pinned station ids, comma-joined (as on `/stations`). */
const selParam: Param<string[]> = {
  encode: (v) => (v.length ? v.join(',') : undefined),
  decode: (raw) => (raw ? raw.split(',').filter(Boolean) : []),
}
const srcParam = codeParam<SourceMode>('auto', [['auto', 'a'], ['api', 'api'], ['shard', 'sh'], ['synth', 'sy']])

/** Today's local calendar date as a local-as-UTC midnight. The only
 *  wall-clock read, and only for the default `d` (movies pass `d`). */
function todayMs(): number {
  const d = new Date()
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Default range: the bin's `DEFAULT_SPAN` (a week at `1h`, a year at
 *  `1d`, …) ending on the last published day. */
function defaultRange(bin: Bin, lastDay: number): Range {
  return spanFrom(DEFAULT_SPAN[bin], lastDay)
}

function spanFrom(span: Span, end: number): Range {
  return span === 'all' ? [GENESIS_MS, end] : spanEnding(span, end, GENESIS_MS)
}

/** `?d=YYMMDD-YYMMDD`: inclusive local day range. */
function rangeParam(bin: Bin, lastDay: number): Param<Range> {
  const def = defaultRange(bin, lastDay)
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

/** Additive blending (`act`): overlapping glows sum toward white. */
const ADDITIVE = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
} as const
const PIN_RGB: [number, number, number] = [255, 210, 74]
const rgbCss = ([r, g, b]: readonly [number, number, number], a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`
const ACT_GRADIENT = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((f) => rgbCss(rampRgb(f))).join(', ')})`
const PRESET_LABEL: Record<Preset, string> = { flow: 'net flow', act: 'activity', split: 'starts / ends' }
const FLOW_GRADIENT = `linear-gradient(to right, ${rgbCss(COOL)}, ${rgbCss(NEUTRAL)}, ${rgbCss(WARM)})`
/** Wide enough for the docked panel + always-expanded controls. */
const WIDE = '(min-width: 768px)'

/** `Tip` on hover-capable devices only: on touch, a tap would open it and
 *  leave it stuck on screen. */
function HTip(props: TipProps) {
  const canHover = useCanHover()
  return canHover ? <Tip {...props} /> : props.children
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <path d={dir === 'left' ? 'M9 2 L4 7 L9 12' : 'M5 2 L10 7 L5 12'} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
      {playing
        ? <><rect x={4} y={3} width={3.5} height={12} rx={1} fill="currentColor" /><rect x={10.5} y={3} width={3.5} height={12} rx={1} fill="currentColor" /></>
        : <path d="M5 2.5 L15 9 L5 15.5 Z" fill="currentColor" strokeLinejoin="round" />}
    </svg>
  )
}

export default function Timelapse() {
  const qc = useQueryClient()
  const [bin, setBin] = useUrlState('b', binParam)
  // Date bounds for the range picker (and the default range's end): the last
  // published day, falling back to yesterday until `station-urls.json` loads.
  const lastDay = useTlLastDay() ?? todayMs() - DAY_MS
  const rangeP = useMemo(() => rangeParam(bin, lastDay), [bin, lastDay])
  const [range, setRange] = useUrlState('d', rangeP)
  const [tUrl, setTUrl] = useUrlState('t', tParam)
  const [sp, setSp] = useUrlState('sp', intParam(8))
  const [view, setView] = useUrlState('ll', viewParam)
  const [preset, setPreset] = useUrlState('st', presetParam)
  const [loop, setLoop] = useUrlState('lp', boolParam)
  const [src] = useUrlState('src', srcParam)
  const [pins, setPins] = useUrlState('sel', selParam)
  const [mv] = useUrlState('mv', boolParam)
  const [fpbRaw] = useUrlState('fpb', intParam(1))
  const fpb = max(1, fpbRaw)
  const [cap] = useUrlState('cap', stringParam())
  const [tileBase] = useUrlState('tileBase', stringParam())
  const [szRaw, setSzRaw] = useUrlState('sz', stringParam())
  const sz = parseSize(szRaw)
  const setSz = useCallback((v: number) => setSzRaw(v === 1 ? undefined : String(v)), [setSzRaw])
  const wide = useMediaQuery(WIDE)
  const canHover = useCanHover()

  // Inclusive frame range: the frames containing the range's first and last instants.
  const [iStart, iEnd] = rangeFrames(bin, range)
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
  // range, floored to the bin). On a range change: clamp the playhead into
  // the new range. On mount, a hand-written `d` too long for the bin is
  // trimmed (`capRange`).
  const prevGrid = useRef<{ bin: Bin; iStart: number; iEnd: number } | null>(null)
  useEffect(() => {
    const p = prevGrid.current
    prevGrid.current = { bin, iStart, iEnd }
    if (!p && !mv) {
      const c = capRange(bin, range, 'end')
      if (c.capped) setRange(c.range)
    }
    if (!p || p.bin !== bin) {
      setPlaying(false)
      const i = tToI(tUrl)
      tRef.current = i
      setT(i)
      if (!mv && tUrl !== undefined && frameStartMs(bin, i) !== tUrl) commitT(i)
    } else if (p.iStart !== iStart || p.iEnd !== iEnd) {
      if (!mv) commitT(floor(tRef.current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin, iStart, iEnd])

  /** The playhead's day, for range presets / re-fits. */
  const tDay = useCallback(() => dayOf(frameStartMs(bin, floor(tRef.current))), [bin])
  // Set by a range edit the frame-count guard trimmed; cleared by the next edit.
  const [capNote, setCapNote] = useState<string | null>(null)
  const setRangeEdit = useCallback((r: Range, keep: 'start' | 'end') => {
    const c = capRange(bin, r, keep)
    setCapNote(c.capped ? `capped to ${frameCount(bin, c.range).toLocaleString('en-US')} frames at ${BIN_LABEL[bin]}` : null)
    setRange(c.range)
  }, [bin, setRange])
  const applySpan = useCallback((span: Span) => {
    setCapNote(null)
    setRange(spanRange(span, range, tDay(), GENESIS_MS, lastDay))
  }, [range, tDay, lastDay, setRange])
  // Switching bins keeps `d`, unless it's too many frames at a finer bin or
  // too few at a coarser one (`fitRangeToBin`). The URL `t` is written first
  // (it isn't while playing), since the bin effect re-derives from it.
  const changeBin = useCallback((nb: Bin) => {
    if (nb === bin) return
    const td = tDay()
    if (!mv) setTUrl(frameStartMs(bin, floor(tRef.current)))
    const r = fitRangeToBin(bin, nb, range, td, GENESIS_MS, lastDay)
    setCapNote(null)
    setBin(nb)
    if (r[0] !== range[0] || r[1] !== range[1]) setRange(r)
  }, [bin, mv, range, lastDay, tDay, setBin, setRange, setTUrl])

  // Scrubber hover preview (`peek`): a frame shown on the map + clock
  // without moving the playhead or touching the URL. Hovering pauses
  // playback; leaving resumes it if hovering paused it.
  const [peek, setPeek] = useState<number | null>(null)
  const resumeRef = useRef(false)
  const onPeek = useCallback((i: number | null) => {
    if (i !== null && playing) {
      resumeRef.current = true
      setPlaying(false)
    }
    if (i === null && resumeRef.current) {
      resumeRef.current = false
      setPlaying(true)
    }
    setPeek(i)
  }, [playing])
  const tView = peek ?? t

  const table = useStationTable()
  const frames = useTlFrames(src, bin, tView, 1)
  const readyRef = useRef(frames.ready)
  readyRef.current = frames.ready
  const rangeChunks = useMemo(() => chunksCovering(bin, iStart, iEnd), [bin, iStart, iEnd])
  useTlPrefetch(src, bin, chunkOf(bin, floor(tView)), rangeChunks[0], rangeChunks[rangeChunks.length - 1])

  // Global scale, frozen per bin for the session: p99 of per-station-frame
  // starts + ends over the first chunk pair the playhead lands on (the
  // spec's builder-computed `tl-scale.json` doesn't exist yet). Taken from
  // exactly that chunk, so a movie URL always gets the same scale.
  const [scales, setScales] = useState<Partial<Record<Bin, number>>>({})
  useEffect(() => {
    if (scales[bin] !== undefined) return
    const { start, end } = frames.chunkA
    if (!start || !end) return
    setScales((s) => ({ ...s, [bin]: scaleFromChunks([{ start, end }]) ?? DEFAULT_SCALE[bin] }))
  }, [frames.chunkA, bin, scales])
  const scale = scales[bin] ?? DEFAULT_SCALE[bin]
  const scaleFrozen = scales[bin] !== undefined

  const play = useCallback(() => {
    resumeRef.current = false
    if (floor(tRef.current) >= iEnd) commitT(iStart)
    setPlaying(true)
  }, [iEnd, iStart, commitT])
  const pause = useCallback(() => {
    resumeRef.current = false
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

  // Selection: `sel=` (URL) + multi-select mode (session-local).
  const [multi, setMulti] = useState(false)
  const selRef = useRef({ ids: pins, multi })
  selRef.current = { ids: pins, multi }
  const applySel = useCallback((a: SelAction) => {
    const s = selRef.current
    const n = reduceSel(s, a)
    if (n.ids.length !== s.ids.length || n.ids.some((x, j) => x !== s.ids[j])) setPins(n.ids)
    if (n.multi !== s.multi) setMulti(n.multi)
    selRef.current = n
  }, [setPins])
  const applySelRef = useRef(applySel)
  applySelRef.current = applySel
  useEffect(() => { if (!pins.length && multi) setMulti(false) }, [pins, multi])

  // Keyboard (`use-kbd`): all show up in the ShortcutsModal / Omnibar. Off in
  // movie mode (interaction disabled).
  const unit = UNIT[bin]
  const big = BIG_STEP[bin]
  const on = !mv
  useAction('tl:play', { label: 'Play / pause', group: 'Timelapse', defaultBindings: ['space'], handler: toggle, enabled: on })
  useAction('tl:prev', { label: `Previous ${unit}`, group: 'Timelapse', defaultBindings: ['arrowleft'], handler: () => step(-1), enabled: on })
  useAction('tl:next', { label: `Next ${unit}`, group: 'Timelapse', defaultBindings: ['arrowright'], handler: () => step(1), enabled: on })
  useAction('tl:prev-week', { label: `Back one ${big.label}`, group: 'Timelapse', defaultBindings: ['shift+arrowleft'], handler: () => step(-big.n), enabled: on })
  useAction('tl:next-week', { label: `Forward one ${big.label}`, group: 'Timelapse', defaultBindings: ['shift+arrowright'], handler: () => step(big.n), enabled: on })
  useAction('tl:slower', { label: 'Slower', group: 'Timelapse', defaultBindings: ['['], handler: () => setSp(stepSpeed(sp, -1)), enabled: on })
  useAction('tl:faster', { label: 'Faster', group: 'Timelapse', defaultBindings: [']'], handler: () => setSp(stepSpeed(sp, 1)), enabled: on })
  useAction('tl:home', { label: 'Jump to range start', group: 'Timelapse', defaultBindings: ['home'], handler: () => { setPlaying(false); commitT(iStart) }, enabled: on })
  useAction('tl:end', { label: 'Jump to range end', group: 'Timelapse', defaultBindings: ['end'], handler: () => { setPlaying(false); commitT(iEnd) }, enabled: on })
  useAction('tl:bin', { label: 'Coarser bin', group: 'Timelapse', defaultBindings: ['b'], handler: () => changeBin(BINS[min(BINS.length - 1, BINS.indexOf(bin) + 1)]), enabled: on })
  useAction('tl:bin-finer', { label: 'Finer bin', group: 'Timelapse', defaultBindings: ['shift+b'], handler: () => changeBin(BINS[max(0, BINS.indexOf(bin) - 1)]), enabled: on })
  useAction('tl:style', { label: 'Cycle style (flow / activity / split)', group: 'Timelapse', defaultBindings: ['s'], handler: () => setPreset(PRESETS[(PRESETS.indexOf(preset) + 1) % PRESETS.length]), enabled: on })
  useAction('tl:loop', { label: 'Toggle loop', group: 'Timelapse', defaultBindings: ['l'], handler: () => setLoop(!loop), enabled: on })
  useAction('tl:unpin', { label: 'Clear selection', group: 'Timelapse', defaultBindings: ['escape'], handler: () => applySel({ t: 'clear' }), enabled: on && (pins.length > 0 || multi) })

  // Jumps land on the nearest cached frame while the real chunk loads (the
  // prefetch queue has already re-targeted to the new chunk).
  const shown = useMemo(() => {
    if (frames.ready) return tView
    const cached = cachedChunks(qc, src, bin, rangeChunks)
    return snapToCached(cached, bin, floor(tView), 1) ?? tView
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, tView, qc, src, bin, rangeChunks])
  const shownFrames = useTlFrames(src, bin, shown, 0)

  // Per-frame attributes: lerp starts/ends between frames ⌊t⌋ and ⌊t⌋+1
  // (frame ⌊t⌋ alone when ⌊t⌋+1 is past the pyramid's tip), then the
  // preset's radius/color. Fresh typed arrays per frame so deck re-uploads
  // them (same-instance binary values are skipped).
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
    const wA = f.bMissing ? 1 : 1 - phi
    add(starts, f.chunkA.start, f.startA, wA)
    add(ends, f.chunkA.end, f.endA, wA)
    if (phi > 0 && !f.bMissing) {
      add(starts, f.chunkB.start, f.startB, phi)
      add(ends, f.chunkB.end, f.endB, phi)
    }
    const flow = preset === 'flow' ? flowAttributes(starts, ends, scale) : null
    const act = preset === 'act' ? actAttributes(starts, ends, scale) : null
    const split = preset === 'split' ? splitAttributes(starts, ends, scale) : null
    return { starts, ends, flow, act, split, unmapped, source: f.chunkA.start?.source, missing: f.aMissing }
  }, [table, shown, shownFrames, preset, scale])

  const pinIdx = useMemo(() => {
    if (!table) return []
    const byId = new Map(table.ids.map((id, i) => [id, i]))
    return pins.map((id) => byId.get(id)).filter((i): i is number => i !== undefined)
  }, [table, pins])

  // Hovered station (mouse only) + where, for the floating hover card.
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  // Circle size: `sz` × a zoomed-out shrink, on top of the presets' radii.
  const rf = radiusFactor(sz, view.zoom)
  const layers = useMemo<Layer[]>(() => {
    if (!table || !frame) return []
    const n = table.ids.length
    // Picking only; selection is `onPointerDown` → `tlGesture` → `pickObject`.
    const pick = {
      pickable: !mv,
      onHover: canHover ? (info: PickingInfo) => setHover(info.index >= 0 ? { i: info.index, x: info.x, y: info.y } : null) : undefined,
    }
    const sized = { radiusScale: rf, radiusMaxPixels: SIZE.rMax * rf }
    const position = { value: table.positions, size: 2 }
    const out: Layer[] = []
    if (frame.flow || frame.act) {
      const { radius, color } = (frame.flow ?? frame.act)!
      out.push(new ScatterplotLayer({
        id: `tl-${preset}`,
        data: { length: n, attributes: { getPosition: position, getRadius: { value: radius, size: 1 }, getFillColor: { value: color, size: 4 } } },
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        ...sized,
        parameters: frame.act ? ADDITIVE : undefined,
        ...pick,
      }))
    }
    if (frame.split) {
      const { rStart, rEnd } = frame.split
      // Idle stations keep a grey disk (the skeleton); active ones warm.
      const disk = new Uint8Array(n * 4)
      for (let i = 0; i < n; i++) {
        const idle = !(frame.starts[i] + frame.ends[i] > 0)
        const [r, g, b] = idle ? NEUTRAL : WARM
        disk.set([r, g, b, idle ? 70 : SPLIT.alpha], 4 * i)
      }
      out.push(
        new ScatterplotLayer({
          id: 'tl-split-starts',
          data: { length: n, attributes: { getPosition: position, getRadius: { value: rStart, size: 1 }, getFillColor: { value: disk, size: 4 } } },
          radiusUnits: 'pixels',
          ...sized,
          ...pick,
        }),
        new ScatterplotLayer({
          id: 'tl-split-ends',
          data: { length: n, attributes: { getPosition: position, getRadius: { value: rEnd, size: 1 } } },
          radiusUnits: 'pixels',
          ...sized,
          filled: false,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: SPLIT.ringWidth,
          getLineColor: [...COOL, 230],
          pickable: false,
        }),
      )
    }
    if (pinIdx.length) {
      const r = (i: number) => {
        if (frame.flow) return frame.flow.radius[i]
        if (frame.act) return frame.act.radius[i]
        return max(frame.split!.rStart[i], frame.split!.rEnd[i], SIZE.rIdle)
      }
      out.push(new ScatterplotLayer<number>({
        id: 'tl-pins',
        data: pinIdx,
        getPosition: (i) => [table.positions[2 * i], table.positions[2 * i + 1]],
        getRadius: (i) => r(i) * rf + 3,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        getLineColor: [...PIN_RGB, 255],
        updateTriggers: { getRadius: [frame, rf] },
        pickable: false,
      }))
    }
    return out
  }, [table, frame, preset, pinIdx, mv, canHover, rf])

  // ---- Movie mode: `window.__tl.seek(i)` -----------------------------------
  // Each seek: fetch the chunk(s) under `t = iStart + i / fpb`, set `t`, then
  // wait for (1) a committed render showing exactly that `t` with its frame
  // pair ready and the scale frozen, (2) a deck redraw of those layers
  // (`onAfterRender`), (3) MapLibre idle; then set `data-tl-frame`.
  const pageRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MaplibreMapInstance | null>(null)
  const waiters = useRef(new Set<() => void>())
  const notify = useCallback(() => { for (const w of Array.from(waiters.current)) w() }, [])
  const waitFor = useCallback((pred: () => boolean) => new Promise<void>((resolve) => {
    if (pred()) return resolve()
    const w = () => { if (pred()) { waiters.current.delete(w); resolve() } }
    waiters.current.add(w)
  }), [])
  const rendered = useRef({ t: NaN, ready: false, layers: [] as Layer[] })
  const drawn = useRef<Layer[] | null>(null)
  const layersRef = useRef(layers)
  layersRef.current = layers
  useLayoutEffect(() => {
    rendered.current = { t: shown, ready: shownFrames.ready && scaleFrozen && layers.length > 0, layers }
    notify()
  })
  const onAfterRender = useCallback(() => {
    drawn.current = layersRef.current
    notify()
  }, [notify])
  const nFrames = (iEnd - iStart + 1) * fpb
  const seekChain = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!mv) return
    const doSeek = async (i: number) => {
      const tt = iStart + i / fpb
      const a = floor(tt)
      const ks = Array.from(new Set([chunkOf(bin, a), chunkOf(bin, a + 1)]))
      await Promise.all(ks.flatMap((k) => ANCHORS.map((anchor) => ensureChunk(qc, src, anchor, bin, k))))
      tRef.current = tt
      setT(tt)
      await waitFor(() => rendered.current.t === tt && rendered.current.ready)
      await waitFor(() => drawn.current === rendered.current.layers)
      await waitFor(() => !!mapRef.current)
      const m = mapRef.current!
      if (!m.loaded() || !m.areTilesLoaded()) await new Promise((r) => m.once('idle', r))
      pageRef.current?.setAttribute('data-tl-frame', String(i))
    }
    const seek = (i: number) => {
      const p = seekChain.current.then(() => doSeek(i))
      seekChain.current = p.catch(() => {})
      return p
    }
    window.__tl = { frames: nFrames, seek }
    // Land on the URL's `t` so `[data-tl-frame]` appears without a caller.
    seek(round((tToI(tUrl) - iStart) * fpb)).catch((e) => console.error('__tl.seek', e))
    return () => { delete window.__tl }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mv, bin, iStart, fpb, nFrames, src])

  // ---- Selection gestures (`lib/tlGesture.ts`) -----------------------------
  // Native pointer listeners on the map's canvas container, so overlays
  // (siblings of the map, not inside it) never start a gesture. Taps pick
  // with deck's `pickObject` (a wider radius for fingers); rectangles test
  // projected station positions (`stationsInRect`).
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const [gestureMap, setGestureMap] = useState<MaplibreMapInstance | null>(null)
  const [dragRect, setDragRect] = useState<Rect | null>(null)
  const pickAt = useRef<(at: Pt, touch: boolean) => string | null>(() => null)
  pickAt.current = (at, touch) => {
    const o = overlayRef.current
    if (!o || !table) return null
    const info = o.pickObject({ x: at.x, y: at.y, radius: touch ? 12 : 3 })
    return info && info.index >= 0 ? table.ids[info.index] : null
  }
  const pickRect = useRef<(r: Rect) => string[]>(() => [])
  pickRect.current = (r) => {
    const m = gestureMap
    if (!m || !table || !frame) return []
    // Current (named) stations, plus any retired one active this frame.
    const keep = (j: number) => table.names[j] !== table.ids[j] || frame.starts[j] + frame.ends[j] > 0
    const project = (lng: number, lat: number): [number, number] => {
      const p = m.project([lng, lat])
      return [p.x, p.y]
    }
    return stationsInRect(table.positions, project, r, keep).map((j) => table.ids[j])
  }
  useEffect(() => {
    const m = gestureMap
    if (!m || mv) return
    // Shift+drag is ours (rectangle select), not MapLibre's box zoom.
    m.boxZoom.disable()
    const el = m.getCanvasContainer()
    let s: GestureState = IDLE
    let timer = 0
    let touch = false
    let fromLongPress = false
    const rel = (e: PointerEvent): Pt => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const handle = (ev: GestureEvent) => {
      const r = gestureStep(s, ev)
      s = r.s
      if (s.k !== 'press') clearTimeout(timer)
      for (const o of r.out) {
        switch (o.t) {
          case 'hold': m.dragPan.disable(); break
          case 'release': m.dragPan.enable(); break
          case 'tap': applySelRef.current({ t: 'tap', id: pickAt.current(o.at, touch), toggle: o.mod }); break
          case 'longpress': {
            fromLongPress = true
            navigator.vibrate?.(15)
            applySelRef.current({ t: 'longpress', id: pickAt.current(o.at, touch) })
            break
          }
          case 'rect': setDragRect(o.rect); break
          case 'rectEnd': {
            setDragRect(null)
            applySelRef.current({ t: 'add', ids: pickRect.current(o.rect), multi: fromLongPress })
            break
          }
          case 'rectCancel': setDragRect(null); break
        }
      }
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const first = s.k === 'idle'
      if (first) {
        touch = e.pointerType !== 'mouse'
        fromLongPress = false
      }
      handle({ t: 'down', id: e.pointerId, at: rel(e), time: performance.now(), touch, shift: e.shiftKey, mod: e.shiftKey || e.metaKey || e.ctrlKey })
      if (first && s.k === 'press') timer = window.setTimeout(() => handle({ t: 'timer', time: performance.now() }), LONG_PRESS_MS)
    }
    const onMove = (e: PointerEvent) => { if (s.k !== 'idle') handle({ t: 'move', id: e.pointerId, at: rel(e) }) }
    const onUp = (e: PointerEvent) => { if (s.k !== 'idle') handle({ t: 'up', id: e.pointerId, at: rel(e) }) }
    const onCancel = () => { if (s.k !== 'idle') handle({ t: 'cancel' }) }
    // A long-press would otherwise open the context menu / callout.
    const onContext = (e: Event) => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('contextmenu', onContext)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    return () => {
      clearTimeout(timer)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('contextmenu', onContext)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      m.dragPan.enable()
    }
  }, [gestureMap, mv])

  // Control-bar height → `--tl-controls-h`, so the selection panel / bottom
  // sheet sits just above it.
  const controlsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const c = controlsRef.current
    const page = pageRef.current
    if (!c || !page) return
    const set = () => page.style.setProperty('--tl-controls-h', `${c.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(c)
    return () => ro.disconnect()
  }, [mv])

  const [legendOpen, setLegendOpen] = useState(() => mv || window.matchMedia(WIDE).matches)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const totals = useTlTotals(src, bin, iStart, iEnd)
  const i = floor(shown)
  const stalled = playing && !frames.ready
  const iMs = frameStartMs(bin, i)
  const dateStr = wide || mv ? clockLabel(bin, iMs) : shortLabel(bin, iMs)
  const nFramesRange = iEnd - iStart + 1
  // Sub-day bins only: `1d` over all of history (~4,850 frames) is a preset.
  const suggested = nFramesRange > SOFT_FRAMES && binMs(bin) < DAY_MS ? suggestBin(range) : null
  const fmt = (n: number) => round(n).toLocaleString('en-US')
  const zf = zoomFactor(view.zoom)
  const sizeTerms = [sz !== 1 && `${factorLabel(sz)} (size)`, zf < 1 && `${factorLabel(zf)} (zoomed out)`].filter(Boolean).join(' ')
  const scaleNote = `size = √(rides ÷ ${fmt(scale)})${sizeTerms ? ` ${sizeTerms}` : ''}, ${scaleFrozen ? 'p99 of the first loaded chunk, fixed for the session' : 'provisional'}`
  const showSettings = wide || settingsOpen

  return (
    <div ref={pageRef} className={css.page} data-tl-frame={mv ? undefined : i} onMouseLeave={() => setHover(null)}>
      <GLMap
        layers={layers}
        center={[view.lat, view.lng]}
        zoom={view.zoom}
        onMove={mv ? undefined : (la, ln, z) => setView({ lat: la, lng: ln, zoom: z })}
        onReady={(m) => { mapRef.current = m; notify() }}
        onOverlay={(o, m) => { overlayRef.current = o; setGestureMap(m) }}
        onAfterRender={mv ? onAfterRender : undefined}
        interactive={!mv}
        preserveDrawingBuffer={mv}
        tileBase={tileBase}
        cursor={hover !== null ? 'pointer' : 'grab'}
        className={css.map}
      >
        <div className={css.header} data-testid="tl-header">
          <div className={css.headRow}>
            <span className={css.clockDate} data-testid="tl-clock">{dateStr}</span>
            <div className={css.badges}>
              {frame?.missing && <span className={`${css.badge} ${css.badgeWarn}`} data-testid="tl-no-data">no data</span>}
              {!mv && <>
                {stalled && <span className={`${css.badge} ${css.badgeWarn}`}>buffering…</span>}
                {!frames.ready && !playing && !frames.error && <span className={css.badge}>loading…</span>}
                {frames.error && <span className={`${css.badge} ${css.badgeError}`}>error: {frames.error.message}</span>}
                {frame?.source === 'synth' && <span className={`${css.badge} ${css.badgeWarn}`}>synthetic</span>}
              </>}
            </div>
            {!mv && (
              <button type="button" className={css.info} onClick={() => setLegendOpen(!legendOpen)} aria-expanded={legendOpen} aria-label={legendOpen ? 'Hide legend' : 'Show legend'}>
                {legendOpen ? '×' : 'i'}
              </button>
            )}
          </div>
          <button type="button" className={css.barBtn} onClick={() => setLegendOpen(!legendOpen)} aria-label="Toggle legend" disabled={mv}>
            <LegendBar preset={preset} />
          </button>
          {legendOpen && (
            <div className={css.legendBody} data-testid="tl-legend">
              <Legend preset={preset} unit={unit} note={scaleNote} />
              <div className={css.clockSub}>
                {mv
                  ? <>{frame && !frame.missing && <>{fmt(frame.starts.reduce((a, b) => a + b, 0))} rides started</>}</>
                  : <>
                    {formatYmd(range[0])} – {formatYmd(range[1])} · {bin} bins · frame {i - iStart + 1} of {nFramesRange}
                    {peek !== null && <> · preview</>}
                    {frame && !frame.missing && <> · {fmt(frame.starts.reduce((a, b) => a + b, 0))} starts</>}
                  </>}
              </div>
              {!mv && frame && (
                <div className={css.chips}>
                  {frame.missing && <span className={css.chip}>no data: past the last published month</span>}
                  {frame.source === 'api' && <span className={css.chip}>source: rides-tl (/api/tl)</span>}
                  {frame.source === 'shard' && <span className={css.chip}>source: live pyramid shard (interim)</span>}
                  {frame.source === 'synth' && <span className={css.chip}>synthesized from monthly station totals (interim)</span>}
                  {frame.unmapped > 0 && <span className={css.chip}>{fmt(frame.unmapped)} rides at unmapped stations</span>}
                </div>
              )}
            </div>
          )}
        </div>
        {cap && <div className={css.caption}>{cap}</div>}
        {dragRect && (
          <div className={css.dragRect} style={{ left: dragRect.x0, top: dragRect.y0, width: dragRect.x1 - dragRect.x0, height: dragRect.y1 - dragRect.y0 }} />
        )}
        {!mv && canHover && table && frame && hover !== null && !dragRect && (
          <HoverCard
            x={hover.x}
            y={hover.y}
            w={pageRef.current?.clientWidth ?? 0}
            name={table.names[hover.i]}
            starts={frame.starts[hover.i]}
            ends={frame.ends[hover.i]}
            selected={pinIdx.includes(hover.i)}
            multi={multi}
          />
        )}
        {!mv && table && frame && (pinIdx.length > 0 || multi) && (
          <SelPanel
            src={src}
            bin={bin}
            table={table}
            idx={pinIdx}
            starts={frame.starts}
            ends={frame.ends}
            iStart={iStart}
            iEnd={iEnd}
            i={i}
            multi={multi}
            wide={wide}
            onRemove={(id) => applySel({ t: 'remove', id })}
            onClear={() => applySel({ t: 'clear' })}
            onDone={() => applySel({ t: 'done' })}
          />
        )}
        {!table && <div className={css.loading}>Loading stations…</div>}
        {!mv && (
          <div className={css.controls} ref={controlsRef} data-testid="tl-controls">
            {showSettings && (
              <div className={css.row} data-testid="tl-settings">
                <RangePicker
                  bin={bin}
                  range={range}
                  lastDay={lastDay}
                  tDay={dayOf(frameStartMs(bin, floor(t)))}
                  onEdit={setRangeEdit}
                  onSpan={applySpan}
                />
                <HTip content="Bin: time per frame (b = coarser, shift+b = finer)">
                  <label className={css.field}>
                    <span className={css.fieldLabel}>bin</span>
                    <select className={css.select} value={bin} onChange={(e) => changeBin(e.target.value as Bin)} aria-label="Bin">
                      {BINS.map((b) => <option key={b} value={b}>{BIN_LABEL[b]}</option>)}
                    </select>
                  </label>
                </HTip>
                <HTip content={`Playback speed: ${sp} frame${sp === 1 ? '' : 's'}/s ([ slower, ] faster)`}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>speed</span>
                    <select className={css.select} value={sp} onChange={(e) => setSp(Number(e.target.value))} aria-label="Speed">
                      {(SPEEDS.includes(sp) ? SPEEDS : [...SPEEDS, sp].sort((a, b) => a - b)).map((v) => (
                        <option key={v} value={v}>{speedLabel(bin, v)}</option>
                      ))}
                    </select>
                  </label>
                </HTip>
                <HTip content="Style preset (s)">
                  <label className={css.field}>
                    <span className={css.fieldLabel}>style</span>
                    <select className={css.select} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Style">
                      {PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
                    </select>
                  </label>
                </HTip>
                <HTip content="Circle size (multiplies every radius; circles also shrink when zoomed out)">
                  <label className={css.field}>
                    <span className={css.fieldLabel}>size</span>
                    <select className={css.select} value={sz} onChange={(e) => setSz(Number(e.target.value))} aria-label="Circle size" data-testid="tl-size">
                      {(SIZES.includes(sz as typeof SIZES[number]) ? [...SIZES] : [...SIZES, sz].sort((a, b) => a - b)).map((v) => (
                        <option key={v} value={v}>{factorLabel(v)}</option>
                      ))}
                    </select>
                  </label>
                </HTip>
                <HTip content="Loop at the end of the range (l)">
                  <label className={css.check}>
                    <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
                  </label>
                </HTip>
                {suggested && suggested !== bin && (
                  <HTip content={`${fmt(nFramesRange)} frames at ${BIN_LABEL[bin]}: long to load and play. Switch to ${BIN_LABEL[suggested]} bins?`}>
                    <button type="button" className={`${css.btn} ${css.hint}`} onClick={() => changeBin(suggested)} data-testid="tl-suggest-bin">
                      {fmt(nFramesRange)} frames · use {suggested}
                    </button>
                  </HTip>
                )}
                {capNote && <span className={css.note} data-testid="tl-cap-note">{capNote}</span>}
                {!canHover && (
                  <div className={css.keys}>
                    Keys: space play · ←/→ {unit} · shift+←/→ {big.label} · [ ] speed · b / shift+b bin · s style · l loop · esc clear selection.
                    {' '}Long-press a station to multi-select; long-press + drag to box-select.
                  </div>
                )}
              </div>
            )}
            <div className={css.transportRow}>
              <div className={css.transport}>
                <HTip content={`Previous ${unit} (←; shift+← = ${big.label})`}>
                  <button type="button" className={css.chev} onClick={() => step(-1)} aria-label={`Previous ${unit}`}><Chevron dir="left" /></button>
                </HTip>
                <HTip content="Play / pause (space)">
                  <button type="button" className={css.play} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} data-testid="tl-play">
                    <PlayIcon playing={playing} />
                  </button>
                </HTip>
                <HTip content={`Next ${unit} (→; shift+→ = ${big.label})`}>
                  <button type="button" className={css.chev} onClick={() => step(1)} aria-label={`Next ${unit}`}><Chevron dir="right" /></button>
                </HTip>
              </div>
              <Scrubber
                bin={bin}
                iStart={iStart}
                iEnd={iEnd}
                i={floor(t)}
                peek={peek}
                totals={totals}
                onScrub={(v) => { tRef.current = v; setT(v) }}
                onCommit={commitT}
                onPeek={onPeek}
              />
              <span className={css.rangeLabel}>{formatT(iMs)}</span>
              {!wide && (
                <button type="button" className={css.gear} onClick={() => setSettingsOpen(!settingsOpen)} aria-expanded={settingsOpen} aria-label="Settings" data-testid="tl-gear">
                  <GearIcon />
                </button>
              )}
            </div>
          </div>
        )}
      </GLMap>
    </div>
  )
}

function GearIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1L11 21h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
        transform="translate(-1 0)"
      />
    </svg>
  )
}

/** The preset's color key as one thin bar (split: two glyphs). */
function LegendBar({ preset }: { preset: Preset }) {
  if (preset === 'split') {
    return (
      <span className={css.legendGlyphs}>
        <span><svg width={12} height={12}><circle cx={6} cy={6} r={5} fill={rgbCss(WARM, SPLIT.alpha / 255)} /></svg> starts</span>
        <span><svg width={12} height={12}><circle cx={6} cy={6} r={4.5} fill="none" stroke={rgbCss(COOL)} strokeWidth={SPLIT.ringWidth} /></svg> ends</span>
      </span>
    )
  }
  return <span className={css.legendBar} style={preset === 'flow' ? { background: FLOW_GRADIENT } : { background: ACT_GRADIENT, opacity: ACT.alpha / 255 + 0.2 }} />
}

/** The expanded legend: title, bar labels, and the shared size note. */
function Legend({ preset, unit, note }: { preset: Preset; unit: string; note: string }) {
  return (
    <>
      <div className={css.legendTitle}>Rides per {unit}, by station · {PRESET_LABEL[preset]}</div>
      {preset === 'flow' && (
        <div className={css.legendLabels}>
          <span>net arrivals</span>
          <span>balanced</span>
          <span>net departures</span>
        </div>
      )}
      {preset === 'act' && (
        <div className={css.legendLabels}>
          <span>quiet</span>
          <span>busy (overlaps glow)</span>
        </div>
      )}
      {preset === 'split' && <div className={css.legendLabels}><span>disk = starts, ring = ends</span></div>}
      <div className={css.legendNote}>{note}; faint dot = no rides that {unit}</div>
    </>
  )
}

const HOVER_W = 260

/** Mouse-only: the hovered station's current-frame stats, by the cursor. */
function HoverCard({ x, y, w, name, starts, ends, selected, multi }: {
  x: number
  y: number
  /** Page width: the card flips to the cursor's left near the right edge. */
  w: number
  name: string
  starts: number
  ends: number
  selected: boolean
  multi: boolean
}) {
  const hint = multi ? 'click to toggle' : selected ? 'shift/⌘-click to remove' : 'click to select · shift/⌘-click to add'
  return (
    <div className={css.hoverCard} style={{ left: x + 14 + HOVER_W > w ? max(8, x - 14 - HOVER_W) : x + 14, top: y + 14, width: HOVER_W }}>
      <span className={css.cardName}>{name}</span>
      <span className={css.cardStat}><Stats starts={starts} ends={ends} /></span>
      <span className={css.cardHint}>{hint}</span>
    </div>
  )
}

function Stats({ starts, ends }: { starts: number; ends: number }) {
  const fmt = (v: number) => round(v).toLocaleString('en-US')
  const net = starts - ends
  return <>{fmt(starts)} starts · {fmt(ends)} ends · net {net >= 0 ? '+' : ''}{fmt(net)}</>
}

/** Selected stations: docked right (desktop) or a collapsible bottom sheet
 *  (phone), with a count, Clear, and Done while in multi-select mode. */
function SelPanel({ src, bin, table, idx, starts, ends, iStart, iEnd, i, multi, wide, onRemove, onClear, onDone }: {
  src: SourceMode
  bin: Bin
  table: StationTable
  idx: number[]
  starts: Float32Array
  ends: Float32Array
  iStart: number
  iEnd: number
  i: number
  multi: boolean
  wide: boolean
  onRemove: (id: string) => void
  onClear: () => void
  onDone: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const n = idx.length
  const single = n === 1 && !multi
  return (
    <div className={`${css.panel} ${collapsed && !wide ? css.panelCollapsed : ''}`} data-testid="tl-sel-panel">
      <div className={css.panelHead}>
        {!wide && (
          <button type="button" className={css.collapse} onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand selection' : 'Collapse selection'}>
            <Chevron dir={collapsed ? 'right' : 'left'} />
          </button>
        )}
        <span className={css.panelCount} data-testid="tl-sel-count">
          {n} selected
          {multi && <span className={css.modeTag}>multi-select</span>}
        </span>
        <span className={css.panelBtns}>
          {multi && <button type="button" className={`${css.btn} ${css.done}`} onClick={onDone} data-testid="tl-sel-done">Done</button>}
          {n > 0 && <button type="button" className={css.btn} onClick={onClear} data-testid="tl-sel-clear">Clear</button>}
        </span>
      </div>
      {multi && !collapsed && <div className={css.panelHint}>Tap stations to add / remove; long-press + drag to box-select.</div>}
      {!(collapsed && !wide) && (
        <div className={css.rows}>
          {idx.map((s) => (
            <SelRow
              key={table.ids[s]}
              src={src}
              bin={bin}
              id={table.ids[s]}
              name={table.names[s]}
              linkable={table.names[s] !== table.ids[s]}
              starts={starts[s]}
              ends={ends[s]}
              iStart={iStart}
              iEnd={iEnd}
              i={i}
              big={single}
              onRemove={() => onRemove(table.ids[s])}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** One selected station: current-frame stats + a sparkline of starts + ends
 *  over the range from whatever chunks are cached (gaps where they aren't);
 *  `big` (a lone selection): a taller sparkline and a station-page link. */
function SelRow({ src, bin, id, name, linkable, starts, ends, iStart, iEnd, i, big, onRemove }: {
  src: SourceMode
  bin: Bin
  id: string
  name: string
  linkable: boolean
  starts: number
  ends: number
  iStart: number
  iEnd: number
  i: number
  big: boolean
  onRemove: () => void
}) {
  const series = useTlStationSeries(src, bin, id, iStart, iEnd)
  const W = big ? 280 : 90
  const H = big ? 48 : 22
  const path = useMemo(() => sparkPath(series, W, H), [series, W, H])
  const n = series.length
  const x = n ? ((i - iStart + 0.5) / n) * W : 0
  const spark = (
    <svg className={big ? css.sparkBig : css.sparkMini} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {path && <path d={path} fill="none" stroke={rgbCss(PIN_RGB)} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      <line x1={x} x2={x} y1={0} y2={H} stroke="rgba(255,255,255,0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
  return (
    <div className={`${css.selRow} ${big ? css.selRowBig : ''}`} data-testid="tl-pin">
      <div className={css.selMain}>
        <span className={css.selName}>{name}</span>
        <span className={css.cardStat}><Stats starts={starts} ends={ends} /></span>
      </div>
      {!big && spark}
      <button type="button" className={css.unpin} onClick={onRemove} aria-label={`Remove ${name}`}>×</button>
      {big && spark}
      {big && linkable && <Link className={css.stationLink} to={`/s/${id}`}>Station page →</Link>}
    </div>
  )
}

/** SVG path over `values` (NaN = gap), scaled to its own peak. Point `f`
 *  sits at its slot's center (`center`), or at `f / (n − 1)` of the width
 *  (`edge`: where a range input's thumb sits for value `f`). */
function sparkPath(values: Float64Array, W: number, H: number, align: 'center' | 'edge' = 'center'): string {
  const n = values.length
  if (!n) return ''
  let peak = 0
  for (const v of values) if (v === v && v > peak) peak = v
  if (!peak) return ''
  const parts: string[] = []
  let pen = false
  for (let f = 0; f < n; f++) {
    const v = values[f]
    if (v !== v) { pen = false; continue }
    const x = align === 'edge' ? edgeX(f, n) * W : ((f + 0.5) / n) * W
    const y = H - 2 - (v / peak) * (H - 6)
    parts.push(`${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
    pen = true
  }
  return parts.join(' ')
}

/** Fraction of the width at which frame `f` of `n` sits under a range input. */
function edgeX(f: number, n: number): number {
  return n > 1 ? f / (n - 1) : 0.5
}

/** Range picker for `d=`: two native date inputs (genesis … the last
 *  published day) and the bin's quick presets (`RANGE_PRESETS`). */
function RangePicker({ bin, range, lastDay, tDay, onEdit, onSpan }: {
  bin: Bin
  range: Range
  lastDay: number
  tDay: number
  onEdit: (r: Range, keep: 'start' | 'end') => void
  onSpan: (span: Span) => void
}) {
  const lo = isoDay(GENESIS_MS)
  const hi = isoDay(lastDay)
  const edit = (side: 'start' | 'end', v: string) => {
    const ms = parseIsoDay(v)
    if (ms !== null) onEdit(editRange(range, side, ms, GENESIS_MS, lastDay), side)
  }
  return (
    <div className={css.group} role="group" aria-label="Range">
      <input type="date" className={css.date} value={isoDay(range[0])} min={lo} max={hi} aria-label="Range start" onChange={(e) => edit('start', e.target.value)} />
      <span className={css.dash}>–</span>
      <input type="date" className={css.date} value={isoDay(range[1])} min={lo} max={hi} aria-label="Range end" onChange={(e) => edit('end', e.target.value)} />
      {RANGE_PRESETS[bin].map(({ label, span }) => {
        const r = spanRange(span, range, tDay, GENESIS_MS, lastDay)
        // A day span clamped at genesis / the last day doesn't count as picked.
        const active = r[0] === range[0] && r[1] === range[1] && (span === 'all' || span.u === 'mo' || r[1] - r[0] === (span.n - 1) * DAY_MS)
        const desc = span === 'all' ? 'all of history' : `${span.n} ${span.u === 'd' ? 'day' : 'month'}${span.n === 1 ? '' : 's'}`
        return (
          <Tip key={label} content={`Range: ${desc} (${formatYmd(r[0])}–${formatYmd(r[1])})`}>
            <button type="button" className={`${css.btn} ${css.preset}`} aria-pressed={active} onClick={() => onSpan(span)}>{label}</button>
          </Tip>
        )
      })}
    </div>
  )
}

/**
 * Range input over the frame range with the totals strip behind it.
 * Hovering (mouse) previews the frame under the pointer (`onPeek`: map +
 * clock, a hover line and a tip with the frame's Σ starts); click commits
 * it. Touch keeps the native behavior (tap/drag → commit on release).
 */
function Scrubber({
  bin,
  iStart,
  iEnd,
  i,
  peek,
  totals,
  onScrub,
  onCommit,
  onPeek,
}: {
  bin: Bin
  iStart: number
  iEnd: number
  i: number
  peek: number | null
  totals: Float64Array
  onScrub: (i: number) => void
  onCommit: (i: number) => void
  onPeek: (i: number | null) => void
}) {
  const W = 1000
  const H = 34
  const n = iEnd - iStart + 1
  const path = useMemo(() => sparkPath(totals, W, H, 'edge'), [totals])
  const boxRef = useRef<HTMLDivElement>(null)
  const frameAt = (clientX: number) => {
    const r = boxRef.current!.getBoundingClientRect()
    const f = n > 1 ? round(((clientX - r.left) / r.width) * (n - 1)) : 0
    return iStart + max(0, min(n - 1, f))
  }
  const px = peek === null ? null : edgeX(peek - iStart, n)
  const { refs, floatingStyles } = useFloating({
    open: peek !== null,
    placement: 'top',
    middleware: [offset(8), shift({ padding: 8 })],
  })
  useLayoutEffect(() => {
    const box = boxRef.current
    if (px === null || !box) return
    refs.setPositionReference({
      getBoundingClientRect: () => {
        const r = box.getBoundingClientRect()
        const x = r.left + px * r.width
        return new DOMRect(x, r.top, 0, r.height)
      },
    })
  }, [px, refs])
  const rides = peek === null ? NaN : totals[peek - iStart]
  return (
    <div
      ref={boxRef}
      className={css.scrub}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') onPeek(frameAt(e.clientX)) }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') onPeek(null) }}
    >
      <svg className={css.strip} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <rect x={0} y={0} width={W} height={H} fill="rgba(255,255,255,0.06)" />
        {path && <path d={path} fill="none" stroke="#7fb3ff" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        {px !== null && <line x1={px * W} x2={px * W} y1={0} y2={H} stroke="rgba(255,255,255,0.85)" strokeWidth={1} vectorEffect="non-scaling-stroke" data-testid="tl-hover-line" />}
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
        onPointerUp={(e) => onCommit(e.pointerType === 'mouse' && peek !== null ? peek : Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
      />
      {peek !== null && (
        <FloatingPortal>
          <div ref={refs.setFloating} style={floatingStyles} className={css.scrubTip} data-testid="tl-scrub-tip">
            {shortLabel(bin, frameStartMs(bin, peek))} · {rides === rides ? `${round(rides).toLocaleString('en-US')} rides` : 'loading…'}
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}
