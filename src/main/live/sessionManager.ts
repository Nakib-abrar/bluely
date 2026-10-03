import { AUDIO } from '@shared/constants'
import { t } from '@shared/i18n'
import type {
  Channel,
  ChannelErrorCode,
  ChannelState,
  ChannelStatus,
  LiveSessionState,
  Mode,
  SessionWarningCode,
  TranscriptLine,
} from '@shared/types'
import type { CoreContext } from '../context'
import { AppError } from '../errors'
import { type ProviderError } from '../providers/errors'
import { TranscriptBuffer } from '../session/transcriptBuffer'
import { EchoDeduper } from '../session/dedup'
import { AutoSuggestScheduler, type AutoTrigger } from '../session/autoSuggestScheduler'
import { RunningSummarizer } from '../ai/runningSummary'
import type {
  QueuedTranscriptionResult,
  TranscriptionErrorInfo,
  TranscriptionJob,
  TranscriptionQueue,
} from '../providers/stt/transcriptionQueue'
import type { ModelsFeature } from '../models/wire'
import { routingFor } from '../models/wire'
import type { SttFeature } from '../stt/wire'
import type { HistoryFeature } from '../history/wire'
import type { ModesFeature } from '../modes/wire'
import type { AiService, LiveContextSource } from './aiService'
import type { PostCallRunner } from './postCallRunner'

const AUDIO_STOP_TIMEOUT_MS = 6_000
const STT_DRAIN_TIMEOUT_MS = 15_000
/** Quitting during a call: the whole shutdown must fit the 4 s quit budget (index.ts). */
const SHUTDOWN_AUDIO_WAIT_MS = 1_200
const SHUTDOWN_DRAIN_MS = 2_000
/** A channel that has reported neither 'listening' nor an error by then is marked failed. */
const CAPTURE_START_TIMEOUT_MS = 20_000
/** Echo de-dup window (± ms around a Them line), shared with the EchoDeduper below. */
const ECHO_WINDOW_MS = AUDIO.dedupWindowMs
/** A Me line that may be speaker echo waits at most this long for its Them copy. */
const ECHO_WAIT_MAX_MS = 4_000
/** How long "Some speech could not be transcribed" stays after the last lost segment. */
const STT_LOST_NOTICE_MS = 30_000

/** Post-call outputs that can be regenerated one by one. */
export type PostCallPart = 'notes' | 'actions' | 'email'

function idleState(modeId: string): LiveSessionState {
  return {
    status: 'idle',
    sessionId: null,
    startedAt: null,
    modeId,
    audio: { me: { state: 'off', error: null }, them: { state: 'off', error: null } },
    warnings: [],
    autoSuggest: true,
    showConsentReminder: false,
    lastError: null,
  }
}

const CHANNELS: Channel[] = ['me', 'them']

/** A channel has finished starting (successfully or not). */
function settled(state: ChannelState): boolean {
  return state === 'listening' || state === 'error' || state === 'off'
}

export interface SegmentInput {
  sessionId: string
  channel: Channel
  startedAt: number
  endedAt: number
  vadEndAt: number
  forced: boolean
  wav: Uint8Array
}

/**
 * Owns the live call: session row, transcription queue, transcript assembly + echo de-dup,
 * auto-suggest scheduling, running summary, and the stop → post-call hand-off.
 * Every finalized line is written to SQLite immediately (crash-safe).
 *
 * Status flow: idle → starting → live → stopping → processing → idle. 'processing' means the
 * call is over and its notes are being generated in the background; a new call can start
 * during it (the notes keep going).
 */
export class SessionManager implements LiveContextSource {
  private state: LiveSessionState
  private buffer = new TranscriptBuffer()
  private deduper = new EchoDeduper()
  private scheduler: AutoSuggestScheduler
  private summarizer: RunningSummarizer | null = null
  private queue: TranscriptionQueue | null = null
  private sttTiming = new Map<string, { vadEndAt: number; sttDoneAt: number }>()
  private audioStoppedWaiters = new Set<() => void>()
  private stopPromise: Promise<void> | null = null
  /** Post-call generation per session; it outlives the live state. */
  private postCallJobs = new Map<string, Promise<void>>()
  /** The most recently started session (its overlay cards live on after it ends). */
  private lastSession: string | null = null
  /** 'session:setAutoSuggest' for the current (or next) session; wins over settings and Mode. */
  private autoSuggestOverride: boolean | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  /** Jobs of this session waiting for a speech-to-text retry. */
  private retrying = new Set<string>()
  /** What `state.lastError` currently shows, so each kind is cleared by the right event. */
  private lastErrorKind: 'provider' | 'lost' | null = null
  private lostSegments = 0
  private lostTimer: ReturnType<typeof setTimeout> | null = null
  /** Them segments sent to speech-to-text, session-relative, until their line arrives. */
  private themInFlight = new Map<string, { startMs: number; endMs: number }>()
  /** Session-relative ms when the Them channel's VAD reported speech, while it lasts. */
  private themSpeakingSinceMs: number | null = null
  /** Kept Me lines that may still be retracted as echo before they may cancel auto-suggest. */
  private deferredMe = new Map<string, { line: TranscriptLine; deadline: number }>()
  private deferredMeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly ctx: CoreContext,
    private readonly deps: {
      models: ModelsFeature
      stt: SttFeature
      history: HistoryFeature
      modes: ModesFeature
      ai: AiService
      postCall: PostCallRunner
    },
  ) {
    this.state = idleState(ctx.settings.get().activeModeId)
    this.scheduler = new AutoSuggestScheduler({
      debounceMs: ctx.settings.get().advanced.autoSuggestDebounceMs,
      cooldownMs: ctx.settings.get().advanced.autoSuggestCooldownSec * 1000,
      // Only during the call: lines transcribed while stopping must not start a paid request.
      isEnabled: () =>
        this.state.status === 'live' && this.autoSuggestEnabled() && !this.deps.ai.isLiveBusy(),
      language: () => {
        const lang = this.ctx.settings.get().language.transcription
        return lang === 'auto' ? undefined : lang
      },
      // Debounce counts from the end of speech (VAD), not from transcription; see the scheduler.
      anchorToVadEnd: true,
      run: (trigger, signal) => this.runAuto(trigger, signal),
      onError: (err) => this.ctx.log.warn('Auto-suggest failed', err),
    })
    deps.ai.attachLive(this)
    ctx.settings.onChange((next, prev) => {
      if (
        next.advanced.autoSuggestDebounceMs !== prev.advanced.autoSuggestDebounceMs ||
        next.advanced.autoSuggestCooldownSec !== prev.advanced.autoSuggestCooldownSec
      ) {
        this.scheduler.setConfig({
          debounceMs: next.advanced.autoSuggestDebounceMs,
          cooldownMs: next.advanced.autoSuggestCooldownSec * 1000,
        })
      }
      if (next.advanced.sttConcurrency !== prev.advanced.sttConcurrency) {
        this.queue?.setConcurrency(next.advanced.sttConcurrency)
      }
      // Changing the global setting is the newer decision: it replaces the session override.
      if (next.general.autoSuggest !== prev.general.autoSuggest) this.autoSuggestOverride = null
      if (
        next.general.autoSuggest !== prev.general.autoSuggest ||
        next.activeModeId !== prev.activeModeId
      ) {
        this.patch({ autoSuggest: this.autoSuggestEnabled(), modeId: next.activeModeId })
      }
    })
    ctx.secrets.onChange(() => this.onKeyChanged())
  }

  // ── LiveContextSource ─────────────────────────────────────────────────────

  sessionId(): string | null {
    return this.state.sessionId
  }

  elapsedMs(): number {
    return this.state.startedAt ? Date.now() - this.state.startedAt : 0
  }

  transcript(): TranscriptLine[] {
    // Once the call is fully over, live actions must not see (or resend) its transcript.
    return this.state.sessionId ? this.buffer.finals() : []
  }

  runningSummary(): { text: string | null; coveredUntilMs: number } {
    return {
      text: this.summarizer?.current() ?? null,
      coveredUntilMs: this.summarizer?.coveredUntilMs() ?? 0,
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  getState(): LiveSessionState {
    return structuredClone(this.state)
  }

  isLive(): boolean {
    return (
      this.state.status === 'starting' ||
      this.state.status === 'live' ||
      this.state.status === 'stopping'
    )
  }

  /** Notes, action items or the email of an ended call are still being generated. */
  isPostCallRunning(): boolean {
    return this.postCallJobs.size > 0
  }

  /** Resolves once no post-call generation is running (tests, diagnostics). */
  async whenPostCallIdle(): Promise<void> {
    while (this.postCallJobs.size > 0) await Promise.allSettled([...this.postCallJobs.values()])
  }

  /** The most recently started session, live or ended; null after forgetLastSession(). */
  lastSessionId(): string | null {
    return this.lastSession
  }

  /**
   * The last session was deleted. If its notes are still generating, return to idle now so the
   * deleted call's transcript is no longer kept for live actions.
   */
  forgetLastSession(): void {
    const id = this.lastSession
    this.lastSession = null
    if (id && this.state.status === 'processing' && this.state.sessionId === id) this.goIdle()
  }

  getTranscript(sessionId: string): TranscriptLine[] {
    if (sessionId === this.state.sessionId) return this.buffer.all()
    return this.deps.history.transcript.listBySession(sessionId, { finalOnly: false })
  }

  /** Tray and global shortcut: stop a live call, otherwise start one (also while notes generate). */
  toggle(): void {
    if (this.isLive()) void this.stop()
    else this.start().catch((err) => this.ctx.log.error('Start failed', err))
  }

  async start(modeId?: string): Promise<{ sessionId: string }> {
    if (this.isLive() && this.state.sessionId) return { sessionId: this.state.sessionId }
    // If notes for the previous call are still generating, they continue in the background.
    const settings = this.ctx.settings.get()
    const activeModeId = modeId ?? settings.activeModeId
    if (modeId && modeId !== settings.activeModeId)
      this.ctx.settings.update({ activeModeId: modeId })
    const now = Date.now()
    const session = this.deps.history.sessions.create({ modeId: activeModeId, startedAt: now })
    this.stopPromise = null
    this.clearSessionTimers()
    this.buffer = new TranscriptBuffer()
    this.deduper = new EchoDeduper({ windowMs: ECHO_WINDOW_MS, threshold: 0.8 })
    this.sttTiming.clear()
    this.retrying.clear()
    this.themInFlight.clear()
    this.themSpeakingSinceMs = null
    this.deferredMe.clear()
    this.lostSegments = 0
    this.lastErrorKind = null
    this.lastSession = session.id
    this.deps.ai.resetLive()
    this.queue = this.deps.stt.createQueue({
      getOptions: () => {
        const s = this.ctx.settings.get()
        return {
          model: s.models.stt.model,
          language: s.language.transcription === 'auto' ? null : s.language.transcription,
        }
      },
      concurrencyPerChannel: settings.advanced.sttConcurrency,
      onResult: (job, result) => this.onTranscribed(job, result),
      onError: (job, err, info) => this.onSttError(job, err, info),
      onDropped: (job) => this.onSegmentGone(job),
    })
    this.summarizer = new RunningSummarizer({
      llm: this.deps.models.llm,
      getModel: () => {
        const s = this.ctx.settings.get()
        return { model: s.models.fast.model, routing: routingFor(s.models.fast) }
      },
      intervalMs: settings.advanced.summaryIntervalMin * 60_000,
      windowMs: settings.advanced.contextMinutes * 60_000,
      log: this.ctx.log.child('summary'),
    })
    const warnings: SessionWarningCode[] = this.ctx.secrets.getKey() ? [] : ['no_key']
    this.state = {
      ...idleState(activeModeId),
      status: 'starting',
      sessionId: session.id,
      startedAt: now,
      audio: { me: { state: 'starting', error: null }, them: { state: 'starting', error: null } },
      warnings,
      autoSuggest: this.autoSuggestEnabled(),
      showConsentReminder: settings.general.consentReminder,
    }
    this.startTimer = setTimeout(
      () => this.captureStartTimedOut(session.id),
      CAPTURE_START_TIMEOUT_MS,
    )
    this.startTimer.unref?.()
    this.emit()
    this.ctx.events.broadcast('sessions:changed', { id: session.id })
    this.ctx.overlay.show(false)
    void this.deps.models.llm.prewarm()
    this.ctx.log.info(`Session ${session.id} started (mode ${activeModeId})`)
    return { sessionId: session.id }
  }

  /**
   * Stop → flush audio → drain STT → status 'processing'. Resolves there: the notes are
   * generated in the background (isPostCallRunning) and the status returns to idle when they
   * are done, unless a new call has started meanwhile. Safe to call repeatedly.
   */
  stop(): Promise<void> {
    if (!this.isLive() || !this.state.sessionId) return Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    const promise: Promise<void> = this.doStop().finally(() => {
      if (this.stopPromise === promise) this.stopPromise = null
    })
    this.stopPromise = promise
    return promise
  }

  private async doStop(): Promise<void> {
    const sessionId = this.state.sessionId as string
    const modeId = this.state.modeId
    this.clearStartTimer()
    this.patch({ status: 'stopping' })
    this.scheduler.notifyManualRequest()
    this.scheduler.setThemSpeaking(false)
    this.themSpeakingSinceMs = null
    // The overlay flushes trailing speech and calls 'audio:stopped'.
    await this.waitForAudioStopped(AUDIO_STOP_TIMEOUT_MS)
    await this.queue?.drain(STT_DRAIN_TIMEOUT_MS)
    this.queue?.cancelAll()
    this.queue = null
    if (this.summarizer) {
      await Promise.race([this.summarizer.whenIdle(), new Promise((r) => setTimeout(r, 5_000))])
      const runningSummary = this.summarizer.current()
      if (runningSummary) {
        try {
          this.deps.history.sessions.updateSummaryJson(sessionId, { runningSummary })
        } catch {
          /* session deleted */
        }
      }
      this.summarizer.dispose()
      this.summarizer = null
    }
    // Lines transcribed during the drain may have armed an auto-suggestion: the call is over.
    this.scheduler.notifyManualRequest()
    this.deps.ai.cancelScope('live')
    this.clearSessionTimers()
    this.deferredMe.clear()
    this.retrying.clear()
    this.autoSuggestOverride = null
    this.lastErrorKind = null
    this.deps.history.sessions.end(sessionId, Date.now())
    this.patch({
      status: 'processing',
      audio: { me: { state: 'off', error: null }, them: { state: 'off', error: null } },
      warnings: [],
      showConsentReminder: false,
      lastError: null,
      autoSuggest: this.autoSuggestEnabled(),
    })
    this.ctx.overlay.hide()
    this.ctx.showMainWindow({ name: 'session', sessionId, tab: 'notes' })
    const sessionMode = this.modeById(modeId) ?? this.deps.ai.activeMode()
    // Not awaited: a new call may start while the notes are written.
    void this.runPostCall(sessionId, sessionMode).then(() => {
      if (this.state.status === 'processing' && this.state.sessionId === sessionId) this.goIdle()
      this.ctx.log.info(`Session ${sessionId} finished`)
    })
  }

  /**
   * Quit during a call: let the overlay flush its trailing speech and give speech-to-text a
   * short, bounded drain so the last seconds are kept; then keep everything already transcribed
   * and mark the session for "Generate notes" (it is 'recovered', not finalized).
   */
  async shutdown(): Promise<void> {
    const sessionId = this.state.sessionId
    const live = !!sessionId && this.isLive()
    this.scheduler.dispose()
    this.clearSessionTimers()
    this.summarizer?.dispose()
    this.summarizer = null
    if (live) {
      if (this.state.status !== 'stopping') this.patch({ status: 'stopping' })
      await this.waitForAudioStopped(SHUTDOWN_AUDIO_WAIT_MS)
      await this.queue?.drain(SHUTDOWN_DRAIN_MS)
    }
    this.queue?.cancelAll()
    this.queue = null
    if (sessionId && live) {
      this.deps.history.sessions.end(sessionId, Date.now())
      this.deps.history.sessions.setStatus(sessionId, 'recovered')
    }
    this.state = idleState(this.state.modeId)
  }

  /** Regenerates post-call output; `parts` limits it (default: whatever is missing). */
  regenerate(sessionId: string, parts?: PostCallPart[]): void {
    const s = this.deps.history.sessions.get(sessionId)
    if (!s) throw new AppError('not_found', 'Session not found')
    if (sessionId === this.state.sessionId && this.isLive()) {
      throw new AppError('busy', 'This session is still live.')
    }
    const mode = (s.modeId && this.modeById(s.modeId)) || this.deps.ai.activeMode()
    void this.runPostCall(sessionId, mode, parts)
  }

  dismissConsent(): void {
    this.patch({ showConsentReminder: false })
  }

  /**
   * The overlay's "Auto-suggest replies" toggle. It overrides Settings › General and the Mode's
   * auto-suggest flag for the current call only (or the next one, when no call is running) and
   * is cleared when that call ends or the global setting changes. Nothing is persisted.
   */
  setAutoSuggest(enabled: boolean): void {
    this.autoSuggestOverride = enabled
    this.patch({ autoSuggest: this.autoSuggestEnabled() })
  }

  // ── audio from the overlay renderer ───────────────────────────────────────

  acceptSegment(input: SegmentInput): boolean {
    if (!this.queue || input.sessionId !== this.state.sessionId || !this.isLive()) return false
    const job: TranscriptionJob = {
      id: globalThis.crypto.randomUUID(),
      sessionId: input.sessionId,
      channel: input.channel,
      segment: {
        channel: input.channel,
        wav: input.wav,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
      },
      vadEndAt: input.vadEndAt,
      forced: input.forced,
    }
    if (job.channel === 'them') {
      const t0 = this.state.startedAt ?? input.startedAt
      this.themInFlight.set(job.id, { startMs: input.startedAt - t0, endMs: input.endedAt - t0 })
      this.scheduler.onThemSegment(job.id, job.vadEndAt)
    }
    this.queue.enqueue(job)
    return true
  }

  setChannelStatus(
    sessionId: string,
    channel: Channel,
    state: ChannelState,
    error: string | null,
    code: ChannelErrorCode | null = null,
  ): void {
    if (sessionId !== this.state.sessionId) return
    const status: ChannelStatus = { state, error, code }
    const audio = { ...this.state.audio, [channel]: status }
    const anyListening = audio.me.state === 'listening' || audio.them.state === 'listening'
    // Leave 'starting' once a channel listens, or once both have given up: the call is then
    // live (with its error warnings) instead of starting forever.
    const started =
      this.state.status === 'starting' &&
      (anyListening || (settled(audio.me.state) && settled(audio.them.state)))
    if (started) this.clearStartTimer()
    this.patch({ audio, status: started ? 'live' : this.state.status })
    this.ctx.events.broadcast('audio:channelStatus', { channel, status })
  }

  setWarning(sessionId: string, code: SessionWarningCode, active: boolean): void {
    if (sessionId !== this.state.sessionId) return
    this.toggleWarning(code, active)
  }

  setSpeaking(sessionId: string, channel: Channel, speaking: boolean): void {
    if (sessionId !== this.state.sessionId || channel !== 'them') return
    this.themSpeakingSinceMs = speaking
      ? (this.themSpeakingSinceMs ?? Math.max(0, this.elapsedMs()))
      : null
    this.scheduler.setThemSpeaking(speaking)
  }

  audioStopped(sessionId: string): void {
    if (sessionId !== this.state.sessionId) return
    for (const resolve of [...this.audioStoppedWaiters]) resolve()
  }

  /**
   * The overlay renderer, where capture runs, crashed or was killed and is being reloaded.
   * Until the new renderer reports 'listening' again both channels show an error, so the call
   * never looks live while nothing is being captured.
   */
  captureLost(): void {
    const sessionId = this.state.sessionId
    if (!sessionId) return
    if (this.state.status === 'stopping') {
      // Nothing can flush any more; don't wait for 'audio:stopped'.
      for (const resolve of [...this.audioStoppedWaiters]) resolve()
      return
    }
    if (this.state.status !== 'starting' && this.state.status !== 'live') return
    this.scheduler.setThemSpeaking(false)
    this.themSpeakingSinceMs = null
    for (const channel of CHANNELS) {
      this.setChannelStatus(sessionId, channel, 'error', t('live.captureLost'), 'unknown')
    }
  }

  /** Manual requests cancel a pending auto-suggestion (spec: "Cancel it if I trigger something manually"). */
  notifyManualRequest(): void {
    this.scheduler.notifyManualRequest()
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private runPostCall(sessionId: string, mode: Mode, parts?: PostCallPart[]): Promise<void> {
    const running = this.postCallJobs.get(sessionId)
    if (running) return running
    const job: Promise<void> = this.deps.postCall
      .run(sessionId, mode, { parts })
      .catch((err: unknown) => this.ctx.log.error('Post-call generation failed', err))
      .finally(() => {
        if (this.postCallJobs.get(sessionId) === job) this.postCallJobs.delete(sessionId)
      })
    this.postCallJobs.set(sessionId, job)
    return job
  }

  private goIdle(): void {
    this.buffer = new TranscriptBuffer()
    this.state = {
      ...idleState(this.ctx.settings.get().activeModeId),
      autoSuggest: this.autoSuggestEnabled(),
    }
    this.emit()
  }

  private waitForAudioStopped(timeoutMs: number): Promise<void> {
    if (!this.ctx.overlay.window) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.audioStoppedWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.audioStoppedWaiters.add(done)
    })
  }

  private captureStartTimedOut(sessionId: string): void {
    this.startTimer = null
    if (this.state.sessionId !== sessionId || this.state.status !== 'starting') return
    this.ctx.log.warn('Audio capture did not start in time')
    for (const channel of CHANNELS) {
      if (this.state.audio[channel].state !== 'starting') continue
      this.setChannelStatus(sessionId, channel, 'error', t('live.captureStartTimeout'), 'unknown')
    }
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer)
    this.startTimer = null
  }

  private clearSessionTimers(): void {
    this.clearStartTimer()
    if (this.lostTimer) clearTimeout(this.lostTimer)
    this.lostTimer = null
    if (this.deferredMeTimer) clearTimeout(this.deferredMeTimer)
    this.deferredMeTimer = null
  }

  private onTranscribed(job: TranscriptionJob, result: QueuedTranscriptionResult): void {
    if (job.sessionId !== this.state.sessionId || !this.state.startedAt) {
      // Late result for a session that already ended: persist only.
      this.persistLate(job, result)
      return
    }
    const startedAt = this.state.startedAt
    const line: TranscriptLine = {
      id: job.id,
      sessionId: job.sessionId,
      channel: job.channel,
      startMs: Math.max(0, job.segment.startedAt - startedAt),
      endMs: Math.max(0, job.segment.endedAt - startedAt),
      text: result.text,
      isFinal: true,
    }
    this.retrying.delete(job.id)
    this.syncRetryingWarning()
    // Speech-to-text works, so a key / auth / credits problem is resolved.
    this.toggleWarning('no_key', false)
    if (this.lastErrorKind === 'provider') this.setLastError(null, null)
    if (line.channel === 'me') {
      const { drop } = this.deduper.checkMe(line)
      if (drop) {
        this.maybeShowHeadphonesTip()
        return
      }
    } else {
      this.themInFlight.delete(job.id)
      // Them lines can retract Me lines that turned out to be speaker echo.
      for (const id of this.deduper.checkThem(line)) {
        this.buffer.remove(id)
        this.deferredMe.delete(id)
        this.deps.history.transcript.remove(id)
        this.ctx.events.broadcast('transcript:remove', { id, sessionId: line.sessionId })
        this.maybeShowHeadphonesTip()
      }
    }
    this.buffer.upsert(line)
    this.deps.history.transcript.upsert(line)
    this.ctx.events.broadcast('transcript:line', line)
    this.sttTiming.set(line.id, { vadEndAt: job.vadEndAt, sttDoneAt: result.receivedAt })
    if (this.sttTiming.size > 200) {
      const first = this.sttTiming.keys().next().value
      if (first) this.sttTiming.delete(first)
    }
    if (line.channel === 'them') {
      // Me lines that were waiting for this Them line first, as if they had arrived in order.
      this.resolveDeferredMe()
      this.scheduler.onThemLine(line, { vadEndAt: job.vadEndAt })
    } else {
      this.onMeLineKept(line)
    }
    this.summarizer?.maybeUpdate(this.buffer.finals(), this.elapsedMs())
  }

  /**
   * A kept Me line normally cancels a pending auto-suggestion right away ("I started talking").
   * But on speakers it may be the echo of Them speech whose own line is still being transcribed;
   * that Them line would retract it, and must not have cancelled the suggestion first. Such a
   * line waits until no Them speech that could match it is pending (or ECHO_WAIT_MAX_MS).
   */
  private onMeLineKept(line: TranscriptLine): void {
    if (!this.mayBeEcho(line)) {
      this.scheduler.onMeLine(line)
      return
    }
    this.deferredMe.set(line.id, { line, deadline: Date.now() + ECHO_WAIT_MAX_MS })
    this.armDeferredMeTimer()
  }

  /** True while Them speech within the echo window of `line` has not been transcribed yet. */
  private mayBeEcho(line: TranscriptLine): boolean {
    if (
      this.themSpeakingSinceMs !== null &&
      this.themSpeakingSinceMs <= line.endMs + ECHO_WINDOW_MS
    )
      return true
    for (const seg of this.themInFlight.values()) {
      if (seg.startMs <= line.endMs + ECHO_WINDOW_MS && seg.endMs >= line.startMs - ECHO_WINDOW_MS)
        return true
    }
    return false
  }

  private resolveDeferredMe(): void {
    if (this.deferredMe.size === 0) return
    const now = Date.now()
    for (const [id, { line, deadline }] of this.deferredMe) {
      if (!this.buffer.get(id)) {
        this.deferredMe.delete(id) // retracted as echo
        continue
      }
      if (now < deadline && this.mayBeEcho(line)) continue
      this.deferredMe.delete(id)
      this.scheduler.onMeLine(line)
    }
    this.armDeferredMeTimer()
  }

  private armDeferredMeTimer(): void {
    if (this.deferredMeTimer) clearTimeout(this.deferredMeTimer)
    this.deferredMeTimer = null
    if (this.deferredMe.size === 0) return
    const next = Math.min(...[...this.deferredMe.values()].map((d) => d.deadline))
    this.deferredMeTimer = setTimeout(
      () => {
        this.deferredMeTimer = null
        this.resolveDeferredMe()
      },
      Math.max(0, next - Date.now()),
    )
  }

  /** A segment that will produce no line (dropped, cancelled or failed for good). */
  private onSegmentGone(job: TranscriptionJob): void {
    this.retrying.delete(job.id)
    if (job.sessionId !== this.state.sessionId) return
    this.syncRetryingWarning()
    if (job.channel !== 'them') return
    this.themInFlight.delete(job.id)
    this.resolveDeferredMe()
    this.scheduler.onThemSegmentDone(job.id)
  }

  private persistLate(job: TranscriptionJob, result: QueuedTranscriptionResult): void {
    const s = this.deps.history.sessions.get(job.sessionId)
    if (!s) return
    this.deps.history.transcript.upsert({
      id: job.id,
      sessionId: job.sessionId,
      channel: job.channel,
      startMs: Math.max(0, job.segment.startedAt - s.startedAt),
      endMs: Math.max(0, job.segment.endedAt - s.startedAt),
      text: result.text,
      isFinal: true,
    })
  }

  private onSttError(
    job: TranscriptionJob,
    err: ProviderError,
    info: TranscriptionErrorInfo,
  ): void {
    if (job.sessionId !== this.state.sessionId) {
      this.retrying.delete(job.id)
      return
    }
    const blocking = err.code === 'no_key' || err.code === 'auth' || err.code === 'credits'
    if (blocking) {
      this.setLastError(err.message, 'provider')
      if (err.code === 'no_key') this.toggleWarning('no_key', true)
    }
    if (info.willRetry) {
      this.retrying.add(job.id)
      this.syncRetryingWarning()
      return
    }
    this.onSegmentGone(job)
    if (!blocking && err.code !== 'aborted') this.noteLostSegment()
  }

  /** A segment failed for good: say so for a while instead of losing its speech silently. */
  private noteLostSegment(): void {
    this.lostSegments++
    // A key or credits problem explains the loss better; don't replace it.
    if (this.lastErrorKind === 'provider') return
    this.setLastError(t('live.sttLost', { count: this.lostSegments }), 'lost')
    if (this.lostTimer) clearTimeout(this.lostTimer)
    this.lostTimer = setTimeout(() => {
      this.lostTimer = null
      if (this.lastErrorKind === 'lost') this.setLastError(null, null)
    }, STT_LOST_NOTICE_MS)
    this.lostTimer.unref?.()
  }

  /** "Transcription error (retrying)" shows while any job of this call waits for a retry. */
  private syncRetryingWarning(): void {
    this.toggleWarning('stt_error_retrying', this.retrying.size > 0)
  }

  private setLastError(message: string | null, kind: 'provider' | 'lost' | null): void {
    this.lastErrorKind = message ? kind : null
    if (this.state.lastError !== message) this.patch({ lastError: message })
  }

  /** The API key was added, replaced or removed during a call. */
  private onKeyChanged(): void {
    if (!this.isLive()) return
    const hasKey = !!this.ctx.secrets.getKey()
    this.toggleWarning('no_key', !hasKey)
    if (hasKey && this.lastErrorKind === 'provider') this.setLastError(null, null)
  }

  private async runAuto(trigger: AutoTrigger, signal: AbortSignal): Promise<void> {
    const timing = trigger.lineIds
      .map((id) => this.sttTiming.get(id))
      .filter(Boolean)
      .at(-1)
    const { finished } = this.deps.ai.startLive(
      { kind: 'auto' },
      {
        triggerText: trigger.text,
        vadEndAt: trigger.vadEndAt ?? timing?.vadEndAt ?? null,
        sttDoneAt: timing?.sttDoneAt ?? null,
      },
      signal,
    )
    await finished
  }

  private autoSuggestEnabled(): boolean {
    if (this.autoSuggestOverride !== null) return this.autoSuggestOverride
    const s = this.ctx.settings.get()
    const mode = this.modeById(s.activeModeId)
    return s.general.autoSuggest && (mode?.autoSuggest ?? true)
  }

  private modeById(id: string) {
    return this.deps.modes.modes.get(id) ?? undefined
  }

  private maybeShowHeadphonesTip(): void {
    const s = this.ctx.settings.get()
    if (s.general.headphonesTipShown) return
    this.ctx.settings.update({ general: { headphonesTipShown: true } })
    this.toggleWarning('use_headphones', true)
  }

  private toggleWarning(code: SessionWarningCode, active: boolean): void {
    const has = this.state.warnings.includes(code)
    if (active === has) return
    this.patch({
      warnings: active
        ? [...this.state.warnings, code]
        : this.state.warnings.filter((w) => w !== code),
    })
  }

  private patch(p: Partial<LiveSessionState>): void {
    this.state = { ...this.state, ...p }
    this.emit()
  }

  private emit(): void {
    this.ctx.events.broadcast('session:state', structuredClone(this.state))
  }
}
