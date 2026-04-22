import { useEffect, useRef, useState } from 'react'

/**
 * Watch `ref` with an `IntersectionObserver`. Once it enters the viewport
 * (or within `rootMargin`), `isInView` flips to `true` and stays there
 * — i.e., this is a one-shot "has ever been visible" signal, suitable
 * for triggering a lazy import that shouldn't be torn down on scroll-out.
 */
export function useIsInView<T extends Element>(rootMargin: string = '200px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null)
  const [isInView, setIsInView] = useState(false)

  useEffect(() => {
    if (isInView) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some(e => e.isIntersecting)) {
          setIsInView(true)
          io.disconnect()
        }
      },
      { rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [isInView, rootMargin])

  return [ref, isInView]
}
