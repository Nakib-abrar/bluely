/**
 * Segment timing and length-cap rules. Pure (no DOM), so they are unit-tested in Node.
 */
import { AUDIO } from '@shared/constants'

/** VAD/STT sample rate. */
export const VAD_SAMPLE_RATE = AUDIO.sampleRate
/** Samples per Silero frame at 16 kHz. */
export const FRAME_SAMPLES = AUDIO.frameSamples
/** Duration of one frame in milliseconds (32 ms). */
export const FRAME_MS = (FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000

/** Duration in ms of `sampleCount` samples at `sampleRate`. */
export function speechDurationMs(
  sampleCount: number,
  sampleRate: number = VAD_SAMPLE_RATE,
): number {
  return (sampleCount / sampleRate) * 1000
}

export interface ForceCutOptions {
  /**
   * Speech probability of the newest frame. When given, the cut may happen up to
   * `softWindowMs` early at a natural pause instead of in the middle of a word.
   */
  frameProb?: number
  /** Probability under which a frame counts as a pause (the VAD's negative threshold). */
  pauseThreshold?: number
  /** How far before the cap an early cut is allowed. Default: min(2 s, 25 % of the cap). */
  softWindowMs?: number
  msPerFrame?: number
}

/**
 * Max-length cap: true when a segment that already holds `speechFrames` frames must be cut
 * now, because one more frame would make it longer than `maxSegmentMs`. Segments therefore
 * never exceed the cap (12 s → at most 375 frames = 12.000 s), and continuous talkers still
 * get live transcript lines.
 */
export function shouldForceCut(
  speechFrames: number,
  maxSegmentMs: number,
  opts: ForceCutOptions = {},
): boolean {
  const msPerFrame = opts.msPerFrame ?? FRAME_MS
  const lengthMs = speechFrames * msPerFrame
  if (lengthMs + msPerFrame > maxSegmentMs) return true
  if (opts.frameProb === undefined) return false
  const softWindowMs = opts.softWindowMs ?? Math.min(2000, maxSegmentMs * 0.25)
  return lengthMs >= maxSegmentMs - softWindowMs && opts.frameProb < (opts.pauseThreshold ?? 0.35)
}

export interface SegmentClockOptions {
  /** AudioContext time (s) of the first 16 kHz sample the worklet produced. */
  firstSampleContextTime: number
  /** A simultaneous (epoch ms, AudioContext time s) pair that maps context time to wall time. */
  anchorEpochMs: number
  anchorContextTime: number
  sampleRate?: number
  frameSamples?: number
}

/**
 * Maps 16 kHz frame indices to epoch milliseconds.
 *
 * Frame indices count samples produced by the worklet, which advance exactly with the
 * AudioContext clock (every render quantum is resampled, silence included), so
 * `contextTime = firstSampleContextTime + sample / 16000`. Context time is mapped to wall
 * time with an anchor pair; `reanchor` lets the pipeline correct slow drift between the
 * audio device clock and the system clock during long calls.
 */
export class SegmentClock {
  private readonly firstSampleContextTime: number
  private readonly sampleRate: number
  private readonly frameSamples: number
  /** epochMs − contextTime × 1000 */
  private offsetMs: number

  constructor(opts: SegmentClockOptions) {
    this.firstSampleContextTime = opts.firstSampleContextTime
    this.sampleRate = opts.sampleRate ?? VAD_SAMPLE_RATE
    this.frameSamples = opts.frameSamples ?? FRAME_SAMPLES
    this.offsetMs = opts.anchorEpochMs - opts.anchorContextTime * 1000
  }

  /** A clock whose sample 0 is at `startEpochMs` (no AudioContext involved). */
  static fromEpoch(startEpochMs: number, sampleRate?: number, frameSamples?: number): SegmentClock {
    return new SegmentClock({
      firstSampleContextTime: 0,
      anchorEpochMs: startEpochMs,
      anchorContextTime: 0,
      ...(sampleRate !== undefined ? { sampleRate } : {}),
      ...(frameSamples !== undefined ? { frameSamples } : {}),
    })
  }

  /**
   * Moves the context-time → epoch mapping towards a fresh simultaneous pair. `weight` 1
   * replaces it; smaller weights low-pass the anchor so per-callback jitter in
   * AudioContext.currentTime does not make timestamps jump while slow drift is still followed.
   */
  reanchor(epochMs: number, contextTime: number, weight = 1): void {
    const target = epochMs - contextTime * 1000
    const w = Math.min(1, Math.max(0, weight))
    this.offsetMs += (target - this.offsetMs) * w
  }

  contextTimeOfSample(sampleIndex: number): number {
    return this.firstSampleContextTime + sampleIndex / this.sampleRate
  }

  epochMsOfContextTime(contextTime: number): number {
    return contextTime * 1000 + this.offsetMs
  }

  sampleToEpochMs(sampleIndex: number): number {
    return this.epochMsOfContextTime(this.contextTimeOfSample(sampleIndex))
  }

  /** Epoch ms of the first sample of frame `frameIndex`. */
  frameStartMs(frameIndex: number): number {
    return this.sampleToEpochMs(frameIndex * this.frameSamples)
  }

  /** Epoch ms just after the last sample of frame `frameIndex`. */
  frameEndMs(frameIndex: number): number {
    return this.sampleToEpochMs((frameIndex + 1) * this.frameSamples)
  }

  /** Start/end epoch ms of a segment spanning frames [firstFrame, lastFrame]. */
  span(firstFrame: number, lastFrame: number): { startedAt: number; endedAt: number } {
    return { startedAt: this.frameStartMs(firstFrame), endedAt: this.frameEndMs(lastFrame) }
  }
}
