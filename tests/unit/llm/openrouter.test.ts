import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildChatBody,
  computeSpeedStats,
  mapGenerationStats,
  INCOMPLETE_STATS_DELAY_MS,
  OpenRouterLLM,
  toProviderPreferences,
  type ChatFinishedInfo,
  type ChatIncompleteInfo,
} from '@main/providers/llm/openrouter'
import type { ChatRequest, ChatStreamEvent } from '@main/providers/llm/LLMProvider'
import { ProviderError } from '@main/providers/errors'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import type { RequestInitLike, ResponseLike } from '@main/providers/openrouterHttp'
import { t } from '@shared/i18n'
import {
  chunk,
  collect,
  deltaChunk,
  fakeFetch,
  fakeResponse,
  fakeStream,
  jsonResponse,
  META,
  silentLogger,
  sseResponse,
  steppedClock,
  typicalStream,
} from './helpers'

const BASE = 'https://openrouter.test/api/v1'
const KEY = 'sk-or-v1-test-0123456789'

function setup(
  handler: (url: string, init: RequestInitLike, n: number) => ResponseLike | Promise<ResponseLike>,
  opts: {
    now?: () => number
    onFinished?: (i: ChatFinishedInfo) => void
    onIncomplete?: (i: ChatIncompleteInfo) => void
    idleTimeoutMs?: number
  } = {},
) {
  const fetch = fakeFetch(handler)
  const log = silentLogger()
  const http = new OpenRouterHttp({ baseUrl: BASE, getKey: () => KEY, log, fetchImpl: fetch })
  const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)
  const llm = new OpenRouterLLM({
    http,
    log,
    sleep,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onFinished ? { onFinished: opts.onFinished } : {}),
    ...(opts.onIncomplete ? { onIncomplete: opts.onIncomplete } : {}),
    ...(opts.idleTimeoutMs ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  })
  return { llm, fetch, sleep, log, http }
}

const REQ: ChatRequest = {
  model: 'meta-llama/llama-3.3-70b-instruct',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hi' },
  ],
}

const streamOf = (parts: string[], usage?: Parameters<typeof typicalStream>[1]) => () =>
  sseResponse(fakeStream(typicalStream(parts, usage)).stream)

afterEach(() => {
  vi.useRealTimers()
})

describe('request building', () => {
  it('maps routing to the provider object and omits an empty order', () => {
    expect(toProviderPreferences({ sort: 'latency', order: [], allowFallbacks: true })).toEqual({
      sort: 'latency',
      allow_fallbacks: true,
    })
    expect(
      toProviderPreferences({
        sort: 'price',
        order: ['groq', ' cerebras '],
        allowFallbacks: false,
      }),
    ).toEqual({ sort: 'price', order: ['groq', 'cerebras'], allow_fallbacks: false })
    expect(toProviderPreferences({})).toEqual({})
  })

  it('builds the full body and never appends :nitro', () => {
    const body = buildChatBody({
      ...REQ,
      maxTokens: 300,
      temperature: 0.2,
      responseFormat: 'json_object',
      routing: { sort: 'throughput', order: ['groq'], allowFallbacks: true },
    })
    expect(body).toEqual({
      model: 'meta-llama/llama-3.3-70b-instruct',
      messages: REQ.messages,
      stream: true,
      max_tokens: 300,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      provider: { sort: 'throughput', order: ['groq'], allow_fallbacks: true },
      usage: { include: true },
    })
    expect(JSON.stringify(body)).not.toContain(':nitro')
  })

  it('omits optional fields and the provider object when not requested', () => {
    const body = buildChatBody({ ...REQ, responseFormat: 'text' })
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'stream', 'usage'])
  })

  it('sends the reasoning object only when the request has one', () => {
    const body = buildChatBody({
      ...REQ,
      model: 'openai/gpt-oss-120b',
      maxTokens: 1244,
      reasoning: { effort: 'low', exclude: true },
    })
    expect(body).toMatchObject({ max_tokens: 1244, reasoning: { effort: 'low', exclude: true } })
    expect(buildChatBody({ ...REQ, reasoning: {} })).not.toHaveProperty('reasoning')
  })
})

describe('computeSpeedStats', () => {
  const base = {
    requestedModel: 'req/model',
    servedModel: null,
    provider: null,
    generationId: null,
    startedAt: 1000,
    deltaCount: 0,
    usage: null,
  }

  it('computes TTFT, total and generation-phase throughput', () => {
    const s = computeSpeedStats({
      ...base,
      firstTokenAt: 1420,
      endedAt: 2900,
      deltaCount: 50,
      usage: { promptTokens: 100, completionTokens: 279, costUsd: 0.0004 },
    })
    expect(s).toMatchObject({ ttftMs: 420, totalMs: 1900, tokensIn: 100, tokensOut: 279 })
    expect(s.tokensPerSec).toBeCloseTo(279 / 1.48, 1)
    expect(s.costUsd).toBe(0.0004)
    expect(s.model).toBe('req/model')
  })

  it('leaves reasoning tokens out of the answer throughput (they come before the first word)', () => {
    const s = computeSpeedStats({
      ...base,
      firstTokenAt: 1700,
      endedAt: 2000,
      deltaCount: 30,
      usage: { promptTokens: 10, completionTokens: 330, costUsd: 0.001, reasoningTokens: 300 },
    })
    // 30 answer tokens in 0.3 s, not 330 tokens (→ "1100 tok/s").
    expect(s.tokensPerSec).toBe(100)
    // Billing still counts every completion token.
    expect(s.tokensOut).toBe(330)
  })

  it('falls back to the delta count without usage, and to null when undefined', () => {
    expect(
      computeSpeedStats({ ...base, firstTokenAt: 1100, endedAt: 2100, deltaCount: 20 }),
    ).toMatchObject({ tokensPerSec: 20, tokensOut: null })
    expect(computeSpeedStats({ ...base, firstTokenAt: null, endedAt: 2000 }).tokensPerSec).toBe(
      null,
    )
    // Everything arrived in one chunk: no measurable generation phase.
    expect(
      computeSpeedStats({ ...base, firstTokenAt: 2000, endedAt: 2000, deltaCount: 1 }).tokensPerSec,
    ).toBe(null)
  })
})

describe('OpenRouterLLM.streamChat', () => {
  it('yields meta once, content deltas, then exactly one done with stats', async () => {
    const { llm } = setup(
      streamOf(['Hello', ' there', '!'], {
        prompt_tokens: 20,
        completion_tokens: 279,
        cost: 0.00042,
      }),
      { now: steppedClock([1000, 1420, 2900]) },
    )
    const events = await collect(llm.streamChat(REQ))
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'delta', 'delta', 'done'])
    expect(events[0]).toEqual({
      type: 'meta',
      generationId: 'gen-123',
      model: 'meta-llama/llama-3.3-70b-instruct',
      provider: 'Groq',
    })
    const text = events
      .filter((e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('Hello there!')
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>
    expect(done.finishReason).toBe('stop')
    expect(done.usage).toEqual({ promptTokens: 20, completionTokens: 279, costUsd: 0.00042 })
    expect(done.stats).toEqual({
      ttftMs: 420,
      totalMs: 1900,
      tokensPerSec: 188.5,
      tokensIn: 20,
      tokensOut: 279,
      costUsd: 0.00042,
      provider: 'Groq',
      model: 'meta-llama/llama-3.3-70b-instruct',
      generationId: 'gen-123',
    })
  })

  it('sends attribution + auth headers and the routing body to /chat/completions', async () => {
    const { llm, fetch } = setup(streamOf(['ok']))
    await collect(
      llm.streamChat({
        ...REQ,
        maxTokens: 50,
        routing: { sort: 'latency', order: ['groq', 'cerebras'], allowFallbacks: true },
      }),
    )
    expect(fetch.calls).toHaveLength(1)
    const call = fetch.calls[0]!
    expect(call.url).toBe(`${BASE}/chat/completions`)
    expect(call.init.method).toBe('POST')
    expect(call.init.headers).toMatchObject({
      'HTTP-Referer': 'https://github.com/nakib-abrar/bluely',
      'X-Title': 'Bluely',
      Authorization: `Bearer ${KEY}`,
    })
    expect(call.body).toMatchObject({
      model: 'meta-llama/llama-3.3-70b-instruct',
      stream: true,
      max_tokens: 50,
      provider: { sort: 'latency', order: ['groq', 'cerebras'], allow_fallbacks: true },
      usage: { include: true },
    })
    expect(String(call.body?.['model'])).not.toContain(':nitro')
  })

  it('ignores reasoning deltas and empty content, and uses the served model', async () => {
    const { llm } = setup(() =>
      sseResponse(
        fakeStream([
          chunk({ id: 'g1', provider: 'OpenAI', model: 'openai/gpt-4o-mini-2024-07-18' }),
          chunk({ id: 'g1', choices: [{ delta: { reasoning: 'thinking…', content: '' } }] }),
          chunk({ id: 'g1', choices: [{ delta: { reasoning_details: [{ text: 'x' }] } }] }),
          chunk({ id: 'g1', choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] }),
          'data: [DONE]\n\n',
        ]).stream,
      ),
    )
    const events = await collect(llm.streamChat({ ...REQ, model: 'openai/gpt-4o-mini' }))
    expect(events.filter((e) => e.type === 'meta')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'delta')).toEqual([{ type: 'delta', text: 'Answer' }])
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>
    expect(done.stats.model).toBe('openai/gpt-4o-mini-2024-07-18')
    expect(done.usage).toBeNull()
  })

  it('reads reasoning token counts from usage details', async () => {
    const { llm } = setup(() =>
      sseResponse(
        fakeStream([
          deltaChunk('ok'),
          chunk({
            ...META,
            choices: [],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 120,
              cost: 0.0001,
              completion_tokens_details: { reasoning_tokens: 118 },
            },
          }),
          'data: [DONE]\n\n',
        ]).stream,
      ),
    )
    const done = (await collect(llm.streamChat(REQ))).at(-1) as Extract<
      ChatStreamEvent,
      { type: 'done' }
    >
    expect(done.usage).toEqual({
      promptTokens: 9,
      completionTokens: 120,
      costUsd: 0.0001,
      reasoningTokens: 118,
    })
  })

  it('skips non-JSON data and still finishes when [DONE] is missing', async () => {
    const { llm } = setup(() =>
      sseResponse(fakeStream(['data: not json\n\n', deltaChunk('Hi')]).stream),
    )
    const events = await collect(llm.streamChat(REQ))
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'done'])
  })

  it.each([
    [401, 'auth', false],
    [402, 'credits', false],
    [404, 'model_unavailable', false],
    [500, 'server', true],
    [503, 'server', true],
    [400, 'bad_request', false],
  ] as const)('maps HTTP %i to %s', async (status, code, retryable) => {
    const { llm } = setup(() =>
      jsonResponse(status, { error: { code: status, message: 'upstream says no' } }),
    )
    const err = await collect(llm.streamChat(REQ)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code, status, retryable, message: t(`errors.${code}`) })
  })

  it('maps 429 with Retry-After to rate_limit', async () => {
    const { llm } = setup(() =>
      jsonResponse(429, { error: { code: 429, message: 'slow down' } }, { 'Retry-After': '3' }),
    )
    await expect(collect(llm.streamChat(REQ))).rejects.toMatchObject({
      code: 'rate_limit',
      retryAfterSec: 3,
      retryable: true,
    })
  })

  it('maps network failures and a missing key', async () => {
    const { llm } = setup(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    await expect(collect(llm.streamChat(REQ))).rejects.toMatchObject({ code: 'network' })

    const log = silentLogger()
    const noKey = new OpenRouterLLM({
      http: new OpenRouterHttp({
        baseUrl: BASE,
        getKey: () => null,
        log,
        fetchImpl: fakeFetch(streamOf(['x'])),
      }),
      log,
    })
    await expect(collect(noKey.streamChat(REQ))).rejects.toMatchObject({ code: 'no_key' })
  })

  it('throws a mapped ProviderError for a mid-stream error event after the deltas so far', async () => {
    const { llm } = setup(() =>
      sseResponse(
        fakeStream([
          deltaChunk('Part'),
          deltaChunk('ial'),
          chunk({
            id: 'gen-123',
            error: { code: 502, message: 'Provider disconnected' },
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
          }),
          'data: [DONE]\n\n',
        ]).stream,
      ),
    )
    const seen: ChatStreamEvent[] = []
    const err = await (async () => {
      for await (const e of llm.streamChat(REQ)) seen.push(e)
    })().catch((e: unknown) => e)
    expect(seen.map((e) => e.type)).toEqual(['meta', 'delta', 'delta'])
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'server', status: 502, detail: 'Provider disconnected' })
  })

  it('maps mid-stream errors with HTTP-like codes (e.g. 429, 402)', async () => {
    for (const [code, expected] of [
      [429, 'rate_limit'],
      [402, 'credits'],
      ['weird', 'server'],
    ] as const) {
      const { llm } = setup(() =>
        sseResponse(fakeStream([chunk({ error: { code, message: 'x' } })]).stream),
      )
      await expect(collect(llm.streamChat(REQ))).rejects.toMatchObject({ code: expected })
    }
  })

  it('treats finish_reason "error" without an error object as a server error', async () => {
    const { llm } = setup(() =>
      sseResponse(
        fakeStream([chunk({ ...META, choices: [{ delta: {}, finish_reason: 'error' }] })]).stream,
      ),
    )
    await expect(collect(llm.streamChat(REQ))).rejects.toMatchObject({ code: 'server' })
  })

  it('abort mid-stream cancels the body reader and throws aborted', async () => {
    const fs = fakeStream([deltaChunk('Hel')], { hang: true })
    const { llm, fetch } = setup(() => sseResponse(fs.stream))
    const ac = new AbortController()
    const it = llm.streamChat({ ...REQ, signal: ac.signal })[Symbol.asyncIterator]()
    expect((await it.next()).value).toMatchObject({ type: 'meta' })
    expect((await it.next()).value).toEqual({ type: 'delta', text: 'Hel' })
    const pending = it.next()
    ac.abort()
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'aborted', message: t('errors.aborted') })
    await fs.cancelled
    expect(fs.cancelSpy).toHaveBeenCalled()
    // The fetch-level signal was aborted too, so the HTTP request is torn down.
    expect(fetch.calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('an already-aborted signal throws before any request', async () => {
    const { llm, fetch } = setup(streamOf(['x']))
    const ac = new AbortController()
    ac.abort()
    await expect(collect(llm.streamChat({ ...REQ, signal: ac.signal }))).rejects.toMatchObject({
      code: 'aborted',
    })
    expect(fetch.calls).toHaveLength(0)
  })

  it('abort while waiting for headers throws aborted', async () => {
    const { llm } = setup(
      (_url, init) =>
        new Promise<ResponseLike>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    const ac = new AbortController()
    const p = collect(llm.streamChat({ ...REQ, signal: ac.signal }))
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
  })

  it('breaking out of the stream early tears the request down', async () => {
    const fs = fakeStream([deltaChunk('a'), deltaChunk('b')], { hang: true })
    const { llm, fetch } = setup(() => sseResponse(fs.stream))
    for await (const e of llm.streamChat(REQ)) {
      if (e.type === 'delta') break
    }
    await fs.cancelled
    expect(fetch.calls[0]?.init.signal?.aborted).toBe(true)
  })

  it('times out when no bytes arrive for 30 s mid-stream (idle timer resets on data)', async () => {
    vi.useFakeTimers()
    const fs = fakeStream([deltaChunk('Hi')], { hang: true })
    const { llm } = setup(() => sseResponse(fs.stream))
    const it = llm.streamChat(REQ)[Symbol.asyncIterator]()
    expect((await it.next()).value).toMatchObject({ type: 'meta' })
    expect((await it.next()).value).toEqual({ type: 'delta', text: 'Hi' })
    const pending = it.next()
    let settled = false
    pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.advanceTimersByTimeAsync(20_000)
    fs.push(': OPENROUTER PROCESSING\n\n') // keep-alive bytes reset the idle timer
    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).toBe(false)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true })
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
    expect(fs.cancelSpy).toHaveBeenCalled()
  })

  it('a slow consumer between events is not mistaken for a stalled stream', async () => {
    vi.useFakeTimers()
    const fs = fakeStream(typicalStream(['a', 'b']))
    const { llm } = setup(() => sseResponse(fs.stream))
    const types: string[] = []
    for await (const e of llm.streamChat(REQ)) {
      types.push(e.type)
      // The consumer takes 40 s per event (data is already buffered in the stream).
      if (e.type !== 'done') await vi.advanceTimersByTimeAsync(40_000)
    }
    expect(types).toEqual(['meta', 'delta', 'delta', 'done'])
  })

  it('finishes after [DONE] even if the server keeps the stream open (bounded drain)', async () => {
    vi.useFakeTimers()
    const fs = fakeStream(typicalStream(['ok']), { hang: true })
    const { llm } = setup(() => sseResponse(fs.stream))
    const p = collect(llm.streamChat(REQ))
    await vi.advanceTimersByTimeAsync(1_000)
    const events = await p
    expect(events.at(-1)?.type).toBe('done')
  })

  it('accepts a non-streamed JSON completion body', async () => {
    const { llm } = setup(() =>
      jsonResponse(200, {
        ...META,
        choices: [
          { message: { role: 'assistant', content: 'Whole answer' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.1 },
      }),
    )
    const events = await collect(llm.streamChat(REQ))
    expect(events.map((e) => e.type)).toEqual(['meta', 'delta', 'done'])
    expect(events[1]).toEqual({ type: 'delta', text: 'Whole answer' })
  })

  it('maps an error JSON body returned with 200', async () => {
    const { llm } = setup(() => jsonResponse(200, { error: { code: 401, message: 'nope' } }))
    await expect(collect(llm.streamChat(REQ))).rejects.toMatchObject({ code: 'auth' })
  })

  it('calls onFinished once per successful stream; a throwing hook does not break it', async () => {
    const infos: ChatFinishedInfo[] = []
    const { llm } = setup(streamOf(['a', 'b']), {
      onFinished: (i) => {
        infos.push(i)
        throw new Error('hook bug')
      },
    })
    const events = await collect(llm.streamChat({ ...REQ, tag: 'auto' }))
    expect(events.at(-1)?.type).toBe('done')
    expect(infos).toHaveLength(1)
    expect(infos[0]?.request.tag).toBe('auto')
    expect(infos[0]?.stats.costUsd).toBe(0.000012)
  })
})

describe('OpenRouterLLM unfinished streams', () => {
  const GEN = {
    id: 'gen-123',
    model: 'meta-llama/llama-3.3-70b-instruct',
    provider_name: 'Groq',
    tokens_prompt: 120,
    tokens_completion: 40,
    total_cost: 0.00009,
  }
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 1))
  }

  it('looks up and reports the cost of a cancelled stream that OpenRouter already started', async () => {
    const infos: ChatIncompleteInfo[] = []
    const fs = fakeStream([deltaChunk('Hel')], { hang: true })
    const { llm, fetch, sleep } = setup(
      (url) =>
        url.includes('/generation') ? jsonResponse(200, { data: GEN }) : sseResponse(fs.stream),
      { onIncomplete: (i) => infos.push(i) },
    )
    const ac = new AbortController()
    const it = llm.streamChat({ ...REQ, tag: 'auto', signal: ac.signal })[Symbol.asyncIterator]()
    await it.next() // meta
    await it.next() // delta
    const pending = it.next()
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await until(() => infos.length > 0)
    expect(sleep).toHaveBeenCalledWith(INCOMPLETE_STATS_DELAY_MS)
    expect(fetch.calls[1]?.url).toBe(`${BASE}/generation?id=gen-123`)
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      generationId: 'gen-123',
      request: { tag: 'auto' },
      stats: { costUsd: 0.00009, tokensIn: 120, tokensOut: 40, provider: 'Groq' },
    })
  })

  it('also reports a stream that failed mid-way, but not a completed or never-started one', async () => {
    const infos: ChatIncompleteInfo[] = []
    const onIncomplete = (i: ChatIncompleteInfo) => infos.push(i)
    const midway = setup(
      (url) =>
        url.includes('/generation')
          ? jsonResponse(200, { data: GEN })
          : sseResponse(
              fakeStream([deltaChunk('Part'), chunk({ id: 'gen-123', error: { code: 502 } })])
                .stream,
            ),
      { onIncomplete },
    )
    await expect(collect(midway.llm.streamChat(REQ))).rejects.toMatchObject({ code: 'server' })
    await until(() => infos.length > 0)
    expect(infos).toHaveLength(1)

    const ok = setup(streamOf(['fine']), { onIncomplete })
    await collect(ok.llm.streamChat(REQ))
    const rejected = setup(() => jsonResponse(429, { error: { code: 429 } }), { onIncomplete })
    await expect(collect(rejected.llm.streamChat(REQ))).rejects.toMatchObject({
      code: 'rate_limit',
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(infos).toHaveLength(1)
    expect(ok.fetch.calls).toHaveLength(1)
    expect(rejected.fetch.calls).toHaveLength(1)
  })
})

describe('OpenRouterLLM.complete', () => {
  it('returns the full text, stats and usage', async () => {
    const { llm } = setup(streamOf(['Hello', ' world']))
    const res = await llm.complete(REQ)
    expect(res.text).toBe('Hello world')
    expect(res.finishReason).toBe('stop')
    expect(res.usage?.completionTokens).toBe(3)
    expect(res.stats.provider).toBe('Groq')
  })

  it('retries once on 429, honouring Retry-After capped at 5 s', async () => {
    const { llm, fetch, sleep } = setup((_u, _i, n) =>
      n === 0
        ? jsonResponse(429, { error: { code: 429, message: 'rl' } }, { 'Retry-After': '10' })
        : streamOf(['ok'])(),
    )
    const res = await llm.complete(REQ)
    expect(res.text).toBe('ok')
    expect(fetch.calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[0]).toBe(5000)
  })

  it('uses the server Retry-After when it is short, and a default backoff otherwise', async () => {
    const a = setup((_u, _i, n) =>
      n === 0
        ? jsonResponse(429, { error: { code: 429 } }, { 'Retry-After': '2' })
        : streamOf(['ok'])(),
    )
    await a.llm.complete(REQ)
    expect(a.sleep.mock.calls[0]?.[0]).toBe(2000)

    const b = setup((_u, _i, n) =>
      n === 0 ? jsonResponse(500, { error: { code: 500 } }) : streamOf(['ok'])(),
    )
    await b.llm.complete(REQ)
    expect(b.sleep.mock.calls[0]?.[0]).toBe(1000)
  })

  it('retries on network errors but only once', async () => {
    const { llm, fetch } = setup(() => {
      throw new TypeError('fetch failed')
    })
    await expect(llm.complete(REQ)).rejects.toMatchObject({ code: 'network' })
    expect(fetch.calls).toHaveLength(2)
  })

  it('does not retry auth/credit errors', async () => {
    const { llm, fetch, sleep } = setup(() => jsonResponse(402, { error: { code: 402 } }))
    await expect(llm.complete(REQ)).rejects.toMatchObject({ code: 'credits' })
    expect(fetch.calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not retry once text has been emitted', async () => {
    const { llm, fetch } = setup(() =>
      sseResponse(
        fakeStream([deltaChunk('half'), chunk({ error: { code: 500, message: 'boom' } })]).stream,
      ),
    )
    await expect(llm.complete(REQ)).rejects.toMatchObject({ code: 'server' })
    expect(fetch.calls).toHaveLength(1)
  })

  it('does not retry after the caller aborted', async () => {
    const ac = new AbortController()
    const { llm, fetch } = setup(() => {
      ac.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(llm.complete({ ...REQ, signal: ac.signal })).rejects.toMatchObject({
      code: 'aborted',
    })
    expect(fetch.calls).toHaveLength(1)
  })
})

describe('OpenRouterLLM.getGenerationStats', () => {
  const GEN = {
    id: 'gen-123',
    model: 'meta-llama/llama-3.3-70b-instruct',
    provider_name: 'Groq',
    latency: 310,
    generation_time: 1210,
    tokens_prompt: 120,
    tokens_completion: 180,
    total_cost: 0.00021,
  }

  it('maps /generation data to partial speed stats', async () => {
    const { llm, fetch } = setup(() => jsonResponse(200, { data: GEN }))
    const stats = await llm.getGenerationStats('gen-123')
    expect(fetch.calls[0]?.url).toBe(`${BASE}/generation?id=gen-123`)
    expect(stats).toEqual({
      generationId: 'gen-123',
      provider: 'Groq',
      model: 'meta-llama/llama-3.3-70b-instruct',
      ttftMs: 310,
      totalMs: 1210,
      tokensIn: 120,
      tokensOut: 180,
      costUsd: 0.00021,
      tokensPerSec: 200,
    })
  })

  it('retries once after 800 ms on 404 (stats not written yet)', async () => {
    const { llm, fetch, sleep } = setup((_u, _i, n) =>
      n === 0
        ? jsonResponse(404, { error: { code: 404, message: 'Generation not found' } })
        : jsonResponse(200, { data: GEN }),
    )
    const stats = await llm.getGenerationStats('gen-123')
    expect(stats?.provider).toBe('Groq')
    expect(fetch.calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(800)
  })

  it('returns null (never throws) on persistent 404, server errors or network failures', async () => {
    const a = setup(() => jsonResponse(404, { error: { code: 404 } }))
    expect(await a.llm.getGenerationStats('x')).toBeNull()
    expect(a.fetch.calls).toHaveLength(2)

    const b = setup(() => jsonResponse(500, { error: { code: 500 } }))
    expect(await b.llm.getGenerationStats('x')).toBeNull()
    expect(b.fetch.calls).toHaveLength(1)

    const c = setup(() => {
      throw new TypeError('fetch failed')
    })
    expect(await c.llm.getGenerationStats('x')).toBeNull()

    const d = setup(() => fakeResponse({ status: 200, text: 'not json' }))
    expect(await d.llm.getGenerationStats('x')).toBeNull()
  })

  it('url-encodes the id', async () => {
    const { llm, fetch } = setup(() => jsonResponse(200, { data: GEN }))
    await llm.getGenerationStats('gen 1/2&x')
    expect(fetch.calls[0]?.url).toBe(`${BASE}/generation?id=gen%201%2F2%26x`)
  })

  it('only includes fields that are present and valid', () => {
    expect(mapGenerationStats('g', { provider_name: '', latency: 'n/a' })).toEqual({
      generationId: 'g',
    })
  })
})

describe('OpenRouterLLM misc', () => {
  it('listModels without a catalog returns []', async () => {
    const { llm } = setup(streamOf(['x']))
    expect(await llm.listModels()).toEqual([])
    expect(llm.id).toBe('openrouter')
  })

  it('prewarm delegates to the HTTP layer and never throws', async () => {
    const { llm, fetch } = setup(() => {
      throw new TypeError('offline')
    })
    await expect(llm.prewarm()).resolves.toBeUndefined()
    expect(fetch.calls[0]?.url).toBe(`${BASE}/key`)
  })
})
