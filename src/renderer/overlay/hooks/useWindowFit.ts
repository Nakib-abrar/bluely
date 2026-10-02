import { useEffect, type RefObject } from 'react'
import { OVERLAY } from '@shared/constants'
import { invoke } from '../../lib/ipc'
import { nextFrame } from '../lib/frame'

/** Elements that paint something the user can click: the pill, the panel and popovers. */
const HIT_SELECTOR = '[data-hit], [data-radix-popper-content-wrapper]'

/** True when the point is over painted overlay UI (as opposed to the transparent window). */
export function isHitTarget(el: Element | null): boolean {
  return !!el?.closest(HIT_SELECTOR)
}

/**
 * Click-through needs `setIgnoreMouseEvents(true, { forward: true })` to keep delivering
 * mouse moves; Electron only supports forwarding on Windows and macOS. Elsewhere the window
 * would never get the pointer back, so it stays clickable.
 */
function supportsClickThrough(): boolean {
  const platform = window.bluely?.platform
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Fits the transparent overlay window to its content and lets clicks on empty areas fall
 * through to the apps underneath.
 */
export function useWindowFit(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let queued = false
    let lastHeight = 0
    const report = () => {
      queued = false
      const height = Math.min(1400, Math.max(40, Math.ceil(el.getBoundingClientRect().height)))
      if (height === lastHeight) return
      lastHeight = height
      invoke('overlay:setContentSize', { width: OVERLAY.windowWidth, height }).catch(
        () => undefined,
      )
    }
    const ro = new ResizeObserver(() => {
      if (queued) return
      queued = true
      nextFrame(report)
    })
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [rootRef])

  useEffect(() => {
    if (!supportsClickThrough()) return
    let ignoring = false
    const apply = (ignore: boolean) => {
      if (ignore === ignoring) return
      ignoring = ignore
      invoke('overlay:setIgnoreMouse', { ignore }).catch(() => undefined)
    }
    const onMove = (e: MouseEvent) => {
      apply(!isHitTarget(document.elementFromPoint(e.clientX, e.clientY)))
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      apply(false)
    }
  }, [])
}
