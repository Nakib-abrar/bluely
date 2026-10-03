import type { SpeedStats, TranscriptLine } from '@shared/types'
import type { Logger } from '../log'
import type { ChatMessage, LLMProvider, ProviderRouting } from '../providers/llm/LLMProvider'
import { answerBudget } from '../providers/llm/reasoning'
import { PROMPT_SPEAKER, formatTimestamp, mergeTranscriptLines, usableLines } from './format'
import { actionInstruction } from './prompts'
import { estimateMessagesTokens, estimateTokens } from './tokens'

export interface RunningSummarizerOptions {
  llm: LLMProvider
  /** Read at each run so a model change in Settings applies mid-call. Usually the Fast model. */
  getModel: () => { model: string; routing?: ProviderRouting }
  /** Minimum time between runs (Settings › Advanced › summary interval, default 3 min). */
  intervalMs: number
  /** Verbatim window; only lines that started before `nowMs - windowMs` are summarized. */
  windowMs: number
  log: Logger
  onUpdate?: (summary: string, stats: SpeedStats) => void
  /** Clock for interval gating (injected in tests). Default Date.now. */
  now?: () => number
  /**
   * Cap on new transcript per run (estimated tokens). A larger backlog is folded in over the
   * following runs, oldest first, so one request never gets huge. Default 8000.
   */
  maxNewTokens?: number
}

/** Generous cap: the prompt asks for ≤ 150 words, but reasoning models spend output tokens too. */
const SUMMARY_MAX_TOKENS = 800
const DEFAULT_MAX_NEW_TOKENS = 8000

/** Chat messages for one summary update (exported for tests and dev tooling). */
export function summaryMessages(previous: string | null, lines: TranscriptLine[]): ChatMessage[] {
  const transcript = mergeTranscriptLines(lines)
    .map((b) => `[${formatTimestamp(b.startMs)}] ${PROMPT_SPEAKER[b.channel]}: ${b.text}`)
    .join('\n')
  return [
    {
      role: 'system',
      content: [
        'You maintain the running summary of a live conversation for Bluely, an AI meeting copilot. "Me" is the user; "Them" is the other participants. Never invent anything that is not in the previous summary or the new lines.',
        actionInstruction('summary', { modeId: '' }),
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        `## Previous summary\n${previous?.trim() || '(none yet)'}`,
        `## New transcript lines\n${transcript}`,
        'Write the updated running summary.',
      ].join('\n\n'),
    },
  ]
}

/**
 * Keeps a short running summary of the transcript that has aged out of the verbatim context
 * window, so live prompts stay small however long the call runs. Updates run in the background
 * on the Fast model: `maybeUpdate()` never throws, never waits, and at most one request is in
 * flight. A failed update keeps the previous summary and is retried after the interval.
 */
export class RunningSummarizer {
  private summary: string | null = null
  private covered = 0
  /** Lines before this were covered by a restored summary (see restore()). */
  private restoredUntil = 0
  private readonly summarizedIds = new Set<string>()
  private lastRunAt = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null
  private controller: AbortController | null = null
  private disposed = false
  private readonly now: () => number

  constructor(private readonly opts: RunningSummarizerOptions) {
    this.now = opts.now ?? Date.now
  }

  /**
   * Call whenever the transcript changes (cheap). Starts a background update when lines older
   * than the window exist that the summary does not cover yet, ≥ intervalMs passed since the
   * last run, and nothing is in flight. `nowMs` is the session clock (ms since start).
   */
  maybeUpdate(lines: TranscriptLine[], nowMs: number): void {
    try {
      if (this.disposed || this.inFlight) return
      const now = this.now()
      if (now - this.lastRunAt < this.opts.intervalMs) return
      const cutoff = nowMs - this.opts.windowMs
      const pending = usableLines(lines).filter(
        (l) =>
          l.startMs < cutoff && l.startMs >= this.restoredUntil && !this.summarizedIds.has(l.id),
      )
      if (pending.length === 0) return
      const batch = this.takeBatch(pending)
      this.lastRunAt = now
      this.inFlight = this.run(batch).finally(() => {
        this.inFlight = null
      })
    } catch (err) {
      this.opts.log.warn('running summary: scheduling failed', err)
    }
  }

  /** The latest summary, or null before the first successful run. */
  current(): string | null {
    return this.summary
  }

  /** Lines with startMs below this are represented by the summary (0 = none). */
  coveredUntilMs(): number {
    return this.covered
  }

  /** True while an update request is running. */
  isUpdating(): boolean {
    return this.inFlight !== null
  }

  /** Resolves when no update is in flight (e.g. before saving the summary at session end). */
  whenIdle(): Promise<void> {
    return this.inFlight ?? Promise.resolve()
  }

  /** Seeds state from a stored summary (e.g. a recovered session). */
  restore(summary: string | null, coveredUntilMs: number): void {
    this.summary = summary?.trim() || null
    this.covered = this.summary ? Math.max(0, coveredUntilMs) : 0
    this.restoredUntil = this.covered
  }

  /** Aborts any in-flight update; later calls are ignored. */
  dispose(): void {
    this.disposed = true
    this.controller?.abort()
    this.controller = null
  }

  private takeBatch(pending: TranscriptLine[]): TranscriptLine[] {
    const cap = this.opts.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS
    const batch: TranscriptLine[] = []
    let tokens = 0
    for (const line of pending) {
      const cost = estimateTokens(line.text) + 8
      if (batch.length > 0 && tokens + cost > cap) break
      batch.push(line)
      tokens += cost
    }
    return batch
  }

  private async run(batch: TranscriptLine[]): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try {
      const { model, routing } = this.opts.getModel()
      const messages = summaryMessages(this.summary, batch)
      this.opts.log.debug('running summary: updating', {
        model,
        lines: batch.length,
        promptTokens: estimateMessagesTokens(messages),
      })
      // A reasoning Fast model could otherwise spend all 800 tokens thinking and return nothing.
      const budget = answerBudget(model, SUMMARY_MAX_TOKENS)
      const res = await this.opts.llm.complete({
        model,
        routing,
        messages,
        temperature: 0.2,
        maxTokens: budget.maxTokens,
        ...(budget.reasoning ? { reasoning: budget.reasoning } : {}),
        signal: controller.signal,
        tag: 'summary',
      })
      if (this.disposed) return
      const text = res.text.trim()
      if (!text) {
        this.opts.log.warn('running summary: empty response; keeping the previous summary')
        return
      }
      this.summary = text
      for (const line of batch) this.summarizedIds.add(line.id)
      const lastStart = batch.reduce((max, l) => Math.max(max, l.startMs), 0)
      this.covered = Math.max(this.covered, lastStart + 1)
      try {
        this.opts.onUpdate?.(text, res.stats)
      } catch (err) {
        this.opts.log.warn('running summary: onUpdate threw', err)
      }
    } catch (err) {
      if (!this.disposed) this.opts.log.warn('running summary: update failed', err)
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}
