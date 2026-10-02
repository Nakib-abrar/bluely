/**
 * Silero VAD (v5, ONNX via onnxruntime-web WASM) wrapped in vad-web's FrameProcessor, plus
 * the max-segment-length cap. Runs in the renderer that captures audio.
 *
 * Model/runtime loading happens once per page (shared promise). Each channel gets its own
 * Silero instance because the model is recurrent (stateful); only the ONNX bytes are shared.
 */
import * as ort from 'onnxruntime-web/wasm'
import {
  FrameProcessor,
  type FrameProcessorEvent,
  type FrameProcessorOptions,
} from '@ricky0123/vad-web/dist/frame-processor'
import { Message } from '@ricky0123/vad-web/dist/messages'
import { Silero } from '@ricky0123/vad-web/dist/models/silero'
import type { Model } from '@ricky0123/vad-web/dist/models/common'
import { dbfsToRms, rms } from './goertzel'
import { FRAME_MS, shouldForceCut } from './segmenter'

export interface SileroVadOptions {
  /** 0 = least sensitive, 1 = most sensitive (Settings › Advanced). */
  sensitivity: number
  /** Continuous speech longer than this is cut into a forced segment. */
  maxSegmentMs: number
  onSpeechStart(): void
  /** `audio` is 16 kHz mono and includes ~200 ms of pre-speech padding. */
  onSpeechEnd(audio: Float32Array, info: { forced: boolean }): void
  /** Speech started but was shorter than minSpeechMs (a cough, a click). */
  onMisfire?(): void
  /** Speech probability of every processed frame (0 for gated silent frames). */
  onFrame?(probability: number): void
  /**
   * Frames quieter than this (dBFS RMS) are scored as non-speech without running the model
   * while nobody is speaking. Default −70 dBFS: only (near-)digital silence, e.g. a call app
   * outputting nothing, so real speech is never skipped. null disables the gate.
   */
  silenceGateDbfs?: number | null
}

/** Counters for diagnostics and CPU accounting. */
export interface SileroVadStats {
  frames: number
  /** Frames that actually ran the ONNX model (the rest were gated as silence). */
  inferences: number
}

export interface SileroVad {
  /** True between speech start and its end/misfire. */
  readonly speaking: boolean
  readonly stats: SileroVadStats
  /** Feeds one 512-sample frame. Await each call before the next (the model is sequential). */
  process(frame: Float32Array): Promise<void>
  /** Ends the current segment now (emits onSpeechEnd if there was enough speech). */
  flush(): void
  setSensitivity(sensitivity: number): void
  setMaxSegmentMs(maxSegmentMs: number): void
  /** Releases the ONNX session. The instance is unusable afterwards. */
  dispose(): Promise<void>
}

/** How the VAD finds its model and configures onnxruntime-web. Swappable for tests. */
export interface VadRuntime {
  fetchModel(): Promise<ArrayBuffer>
  configureOrt(env: typeof ort.env): void
}

/** Production runtime: assets are served next to the renderer under /vad/ (see copy-vad-assets). */
const browserRuntime: VadRuntime = {
  async fetchModel() {
    const response = await fetch(new URL('/vad/silero_vad_v5.onnx', location.href).href)
    if (!response.ok) throw new Error(`Could not load the VAD model (HTTP ${response.status})`)
    return response.arrayBuffer()
  },
  configureOrt(env) {
    // Load ort-wasm-simd-threaded.{mjs,wasm} from our own origin (CSP: no CDNs).
    env.wasm.wasmPaths = new URL('/vad/', location.href).href
    // Renderers are not cross-origin isolated (no SharedArrayBuffer), so no WASM threads;
    // Silero needs well under a millisecond per frame anyway.
    env.wasm.numThreads = 1
    env.wasm.proxy = false
    env.logLevel = 'error'
  },
}

let runtime: VadRuntime = browserRuntime
let modelPromise: Promise<ArrayBuffer> | null = null

/** Replaces how the model is fetched / ORT is configured (tests, the dev harness). */
export function configureVadRuntime(next: VadRuntime): void {
  runtime = next
  modelPromise = null
}

/** Loads the ONNX bytes once per page; later calls share the same promise. */
export function loadVadModel(): Promise<ArrayBuffer> {
  if (!modelPromise) {
    const promise = (async () => {
      runtime.configureOrt(ort.env)
      return runtime.fetchModel()
    })()
    modelPromise = promise
    // A failed load (e.g. a transient fetch error) must not poison every later session.
    promise.catch(() => {
      if (modelPromise === promise) modelPromise = null
    })
  }
  return modelPromise
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.min(1, Math.max(0, v))
}

/**
 * Sensitivity (0..1) → FrameProcessor options. Higher sensitivity lowers the speech
 * threshold: 0 → 0.70, 0.5 → 0.50, 1 → 0.30; the end threshold sits 0.15 below it (Silero's
 * recommended hysteresis). 400 ms of silence ends a phrase, which keeps transcript lines
 * live (they land ~0.5–1.5 s after the speaker pauses).
 */
export function vadOptionsForSensitivity(sensitivity: number): FrameProcessorOptions {
  const positive = 0.7 - 0.4 * clamp01(sensitivity)
  return {
    positiveSpeechThreshold: positive,
    negativeSpeechThreshold: Math.max(0.01, positive - 0.15),
    redemptionMs: 400,
    preSpeechPadMs: 200,
    minSpeechMs: 250,
    submitUserSpeechOnPause: false,
  }
}

/** Creates a VAD instance for one channel (loads the shared model on first use). */
export async function createSileroVad(opts: SileroVadOptions): Promise<SileroVad> {
  const bytes = await loadVadModel()
  // ORT may take ownership of the buffer it is given, so every session gets its own copy.
  const model = await Silero.new(ort, async () => bytes.slice(0))
  return new SileroVadImpl(model, opts)
}

/** Model result used for gated (silent) frames. */
const SILENT_FRAME = { isSpeech: 0, notSpeech: 1 } as const
/** After this many gated frames (~256 ms) the recurrent state is reset before the next run. */
const GATED_RESET_FRAMES = 8

class SileroVadImpl implements SileroVad {
  readonly stats: SileroVadStats = { frames: 0, inferences: 0 }
  private readonly processor: FrameProcessor
  private readonly gateRms: number
  private gatedRun = 0
  private maxSegmentMs: number
  /** Set while force-cutting: the speaker is still talking, so keep Silero's recurrent state. */
  private keepModelState = false
  private forcing = false
  private lastProbability = 0
  private disposed = false
  private inflight: Promise<void> | null = null

  constructor(
    private readonly model: Model,
    private readonly opts: SileroVadOptions,
  ) {
    this.maxSegmentMs = opts.maxSegmentMs
    const gate = opts.silenceGateDbfs === undefined ? -70 : opts.silenceGateDbfs
    this.gateRms = gate === null ? 0 : dbfsToRms(gate)
    this.processor = new FrameProcessor(
      (frame) => this.score(frame),
      () => {
        if (!this.keepModelState) model.reset_state()
      },
      vadOptionsForSensitivity(opts.sensitivity),
      FRAME_MS,
    )
    this.processor.resume()
  }

  get speaking(): boolean {
    return this.processor.speaking
  }

  /**
   * Runs Silero on a frame, except for (near-)silent frames between utterances: those are
   * certainly not speech, and skipping them is most of the VAD's idle CPU (one inference is
   * ~0.5 ms of WASM in Chromium per 32 ms frame per channel). After a long gated run the
   * recurrent state is reset, which is what Silero would converge to on silence anyway.
   */
  private score(frame: Float32Array): Promise<{ isSpeech: number; notSpeech: number }> {
    this.stats.frames++
    if (this.gateRms > 0 && !this.processor.speaking && rms(frame) < this.gateRms) {
      this.gatedRun++
      return Promise.resolve(SILENT_FRAME)
    }
    if (this.gatedRun >= GATED_RESET_FRAMES) this.model.reset_state()
    this.gatedRun = 0
    this.stats.inferences++
    return this.model.process(frame)
  }

  private readonly handleEvent = (event: FrameProcessorEvent): void => {
    switch (event.msg) {
      case Message.FrameProcessed:
        this.lastProbability = event.probs.isSpeech
        this.opts.onFrame?.(event.probs.isSpeech)
        break
      case Message.SpeechStart:
        this.opts.onSpeechStart()
        break
      case Message.SpeechEnd:
        this.opts.onSpeechEnd(event.audio, { forced: this.forcing })
        break
      case Message.VADMisfire:
        this.opts.onMisfire?.()
        break
      default:
        break
    }
  }

  async process(frame: Float32Array): Promise<void> {
    if (this.disposed) return
    const run = this.processor.process(frame, this.handleEvent)
    this.inflight = run
    try {
      await run
    } finally {
      this.inflight = null
    }
    if (this.disposed || !this.processor.speaking) return
    const cut = shouldForceCut(this.processor.audioBuffer.length, this.maxSegmentMs, {
      frameProb: this.lastProbability,
      pauseThreshold: this.processor.options.negativeSpeechThreshold,
    })
    if (cut) this.endSegment(true)
  }

  flush(): void {
    if (this.disposed) return
    this.endSegment(false)
  }

  private endSegment(forced: boolean): void {
    this.forcing = forced
    this.keepModelState = forced
    try {
      this.processor.endSegment(this.handleEvent)
    } finally {
      this.forcing = false
      this.keepModelState = false
    }
  }

  setSensitivity(sensitivity: number): void {
    this.processor.setOptions(vadOptionsForSensitivity(sensitivity))
  }

  setMaxSegmentMs(maxSegmentMs: number): void {
    this.maxSegmentMs = maxSegmentMs
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.inflight) await this.inflight.catch(() => undefined)
    this.processor.audioBuffer = []
    await this.model.release()
  }
}
