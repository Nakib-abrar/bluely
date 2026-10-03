import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverlayTab } from '../stores/uiStore'

/** Distance from the bottom (px) that still counts as "at the bottom". */
const STICK_THRESHOLD = 32
/** One Ctrl+Shift+↑/↓ press scrolls this much. */
const SCROLL_STEP = 160

const scrollers = new Map<OverlayTab, HTMLElement>()

/** Smooth scrolling unless the user asked for reduced motion (CSS can't reach JS scrolls). */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** Scrolls the list of the given tab (Ctrl+Shift+↑/↓ and the scroll command). */
export function scrollList(tab: OverlayTab, direction: 'up' | 'down'): void {
  scrollers
    .get(tab)
    ?.scrollBy({ top: direction === 'up' ? -SCROLL_STEP : SCROLL_STEP, behavior: scrollBehavior() })
}

/**
 * Chat-style scrolling: follows new content while the user is at the bottom, stays put
 * when they scrolled up (and reports that so a "Jump to latest" pill can show).
 */
export function useStickToBottom(tab: OverlayTab) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    scrollers.set(tab, el)
    let lastTop = el.scrollTop
    const distance = () => el.scrollHeight - el.scrollTop - el.clientHeight
    const unstick = () => {
      stick.current = false
      setAtBottom(distance() <= STICK_THRESHOLD)
    }
    const onScroll = () => {
      const top = el.scrollTop
      const movedUp = top < lastTop - 1
      lastTop = top
      if (distance() <= STICK_THRESHOLD) {
        stick.current = true
        setAtBottom(true)
      } else if (movedUp) {
        // Only an upward scroll means "the user is reading back": content that grows between
        // our scrollTop write and this (async) event also leaves us above the bottom.
        unstick()
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unstick()
    }
    const follow = () => {
      // The inactive tab is display:none: its 0-size box would look "at the bottom" and
      // re-stick, losing the user's read-back position when they switch back.
      if (el.clientHeight === 0) return
      if (stick.current) {
        // Instant, not smooth: streaming grows the content every frame.
        el.scrollTop = el.scrollHeight
        lastTop = el.scrollTop
      } else {
        // Content shrank (e.g. chat cleared) back to the bottom: follow again.
        const bottom = distance() <= STICK_THRESHOLD
        if (bottom) stick.current = true
        setAtBottom(bottom)
      }
    }
    const ro = new ResizeObserver(follow)
    ro.observe(content)
    ro.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      if (scrollers.get(tab) === el) scrollers.delete(tab)
    }
  }, [tab])

  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    // A smooth scroll only moves down, so it never trips the "moved up" check above.
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() })
  }, [])

  return { scrollRef, contentRef, atBottom, jumpToLatest }
}
