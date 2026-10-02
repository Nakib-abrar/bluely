import { describe, expect, it } from 'vitest'
import type { LatencyTestProgress, SpeedStats } from '@shared/types'
import { t } from '@shared/i18n'
import { openDatabase } from '@main/db/database'
import { AppError } from '@main/errors'
import { ProviderError } from '@main/providers/errors'
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  LLMProvider,
} from '@main/providers/llm/LLMProvider'
import { LATENCY_TEST_PROMPT, LATENCY_TEST_TAG, LatencyTester } from '@main/models/latency'
import { ModelStatsRepo } from '@main/models/statsRepo'
import { silentLogger } from './helpers'

type Outcome = { ttftMs: number; provider?: string } | ProviderError | 'hang'

/** Scripted LLM: outcomes per model, consumed in order. Tracks concurrency. */
class FakeLLM implements LLMProvider {
  readonly id = 'fake'
  requests: ChatRequest[] = []
  inFlight = 0
  maxInFlight = 0
  constructor(private readonly script: Record<string, Outcome[]>) {}

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    this.requests.push(req)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await new Promise((r) => setTimeout(r, 1))
      const outcome = this.script[req.model]?.shift() ?? { ttftMs: 100 }
      if (outcome instanceof ProviderError) throw outcome
      if (outcome === 'hang') {
        await new Promise<void>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new ProviderError('aborted')))
        })
        return
      }
      const stats: SpeedStats = {
        ttftMs: outcome.ttftMs,
        totalMs: outcome.ttftMs + 50,
        tokensPerSec: 80,
        tokensIn: 12,
        tokensOut: 1,
        costUsd: 0.000001,
        provider: outcome.provider ?? 'Groq',
        model: req.model,
        generationId: 'g',
      }
      yield { type: 'meta', generationId: 'g', model: req.model, provider: stats.provider }
      yield { type: 'delta', text: 'ok' }
      yield { type: 'done', finishReason: 'stop', usage: null, stats }
    } finally {
      this.inFlight--
    }
  }
  complete(): Promise<ChatResult> {
    throw new Error('not used')
  }
  async listModels() {
    return []
  }
  async prewarm() {}
}

function setup(script: Record<string, Outcome[]>) {
  const llm = new FakeLLM(script)
  const stats = new ModelStatsRepo(openDatabase(':memory:'))
  const events: LatencyTestProgress[] = []
  let ids = 0
  const tester = new LatencyTester({
    llm,
    stats,
    events: {
      broadcast: (channel, payload) => {
        expect(channel).toBe('models:latencyProgress')
        events.push(payload as LatencyTestProgress)
      },
    },
    log: silentLogger(),
    getRouting: (model) =>
      model === 'm/pinned'
        ? { sort: 'price', order: ['groq'], allowFallbacks: false }
        : { sort: 'throughput', allowFallbacks: true },
    newRunId: () => `run-${++ids}`,
  })
  return { llm, stats, events, tester }
}

describe('LatencyTester', () => {
  it('runs runs × models sequentially with a tiny latency-sorted prompt', async () => {
    const { llm, tester } = setup({})
    const runId = tester.start(['m/pinned', 'm/other'], 3)
    expect(runId).toBe('run-1')
    expect(tester.isRunning()).toBe(true)
    await tester.whenIdle()
    expect(tester.isRunning()).toBe(false)
    expect(llm.requests).toHaveLength(6)
    expect(llm.maxInFlight).toBe(1)
    expect(llm.requests.map((r) => r.model)).toEqual([
      'm/pinned',
      'm/pinned',
      'm/pinned',
      'm/other',
      'm/other',
      'm/other',
    ])
    const first = llm.requests[0]!
    expect(first).toMatchObject({
      messages: [{ role: 'user', content: LATENCY_TEST_PROMPT }],
      maxTokens: 5,
      temperature: 0,
      tag: LATENCY_TEST_TAG,
      // User's provider pins are kept; sort is forced to latency.
      routing: { sort: 'latency', order: ['groq'], allowFallbacks: false },
    })
    expect(llm.requests[3]?.routing).toEqual({ sort: 'latency', allowFallbacks: true })
  })

  it('emits progress after each request and one final event per model with this run’s stat', async () => {
    const { stats, events, tester } = setup({
      'm/a': [{ ttftMs: 300 }, { ttftMs: 100 }, { ttftMs: 200 }, { ttftMs: 500 }, { ttftMs: 400 }],
    })
    // An older sample must not leak into this run's result.
    stats.recordSample({
      model: 'm/a',
      provider: 'Groq',
      ttftMs: 5000,
      totalMs: 6000,
      tokensPerSec: 1,
    })
    const runId = tester.start(['m/a'])
    await tester.whenIdle()
    expect(events).toHaveLength(6)
    expect(events.slice(0, 5).map((e) => [e.completed, e.total, e.result])).toEqual([
      [1, 5, null],
      [2, 5, null],
      [3, 5, null],
      [4, 5, null],
      [5, 5, null],
    ])
    const final = events[5]!
    expect(final).toMatchObject({ runId, model: 'm/a', completed: 5, total: 5, errors: [] })
    expect(final.result).toMatchObject({
      model: 'm/a',
      provider: 'Groq',
      samples: 5,
      ttftP50: 300,
      ttftP90: 500,
      totalP50: 350,
      tokensPerSecP50: 80,
    })
    // Every sample was also recorded in the rolling stats (5 new + 1 old).
    expect(stats.get('m/a', 'Groq')?.samples).toBe(6)
  })

  it('collects friendly errors without aborting the run', async () => {
    const { events, tester, llm } = setup({
      'm/a': [
        { ttftMs: 100 },
        new ProviderError('rate_limit', { retryAfterSec: 2 }),
        { ttftMs: 120 },
      ],
      'm/b': [new ProviderError('model_unavailable'), new ProviderError('model_unavailable')],
    })
    tester.start(['m/a', 'm/b'], 3)
    await tester.whenIdle()
    expect(llm.requests).toHaveLength(6)
    const finals = events.filter((e) => e.result !== null)
    expect(finals.map((e) => e.model)).toEqual(['m/a', 'm/b'])
    expect(finals[0]?.errors).toEqual([t('errors.rate_limit')])
    expect(finals[0]?.result?.samples).toBe(3 - 1)
    expect(finals[1]?.errors).toEqual([
      t('errors.model_unavailable'),
      t('errors.model_unavailable'),
    ])
    expect(finals[1]?.result).toMatchObject({ samples: 1, ttftP50: 100 })
    // Progress events carry the errors so far.
    expect(events.find((e) => e.model === 'm/a' && e.completed === 2)?.errors).toEqual([
      t('errors.rate_limit'),
    ])
  })

  it('rejects a second start while running (busy) and allows one afterwards', async () => {
    const { tester } = setup({})
    tester.start(['m/a'], 2)
    let err: unknown
    try {
      tester.start(['m/b'])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'busy' })
    await tester.whenIdle()
    expect(tester.start(['m/b'], 1)).toBe('run-2')
    await tester.whenIdle()
  })

  it('cancel aborts the in-flight request and closes out every unfinished model', async () => {
    const { tester, events, llm } = setup({ 'm/a': [{ ttftMs: 90 }, 'hang'] })
    tester.start(['m/a', 'm/b', 'm/c'], 3)
    await new Promise((r) => setTimeout(r, 20))
    expect(llm.requests).toHaveLength(2)
    tester.cancel()
    await tester.whenIdle()
    expect(llm.requests).toHaveLength(2)
    const finals = events.filter((e) => e.result !== null)
    expect(finals.map((e) => e.model)).toEqual(['m/a', 'm/b', 'm/c'])
    expect(finals[0]).toMatchObject({ completed: 1, result: { samples: 1 } })
    expect(finals[0]?.errors).toEqual(['Latency test cancelled.'])
    expect(finals[2]).toMatchObject({ completed: 0, result: { samples: 0, ttftP50: null } })
    expect(tester.isRunning()).toBe(false)
  })

  it('deduplicates models, clamps runs and rejects an empty list', async () => {
    const { tester, llm } = setup({})
    tester.start(['m/a', ' m/a ', 'm/a'], 99)
    await tester.whenIdle()
    expect(llm.requests).toHaveLength(10)
    expect(() => tester.start([' '])).toThrow(AppError)
  })
})
