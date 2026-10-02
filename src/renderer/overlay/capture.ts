/**
 * Seam between the overlay UI and audio capture.
 *
 * The overlay only talks to capture through `CaptureLike`. Until the audio slice is wired
 * in, `createCapture()` returns a placeholder that captures nothing; the integrator swaps
 * it for `new CaptureController()` from '../audio/captureController'.
 */
import type { ChannelState } from '@shared/types'
import { invoke } from '../lib/ipc'

export interface ChannelLevel {
  /** Recent RMS level, 0..1. */
  rms: number
  /** True while VAD thinks this channel is speaking. */
  speaking: boolean
  state: ChannelState
}

export interface CaptureLevels {
  me: ChannelLevel
  them: ChannelLevel
}

export interface CaptureStartOptions {
  sessionId: string
  micDeviceId: string | null
  sensitivity: number
  maxSegmentSec: number
}

export interface CaptureLike {
  readonly running: boolean
  start(opts: CaptureStartOptions): Promise<void>
  /** Flushes pending audio and tells main via 'audio:stopped'. */
  stop(): Promise<void>
  /** Level updates for the pill's Me/Them indicator. Returns an unsubscribe function. */
  subscribe(cb: (levels: CaptureLevels) => void): () => void
}

/**
 * Placeholder capture: records nothing, but still completes the stop handshake so the
 * main process does not wait for audio that will never come.
 */
class PlaceholderCapture implements CaptureLike {
  private sessionId: string | null = null

  get running(): boolean {
    return this.sessionId !== null
  }

  async start(opts: CaptureStartOptions): Promise<void> {
    this.sessionId = opts.sessionId
  }

  async stop(): Promise<void> {
    const sessionId = this.sessionId
    this.sessionId = null
    if (sessionId) await invoke('audio:stopped', { sessionId }).catch(() => undefined)
  }

  subscribe(_cb: (levels: CaptureLevels) => void): () => void {
    return () => undefined
  }
}

/** Creates the overlay's audio capture. */
export function createCapture(): CaptureLike {
  return new PlaceholderCapture()
}
