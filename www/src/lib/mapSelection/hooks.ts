/**
 * React glue for the shared map-selection model: `useSelection` holds the
 * `sel` ids (the caller's store: URL param or local state) plus the
 * session-local multi-select mode; `useSelectionGestures` turns native pointer
 * events on a MapLibre canvas container into `SelAction`s via the `gesture`
 * state machine.
 *
 * Listeners go on `map.getCanvasContainer()`, so anything rendered beside the
 * map (legends, panels, drawers: siblings of the MapLibre container) never
 * starts a gesture.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IDLE, LONG_PRESS_MS, step, type GestureEvent, type GestureState, type Pt, type Rect } from './gesture'
import { gestureSelAction, reduceSel, type SelAction, type SelState } from './selection'
import type { Map as MaplibreMapInstance } from 'maplibre-gl'

export interface Selection {
  ids: readonly string[]
  multi: boolean
  /** Reduce `a` into the selection; writes `ids` only when they change. */
  apply: (a: SelAction) => void
}

/** `ids` + `setIds` (e.g. a `use-prms` URL param; a `push: true` param makes
 *  every edit an undo step) → the selection with multi-select mode. */
export function useSelection(ids: readonly string[], setIds: (ids: string[]) => void): Selection {
  const [multi, setMulti] = useState(false)
  const ref = useRef<SelState>({ ids: [...ids], multi })
  ref.current = { ids: [...ids], multi }
  const apply = useCallback((a: SelAction) => {
    const s = ref.current
    const n = reduceSel(s, a)
    if (n.ids.length !== s.ids.length || n.ids.some((x, j) => x !== s.ids[j])) setIds(n.ids)
    if (n.multi !== s.multi) setMulti(n.multi)
    ref.current = n
  }, [setIds])
  // The set emptied from outside (history back, a panel's Clear): leave the mode.
  useEffect(() => { if (!ids.length && multi) setMulti(false) }, [ids, multi])
  return { ids, multi, apply }
}

export interface GestureHandlers {
  /** Station id under `at` (canvas-container px), or null. `touch`: pick
   *  with a finger-sized radius. */
  pickAt: (at: Pt, touch: boolean) => string | null
  /** Station ids inside `rect` (canvas-container px). */
  pickRect: (rect: Rect) => string[]
  apply: (a: SelAction) => void
}

/**
 * Tap / long-press / rectangle gestures on `map` → `apply(…)`. Returns the
 * in-progress drag rectangle (container px) for the caller to draw. Handlers
 * are read through a ref, so they may change every render. `enabled: false`
 * (e.g. movie mode) detaches everything.
 */
export function useSelectionGestures(
  map: MaplibreMapInstance | null,
  handlers: GestureHandlers,
  enabled = true,
): Rect | null {
  const [dragRect, setDragRect] = useState<Rect | null>(null)
  const h = useRef(handlers)
  h.current = handlers
  useEffect(() => {
    const m = map
    if (!m || !enabled) return
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
      const r = step(s, ev)
      s = r.s
      if (s.k !== 'press') clearTimeout(timer)
      for (const o of r.out) {
        switch (o.t) {
          case 'hold': m.dragPan.disable(); break
          case 'release': m.dragPan.enable(); break
          case 'longpress':
            fromLongPress = true
            navigator.vibrate?.(15)
            break
          case 'rect': setDragRect(o.rect); break
          case 'rectEnd': case 'rectCancel': setDragRect(null); break
        }
        const a = gestureSelAction(o, (at) => h.current.pickAt(at, touch), (rect) => h.current.pickRect(rect), fromLongPress)
        if (a) h.current.apply(a)
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
      setDragRect(null)
    }
  }, [map, enabled])
  return dragRect
}
