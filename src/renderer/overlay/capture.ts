/**
 * Seam between the overlay UI and audio capture. The overlay only talks to capture through
 * `CaptureLike`; the implementation is the audio pipeline's CaptureController.
 */
import type { Channel, ChannelState } from '@shared/types'
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
  /** Applies new VAD settings to the running capture (no-op when not running). */
  update(opts: Partial<Pick<CaptureStartOptions, 'sensitivity' | 'maxSegmentSec'>>): void
  /** Switches the microphone mid-session; only Me restarts (no-op when unchanged). */
  setMicDevice(micDeviceId: string | null): Promise<void>
  /** Re-opens one channel now (Retry after a capture failure). */
  restartChannel(channel: Channel): Promise<void>
  /** Level updates for the pill's Me/Them indicator. Returns an unsubscribe function. */
  subscribe(cb: (levels: CaptureLevels) => void): () => void
}

/** Real capture: microphone (Me) + desktop loopback (Them) → VAD → WAV segments to main. */
export function createCapture(): CaptureLike {
  return new CaptureController()
}
