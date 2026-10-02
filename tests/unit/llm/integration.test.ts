import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockOpenRouter, type MockOpenRouter } from '../../../scripts/mock-openrouter.mjs'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import { OpenRouterLLM, type ChatFinishedInfo } from '@main/providers/llm/openrouter'
import type { ChatStreamEvent } from '@main/providers/llm/LLMProvider'
import { ModelCatalog } from '@main/models/catalog'
import { testKey } from '@main/models/keyInfo'
import { collect, silentLogger } from './helpers'

/**
 * End-to-end through the REAL OpenRouterHttp (undici keep-alive agent) against the local mock
 * OpenRouter server: SSE streaming, usage, /generation, /key, /models and error paths.
 */
let mock: MockOpenRouter
const opened: OpenRouterHttp[] = []

function client(key: string | null = 'sk-or-test-integration-1234') {
  const log = silentLogger()
  const http = new OpenRouterHttp({ baseUrl: mock.baseUrl, getKey: () => key, log })
  opened.push(http)
  const finished: ChatFinishedInfo[] = []
  const catalog = new ModelCatalog({
    http,
    log,
    cacheFile: join(mkdtempSync(join(tmpdir(), 'bluely-int-')), 'models-cache.json'),
  })
  const llm = new OpenRouterLLM({ http, log, catalog, onFinished: (i) => finished.push(i) })
  return { http, llm, catalog, finished }
}

const user = (content: string) => [{ role: 'user' as const, content }]

beforeAll(async () => {
  mock = await startMockOpenRouter({ ttftMs: 20, tokenMs: 2 })
})
afterAll(async () => {
  await Promise.all(opened.map((h) => h.close()))
  await mock.close()
})

describe('OpenRouterLLM ↔ mock OpenRouter (real undici)', () => {
  it('streams a chat completion with meta, deltas, usage and speed stats', async () => {
    const { llm, finished } = client()
    const events = await collect(
      llm.streamChat({
        model: 'meta-llama/llama-3.3-70b-instruct',
        messages: user('What does the enterprise plan cost?'),
        maxTokens: 200,
        routing: { sort: 'latency', order: ['groq'], allowFallbacks: true },
        tag: 'integration',
      }),
    )
    expect(events[0]).toMatchObject({
      type: 'meta',
      model: 'meta-llama/llama-3.3-70b-instruct',
      provider: 'Groq',
    })
    const deltas = events.filter(
      (e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta',
    )
    expect(deltas.length).toBeGreaterThan(5)
    expect(deltas.map((d) => d.text).join('')).toContain('enterprise plan')
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>
    expect(done.type).toBe('done')
    expect(done.finishReason).toBe('stop')
    expect(done.usage?.completionTokens).toBe(deltas.length)
    expect(done.usage?.costUsd).toBeGreaterThan(0)
    expect(done.stats.provider).toBe('Groq')
    expect(done.stats.generationId).toMatch(/^gen-mock-/)
    expect(done.stats.ttftMs).toBeGreaterThanOrEqual(15)
    expect(done.stats.totalMs).toBeGreaterThanOrEqual(done.stats.ttftMs ?? 0)
    expect(done.stats.tokensPerSec).toBeGreaterThan(0)
    expect(finished).toHaveLength(1)

    const rec = mock.requests.filter((r) => r.path === '/chat/completions').at(-1)
    expect(rec?.headers).toMatchObject({
      referer: 'https://github.com/nakib-abrar/bluely',
      title: 'Bluely',
    })
    expect(rec?.headers.authorization).toMatch(/^Bearer sk-or/)
    expect(rec?.body).toMatchObject({
      model: 'meta-llama/llama-3.3-70b-instruct',
      stream: true,
      max_tokens: 200,
      provider: { sort: 'latency', order: ['groq'], allow_fallbacks: true },
      usage: { include: true },
    })

    // Exact stats from /generation afterwards.
    const exact = await llm.getGenerationStats(done.stats.generationId ?? '')
    expect(exact).toMatchObject({ provider: 'Groq', ttftMs: 20, tokensOut: deltas.length })
  })

  it('complete() returns the full text; JSON mode is forwarded', async () => {
    const { llm } = client()
    const res = await llm.complete({
      model: 'google/gemini-2.5-flash',
      messages: user('Write the meeting notes'),
      responseFormat: 'json_object',
    })
    expect(JSON.parse(res.text)).toMatchObject({ title: expect.any(String) })
    expect(res.stats.provider).toBe('Google')
  })

  it('maps a mid-stream error event after partial text', async () => {
    const { llm } = client()
    const seen: string[] = []
    const err = await (async () => {
      for await (const e of llm.streamChat({
        model: 'openai/gpt-4o-mini',
        messages: user('__midstream_error__ hello'),
      }))
        if (e.type === 'delta') seen.push(e.text)
    })().catch((e: unknown) => e)
    expect(seen.length).toBe(3)
    expect(err).toMatchObject({ code: 'server', status: 502 })
  })

  it('maps 429 (Retry-After), 500, unknown model and bad keys', async () => {
    const { llm } = client()
    const run = (content: string, model = 'openai/gpt-4o-mini') =>
      collect(llm.streamChat({ model, messages: user(content) })).catch((e: unknown) => e)
    expect(await run('__error_429__')).toMatchObject({ code: 'rate_limit', retryAfterSec: 2 })
    expect(await run('__error_500__')).toMatchObject({ code: 'server' })
    expect(await run('hi', 'acme/does-not-exist')).toMatchObject({ code: 'model_unavailable' })
    const bad = client('sk-or-bad-key-123456')
    await expect(
      collect(bad.llm.streamChat({ model: 'openai/gpt-4o-mini', messages: user('hi') })),
    ).rejects.toMatchObject({ code: 'auth' })
    const broke = client('sk-or-nocredits-123456')
    await expect(
      broke.llm.complete({ model: 'openai/gpt-4o-mini', messages: user('hi') }),
    ).rejects.toMatchObject({ code: 'credits' })
  })

  it('aborting mid-stream stops promptly with ProviderError("aborted")', async () => {
    const { llm } = client()
    const ac = new AbortController()
    let deltas = 0
    const started = Date.now()
    const err = await (async () => {
      for await (const e of llm.streamChat({
        model: 'openai/gpt-4o-mini',
        messages: user('Give me a recap'),
        signal: ac.signal,
      })) {
        if (e.type === 'delta' && ++deltas === 2) ac.abort()
      }
    })().catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'aborted' })
    expect(Date.now() - started).toBeLessThan(2000)
    // The connection pool is still usable afterwards.
    const res = await llm.complete({ model: 'openai/gpt-4o-mini', messages: user('hi') })
    expect(res.text.length).toBeGreaterThan(0)
  })

  it('reads /key through testKey and lists models through the catalog', async () => {
    const { http, catalog } = client()
    const key = await testKey(http)
    expect(key).toMatchObject({
      ok: true,
      limit: 20,
      usage: 3.21,
      remaining: 16.79,
      isFreeTier: false,
      error: null,
    })
    expect(key.latencyMs).toBeGreaterThanOrEqual(0)

    const bad = await testKey(client('sk-or-bad-123456789').http)
    expect(bad).toMatchObject({ ok: false, error: { code: 'auth' } })

    const models = await catalog.list()
    expect(models.length).toBe(9)
    expect(catalog.getById('openai/whisper-large-v3-turbo')).toMatchObject({
      isStt: true,
      supportsAudioInput: true,
      pricing: { audio: 0.00000011 },
    })
    expect(catalog.getById('google/gemini-2.5-flash')).toMatchObject({
      supportsVision: true,
      isStt: false,
    })
    expect(catalog.sttModels()).toHaveLength(2)
  })

  it('prewarm hits the API without throwing', async () => {
    const { llm } = client()
    const before = mock.requests.length
    await llm.prewarm()
    expect(mock.requests.length).toBe(before + 1)
    expect(mock.requests.at(-1)?.path).toBe('/key')
  })
})
