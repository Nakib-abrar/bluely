import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMockOpenRouter, type MockOpenRouter } from '../../../scripts/mock-openrouter.mjs'
import type { EventChannel } from '@shared/ipc'
import type { IpcEnvelope } from '@shared/ipc'
import type { LatencyTestProgress, ModelValidationResult } from '@shared/types'
import type { CoreContext } from '@main/context'
import { openDatabase } from '@main/db/database'
import { _resetRegistryForTests, initIpcRegistry } from '@main/ipc/registry'
import { SettingsStore } from '@main/settings/settingsStore'
import type { WindowRegistry } from '@main/windows/registry'
import { routingFor, routingForModel, wireModels, type ModelsFeature } from '@main/models/wire'
import { INCOMPLETE_STATS_DELAY_MS } from '@main/providers/llm/openrouter'
import { DEFAULT_SETTINGS } from '@shared/settings'
import {
  deltaChunk,
  fakeFetch,
  fakeStream,
  jsonResponse,
  META,
  silentLogger,
  sseResponse,
} from './helpers'

type Listener = (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcEnvelope<unknown>>

let mock: MockOpenRouter
let handlers: Map<string, Listener>
let feature: ModelsFeature | null = null

beforeAll(async () => {
  mock = await startMockOpenRouter({ ttftMs: 5, tokenMs: 0 })
})
afterAll(async () => {
  await mock.close()
})

beforeEach(() => {
  handlers = new Map()
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel, listener) => {
    handlers.set(channel, listener as Listener)
  })
  initIpcRegistry({
    windows: { kindOf: () => 'main', get: () => null } as unknown as WindowRegistry,
    log: silentLogger(),
    isTrustedUrl: () => true,
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await feature?.dispose()
  feature = null
  _resetRegistryForTests()
})

function makeCtx(key: string | null = 'sk-or-test-wire-123456') {
  const db = openDatabase(':memory:')
  const settings = new SettingsStore(db)
  const events: { channel: EventChannel; payload: unknown }[] = []
  const ctx = {
    env: { openRouterBaseUrl: mock.baseUrl },
    paths: { userData: mkdtempSync(join(tmpdir(), 'bluely-wire-')) },
    log: silentLogger(),
    db,
    settings,
    secrets: { getKey: () => key },
    events: {
      broadcast: (channel: EventChannel, payload: unknown) => events.push({ channel, payload }),
    },
  } as unknown as CoreContext
  return { ctx, settings, events }
}

async function invoke<T>(channel: string, payload?: unknown): Promise<IpcEnvelope<T>> {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`no handler for ${channel}`)
  const event = {
    senderFrame: { url: 'bluely://app/main/index.html' },
    sender: {},
  } as unknown as IpcMainInvokeEvent
  return (await listener(event, payload)) as IpcEnvelope<T>
}

async function data<T>(channel: string, payload?: unknown): Promise<T> {
  const env = await invoke<T>(channel, payload)
  if (!env.ok) throw new Error(`${channel} failed: ${env.error.code} ${env.error.message}`)
  return env.data
}

function nextValidation(f: ModelsFeature): Promise<ModelValidationResult[]> {
  return new Promise((resolve) => {
    const off = f.onValidation((r) => {
      off()
      resolve(r)
    })
  })
}

describe('routing helpers', () => {
  it('routingFor maps a role config and omits an empty order', () => {
    expect(routingFor(DEFAULT_SETTINGS.models.fast)).toEqual({
      sort: 'latency',
      order: ['groq', 'cerebras'],
      allowFallbacks: true,
    })
    expect(routingFor(DEFAULT_SETTINGS.models.smart)).toEqual({
      sort: 'latency',
      allowFallbacks: true,
    })
  })

  it('routingForModel uses the role that uses the model', () => {
    expect(routingForModel(DEFAULT_SETTINGS, DEFAULT_SETTINGS.models.notes.model)).toEqual({
      sort: 'price',
      allowFallbacks: true,
    })
    expect(routingForModel(DEFAULT_SETTINGS, 'other/model')).toEqual({
      sort: 'latency',
      allowFallbacks: true,
    })
  })
})

describe('wireModels', () => {
  it('registers its channels and validates defaults in the background at startup', async () => {
    const { ctx } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 0 })
    expect([...handlers.keys()].sort()).toEqual([
      'key:test',
      'models:getStats',
      'models:list',
      'models:runLatencyTest',
      'models:validateDefaults',
      'usage:getMonthSpend',
    ])
    expect(feature.lastValidation()).toEqual([])
    const results = await nextValidation(feature)
    expect(results.map((r) => [r.role, r.replaced])).toEqual([
      ['fast', false],
      ['smart', false],
      ['notes', false],
      ['stt', false],
    ])
    expect(feature.lastValidation()).toBe(results)
    expect(mock.requests.some((r) => r.path === '/models')).toBe(true)
  })

  it('models:list returns the catalog and rejects invalid payloads', async () => {
    const { ctx } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 60_000 })
    const models = await data<{ id: string }[]>('models:list', { refresh: true })
    expect(models).toHaveLength(9)
    const bad = await invoke('models:list', { refresh: 'yes' })
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_payload' } })
  })

  it('models:validateDefaults replaces a missing model, persists it and notifies', async () => {
    const { ctx, settings } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 60_000 })
    settings.update({ models: { fast: { model: 'acme/retired' }, stt: { model: 'acme/gone' } } })
    const notified = nextValidation(feature)
    const results = await data<ModelValidationResult[]>('models:validateDefaults')
    expect(results.find((r) => r.role === 'fast')).toMatchObject({
      requested: 'acme/retired',
      resolved: 'meta-llama/llama-3.3-70b-instruct',
      replaced: true,
    })
    expect(results.find((r) => r.role === 'stt')?.resolved).toBe('openai/whisper-large-v3-turbo')
    expect(settings.get().models.fast.model).toBe('meta-llama/llama-3.3-70b-instruct')
    expect(settings.get().models.fast.order).toEqual(['groq', 'cerebras'])
    expect(settings.get().models.stt.model).toBe('openai/whisper-large-v3-turbo')
    expect(await notified).toBe(results)
  })

  it('key:test reports remaining credits; errors come back as data, not exceptions', async () => {
    const good = makeCtx()
    feature = wireModels(good.ctx, { startupDelayMs: 60_000 })
    expect(await data('key:test')).toMatchObject({ ok: true, remaining: 16.79 })
    await feature.dispose()
    _resetRegistryForTests()

    const none = makeCtx(null)
    feature = wireModels(none.ctx, { startupDelayMs: 60_000 })
    expect(await data('key:test')).toMatchObject({ ok: false, error: { code: 'no_key' } })
  })

  it('logs every chat request for monthly spend and the rolling stats', async () => {
    const { ctx } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 60_000 })
    const before = await data<{ requests: number; totalUsd: number }>('usage:getMonthSpend')
    expect(before).toMatchObject({ requests: 0, totalUsd: 0 })
    await feature.llm.complete({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const after = await data<{ requests: number; llmUsd: number; sttUsd: number }>(
      'usage:getMonthSpend',
    )
    expect(after.requests).toBe(1)
    expect(after.llmUsd).toBeGreaterThan(0)
    expect(after.sttUsd).toBe(0)
    const stats =
      await data<{ model: string; provider: string | null; samples: number }[]>('models:getStats')
    expect(stats).toEqual([
      expect.objectContaining({ model: 'openai/gpt-4o-mini', provider: 'OpenAI', samples: 1 }),
    ])
  })

  it('logs the cost of a cancelled stream for monthly spend, without a latency sample', async () => {
    // OpenRouter bills the tokens generated before we hung up; the cost is looked up from
    // GET /generation a few seconds later (the stream itself never carried its usage).
    const generation = {
      id: META.id,
      model: META.model,
      provider_name: 'Groq',
      tokens_prompt: 120,
      tokens_completion: 40,
      total_cost: 0.00009,
    }
    const body = fakeStream([deltaChunk('Hel')], { hang: true })
    const fetchImpl = fakeFetch((url) =>
      url.includes('/generation')
        ? jsonResponse(200, { data: generation })
        : sseResponse(body.stream),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ctx } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 60_000, fetchImpl })
    const ac = new AbortController()
    const stream = feature.llm
      .streamChat({
        model: META.model,
        messages: [{ role: 'user', content: 'hello' }],
        tag: 'auto',
        signal: ac.signal,
      })
      [Symbol.asyncIterator]()
    await stream.next() // meta
    await stream.next() // 'Hel'
    const pending = stream.next()
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect((await data<{ requests: number }>('usage:getMonthSpend')).requests).toBe(0)

    await vi.advanceTimersByTimeAsync(INCOMPLETE_STATS_DELAY_MS)
    await vi.waitFor(() =>
      expect(fetchImpl.calls.map((c) => c.url)).toContain(
        `${mock.baseUrl}/generation?id=${META.id}`,
      ),
    )
    await vi.waitFor(async () =>
      expect(await data('usage:getMonthSpend')).toMatchObject({
        requests: 1,
        llmUsd: 0.00009,
        sttUsd: 0,
      }),
    )
    const row = ctx.db
      .prepare('SELECT kind, model, provider, cost_usd, tokens_in, tokens_out FROM usage_log')
      .all()
    expect(row).toEqual([
      {
        kind: 'llm',
        model: META.model,
        provider: 'Groq',
        cost_usd: 0.00009,
        tokens_in: 120,
        tokens_out: 40,
      },
    ])
    // An unfinished request says nothing about the model's speed.
    expect(await data('models:getStats')).toEqual([])
  })

  it('models:runLatencyTest streams progress events and records each sample once', async () => {
    const { ctx, events } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 60_000 })
    const { runId } = await data<{ runId: string }>('models:runLatencyTest', {
      models: ['meta-llama/llama-3.3-70b-instruct'],
      runs: 2,
    })
    const busy = await invoke('models:runLatencyTest', { models: ['openai/gpt-4o-mini'] })
    expect(busy).toMatchObject({ ok: false, error: { code: 'busy' } })
    await feature.latency.whenIdle()
    const progress = events
      .filter((e) => e.channel === 'models:latencyProgress')
      .map((e) => e.payload as LatencyTestProgress)
    expect(progress.map((p) => [p.runId, p.completed, p.result === null])).toEqual([
      [runId, 1, true],
      [runId, 2, true],
      [runId, 2, false],
    ])
    expect(progress[2]?.result).toMatchObject({ provider: 'Groq', samples: 2 })
    expect(progress[2]?.errors).toEqual([])
    // Latency-test requests count towards spend, but samples are not double-recorded.
    expect((await data<{ requests: number }>('usage:getMonthSpend')).requests).toBe(2)
    const stats = await data<{ samples: number }[]>('models:getStats')
    expect(stats[0]?.samples).toBe(2)
    const latencyReq = mock.requests.filter((r) => r.path === '/chat/completions').at(-1)
    expect(latencyReq?.body).toMatchObject({
      max_tokens: 64,
      temperature: 0,
      provider: { sort: 'latency', order: ['groq', 'cerebras'], allow_fallbacks: true },
    })
  })

  it('models:runLatencyTest validates its payload', async () => {
    const { ctx } = makeCtx()
    feature = wireModels(ctx, { startupDelayMs: 60_000 })
    expect(await invoke('models:runLatencyTest', { models: [] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    })
  })
})
