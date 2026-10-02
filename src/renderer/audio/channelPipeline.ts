/**
 * One capture channel end to end: AudioSource → AudioContext + capture worklet (16 kHz
 * frames) → Silero VAD → speech segments with epoch timestamps.
 *
 * Frames are fed to the VAD strictly in order, one inference at a time. If inference falls
 * more than ~2 s behind, the oldest queued frames are dropped instead of letting memory and
 * latency grow without bound.
 */
import type { Channel, ChannelState } from '@shared/types'
import {
  openCaptureGraph,
  type CaptureGraph,
  type CaptureGraphHandlers,
  type CaptureStartedInfo,
} from './captureGraph'
import { FrameIndexHistory, FrameQueue } from './frameQueue'
import { FRAME_MS, FRAME_SAMPLES, SegmentClock } from './segmenter'
import { AudioSourceError, type AudioSource } from './sources'
import { createSileroVad, type SileroVad, type SileroVadOptions } from './vad'

export interface PipelineSegment {
  channel: Channel
  /** Epoch ms of the first sample (includes ~200 ms of pre-speech padding). */
  startedAt: number
  /** Epoch ms just after the last sample. */
  endedAt: number
  /** Epoch ms when the VAD decided the segment ended (latency tracing). */
  vadEndAt: number
  /** Cut by the max-length cap rather than a pause. */
  forced: boolean
  /** 16 kHz mono samples. */
  samples: Float32Array
}

export type PipelineLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ChannelPipelineOptions {
  channel: Channel
  source: AudioSource
  /** VAD sensitivity 0..1. */
  sensitivity: number
  maxSegmentMs: number
  onSegment(segment: PipelineSegment): void
  /** RMS of every 32 ms frame (~31 Hz). */
  onLevel(rms: number): void
  onSpeaking(speaking: boolean): void
  onStatus(state: ChannelState, error: AudioSourceError | null): void
  /** Microphone track muted/unmuted by the OS or hardware (mic sources only). */
  onMuted?(muted: boolean): void
  onLog?(level: PipelineLogLevel, message: string): void
  /** Test seams; default to the real implementations. */
  createVad?: (opts: SileroVadOptions) => Promise<SileroVad>
  openGraph?: (stream: MediaStream, handlers: CaptureGraphHandlers) => Promise<CaptureGraph>
  now?: () => number
}

/** Frames allowed to wait for the VAD (~2 s) before the oldest are dropped. */
export const MAX_QUEUED_FRAMES = Math.ceil(2000 / FRAME_MS)
/** Enough frame indices to cover the longest allowed segment (30 s) plus padding. */
const HISTORY_FRAMES = Math.ceil(35_000 / FRAME_MS)
/** Re-anchor the sample clock to wall time about every 30 s. */
const REANCHOR_EVERY_FRAMES = Math.round(30_000 / FRAME_MS)
/** Consecutive inference failures after which the channel is reported as broken. */
const MAX_CONSECUTIVE_VAD_ERRORS = 30

class StartCancelled extends Error {}

/**
 * Single-use: `start()` once, `stop()` once (create a new pipeline for the next session).
 * Status transitions: off → starting → listening → off, or → error (start failure, device
 * unplugged, loopback ended) and then → off when stopped.
 */
export class ChannelPipeline {
  readonly channel: Channel
  private readonly opts: ChannelPipelineOptions
  private readonly now: () => number
  private currentState: ChannelState = 'off'
  private graph: CaptureGraph | null = null
  private vad: SileroVad | null = null
  private vadPromise: Promise<SileroVad> | null = null
  private clock: SegmentClock | null = null
  private readonly queue = new FrameQueue(MAX_QUEUED_FRAMES)
  private readonly history = new FrameIndexHistory(HISTORY_FRAMES)
  private draining = false
  private drainDone: Promise<void> = Promise.resolve()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private teardownPromise: Promise<void> | null = null
  private stopRequested = false
  private failure: AudioSourceError | null = null
  private speaking = false
  private muted = false
  private consecutiveVadErrors = 0
  private droppedSinceLog = 0
  private lastDropLogAt = 0
  private detachTrack: (() => void) | null = null

  constructor(opts: ChannelPipelineOptions) {
    this.opts = opts
    this.channel = opts.channel
    this.now = opts.now ?? Date.now
  }

  get state(): ChannelState {
    return this.currentState
  }

  /** Total frames dropped because the VAD fell behind. */
  get droppedFrames(): number {
    return this.queue.droppedCount
  }

  /** Opens the source and starts listening. Rejects with AudioSourceError on failure. */
  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart()
    return this.startPromise
  }

  /**
   * Stops capture. With `flush` (default) audio already captured is still run through the
   * VAD and trailing speech is emitted as a final segment before this resolves.
   */
  stop(opts: { flush?: boolean } = {}): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        this.stopRequested = true
        if (this.startPromise) await this.startPromise.catch(() => undefined)
        await this.teardown(opts.flush ?? true)
        this.setState('off', null)
      })()
    }
    return this.stopPromise
  }

  setSensitivity(sensitivity: number): void {
    this.opts.sensitivity = sensitivity
    this.vad?.setSensitivity(sensitivity)
  }

  setMaxSegmentMs(maxSegmentMs: number): void {
    this.opts.maxSegmentMs = maxSegmentMs
    this.vad?.setMaxSegmentMs(maxSegmentMs)
  }

  // ── start / stop ──────────────────────────────────────────────────────────

  private async doStart(): Promise<void> {
    this.setState('starting', null)
    // Load the model while the device opens; both take a few hundred ms on first use.
    const createVad = this.opts.createVad ?? createSileroVad
    const vadPromise = createVad(this.vadOptions())
    this.vadPromise = vadPromise
    vadPromise.catch(() => undefined) // observed below; avoid an unhandled rejection meanwhile
    try {
      const stream = await this.opts.source.start()
      if (this.cancelled()) {
        this.opts.source.stop()
        throw new StartCancelled()
      }
      this.attachTrack(stream)
      const openGraph = this.opts.openGraph ?? openCaptureGraph
      const graph = await openGraph(stream, {
        onFrame: (frame, rms, index) => this.onFrame(frame, rms, index),
        onStarted: (info) => this.onStarted(info),
      })
      if (this.cancelled()) {
        await graph.close()
        throw new StartCancelled()
      }
      this.graph = graph
      let vad: SileroVad
      try {
        vad = await vadPromise
      } catch (err) {
        throw new AudioSourceError('unknown', `Voice detection failed to load: ${describe(err)}`, {
          cause: err,
        })
      }
      if (this.cancelled()) throw new StartCancelled()
      this.vad = vad
      this.kick() // frames captured while the model was loading
      this.setState('listening', null)
    } catch (err) {
      await this.teardown(false)
      if (err instanceof StartCancelled) {
        // Stopped during start → resolve quietly; failed during start → report that failure.
        if (this.failure && !this.stopRequested) throw this.failure
        return
      }
      const error =
        err instanceof AudioSourceError
          ? err
          : new AudioSourceError('unknown', `Audio capture failed: ${describe(err)}`, {
              cause: err,
            })
      this.setState('error', error)
      throw error
    }
  }

  /** True once stop() was called or a runtime failure tore the channel down. */
  private cancelled(): boolean {
    return this.stopRequested || this.teardownPromise !== null
  }

  /** Runtime failure (device unplugged, loopback ended, VAD broken): flush, then error. */
  private async fail(error: AudioSourceError): Promise<void> {
    if (this.stopRequested || this.teardownPromise) return
    this.failure = error
    this.log('warn', `${this.channel} channel failed: ${error.code} ${error.message}`)
    await this.teardown(true)
    if (!this.stopRequested) this.setState('error', error)
  }

  private teardown(flush: boolean): Promise<void> {
    if (!this.teardownPromise) this.teardownPromise = this.doTeardown(flush)
    return this.teardownPromise
  }

  private async doTeardown(flush: boolean): Promise<void> {
    this.detachTrack?.()
    this.detachTrack = null
    this.opts.source.stop()
    const graph = this.graph
    this.graph = null
    if (graph) await graph.close()

    // No more frames can arrive. Let the queued ones reach the VAD, then emit what is left.
    let vad = this.vad
    if (vad) {
      while (this.draining) await this.drainDone
      if (flush) {
        try {
          vad.flush()
        } catch (err) {
          this.log('warn', `VAD flush failed: ${describe(err)}`)
        }
      }
    } else if (this.vadPromise) {
      vad = await this.vadPromise.catch(() => null)
    }
    this.vad = null
    if (vad) await vad.dispose().catch((err) => this.log('warn', `VAD dispose: ${describe(err)}`))
    this.queue.clear()
    this.setSpeaking(false)
    this.setMuted(false)
    if (this.queue.droppedCount > 0) {
      this.log('warn', `${this.channel}: ${this.queue.droppedCount} frames dropped (VAD behind)`)
    }
  }

  private attachTrack(stream: MediaStream): void {
    const track = stream.getAudioTracks()[0]
    if (!track) return
    const isMic = this.opts.source.kind === 'mic'
    const onEnded = () => {
      const error = isMic
        ? new AudioSourceError('mic_not_found', 'The microphone was disconnected')
        : new AudioSourceError('loopback_unavailable', 'System audio capture ended')
      void this.fail(error)
    }
    const onMute = () => this.setMuted(true)
    const onUnmute = () => this.setMuted(false)
    track.addEventListener('ended', onEnded)
    if (isMic) {
      track.addEventListener('mute', onMute)
      track.addEventListener('unmute', onUnmute)
      if (track.muted) this.setMuted(true)
    }
    this.detachTrack = () => {
      track.removeEventListener('ended', onEnded)
      track.removeEventListener('mute', onMute)
      track.removeEventListener('unmute', onUnmute)
    }
  }

  // ── frames → VAD ──────────────────────────────────────────────────────────

  private onStarted(info: CaptureStartedInfo): void {
    // The worklet stamped its first quantum with AudioContext time; anchor that clock to
    // wall time (refined periodically in onFrame).
    this.clock = new SegmentClock({
      firstSampleContextTime: info.contextTime,
      anchorEpochMs: info.anchor.epochMs,
      anchorContextTime: info.anchor.contextTime,
    })
  }

  private onFrame(frame: Float32Array, rms: number, index: number): void {
    if (this.teardownPromise) return
    if (!this.clock) {
      // 'started' always precedes frames; this is only a safety net.
      this.clock = SegmentClock.fromEpoch(this.now() - (index + 1) * FRAME_MS)
    } else if (index > 0 && index % REANCHOR_EVERY_FRAMES === 0 && this.graph) {
      const ts = this.graph.timestamp()
      this.clock.reanchor(ts.epochMs, ts.contextTime, 0.2)
    }
    this.opts.onLevel(rms)
    if (this.queue.push(frame, index)) this.noteDropped()
    this.kick()
  }

  private noteDropped(): void {
    this.droppedSinceLog++
    const now = this.now()
    if (now - this.lastDropLogAt >= 10_000) {
      this.log('warn', `${this.channel}: VAD fell behind, dropped ${this.droppedSinceLog} frames`)
      this.lastDropLogAt = now
      this.droppedSinceLog = 0
    }
  }

  private kick(): void {
    if (this.draining || !this.vad) return
    this.draining = true
    this.drainDone = this.drain(this.vad)
  }

  private async drain(vad: SileroVad): Promise<void> {
    for (;;) {
      const frame = this.queue.shift()
      if (!frame) {
        // Cleared in the same tick as the empty check, so a frame arriving later re-kicks.
        this.draining = false
        return
      }
      this.history.push(this.queue.lastShiftedIndex)
      try {
        await vad.process(frame)
        this.consecutiveVadErrors = 0
      } catch (err) {
        this.consecutiveVadErrors++
        this.log('warn', `VAD inference failed: ${describe(err)}`)
        if (this.consecutiveVadErrors >= MAX_CONSECUTIVE_VAD_ERRORS) {
          this.draining = false
          void this.fail(new AudioSourceError('unknown', 'Voice detection stopped working'))
          return
        }
      }
    }
  }

  private vadOptions(): SileroVadOptions {
    return {
      sensitivity: this.opts.sensitivity,
      maxSegmentMs: this.opts.maxSegmentMs,
      onSpeechStart: () => this.setSpeaking(true),
      onSpeechEnd: (audio, info) => {
        this.setSpeaking(false)
        this.emitSegment(audio, info.forced)
      },
      onMisfire: () => this.setSpeaking(false),
    }
  }

  private emitSegment(samples: Float32Array, forced: boolean): void {
    if (samples.length === 0) return
    const vadEndAt = this.now()
    const frames = Math.max(1, Math.round(samples.length / FRAME_SAMPLES))
    const last = this.history.fromEnd(1)
    const first = this.history.fromEnd(frames)
    let startedAt: number
    let endedAt: number
    if (this.clock && last >= 0) {
      ;({ startedAt, endedAt } = this.clock.span(first, last))
    } else {
      endedAt = vadEndAt
      startedAt = endedAt - frames * FRAME_MS
    }
    try {
      this.opts.onSegment({ channel: this.channel, startedAt, endedAt, vadEndAt, forced, samples })
    } catch (err) {
      this.log('error', `onSegment threw: ${describe(err)}`)
    }
  }

  // ── state helpers ─────────────────────────────────────────────────────────

  private setState(state: ChannelState, error: AudioSourceError | null): void {
    if (state === this.currentState && error === null) return
    this.currentState = state
    this.opts.onStatus(state, error)
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return
    this.speaking = speaking
    this.opts.onSpeaking(speaking)
  }

  private setMuted(muted: boolean): void {
    if (muted === this.muted) return
    this.muted = muted
    this.opts.onMuted?.(muted)
  }

  private log(level: PipelineLogLevel, message: string): void {
    this.opts.onLog?.(level, message)
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}
