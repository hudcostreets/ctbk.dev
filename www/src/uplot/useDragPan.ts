/**
 * Drag-to-pan on a uPlot chart. uPlot has no built-in pan, so this attaches
 * mousedown/mousemove/mouseup listeners and live-shifts the x-scale during
 * the drag. The final position is committed to the caller's `onPan` on
 * mouseup (matching Plotly's `onRelayout`-after-drag behavior) — intermediate
 * URL/data updates would cause refetch flicker during the gesture.
 *
 * Designed to be reusable: this hook doesn't know about `TimeRange` or URL
 * state. Callers translate `(minS, maxS)` into their domain — e.g. "switch
 * to Latest mode when `maxS` is within N minutes of `now`".
 */
import { useEffect, useRef } from 'react'
import type uPlot from 'uplot'

export interface DragPanOptions {
  enabled?: boolean
  /** Called on mouseup with the new visible x-range (uPlot's scale units,
   *  typically unix seconds for time series). Not called if the drag distance
   *  was zero (i.e. a plain click). */
  onPan: (minS: number, maxS: number) => void
}

export function useDragPan(
  plotRef: React.MutableRefObject<uPlot | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  { enabled = true, onPan }: DragPanOptions,
): void {
  // Capture onPan in a ref so handler identity is stable across renders.
  const onPanRef = useRef(onPan)
  useEffect(() => { onPanRef.current = onPan }, [onPan])

  useEffect(() => {
    if (!enabled) return
    const container = containerRef.current
    if (!container) return

    let dragging = false
    let startPxX = 0
    let scaleMinAtStart = 0
    let scaleMaxAtStart = 0
    // Track last-set bounds in the hook's closure. If the plot is rebuilt
    // mid-drag (e.g. from a refetch updating the `rows` dep), `plot.scales.x`
    // resets — reading from it on mouseup would skip the commit. Our own
    // tracked values survive plot rebuilds.
    let currentMin = 0
    let currentMax = 0

    const isOverPlotArea = (e: MouseEvent): boolean => {
      const plot = plotRef.current
      if (!plot) return false
      const over = plot.over as HTMLElement | undefined
      if (!over) return false
      const rect = over.getBoundingClientRect()
      return (
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom
      )
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const plot = plotRef.current
      if (!plot) return
      if (!isOverPlotArea(e)) return
      const min = plot.scales.x.min
      const max = plot.scales.x.max
      if (min == null || max == null) return
      dragging = true
      startPxX = e.clientX
      scaleMinAtStart = min
      scaleMaxAtStart = max
      currentMin = min
      currentMax = max
      container.style.cursor = 'grabbing'
      e.preventDefault()
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const plot = plotRef.current
      if (!plot) return
      const bbox = plot.bbox
      if (!bbox.width) return
      // uPlot's bbox is in canvas pixels (devicePixelRatio-scaled); convert to CSS px.
      const plotPxWidth = bbox.width / devicePixelRatio
      const deltaPx = e.clientX - startPxX
      const scaleRange = scaleMaxAtStart - scaleMinAtStart
      const deltaScale = -(deltaPx / plotPxWidth) * scaleRange
      currentMin = scaleMinAtStart + deltaScale
      currentMax = scaleMaxAtStart + deltaScale
      plot.setScale('x', { min: currentMin, max: currentMax })
    }

    const onMouseUp = (_e: MouseEvent) => {
      if (!dragging) return
      dragging = false
      container.style.cursor = 'grab'
      // Skip no-op clicks where nothing moved.
      if (currentMin === scaleMinAtStart && currentMax === scaleMaxAtStart) return
      onPanRef.current(currentMin, currentMax)
    }

    container.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    container.style.cursor = 'grab'

    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      container.style.cursor = ''
    }
  }, [enabled, plotRef, containerRef])
}
