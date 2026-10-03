/**
 * Decides when to stream an automatic "What should I say?" answer after the other person asks
 * a question.
 *
 * Flow: a finalized Them line that reads as a question creates a pending trigger and starts a
 * debounce (700 ms by default). If they keep talking, each new Them line is merged into the
 * trigger and the debounce restarts, so the answer covers the whole question. A Them segment
 * that ended after the question but is still being transcribed holds the run until its line
 * merges (at most `continuationWaitMs`). When I start
 * talking or trigger something manually, the pending trigger is dropped. When the debounce
 * elapses the run is skipped if auto-suggest is off, if the previous auto run STARTED less than
 * the cooldown (8 s) ago, or if one is still in flight; otherwise `run()` is called and tracked
 * until its promise settles. Never more than one auto run is in flight.
 */
import type { TranscriptLine } from '@shared/types'
import { detectQuestion } from './questionDetector'

export interface AutoTrigger {
  /** Them line ids that make up the question, oldest first. */
  lineIds: string[]
  /** The merged text of those lines. */
  text: string
  /** Epoch ms when VAD saw the end of the latest merged line (latency tracing), if known. */
  vadEndAt: number | null
  /** now() when the first line was detected as a question. */
  detectedAt: number
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type AutoSkipReason = 'disabled' | 'cooldown' | 'in-flight'

export interface AutoSuggestSchedulerOptions {
  debounceMs?: number
  cooldownMs?: number
  /** Read at decision time so toggling the setting applies immediately. */
  isEnabled: () => boolean
  detect?: typeof detectQuestion
  /** Language hint for the detector (e.g. settings.language.transcription). */
  language?: () => string | undefined
  /**
   * Streams the auto answer. The signal aborts when a manual request supersedes it or the
   * scheduler is disposed; the run should then settle promptly.
   */
  run: (trigger: AutoTrigger, signal: AbortSignal) => Promise<void>
  now?: () => number
  timers?: SchedulerTimers
  /** run() rejected or threw. */
  onError?: (err: unknown) => void
  /** A debounced trigger was dropped instead of run (diagnostics). */
  onSkip?: (reason: AutoSkipReason, trigger: AutoTrigger) => void
  /**
   * Count the debounce from the moment the speaker stopped (the line's VAD end) instead of from
   * when transcription returned. VAD already waited for a pause and speech-to-text took time, so
   * this removes dead time without shortening the real silence the spec asks for.
   */
  anchorToVadEnd?: boolean
  /**
   * Longest hold, counted from a segment's VAD end, while a Them segment that ended after the
   * question is still being transcribed (see onThemSegment). Default 2000 ms.
   */
  continuationWaitMs?: number
}

export interface AutoSuggestState {
  pending: boolean
  inFlight: boolean
  lastRunAt: number | null
  cooldownRemainingMs: number
}

export type ThemLineOutcome = 'pending' | 'merged' | 'ignored'

type ThemLine = Pick<TranscriptLine, 'id' | 'text' | 'isFinal' | 'startMs'>
type MeLine = Pick<TranscriptLine, 'startMs' | 'endMs'>

interface Pending {
  trigger: AutoTrigger
  /** Session-relative start of the first Them line, to ignore Me speech from before the question. */
  startMs: number
  /** Latest VAD end of a later Them segment that produced no line (the debounce counts from it). */
  silentUntil: number | null
}

/** In-flight Them segments older than this are forgotten (their outcome was never reported). */
const IN_FLIGHT_TTL_MS = 60_000

function latest(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null
  return b == null ? a : Math.max(a, b)
}

const defaultTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class AutoSuggestScheduler {
  private debounceMs: number
  private cooldownMs: number
  private readonly continuationWaitMs: number
  private readonly detect: typeof detectQuestion
  private readonly now: () => number
  private readonly timers: SchedulerTimers
  private pending: Pending | null = null
  private timer: unknown = null
  private inFlight: AbortController | null = null
  private lastRunAt: number | null = null
  private themSpeaking = false
  /** Them segments sent to speech-to-text whose line has not arrived: id → VAD end (epoch ms). */
  private readonly themInFlight = new Map<string, number>()
  private disposed = false

  constructor(private readonly opts: AutoSuggestSchedulerOptions) {
    this.debounceMs = Math.max(0, opts.debounceMs ?? 700)
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 8000)
    this.continuationWaitMs = Math.max(0, opts.continuationWaitMs ?? 2000)
    this.detect = opts.detect ?? detectQuestion
    this.now = opts.now ?? Date.now
    this.timers = opts.timers ?? defaultTimers
  }

  /**
   * A finalized Them line. Merges into a pending trigger (restarting the debounce) or, when the
   * line is a question, starts a new one. A pending trigger stays even if the continuation
   * itself is not a question ("How would you approach it… given our budget").
   */
  onThemLine(line: ThemLine, meta: { vadEndAt: number | null }): ThemLineOutcome {
    if (this.disposed || !line.isFinal) return 'ignored'
    this.themInFlight.delete(line.id)
    const text = line.text.trim()
    if (!text) return 'ignored'
    if (this.pending) {
      const t = this.pending.trigger
      if (t.lineIds.includes(line.id)) return 'ignored'
      // Speech from before the question that was transcribed late is not a continuation.
      if (line.startMs < this.pending.startMs) return 'ignored'
      t.lineIds.push(line.id)
      t.text = `${t.text} ${text}`
      // Lines can arrive out of order (a slow request); keep the latest end of speech.
      t.vadEndAt = latest(t.vadEndAt, meta.vadEndAt)
      this.armTimer()
      return 'merged'
    }
    if (!this.opts.isEnabled()) return 'ignored'
    if (!this.detect(text, { language: this.opts.language?.() }).isQuestion) return 'ignored'
    this.pending = {
      trigger: { lineIds: [line.id], text, vadEndAt: meta.vadEndAt, detectedAt: this.now() },
      startMs: line.startMs,
      silentUntil: null,
    }
    this.armTimer()
    return 'pending'
  }

  /**
   * I started talking: drop the pending trigger. Pass the Me line so speech that ended before the
   * question started (finalized late by speech-to-text) does not cancel it.
   */
  onMeLine(line?: MeLine): void {
    if (!this.pending) return
    if (line && line.endMs < this.pending.startMs) return
    this.cancelPending()
  }

  /**
   * The other person is talking right now (live VAD signal from the capture). A pending trigger
   * is held until they stop — their next line will merge into it — then the debounce restarts.
   */
  setThemSpeaking(speaking: boolean): void {
    if (this.disposed || speaking === this.themSpeaking) return
    this.themSpeaking = speaking
    if (!this.pending) return
    if (speaking) {
      if (this.timer !== null) this.timers.clearTimeout(this.timer)
      this.timer = null
    } else {
      this.armTimer(true)
    }
  }

  /**
   * A Them segment went to speech-to-text; its line will arrive with the same `id`. If it ended
   * after the pending question, the run waits for that line so the continuation is merged:
   * speech-to-text (~0.5–1.5 s) is usually slower than the debounce, so without this the answer
   * would cover only the first fragment of the question.
   */
  onThemSegment(id: string, vadEndAt: number): void {
    if (this.disposed) return
    const now = this.now()
    for (const [key, end] of this.themInFlight) {
      if (now - end > IN_FLIGHT_TTL_MS) this.themInFlight.delete(key)
    }
    this.themInFlight.set(id, vadEndAt)
    if (this.timer !== null && this.endedAfterPending(vadEndAt)) this.armTimer()
  }

  /**
   * That segment will not produce a line (silence, hallucination, error, cancelled). If the run
   * was waiting for it, the debounce now counts from the end of that speech.
   */
  onThemSegmentDone(id: string): void {
    const end = this.themInFlight.get(id)
    if (end === undefined || !this.themInFlight.delete(id) || this.disposed) return
    if (!this.pending || !this.endedAfterPending(end)) return
    this.pending.silentUntil = Math.max(this.pending.silentUntil ?? end, end)
    if (this.timer !== null) this.armTimer()
  }

  /** A manual action supersedes auto-suggest: drop the pending trigger and abort an in-flight run. */
  notifyManualRequest(): void {
    this.cancelPending()
    this.inFlight?.abort()
  }

  setConfig(cfg: { debounceMs?: number; cooldownMs?: number }): void {
    if (cfg.debounceMs !== undefined) this.debounceMs = Math.max(0, cfg.debounceMs)
    if (cfg.cooldownMs !== undefined) this.cooldownMs = Math.max(0, cfg.cooldownMs)
  }

  state(): AutoSuggestState {
    return {
      pending: this.pending !== null,
      inFlight: this.inFlight !== null,
      lastRunAt: this.lastRunAt,
      cooldownRemainingMs: this.cooldownRemaining(),
    }
  }

  /** Stops timers and aborts an in-flight run; later calls are ignored. */
  dispose(): void {
    this.disposed = true
    this.cancelPending()
    this.themInFlight.clear()
    this.inFlight?.abort()
  }

  private cooldownRemaining(): number {
    if (this.lastRunAt === null) return 0
    return Math.max(0, this.lastRunAt + this.cooldownMs - this.now())
  }

  private armTimer(fromNow = false): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    if (this.themSpeaking) return // held until the speaker pauses (setThemSpeaking(false))
    let delay = this.debounceMs
    const anchor = latest(this.pending?.trigger.vadEndAt, this.pending?.silentUntil)
    const waitUntil = this.continuationDeadline()
    if (waitUntil !== null) {
      delay = Math.max(0, waitUntil - this.now())
    } else if (this.opts.anchorToVadEnd && !fromNow && anchor != null) {
      delay = Math.min(this.debounceMs, Math.max(0, anchor + this.debounceMs - this.now()))
    }
    this.timer = this.timers.setTimeout(() => this.fire(), delay)
  }

  private endedAfterPending(vadEndAt: number): boolean {
    const after = this.pending?.trigger.vadEndAt
    return after != null && vadEndAt > after
  }

  /**
   * While Them segments that ended after the latest merged line are still being transcribed:
   * the time to stop waiting for them. Null when there is nothing to wait for.
   */
  private continuationDeadline(): number | null {
    let deadline: number | null = null
    for (const end of this.themInFlight.values()) {
      if (!this.endedAfterPending(end)) continue
      const until = end + this.continuationWaitMs
      if (deadline === null || until > deadline) deadline = until
    }
    return deadline
  }

  private cancelPending(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private fire(): void {
    this.timer = null
    const pending = this.pending
    this.pending = null
    if (!pending || this.disposed) return
    const { trigger } = pending
    const skip = !this.opts.isEnabled()
      ? 'disabled'
      : this.inFlight
        ? 'in-flight'
        : this.cooldownRemaining() > 0
          ? 'cooldown'
          : null
    if (skip) {
      this.opts.onSkip?.(skip, trigger)
      return
    }
    this.lastRunAt = this.now()
    const controller = new AbortController()
    this.inFlight = controller
    let promise: Promise<void>
    try {
      promise = Promise.resolve(this.opts.run(trigger, controller.signal))
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise
      .catch((err: unknown) => this.opts.onError?.(err))
      .finally(() => {
        if (this.inFlight === controller) this.inFlight = null
      })
  }
}
