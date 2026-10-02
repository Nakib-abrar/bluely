/**
 * Live-session audio capture for the renderer that hosts it (the overlay): runs the Me
 * (microphone) and Them (desktop loopback) channels, ships finished speech segments to main
 * as 16 kHz WAV, and reports channel status + session warnings over IPC.
 *
 * Main owns the session; this class only captures. Typical use:
 *   const capture = new CaptureController()
 *   await capture.start({ sessionId, micDeviceId, sensitivity, maxSegmentSec })
 *   const off = capture.subscribe((s) => render(s.me.rms, s.them.speaking))
 *   await capture.stop() // flushes trailing speech, awaits uploads, then 'audio:stopped'
 */
import type { InvokeRequest } from '@shared/ipc'
import type { Channel, ChannelState } from '@shared/types'
import { invoke } from '@renderer/lib/ipc'
import {
  ChannelPipeline,
  type ChannelPipelineOptions,
  type PipelineLogLevel,
  type PipelineSegment,
} from './channelPipeline'
import { DigitalSilenceDetector, NoSystemAudioDetector } from './silenceWatch'
import { AudioSourceError, LoopbackSource, MicSource, type AudioSource } from './sources'
import { encodeWav16 } from './wav'

export interface CaptureStartOptions {
  sessionId: string
  /** null = system default microphone. */
  micDeviceId: string | null
  /** VAD sensitivity 0..1 (settings.advanced.vadSensitivity). */
  sensitivity: number
  /** Max segment length in seconds (settings.advanced.maxSegmentSec, 4..30). */
  maxSegmentSec: number
}

export interface ChannelLevel {
  /** Peak frame RMS since the previous snapshot (linear, 1.0 = full scale). */
  rms: number
  speaking: boolean
  state: ChannelState
}

export interface CaptureSnapshot {
  me: ChannelLevel
  them: ChannelLevel
}

export type CaptureWarningCode = InvokeRequest<'audio:warning'>['code']

/** Where the controller sends its output. Defaults to the typed IPC channels. */
export interface CaptureSink {
  segment(req: InvokeRequest<'audio:segment'>): Promise<{ accepted: boolean }>
  channelStatus(req: InvokeRequest<'audio:channelStatus'>): Promise<void>
  warning(req: InvokeRequest<'audio:warning'>): Promise<void>
  stopped(req: InvokeRequest<'audio:stopped'>): Promise<void>
  log(level: PipelineLogLevel, message: string): void
}

/** The part of ChannelPipeline the controller uses (lets tests substitute fakes). */
export interface CapturePipeline {
  start(): Promise<void>
  stop(opts?: { flush?: boolean }): Promise<void>
  setSensitivity(sensitivity: number): void
  setMaxSegmentMs(maxSegmentMs: number): void
}

export interface CaptureControllerDeps {
  sink: CaptureSink
  createSource(channel: Channel, micDeviceId: string | null): AudioSource
  createPipeline(opts: ChannelPipelineOptions): CapturePipeline
  now(): number
  /** When the saved microphone is missing, fall back to the system default (default true). */
  micFallbackToDefault: boolean
  /** Upper bound on how long stop() waits for in-flight IPC (segment uploads etc.). */
  stopTimeoutMs: number
  /**
   * Delay before re-opening a channel whose device disappeared mid-session (mic unplugged,
   * loopback ended when the output device changed).
   */
  recoveryDelayMs: number
}

/** Snapshots are published at most this often (~15 Hz). */
export const SNAPSHOT_INTERVAL_MS = Math.round(1000 / 15)

/** Automatic re-opens per channel and session after its device disappeared. */
const MAX_RECOVERIES = 3

/** Contract limits for 'audio:segment' (see src/shared/ipc.ts). */
const MAX_WAV_BYTES = 4 * 1024 * 1024
const MAX_STATUS_ERROR_CHARS = 500

function logToConsole(level: PipelineLogLevel, message: string): void {
  if (level === 'error') console.error(`[audio] ${message}`)
  else if (level === 'warn') console.warn(`[audio] ${message}`)
}

/** Production sink: typed IPC to main (+ renderer log forwarding). */
export const ipcCaptureSink: CaptureSink = {
  segment: (req) => invoke('audio:segment', req),
  channelStatus: (req) => invoke('audio:channelStatus', req),
  warning: (req) => invoke('audio:warning', req),
  stopped: (req) => invoke('audio:stopped', req),
  log(level, message) {
    logToConsole(level, message)
    if (level === 'debug') return
    invoke('app:rendererLog', { level, message: `[audio] ${message}`.slice(0, 4000) }).catch(
      () => undefined,
    )
  },
}

function defaultDeps(): CaptureControllerDeps {
  return {
    sink: ipcCaptureSink,
    createSource: (channel, micDeviceId) =>
      channel === 'me' ? new MicSource(micDeviceId) : new LoopbackSource(),
    createPipeline: (opts) => new ChannelPipeline(opts),
    now: Date.now,
    micFallbackToDefault: true,
    stopTimeoutMs: 15_000,
    recoveryDelayMs: 1500,
  }
}

interface ChannelRuntime {
  pipeline: CapturePipeline | null
  state: ChannelState
  speaking: boolean
  /** Highest frame RMS since the last snapshot. */
  peakRms: number
  lastRms: number
}

interface ActiveSession {
  id: string
  opts: CaptureStartOptions
}

const CHANNELS: readonly Channel[] = ['me', 'them']

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

export class CaptureController {
  private readonly deps: CaptureControllerDeps
  private session: ActiveSession | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private readonly channels: Record<Channel, ChannelRuntime> = {
    me: { pipeline: null, state: 'off', speaking: false, peakRms: 0, lastRms: 0 },
    them: { pipeline: null, state: 'off', speaking: false, peakRms: 0, lastRms: 0 },
  }
  private readonly warnings = new Set<CaptureWarningCode>()
  private readonly detector = new NoSystemAudioDetector()
  /** Mic delivering exact zeros (Windows endpoint mute, hardware mute button). */
  private readonly micSilence = new DigitalSilenceDetector()
  /** Mic track reported muted by Chromium. */
  private micTrackMuted = false
  private readonly recoveries: Record<Channel, number> = { me: 0, them: 0 }
  private readonly recoveryTimers: Record<Channel, ReturnType<typeof setTimeout> | null> = {
    me: null,
    them: null,
  }
  /** In-flight channel re-opens; stop() waits for them. */
  private readonly recovering = new Set<Promise<void>>()
  /** Every IPC call still in flight (segments, statuses, warnings); stop() awaits them. */
  private readonly pending = new Set<Promise<unknown>>()
  private readonly subscribers = new Set<(s: CaptureSnapshot) => void>()
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private lastPublishAt = Number.NEGATIVE_INFINITY

  constructor(deps: Partial<CaptureControllerDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  /** True from start() until stop() has finished. */
  get running(): boolean {
    return this.session !== null
  }

  /**
   * Starts both channels for `opts.sessionId`. Resolves once each channel is listening or
   * has failed: one channel failing (no mic, no loopback) never stops the other; failures
   * are reported through 'audio:channelStatus' / 'audio:warning'. If a session is already
   * running it is stopped first.
   */
  async start(opts: CaptureStartOptions): Promise<void> {
    if (!opts.sessionId) throw new Error('CaptureController.start: sessionId is required')
    if (this.stopPromise) await this.stopPromise
    if (this.session) await this.stop()
    const session: ActiveSession = {
      id: opts.sessionId,
      opts: {
        sessionId: opts.sessionId,
        micDeviceId: opts.micDeviceId || null,
        sensitivity: clamp(opts.sensitivity, 0, 1, 0.5),
        maxSegmentSec: clamp(opts.maxSegmentSec, 4, 30, 12),
      },
    }
    this.session = session
    this.warnings.clear()
    this.detector.stop()
    this.micSilence.reset()
    this.micTrackMuted = false
    this.recoveries.me = 0
    this.recoveries.them = 0
    for (const channel of CHANNELS) this.resetChannel(channel)
    const run = Promise.allSettled(CHANNELS.map((c) => this.startChannel(session, c))).then(
      () => undefined,
    )
    this.startPromise = run
    try {
      await run
    } finally {
      if (this.startPromise === run) this.startPromise = null
    }
  }

  /**
   * Stops capture: flushes trailing speech into a final segment, waits for in-flight
   * uploads, clears warnings, reports both channels 'off', then invokes 'audio:stopped'.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const session = this.session
    if (!session) return Promise.resolve()
    const run = this.doStop(session).finally(() => {
      if (this.stopPromise === run) this.stopPromise = null
    })
    this.stopPromise = run
    return run
  }

  /** Applies new VAD settings to the running session (takes effect immediately). */
  update(opts: Partial<Pick<CaptureStartOptions, 'sensitivity' | 'maxSegmentSec'>>): void {
    const session = this.session
    if (!session) return
    if (opts.sensitivity !== undefined) {
      session.opts.sensitivity = clamp(opts.sensitivity, 0, 1, session.opts.sensitivity)
    }
    if (opts.maxSegmentSec !== undefined) {
      session.opts.maxSegmentSec = clamp(opts.maxSegmentSec, 4, 30, session.opts.maxSegmentSec)
    }
    for (const channel of CHANNELS) {
      const pipeline = this.channels[channel].pipeline
      pipeline?.setSensitivity(session.opts.sensitivity)
      pipeline?.setMaxSegmentMs(session.opts.maxSegmentSec * 1000)
    }
  }

  /**
   * Live levels/speaking/state for meters. Called immediately with the current snapshot,
   * then at most ~15 times per second while something changes. Returns an unsubscribe.
   */
  subscribe(cb: (s: CaptureSnapshot) => void): () => void {
    this.subscribers.add(cb)
    try {
      cb(this.snapshot(false))
    } catch (err) {
      this.deps.sink.log('error', `snapshot subscriber threw: ${describe(err)}`)
    }
    return () => {
      this.subscribers.delete(cb)
      if (this.subscribers.size === 0 && this.publishTimer) {
        clearTimeout(this.publishTimer)
        this.publishTimer = null
      }
    }
  }

  // ── channels ──────────────────────────────────────────────────────────────

  private resetChannel(channel: Channel): void {
    const rt = this.channels[channel]
    rt.pipeline = null
    rt.state = 'off'
    rt.speaking = false
    rt.peakRms = 0
    rt.lastRms = 0
  }

  private async startChannel(session: ActiveSession, channel: Channel): Promise<void> {
    const { micDeviceId } = session.opts
    const canFallBack = channel === 'me' && micDeviceId !== null && this.deps.micFallbackToDefault
    const quiet = { missingMic: canFallBack }
    const first = this.createPipeline(session, channel, micDeviceId, quiet)
    try {
      await first.start()
      quiet.missingMic = false // later failures (device unplugged mid-call) are reported
      return
    } catch (err) {
      quiet.missingMic = false
      const missingMic = err instanceof AudioSourceError && err.code === 'mic_not_found'
      if (!canFallBack || !missingMic || this.session !== session) return
    }
    // The saved microphone is gone (unplugged headset…): capture the default mic instead
    // of losing the user's side of the call.
    this.deps.sink.log('warn', `Saved microphone not found; using the system default mic`)
    this.channels[channel].pipeline = null // silence the failed pipeline's remaining callbacks
    await first.stop({ flush: false }).catch(() => undefined)
    if (this.session !== session) return
    const fallback = this.createPipeline(session, channel, null)
    await fallback.start().catch(() => undefined) // failures already reported via onStatus
  }

  /**
   * A channel's device disappeared mid-session (headset unplugged, USB mic reset, the
   * loopback ended because the output device changed): after a short delay (Windows needs a
   * moment to settle on a new default device) re-open it — the system default mic for Me, a
   * fresh loopback for Them — a few times per session at most. The error status/warning
   * stays visible until the channel is listening again.
   */
  private scheduleRecovery(session: ActiveSession, channel: Channel): void {
    if (channel === 'me' && !this.deps.micFallbackToDefault) return
    if (this.recoveryTimers[channel] || this.recoveries[channel] >= MAX_RECOVERIES) return
    this.recoveries[channel]++
    this.recoveryTimers[channel] = setTimeout(() => {
      this.recoveryTimers[channel] = null
      if (this.session !== session || this.stopPromise) return
      const rt = this.channels[channel]
      if (rt.state !== 'error') return
      this.deps.sink.log('warn', `${channel} capture lost; re-opening it`)
      const failed = rt.pipeline
      rt.pipeline = null // ignore the failed pipeline's 'off'
      const run = (async () => {
        await failed?.stop({ flush: false }).catch(() => undefined)
        if (this.session !== session || this.stopPromise) return
        await this.createPipeline(session, channel, null)
          .start()
          .catch(() => undefined) // reported via onStatus
      })()
      this.recovering.add(run)
      void run.finally(() => this.recovering.delete(run))
    }, this.deps.recoveryDelayMs)
  }

  private createPipeline(
    session: ActiveSession,
    channel: Channel,
    micDeviceId: string | null,
    quiet: { missingMic: boolean } = { missingMic: false },
  ): CapturePipeline {
    const rt = this.channels[channel]
    // Callbacks from a pipeline that is no longer current (replaced/stopped) are ignored.
    const current = () => this.session === session && rt.pipeline === pipeline
    const pipeline: CapturePipeline = this.deps.createPipeline({
      channel,
      source: this.deps.createSource(channel, channel === 'me' ? micDeviceId : null),
      sensitivity: session.opts.sensitivity,
      maxSegmentMs: session.opts.maxSegmentSec * 1000,
      onSegment: (seg) => {
        if (this.session === session) this.upload(session, seg)
      },
      onLevel: (rms) => {
        if (current()) this.onLevel(session, channel, rms)
      },
      onSpeaking: (speaking) => {
        if (current()) this.onSpeaking(session, channel, speaking)
      },
      onStatus: (state, error) => {
        if (!current()) return
        // A missing saved mic is retried with the default device: don't flash an error.
        if (quiet.missingMic && state === 'error' && error?.code === 'mic_not_found') return
        this.onStatus(session, channel, state, error)
      },
      onMuted: (muted) => {
        if (!current() || channel !== 'me') return
        this.micTrackMuted = muted
        this.setWarning(session, 'mic_muted', muted || this.micSilence.active)
      },
      onLog: (level, message) => this.deps.sink.log(level, message),
    })
    rt.pipeline = pipeline
    return pipeline
  }

  private onStatus(
    session: ActiveSession,
    channel: Channel,
    state: ChannelState,
    error: AudioSourceError | null,
  ): void {
    const rt = this.channels[channel]
    const wasListening = rt.state === 'listening'
    rt.state = state
    if (state !== 'listening') {
      rt.speaking = false
      rt.peakRms = 0
      rt.lastRms = 0
    }
    this.track(
      this.deps.sink.channelStatus({
        sessionId: session.id,
        channel,
        state,
        error: error ? error.message.slice(0, MAX_STATUS_ERROR_CHARS) : null,
      }),
      'audio:channelStatus',
    )
    const warning: CaptureWarningCode = channel === 'me' ? 'mic_not_found' : 'loopback_unavailable'
    if (state === 'error') this.setWarning(session, warning, true)
    else if (state === 'listening') this.setWarning(session, warning, false)
    if (channel === 'them') {
      if (state === 'listening') this.detector.start(this.deps.now())
      else this.detector.stop()
      if (!this.detector.active) this.setWarning(session, 'no_system_audio', false)
    } else if (state !== 'listening') {
      // A mic that is not capturing is "not found", not "muted".
      this.micSilence.reset()
      this.micTrackMuted = false
      this.setWarning(session, 'mic_muted', false)
    }
    const lostDevice = error?.code === 'mic_not_found' || error?.code === 'loopback_unavailable'
    if (state === 'error' && wasListening && lostDevice) this.scheduleRecovery(session, channel)
    this.schedulePublish()
  }

  private onLevel(session: ActiveSession, channel: Channel, rms: number): void {
    const rt = this.channels[channel]
    rt.lastRms = rms
    if (rms > rt.peakRms) rt.peakRms = rms
    const now = this.deps.now()
    if (channel === 'them') {
      this.setWarning(session, 'no_system_audio', this.detector.themLevel(rms, now))
    } else {
      const silent = this.micSilence.update(rms, now)
      this.setWarning(session, 'mic_muted', this.micTrackMuted || silent)
      if (rt.speaking) this.setWarning(session, 'no_system_audio', this.detector.meSpeech(now))
    }
    this.schedulePublish()
  }

  private onSpeaking(session: ActiveSession, channel: Channel, speaking: boolean): void {
    this.channels[channel].speaking = speaking
    if (channel === 'me' && speaking) {
      this.setWarning(session, 'no_system_audio', this.detector.meSpeech(this.deps.now()))
    }
    this.schedulePublish()
  }

  private setWarning(session: ActiveSession, code: CaptureWarningCode, active: boolean): void {
    if (this.warnings.has(code) === active) return
    if (active) this.warnings.add(code)
    else this.warnings.delete(code)
    this.track(this.deps.sink.warning({ sessionId: session.id, code, active }), 'audio:warning')
  }

  // ── segments ──────────────────────────────────────────────────────────────

  private upload(session: ActiveSession, seg: PipelineSegment): void {
    const wav = encodeWav16(seg.samples)
    if (wav.byteLength > MAX_WAV_BYTES) {
      this.deps.sink.log('warn', `Dropping oversized ${seg.channel} segment (${wav.byteLength} B)`)
      return
    }
    const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback)
    const vadEndAt = finite(seg.vadEndAt, this.deps.now())
    const endedAt = finite(seg.endedAt, vadEndAt)
    const startedAt = finite(seg.startedAt, endedAt - (seg.samples.length / 16_000) * 1000)
    const request = this.deps.sink
      .segment({
        sessionId: session.id,
        channel: seg.channel,
        startedAt,
        endedAt,
        vadEndAt,
        forced: seg.forced,
        wav,
      })
      .then((res) => {
        if (!res.accepted) this.deps.sink.log('info', `${seg.channel} segment not accepted`)
      })
    this.track(request, 'audio:segment')
  }

  /** Fire-and-forget IPC that stop() can still await; failures are logged, never thrown. */
  private track(promise: Promise<unknown>, what: string): void {
    const tracked = promise.then(
      () => undefined,
      (err: unknown) => this.deps.sink.log('warn', `${what} failed: ${describe(err)}`),
    )
    this.pending.add(tracked)
    void tracked.finally(() => this.pending.delete(tracked))
  }

  private async drainPending(timeoutMs: number): Promise<void> {
    const deadline = this.deps.now() + timeoutMs
    while (this.pending.size > 0) {
      const remaining = deadline - this.deps.now()
      if (remaining <= 0) {
        this.deps.sink.log('warn', `stop: ${this.pending.size} IPC calls still pending`)
        return
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining)
      })
      await Promise.race([Promise.allSettled([...this.pending]), timeout])
      if (timer) clearTimeout(timer)
    }
  }

  // ── stop ──────────────────────────────────────────────────────────────────

  private async doStop(session: ActiveSession): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    for (const channel of CHANNELS) {
      const timer = this.recoveryTimers[channel]
      if (timer) clearTimeout(timer)
      this.recoveryTimers[channel] = null
    }
    await Promise.allSettled([...this.recovering])
    // Both channels flush in parallel; trailing segments are emitted (and their uploads
    // tracked) before each stop() resolves.
    await Promise.allSettled(
      CHANNELS.map((c) => this.channels[c].pipeline?.stop({ flush: true }) ?? Promise.resolve()),
    )
    this.detector.stop()
    for (const code of [...this.warnings]) this.setWarning(session, code, false)
    await this.drainPending(this.deps.stopTimeoutMs)
    try {
      await this.deps.sink.stopped({ sessionId: session.id })
    } catch (err) {
      this.deps.sink.log('warn', `audio:stopped failed: ${describe(err)}`)
    }
    if (this.session === session) {
      this.session = null
      for (const channel of CHANNELS) this.resetChannel(channel)
    }
    this.schedulePublish()
  }

  // ── snapshots ─────────────────────────────────────────────────────────────

  private snapshot(consume: boolean): CaptureSnapshot {
    const level = (channel: Channel): ChannelLevel => {
      const rt = this.channels[channel]
      const rms = Math.max(rt.peakRms, rt.lastRms)
      if (consume) rt.peakRms = 0
      return { rms, speaking: rt.speaking, state: rt.state }
    }
    return { me: level('me'), them: level('them') }
  }

  private schedulePublish(): void {
    if (this.subscribers.size === 0 || this.publishTimer) return
    const wait = Math.max(0, this.lastPublishAt + SNAPSHOT_INTERVAL_MS - this.deps.now())
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      this.lastPublishAt = this.deps.now()
      const snap = this.snapshot(true)
      for (const cb of [...this.subscribers]) {
        try {
          cb(snap)
        } catch (err) {
          this.deps.sink.log('error', `snapshot subscriber threw: ${describe(err)}`)
        }
      }
    }, wait)
  }
}
