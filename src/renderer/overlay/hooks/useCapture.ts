import { useEffect } from 'react'
import type { Channel } from '@shared/types'
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
 * Applies audio settings changed during a call to the running capture: VAD sensitivity and
 * max segment length take effect at once, and a different microphone restarts only the Me
 * channel. Queued behind start/stop, so a change made while capture is starting still lands.
 * Returns an unsubscribe.
 */
export function watchCaptureSettings(capture: CaptureLike): () => void {
  return useSettings.subscribe((state, prev) => {
    const next = state.settings
    const before = prev.settings
    if (
      next.advanced.vadSensitivity !== before.advanced.vadSensitivity ||
      next.advanced.maxSegmentSec !== before.advanced.maxSegmentSec
    ) {
      const { vadSensitivity, maxSegmentSec } = next.advanced
      enqueue(async () => capture.update({ sensitivity: vadSensitivity, maxSegmentSec }), 'update')
    }
    if (next.audio.micDeviceId !== before.audio.micDeviceId) {
      const micDeviceId = next.audio.micDeviceId
      enqueue(() => capture.setMicDevice(micDeviceId), 'microphone switch')
    }
  })
}

/** Re-opens a failed channel (the warnings' Retry); a no-op when capture isn't running. */
export function retryCapture(channel: Channel, capture: CaptureLike = getCapture()): void {
  enqueue(() => capture.restartChannel(channel), 'retry')
}

/**
 * Starts capture when a session is starting/live and stops it when main says the session
 * is stopping (or is already over). Calls are serialized so a quick stop → start for a new
 * session never overlaps. Audio settings changed mid-session are applied as they change.
 */
export function useCaptureLifecycle(capture: CaptureLike = getCapture()): void {
  const status = useLive((s) => s.state.status)
  const sessionId = useLive((s) => s.state.sessionId)

  useEffect(() => watchCaptureSettings(capture), [capture])

  useEffect(() => {
    const wantsCapture = (status === 'starting' || status === 'live') && !!sessionId
    if (wantsCapture && sessionId) {
      if (startedFor === sessionId) return
      const previous = startedFor
      startedFor = sessionId
      enqueue(async () => {
        if (previous && capture.running) await capture.stop()
        // Read when the start actually runs, so settings changed meanwhile are used.
        const { audio, advanced } = useSettings.getState().settings
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

/**
 * Forwards "Them is speaking" transitions to main so auto-suggest waits while the other person
 * keeps talking (the capture snapshot already carries VAD speaking flags at ≤ 15 Hz).
 */
export function useSpeakingSignal(capture: CaptureLike = getCapture()): void {
  const sessionId = useLive((s) => s.state.sessionId)
  useEffect(() => {
    if (!sessionId) return
    let last = false
    const unsubscribe = capture.subscribe((levels) => {
      const speaking = levels.them.speaking
      if (speaking === last) return
      last = speaking
      void invoke('audio:speaking', { sessionId, channel: 'them', speaking }).catch(() => undefined)
    })
    return () => {
      unsubscribe()
      if (last)
        void invoke('audio:speaking', { sessionId, channel: 'them', speaking: false }).catch(
          () => undefined,
        )
    }
  }, [sessionId, capture])
}

function enqueue(task: () => Promise<void>, what: string): void {
  queue = queue.then(task).catch((err: unknown) => {
    invoke('app:rendererLog', {
      level: 'error',
      message: `overlay: capture ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => undefined)
  })
}
