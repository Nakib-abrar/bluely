/**
 * Decides when to stream an automatic "What should I say?" answer after the other person asks
 * a question.
 *
 * Flow: a finalized Them line that reads as a question creates a pending trigger and starts a
 * debounce (700 ms by default). If they keep talking, each new Them line is merged into the
 * trigger and the debounce restarts, so the answer covers the whole question. When I start
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
}

const defaultTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class AutoSuggestScheduler {
  private debounceMs: number
  private cooldownMs: number
  private readonly detect: typeof detectQuestion
  private readonly now: () => number
  private readonly timers: SchedulerTimers
  private pending: Pending | null = null
  private timer: unknown = null
  private inFlight: AbortController | null = null
  private lastRunAt: number | null = null
  private disposed = false

  constructor(private readonly opts: AutoSuggestSchedulerOptions) {
    this.debounceMs = Math.max(0, opts.debounceMs ?? 700)
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 8000)
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
    const text = line.text.trim()
    if (!text) return 'ignored'
    if (this.pending) {
      const t = this.pending.trigger
      if (t.lineIds.includes(line.id)) return 'ignored'
      t.lineIds.push(line.id)
      t.text = `${t.text} ${text}`
      t.vadEndAt = meta.vadEndAt ?? t.vadEndAt
      this.armTimer()
      return 'merged'
    }
    if (!this.opts.isEnabled()) return 'ignored'
    if (!this.detect(text, { language: this.opts.language?.() }).isQuestion) return 'ignored'
    this.pending = {
      trigger: { lineIds: [line.id], text, vadEndAt: meta.vadEndAt, detectedAt: this.now() },
      startMs: line.startMs,
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
    this.inFlight?.abort()
  }

  private cooldownRemaining(): number {
    if (this.lastRunAt === null) return 0
    return Math.max(0, this.lastRunAt + this.cooldownMs - this.now())
  }

  private armTimer(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = this.timers.setTimeout(() => this.fire(), this.debounceMs)
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
