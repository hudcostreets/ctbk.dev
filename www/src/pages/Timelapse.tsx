/**
 * `/timelapse` (`specs/timelapse-map.md`, P1–P3): every station, one bin
 * (any `/api/tl` tier, `1h` … `1mo`) per frame, on the shared `GLMap`. `ScatterplotLayer`s with
 * binary per-frame attributes in one of three presets (`st=`: `flow` =
 * diverging color on damped net share, `act` = single-hue glow, `split` =
 * disk/ring for starts/ends), all sized against one per-bin scale frozen for
 * the session. Frames are lerped in JS from a continuous playhead `t` (frame
 * index + φ) driven by one rAF loop that stalls (badge) while the next chunk
 * isn't cached; an idle fan-out prefetches the rest of the range behind it.
 * Click pins a station (`sel=`, ring + sparkline drawer; `esc` clears).
 * Control bar: range (`d=`: date inputs + per-bin presets, capped by a
 * frame-count guard), bin, speed, style, loop, and a scrubber whose totals
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
import { ScatterplotLayer } from '@deck.gl/layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { Map as MaplibreMapInstance } from 'maplibre-gl'
import { useAction } from 'use-kbd'
import { boolParam, codeParam, intParam, llzParam, stringParam, useUrlState, type LLZ, type Param } from 'use-prms'
import GLMap from '../components/GLMap'
import { rampRgb } from '../components/flowLens'
import { Tip } from '../components/Tip'
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
 *  `1d`, …) ending yesterday. */
function defaultRange(bin: Bin): Range {
  return spanFrom(DEFAULT_SPAN[bin], todayMs() - DAY_MS)
}

function spanFrom(span: Span, end: number): Range {
  return span === 'all' ? [GENESIS_MS, end] : spanEnding(span, end, GENESIS_MS)
}

/** `?d=YYMMDD-YYMMDD`: inclusive local day range. */
function rangeParam(bin: Bin): Param<Range> {
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

export default function Timelapse() {
  const qc = useQueryClient()
  const [bin, setBin] = useUrlState('b', binParam)
  const rangeP = useMemo(() => rangeParam(bin), [bin])
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

  // Date bounds for the range picker: genesis … the last published day.
  const lastDay = useTlLastDay() ?? todayMs() - DAY_MS

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

  const togglePin = useCallback((id: string) => setPins(pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]), [pins, setPins])

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
  useAction('tl:unpin', { label: 'Clear pinned stations', group: 'Timelapse', defaultBindings: ['escape'], handler: () => setPins([]), enabled: on && pins.length > 0 })

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

  const [hover, setHover] = useState<number | null>(null)
  const layers = useMemo<Layer[]>(() => {
    if (!table || !frame) return []
    const n = table.ids.length
    const pickable = !mv
    const pick = {
      pickable,
      onHover: (info: PickingInfo) => setHover(info.index >= 0 ? info.index : null),
      onClick: (info: PickingInfo) => { if (info.index >= 0) togglePin(table.ids[info.index]) },
    }
    const position = { value: table.positions, size: 2 }
    const out: Layer[] = []
    if (frame.flow || frame.act) {
      const { radius, color } = (frame.flow ?? frame.act)!
      out.push(new ScatterplotLayer({
        id: `tl-${preset}`,
        data: { length: n, attributes: { getPosition: position, getRadius: { value: radius, size: 1 }, getFillColor: { value: color, size: 4 } } },
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        radiusMaxPixels: SIZE.rMax,
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
          radiusMaxPixels: SIZE.rMax,
          ...pick,
        }),
        new ScatterplotLayer({
          id: 'tl-split-ends',
          data: { length: n, attributes: { getPosition: position, getRadius: { value: rEnd, size: 1 } } },
          radiusUnits: 'pixels',
          radiusMaxPixels: SIZE.rMax,
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
        getRadius: (i) => r(i) + 3,
        radiusUnits: 'pixels',
        filled: false,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        getLineColor: [...PIN_RGB, 255],
        updateTriggers: { getRadius: frame },
        pickable: false,
      }))
    }
    return out
  }, [table, frame, preset, pinIdx, mv, togglePin])

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

  const totals = useTlTotals(src, bin, iStart, iEnd)
  const i = floor(shown)
  const stalled = playing && !frames.ready
  const iMs = frameStartMs(bin, i)
  const dateStr = clockLabel(bin, iMs)
  const nFramesRange = iEnd - iStart + 1
  // Sub-day bins only: `1d` over all of history (~4,850 frames) is a preset.
  const suggested = nFramesRange > SOFT_FRAMES && binMs(bin) < DAY_MS ? suggestBin(range) : null
  const fmt = (n: number) => round(n).toLocaleString('en-US')
  const scaleNote = `size = √(rides ÷ ${fmt(scale)}), ${scaleFrozen ? 'p99 of the first loaded chunk, fixed for the session' : 'provisional'}`

  return (
    <div ref={pageRef} className={css.page} data-tl-frame={mv ? undefined : i} onMouseLeave={() => setHover(null)}>
      <GLMap
        layers={layers}
        center={[view.lat, view.lng]}
        zoom={view.zoom}
        onMove={mv ? undefined : (la, ln, z) => setView({ lat: la, lng: ln, zoom: z })}
        onReady={(m) => { mapRef.current = m; notify() }}
        onAfterRender={mv ? onAfterRender : undefined}
        interactive={!mv}
        preserveDrawingBuffer={mv}
        tileBase={tileBase}
        cursor={hover !== null ? 'pointer' : 'grab'}
        className={css.map}
      >
        <div className={css.clock}>
          <span className={css.clockDate} data-testid="tl-clock">{dateStr}</span>
          <span className={css.clockSub}>
            {mv
              ? <>{frame && !frame.missing && <>{fmt(frame.starts.reduce((a, b) => a + b, 0))} rides started</>}</>
              : <>
                {formatYmd(range[0])} – {formatYmd(range[1])} · {bin} bins · frame {i - iStart + 1} of {nFramesRange}
                {peek !== null && <> · preview</>}
                {frame && !frame.missing && <> · {fmt(frame.starts.reduce((a, b) => a + b, 0))} starts</>}
              </>}
          </span>
          <div className={css.badges}>
            {frame?.missing && <span className={`${css.badge} ${css.badgeWarn}`} data-testid="tl-no-data" title="Past the last published month: the pyramid has no rides for this frame yet">no data</span>}
            {!mv && <>
              {stalled && <span className={`${css.badge} ${css.badgeWarn}`}>buffering…</span>}
              {!frames.ready && !playing && !frames.error && <span className={css.badge}>loading…</span>}
              {frames.error && <span className={`${css.badge} ${css.badgeError}`} title={frames.error.message}>error: {frames.error.message}</span>}
              {frame?.source === 'api' && <span className={css.badge} title="Frames from /api/tl over the time-first rides-tl pyramid">rides-tl</span>}
              {frame?.source === 'synth' && <span className={`${css.badge} ${css.badgeWarn}`} title="rides-tl doesn't cover this range yet and no small-enough rides shard does either; frames are synthesized from monthly station totals (interim)">synthetic</span>}
              {frame?.source === 'shard' && <span className={css.badge} title="rides-tl doesn't cover this range yet; read from the live rides pyramid shards (interim tail-read)">live shard</span>}
              {frame && frame.unmapped > 0 && <span className={css.badge} title="Rides at station ids with no known position">{fmt(frame.unmapped)} unmapped</span>}
            </>}
          </div>
        </div>
        <Legend preset={preset} unit={unit} note={scaleNote} />
        {cap && <div className={css.caption}>{cap}</div>}
        {!mv && table && frame && (
          <div className={css.drawers}>
            {pinIdx.map((s) => (
              <PinCard key={table.ids[s]} src={src} bin={bin} id={table.ids[s]} name={table.names[s]} starts={frame.starts[s]} ends={frame.ends[s]} iStart={iStart} iEnd={iEnd} i={i} onUnpin={() => togglePin(table.ids[s])} />
            ))}
            {hover !== null && !pinIdx.includes(hover) && (
              <div className={css.card}>
                <span className={css.cardName}>{table.names[hover] ?? table.ids[hover]}</span>
                <span className={css.cardStat}>{fmt(frame.starts[hover])} starts · {fmt(frame.ends[hover])} ends · net {frame.starts[hover] - frame.ends[hover] >= 0 ? '+' : ''}{fmt(frame.starts[hover] - frame.ends[hover])}</span>
                <span className={css.cardHint}>click to pin</span>
              </div>
            )}
          </div>
        )}
        {!table && <div className={css.loading}>Loading stations…</div>}
        {!mv && (
          <div className={css.controls}>
            <div className={css.row}>
              <div className={css.group}>
                <Tip content="Play / pause (space)">
                  <button type="button" className={css.btn} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
                    {playing ? '❚❚' : '▶'}
                  </button>
                </Tip>
                <Tip content={`Previous ${unit} (←; shift+← = ${big.label})`}>
                  <button type="button" className={css.btn} onClick={() => step(-1)} aria-label={`Previous ${unit}`}>◀</button>
                </Tip>
                <Tip content={`Next ${unit} (→; shift+→ = ${big.label})`}>
                  <button type="button" className={css.btn} onClick={() => step(1)} aria-label={`Next ${unit}`}>▶</button>
                </Tip>
              </div>
              <RangePicker
                bin={bin}
                range={range}
                lastDay={lastDay}
                tDay={dayOf(frameStartMs(bin, floor(t)))}
                onEdit={setRangeEdit}
                onSpan={applySpan}
              />
              <Tip content="Bin: time per frame (b = coarser, shift+b = finer)">
                <label className={css.field}>
                  <span className={css.fieldLabel}>bin</span>
                  <select className={css.select} value={bin} onChange={(e) => changeBin(e.target.value as Bin)} aria-label="Bin">
                    {BINS.map((b) => <option key={b} value={b}>{BIN_LABEL[b]}</option>)}
                  </select>
                </label>
              </Tip>
              <Tip content={`Playback speed: ${sp} frame${sp === 1 ? '' : 's'}/s ([ slower, ] faster)`}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>speed</span>
                  <select className={css.select} value={sp} onChange={(e) => setSp(Number(e.target.value))} aria-label="Speed">
                    {(SPEEDS.includes(sp) ? SPEEDS : [...SPEEDS, sp].sort((a, b) => a - b)).map((v) => (
                      <option key={v} value={v}>{speedLabel(bin, v)}</option>
                    ))}
                  </select>
                </label>
              </Tip>
              <Tip content="Style preset (s)">
                <label className={css.field}>
                  <span className={css.fieldLabel}>style</span>
                  <select className={css.select} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Style">
                    {PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
                  </select>
                </label>
              </Tip>
              <Tip content="Loop at the end of the range (l)">
                <label className={css.check}>
                  <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
                </label>
              </Tip>
              {suggested && suggested !== bin && (
                <Tip content={`${fmt(nFramesRange)} frames at ${BIN_LABEL[bin]}: long to load and play. Switch to ${BIN_LABEL[suggested]} bins?`}>
                  <button type="button" className={`${css.btn} ${css.hint}`} onClick={() => changeBin(suggested)} data-testid="tl-suggest-bin">
                    {fmt(nFramesRange)} frames · use {suggested}
                  </button>
                </Tip>
              )}
              {capNote && <span className={css.note} data-testid="tl-cap-note">{capNote}</span>}
            </div>
            <div className={css.row}>
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
            </div>
          </div>
        )}
      </GLMap>
    </div>
  )
}

/** The preset's color key + the shared size note. */
function Legend({ preset, unit, note }: { preset: Preset; unit: string; note: string }) {
  return (
    <div className={css.legend} data-testid="tl-legend">
      <div className={css.legendTitle}>Rides per {unit}, by station · {PRESET_LABEL[preset]}</div>
      {preset === 'flow' && <>
        <div className={css.legendBar} style={{ background: `linear-gradient(to right, ${rgbCss(COOL)}, ${rgbCss(NEUTRAL)}, ${rgbCss(WARM)})` }} />
        <div className={css.legendLabels}>
          <span>net arrivals</span>
          <span>balanced</span>
          <span>net departures</span>
        </div>
      </>}
      {preset === 'act' && <>
        <div className={css.legendBar} style={{ background: ACT_GRADIENT, opacity: ACT.alpha / 255 + 0.2 }} />
        <div className={css.legendLabels}>
          <span>quiet</span>
          <span>busy (overlaps glow)</span>
        </div>
      </>}
      {preset === 'split' && (
        <div className={css.legendGlyphs}>
          <span><svg width={14} height={14}><circle cx={7} cy={7} r={6} fill={rgbCss(WARM, SPLIT.alpha / 255)} /></svg> starts (disk)</span>
          <span><svg width={14} height={14}><circle cx={7} cy={7} r={5.5} fill="none" stroke={rgbCss(COOL)} strokeWidth={SPLIT.ringWidth} /></svg> ends (ring)</span>
        </div>
      )}
      <div className={css.legendNote}>{note}; faint dot = no rides that {unit}</div>
    </div>
  )
}

/** A pinned station: current-frame stats + a sparkline of starts + ends over
 *  the range from whatever chunks are cached (gaps where they aren't). */
function PinCard({ src, bin, id, name, starts, ends, iStart, iEnd, i, onUnpin }: {
  src: SourceMode
  bin: Bin
  id: string
  name: string | undefined
  starts: number
  ends: number
  iStart: number
  iEnd: number
  i: number
  onUnpin: () => void
}) {
  const series = useTlStationSeries(src, bin, id, iStart, iEnd)
  const W = 240
  const H = 36
  const path = useMemo(() => sparkPath(series, W, H), [series])
  const n = series.length
  const x = n ? ((i - iStart + 0.5) / n) * W : 0
  const fmt = (v: number) => round(v).toLocaleString('en-US')
  return (
    <div className={`${css.card} ${css.cardPinned}`} data-testid="tl-pin">
      <span className={css.cardName}>
        {name ?? id}
        <button type="button" className={css.unpin} onClick={onUnpin} aria-label={`Unpin ${name ?? id}`} title="Unpin (esc clears all)">×</button>
      </span>
      <span className={css.cardStat}>{fmt(starts)} starts · {fmt(ends)} ends · net {starts - ends >= 0 ? '+' : ''}{fmt(starts - ends)}</span>
      <svg className={css.spark} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {path && <path d={path} fill="none" stroke={rgbCss(PIN_RGB)} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        <line x1={x} x2={x} y1={0} y2={H} stroke="rgba(255,255,255,0.6)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
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
