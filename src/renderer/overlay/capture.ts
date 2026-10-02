/**
 * Seam between the overlay UI and audio capture. The overlay only talks to capture through
 * `CaptureLike`; the implementation is the audio pipeline's CaptureController.
 */
import type { ChannelState } from '@shared/types'
import { CaptureController } from '../audio/captureController'

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

/** Real capture: microphone (Me) + desktop loopback (Them) → VAD → WAV segments to main. */
export function createCapture(): CaptureLike {
  return new CaptureController()
}
