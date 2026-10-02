import { useEffect, useRef, useState } from 'react'
import { OVERLAY } from '@shared/constants'
import { Pill } from './components/Pill'
import { Panel } from './components/Panel'
import { getCapture, useCaptureLifecycle } from './hooks/useCapture'
import { useLiveSync } from './hooks/useLiveSync'
import { useOverlayKeys } from './hooks/useOverlayKeys'
import { useWindowFit } from './hooks/useWindowFit'
import { useUi } from './stores/uiStore'

/** Preferred panel height; Cluely-like tall card with room for a few answers. */
const PANEL_HEIGHT = 500
/** Pill, gaps and shadow room around the panel inside the transparent window. */
const CHROME_HEIGHT = 8 + 44 + 8 + 16

/**
 * Fixed panel height (not content-driven) so streaming never resizes the window or moves the
 * input. Shrinks on short screens so the overlay never covers most of the display.
 */
function panelHeight(): number {
  const maxForWindow = OVERLAY.maxExpandedHeight - CHROME_HEIGHT
  const avail = typeof window !== 'undefined' ? window.screen.availHeight : 1000
  const maxForScreen = Math.round(avail * 0.72) - CHROME_HEIGHT
  return Math.max(320, Math.min(PANEL_HEIGHT, maxForWindow, maxForScreen))
}

/** Keeps the panel mounted while its exit animation runs. */
function usePanelPresence(expanded: boolean) {
  const [mounted, setMounted] = useState(expanded)
  const [prevExpanded, setPrevExpanded] = useState(expanded)
  if (expanded !== prevExpanded) {
    setPrevExpanded(expanded)
    if (expanded) setMounted(true)
  }
  const closing = mounted && !expanded
  useEffect(() => {
    if (!closing) return
    // Fallback in case animationend never fires (e.g. the window is hidden mid-animation).
    const timer = setTimeout(() => setMounted(false), 260)
    return () => clearTimeout(timer)
  }, [closing])
  return { mounted, closing, onExited: () => setMounted(false) }
}

/**
 * Overlay root. The window is transparent: only the pill and the panel paint, the rest of
 * the window lets clicks through (see useWindowFit).
 */
export function App() {
  const rootRef = useRef<HTMLDivElement>(null)
  const capture = getCapture()
  const expanded = useUi((s) => s.expanded)
  const panel = usePanelPresence(expanded)
  const [height] = useState(panelHeight)

  useLiveSync()
  useCaptureLifecycle(capture)
  useOverlayKeys()
  useWindowFit(rootRef)

  return (
    <div ref={rootRef} className="flex w-full flex-col items-center px-5 pt-2 pb-4">
      <Pill capture={capture} />
      {panel.mounted ? (
        <Panel height={height} closing={panel.closing} onExited={panel.onExited} />
      ) : null}
    </div>
  )
}
