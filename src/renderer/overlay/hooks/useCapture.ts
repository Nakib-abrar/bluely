import { useEffect } from 'react'
import { invoke } from '../../lib/ipc'
import { useSettings } from '../../stores/settings'
import { createCapture, type CaptureLike } from '../capture'
import { useLive } from '../stores/liveStore'

let instance: CaptureLike | null = null
/** Session the capture was last started for (module scope: survives StrictMode remounts). */
let startedFor: string | null = null
let queue: Promise<void> = Promise.resolve()

/** The overlay's single capture instance (created lazily, shared by the pill meters). */
export function getCapture(): CaptureLike {
  instance ??= createCapture()
  return instance
}

/**
 * Starts capture when a session is starting/live and stops it when main says the session
 * is stopping (or is already over). Calls are serialized so a quick stop → start for a new
 * session never overlaps.
 */
export function useCaptureLifecycle(capture: CaptureLike = getCapture()): void {
  const status = useLive((s) => s.state.status)
  const sessionId = useLive((s) => s.state.sessionId)

  useEffect(() => {
    const wantsCapture = (status === 'starting' || status === 'live') && !!sessionId
    if (wantsCapture && sessionId) {
      if (startedFor === sessionId) return
      const previous = startedFor
      startedFor = sessionId
      const { audio, advanced } = useSettings.getState().settings
      enqueue(async () => {
        if (previous && capture.running) await capture.stop()
        await capture.start({
          sessionId,
          micDeviceId: audio.micDeviceId,
          sensitivity: advanced.vadSensitivity,
          maxSegmentSec: advanced.maxSegmentSec,
        })
      }, 'start')
      return
    }
    if (status === 'stopping' || status === 'processing' || status === 'idle') {
      // Only stop what this overlay started (a stop may already be in flight).
      if (!startedFor) return
      startedFor = null
      enqueue(() => capture.stop(), 'stop')
    }
  }, [status, sessionId, capture])
}

function enqueue(task: () => Promise<void>, what: string): void {
  queue = queue.then(task).catch((err: unknown) => {
    invoke('app:rendererLog', {
      level: 'error',
      message: `overlay: capture ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => undefined)
  })
}
