import type {
  Channel,
  ChannelState,
  LiveSessionState,
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
 */
export class SessionManager implements LiveContextSource {
  private state: LiveSessionState
  private buffer = new TranscriptBuffer()
  private deduper = new EchoDeduper()
  private scheduler: AutoSuggestScheduler
  private summarizer: RunningSummarizer | null = null
  private queue: TranscriptionQueue | null = null
  private sttTiming = new Map<string, { vadEndAt: number; sttDoneAt: number }>()
  private audioStoppedResolver: (() => void) | null = null
  private stopPromise: Promise<void> | null = null

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
      isEnabled: () => this.autoSuggestEnabled() && !this.deps.ai.isLiveBusy(),
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
      if (
        next.general.autoSuggest !== prev.general.autoSuggest ||
        next.activeModeId !== prev.activeModeId
      ) {
        this.patch({ autoSuggest: this.autoSuggestEnabled(), modeId: next.activeModeId })
      }
    })
  }

  // ── LiveContextSource ─────────────────────────────────────────────────────

  sessionId(): string | null {
    return this.state.sessionId
  }

  elapsedMs(): number {
    return this.state.startedAt ? Date.now() - this.state.startedAt : 0
  }

  transcript(): TranscriptLine[] {
    return this.buffer.finals()
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

  getTranscript(sessionId: string): TranscriptLine[] {
    if (sessionId === this.state.sessionId) return this.buffer.all()
    return this.deps.history.transcript.listBySession(sessionId, { finalOnly: false })
  }

  toggle(): void {
    if (this.isLive()) void this.stop()
    else if (this.state.status === 'idle')
      this.start().catch((err) => this.ctx.log.error('Start failed', err))
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
    this.buffer = new TranscriptBuffer()
    this.deduper = new EchoDeduper({ windowMs: 3000, threshold: 0.8 })
    this.sttTiming.clear()
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
    this.emit()
    this.ctx.events.broadcast('sessions:changed', { id: session.id })
    this.ctx.overlay.show(false)
    void this.deps.models.llm.prewarm()
    this.ctx.log.info(`Session ${session.id} started (mode ${activeModeId})`)
    return { sessionId: session.id }
  }

  /** Stop → flush audio → drain STT → post-call notes. Safe to call repeatedly. */
  stop(): Promise<void> {
    if (!this.isLive() || !this.state.sessionId) return Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.doStop().finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  private async doStop(): Promise<void> {
    const sessionId = this.state.sessionId as string
    const modeId = this.state.modeId
    this.patch({ status: 'stopping' })
    this.scheduler.notifyManualRequest()
    this.scheduler.setThemSpeaking(false)
    // The overlay flushes trailing speech and calls 'audio:stopped'.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AUDIO_STOP_TIMEOUT_MS)
      this.audioStoppedResolver = () => {
        clearTimeout(timer)
        resolve()
      }
      if (!this.ctx.overlay.window) {
        clearTimeout(timer)
        resolve()
      }
    })
    this.audioStoppedResolver = null
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
    this.deps.ai.cancelScope('live')
    this.deps.history.sessions.end(sessionId, Date.now())
    this.patch({
      status: 'processing',
      audio: { me: { state: 'off', error: null }, them: { state: 'off', error: null } },
      warnings: [],
      showConsentReminder: false,
    })
    this.ctx.overlay.hide()
    this.ctx.showMainWindow({ name: 'session', sessionId, tab: 'notes' })
    const sessionMode = this.modeById(modeId) ?? this.deps.ai.activeMode()
    await this.deps.postCall.run(sessionId, sessionMode)
    // A new call may have started while notes were generating; don't clobber it.
    if (this.state.sessionId === sessionId) {
      this.state = { ...idleState(this.ctx.settings.get().activeModeId) }
      this.emit()
    }
    this.ctx.log.info(`Session ${sessionId} finished`)
  }

  /** Quit during a call: keep everything already transcribed and mark it for "Generate notes". */
  async shutdown(): Promise<void> {
    const sessionId = this.state.sessionId
    this.scheduler.dispose()
    this.summarizer?.dispose()
    this.queue?.cancelAll()
    if (sessionId && this.isLive()) {
      this.deps.history.sessions.end(sessionId, Date.now())
      this.deps.history.sessions.setStatus(sessionId, 'recovered')
    }
    this.state = idleState(this.state.modeId)
  }

  regenerate(sessionId: string): void {
    const s = this.deps.history.sessions.get(sessionId)
    if (!s) throw new AppError('not_found', 'Session not found')
    if (sessionId === this.state.sessionId && this.isLive()) {
      throw new AppError('busy', 'This session is still live.')
    }
    const mode = (s.modeId && this.modeById(s.modeId)) || this.deps.ai.activeMode()
    void this.deps.postCall.run(sessionId, mode)
  }

  dismissConsent(): void {
    this.patch({ showConsentReminder: false })
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
    this.queue.enqueue(job)
    return true
  }

  setChannelStatus(
    sessionId: string,
    channel: Channel,
    state: ChannelState,
    error: string | null,
  ): void {
    if (sessionId !== this.state.sessionId) return
    const audio = { ...this.state.audio, [channel]: { state, error } }
    const anyListening = audio.me.state === 'listening' || audio.them.state === 'listening'
    const status = this.state.status === 'starting' && anyListening ? 'live' : this.state.status
    this.patch({ audio, status })
    this.ctx.events.broadcast('audio:channelStatus', { channel, status: { state, error } })
  }

  setWarning(sessionId: string, code: SessionWarningCode, active: boolean): void {
    if (sessionId !== this.state.sessionId) return
    this.toggleWarning(code, active)
  }

  setSpeaking(sessionId: string, channel: Channel, speaking: boolean): void {
    if (sessionId !== this.state.sessionId || channel !== 'them') return
    this.scheduler.setThemSpeaking(speaking)
  }

  audioStopped(sessionId: string): void {
    if (sessionId === this.state.sessionId) this.audioStoppedResolver?.()
  }

  /** Manual requests cancel a pending auto-suggestion (spec: "Cancel it if I trigger something manually"). */
  notifyManualRequest(): void {
    this.scheduler.notifyManualRequest()
  }

  // ── internals ─────────────────────────────────────────────────────────────

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
    this.toggleWarning('stt_error_retrying', false)
    if (line.channel === 'me') {
      const { drop } = this.deduper.checkMe(line)
      if (drop) {
        this.maybeShowHeadphonesTip()
        return
      }
    } else {
      // Them lines can retract Me lines that turned out to be speaker echo.
      for (const id of this.deduper.checkThem(line)) {
        this.buffer.remove(id)
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
    if (line.channel === 'them') this.scheduler.onThemLine(line, { vadEndAt: job.vadEndAt })
    else this.scheduler.onMeLine(line)
    this.summarizer?.maybeUpdate(this.buffer.finals(), this.elapsedMs())
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
    _job: TranscriptionJob,
    err: ProviderError,
    info: { willRetry: boolean },
  ): void {
    if (err.code === 'no_key' || err.code === 'auth' || err.code === 'credits') {
      this.patch({ lastError: err.message })
      if (err.code === 'no_key') this.toggleWarning('no_key', true)
    }
    this.toggleWarning('stt_error_retrying', info.willRetry)
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
