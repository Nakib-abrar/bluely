/**
 * AudioWorkletProcessor 'bluely-capture': downmixes the input to mono, resamples it to
 * 16 kHz and posts 512-sample frames (Silero's frame size) with their RMS to the page.
 *
 * Runs on the real-time audio thread: every buffer is preallocated in the constructor. The
 * only per-frame allocation is the frame itself (2 KiB, ~31/s): its buffer is transferred to
 * the page (zero-copy) and the VAD keeps frames for the segment audio, so it cannot be reused.
 *
 * Loaded with `audioWorklet.addModule()` from a Vite `?worker&url` build of this file.
 */
import { AUDIO } from '@shared/constants'
import { Resampler, downmixInto } from '../resampler'
import {
  CAPTURE_PROCESSOR_NAME,
  type CaptureFrameMessage,
  type CaptureStartedMessage,
  type CaptureWorkletCommand,
} from './protocol'

// AudioWorkletGlobalScope members (TypeScript's DOM lib does not describe this scope).
declare const sampleRate: number
declare const currentTime: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void

const FRAME_SAMPLES = AUDIO.frameSamples
/** Render quantum size today; buffers grow if Chromium ever hands us larger blocks. */
const DEFAULT_QUANTUM = 128

export class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler: Resampler
  private mono: Float32Array
  private resampled: Float32Array
  private frame: Float32Array
  private fill = 0
  private sumSquares = 0
  private index = 0
  private started = false
  private stopped = false

  constructor(options?: unknown) {
    super(options)
    this.resampler = new Resampler(sampleRate, AUDIO.sampleRate)
    this.mono = new Float32Array(DEFAULT_QUANTUM)
    this.resampled = new Float32Array(this.resampler.maxOutputLength(DEFAULT_QUANTUM))
    this.frame = new Float32Array(FRAME_SAMPLES)
    this.port.onmessage = (event: MessageEvent<CaptureWorkletCommand>) => {
      if (event.data?.type === 'stop') this.stopped = true
    }
  }

  /** Called once per render quantum by the audio thread. Returning false ends the processor. */
  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const channels = inputs[0]
    // No channels: the source is not connected (yet) or has ended. Stay alive.
    if (!channels || channels.length === 0) return true
    const length = (channels[0] as Float32Array).length
    if (length === 0) return true
    if (length > this.mono.length) {
      this.mono = new Float32Array(length)
      this.resampled = new Float32Array(this.resampler.maxOutputLength(length))
    }

    if (!this.started) {
      this.started = true
      const started: CaptureStartedMessage = {
        type: 'started',
        contextTime: currentTime,
        inputSampleRate: sampleRate,
      }
      this.port.postMessage(started)
    }

    downmixInto(channels, this.mono, length)
    const count = this.resampler.processInto(this.mono, this.resampled, length)
    const out = this.resampled
    for (let i = 0; i < count; i++) {
      const s = out[i] as number
      this.frame[this.fill++] = s
      this.sumSquares += s * s
      if (this.fill === FRAME_SAMPLES) this.emitFrame()
    }
    return true
  }

  private emitFrame(): void {
    const frame = this.frame
    const message: CaptureFrameMessage = {
      type: 'frame',
      frame,
      rms: Math.sqrt(this.sumSquares / FRAME_SAMPLES),
      index: this.index++,
    }
    this.port.postMessage(message, [frame.buffer])
    this.frame = new Float32Array(FRAME_SAMPLES)
    this.fill = 0
    this.sumSquares = 0
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor)
}
