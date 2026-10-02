/**
 * Shape of `window.__bluelyHarness` (dev-only audio test page). Types only, so E2E specs can
 * import them without pulling renderer code into the test runner.
 */
import type { Channel, ChannelState } from '@shared/types'
import type { SystemAudioTestResult } from '../audio/systemAudioTest'

export interface HarnessSegment {
  channel: Channel
  startedAt: number
  endedAt: number
  vadEndAt: number
  forced: boolean
  /** endedAt − startedAt */
  durationMs: number
  /** Duration implied by the WAV's sample count. */
  audioMs: number
  wavBytes: number
  /** Header parsed back as 16 kHz mono PCM16 with a matching data size. */
  wavValid: boolean
  /** Peak absolute sample value. */
  peak: number
}

export interface HarnessCaptureResult {
  /** Me-channel segments (the microphone). */
  segments: HarnessSegment[]
  /** Segments from both channels, in arrival order. */
  allSegments: HarnessSegment[]
  statuses: { channel: Channel; state: ChannelState; error: string | null }[]
  warnings: { code: string; active: boolean }[]
  stoppedCalls: number
  snapshots: number
  elapsedMs: number
  /** Order of sink calls by kind, to check 'stopped' comes last. */
  callOrder: string[]
}

export interface HarnessFrameStats {
  frames: number
  seconds: number
  framesPerSecond: number
  contextSampleRate: number
  /** 'none' = capture-only AudioContext without an output device; 'default' = speakers. */
  sink: string
  inputSampleRate: number | null
  meanRms: number
}

export interface BluelyHarness {
  /** CaptureController with a recording sink (no IPC), both channels, for `seconds`. */
  runMicPipeline(seconds: number): Promise<HarnessCaptureResult>
  /** Same as runMicPipeline; kept separate for readability in specs that care about Them. */
  runCapture(seconds: number): Promise<HarnessCaptureResult>
  /** Raw capture graph cadence for the default mic (real-time check). */
  measureFrames(seconds: number): Promise<HarnessFrameStats>
  testSystemAudio(): Promise<SystemAudioTestResult>
  listMicrophones(): Promise<{ deviceId: string; label: string }[]>
  recordMicSample(
    seconds: number,
  ): Promise<{ durationMs: number; peakRms: number; wavBytes: number }>
  encodeWavSelfTest(): { ok: boolean; bytes: number; maxError: number }
  /** Sends real 'audio:segment' payloads through preload + zod validation in main. */
  ipcSegmentProbe(): Promise<{ valid: string; invalid: string }>
  /** getSettings() of a mic track and a loopback track (audio processing flags etc.). */
  trackSettings(): Promise<{
    mic: MediaTrackSettings | null
    loopback: MediaTrackSettings | null
    loopbackError: string | null
  }>
  /** Mean Silero inference time per 32 ms frame in this renderer. */
  vadBenchmark(frames: number): Promise<{ frames: number; msPerFrame: number }>
}

declare global {
  interface Window {
    __bluelyHarness?: BluelyHarness
  }
}
