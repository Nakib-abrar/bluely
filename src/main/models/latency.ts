import { t } from '@shared/i18n'
import type { LatencyTestProgress, ModelStat, SpeedStats } from '@shared/types'
import { AppError } from '../errors'
import type { EventBus } from '../ipc/events'
import type { Logger } from '../log'
import { ProviderError } from '../providers/errors'
import type { LLMProvider, ProviderRouting } from '../providers/llm/LLMProvider'
import { modelMessage } from './messages'
import { summarizeSamples, type LatencySample, type ModelStatsRepo } from './statsRepo'

/** Tag on latency-test requests (lets usage hooks skip double-recording samples). */
export const LATENCY_TEST_TAG = 'latency_test'
export const LATENCY_TEST_PROMPT = 'Reply with the single word: ok'
export const DEFAULT_LATENCY_RUNS = 5
const MAX_RUNS = 10

export interface LatencyTesterOptions {
  llm: LLMProvider
  stats: ModelStatsRepo
  events: Pick<EventBus, 'broadcast'>
  log: Logger
  /** The user's routing for a model (sort is forced to 'latency' for the test). */
  getRouting: (model: string) => ProviderRouting
  /** Wall clock for ModelStat.updatedAt. */
  now?: () => number
  newRunId?: () => string
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

function friendlyError(err: unknown): string {
  if (err instanceof ProviderError) return err.message
  return t('errors.unknown')
}

/**
 * "Run latency test" in Settings › AI Models: `runs` tiny requests per model, strictly
 * sequential so requests don't compete for bandwidth, reporting progress over
 * 'models:latencyProgress'. A failing request is reported and the run continues.
 */
export class LatencyTester {
  private current: { runId: string; controller: AbortController; done: Promise<void> } | null = null
  private readonly now: () => number
  private readonly newRunId: () => string

  constructor(private readonly opts: LatencyTesterOptions) {
    this.now = opts.now ?? Date.now
    this.newRunId = opts.newRunId ?? (() => globalThis.crypto.randomUUID())
  }

  isRunning(): boolean {
    return this.current !== null
  }

  /** Starts a test in the background and returns its run id. Throws AppError('busy') if one is running. */
  start(models: string[], runs: number = DEFAULT_LATENCY_RUNS): string {
    if (this.current) throw new AppError('busy', modelMessage('latencyBusy'))
    const unique = [...new Set(models.map((m) => m.trim()).filter((m) => m.length > 0))]
    if (unique.length === 0) throw new AppError('invalid_payload', modelMessage('latencyNoModels'))
    const count = Math.min(MAX_RUNS, Math.max(1, Math.floor(Number.isFinite(runs) ? runs : 1)))
    const runId = this.newRunId()
    const controller = new AbortController()
    const done = this.run(runId, unique, count, controller.signal)
      .catch((err: unknown) => this.opts.log.error('Latency test crashed', err))
      .finally(() => {
        if (this.current?.runId === runId) this.current = null
      })
    this.current = { runId, controller, done }
    return runId
  }

  /** Stops the running test (in-flight request aborted; unfinished models get a final event). */
  cancel(): void {
    this.current?.controller.abort()
  }

  /** Resolves when no test is running (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await this.current?.done
  }

  private emit(p: LatencyTestProgress): void {
    this.opts.events.broadcast('models:latencyProgress', p)
  }

  private async run(
    runId: string,
    models: string[],
    runs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { llm, stats, log } = this.opts
    this.opts.log.info(`Latency test ${runId}: ${models.join(', ')} × ${runs}`)
    for (const model of models) {
      const errors: string[] = []
      const samples: LatencySample[] = []
      const providers: string[] = []
      let completed = 0
      const routing: ProviderRouting = { ...this.opts.getRouting(model), sort: 'latency' }
      for (let i = 0; i < runs && !signal.aborted; i++) {
        // undici returns a finished socket to the pool on a later event-loop turn. Without this
        // yield, back-to-back requests alternate between two sockets and the second one pays a
        // TLS handshake that would show up as TTFT.
        await yieldToEventLoop()
        try {
          let stat: SpeedStats | null = null
          for await (const ev of llm.streamChat({
            model,
            messages: [{ role: 'user', content: LATENCY_TEST_PROMPT }],
            maxTokens: 5,
            temperature: 0,
            routing,
            signal,
            tag: LATENCY_TEST_TAG,
          })) {
            if (ev.type === 'done') stat = ev.stats
          }
          if (stat) {
            samples.push({
              ttftMs: stat.ttftMs,
              totalMs: stat.totalMs,
              tokensPerSec: stat.tokensPerSec,
              at: this.now(),
            })
            if (stat.provider) providers.push(stat.provider)
            stats.recordSample({
              model,
              provider: stat.provider,
              ttftMs: stat.ttftMs,
              totalMs: stat.totalMs,
              tokensPerSec: stat.tokensPerSec,
            })
          }
        } catch (err) {
          if (signal.aborted) break
          log.warn(`Latency test ${model} request ${i + 1} failed`, err)
          errors.push(friendlyError(err))
        }
        completed++
        this.emit({ runId, model, completed, total: runs, result: null, errors: [...errors] })
      }
      if (signal.aborted) errors.push(modelMessage('latencyCancelled'))
      this.emit({
        runId,
        model,
        completed,
        total: runs,
        result: this.resultFor(model, providers, samples),
        errors,
      })
      if (signal.aborted) {
        // Close out the models that never started so the UI stops waiting for them.
        for (const rest of models.slice(models.indexOf(model) + 1)) {
          this.emit({
            runId,
            model: rest,
            completed: 0,
            total: runs,
            result: this.resultFor(rest, [], []),
            errors: [modelMessage('latencyCancelled')],
          })
        }
        return
      }
    }
  }

  /** This run's stat for a model; `provider` is the most frequent serving provider. */
  private resultFor(model: string, providers: string[], samples: LatencySample[]): ModelStat {
    const counts = new Map<string, number>()
    for (const p of providers) counts.set(p, (counts.get(p) ?? 0) + 1)
    let provider: string | null = null
    let best = 0
    for (const [p, c] of counts) {
      if (c > best) {
        best = c
        provider = p
      }
    }
    return summarizeSamples(model, provider, samples, this.now())
  }
}
