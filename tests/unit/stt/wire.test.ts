import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { IpcEnvelope } from '@shared/ipc'
import type { CoreContext } from '@main/context'
import { openDatabase, type Db } from '@main/db/database'
import { _resetRegistryForTests, initIpcRegistry } from '@main/ipc/registry'
import { OpenRouterHttp, type ResponseLike } from '@main/providers/openrouterHttp'
import type { STTProvider } from '@main/providers/stt/STTProvider'
import type { WindowRegistry } from '@main/windows/registry'
import { SettingsStore } from '@main/settings/settingsStore'
import { createSttUsageRecorder } from '@main/stt/usage'
import { MAX_TEST_WAV_BYTES, runTestTranscription } from '@main/stt/testTranscribe'
import { wireStt } from '@main/stt/wire'
import {
  deferred,
  fixture,
  flushMicrotasks,
  jsonResponse,
  makeWav,
  memoryLogger,
  recordingFetch,
  silence,
  speechLikeWav,
  sttResult,
  type RecordedRequest,
} from './helpers'

type Listener = (event: unknown, payload: unknown) => Promise<IpcEnvelope<unknown>>

interface UsageRow {
  kind: string
  model: string
  provider: string | null
  cost_usd: number | null
  audio_seconds: number | null
  session_id: string | null
  tokens_in: number | null
}

let listeners: Map<string, Listener>
let db: Db

beforeEach(() => {
  listeners = new Map()
  vi.spyOn(ipcMain, 'handle').mockImplementation((channel: string, fn: unknown) => {
    listeners.set(channel, fn as Listener)
  })
  const windows = { kindOf: () => 'main', get: () => null } as unknown as WindowRegistry
  initIpcRegistry({ windows, log: memoryLogger(), isTrustedUrl: () => true })
  db = openDatabase(':memory:')
})

afterEach(() => {
  _resetRegistryForTests()
  db.close()
})

function setup(respond: (req: RecordedRequest) => ResponseLike | Promise<ResponseLike>) {
  const settings = new SettingsStore(db)
  const log = memoryLogger()
  const ctx = { log, db, settings } as unknown as CoreContext
  const fetchImpl = recordingFetch(respond)
  const http = new OpenRouterHttp({
    baseUrl: 'https://openrouter.test/api/v1',
    getKey: () => 'sk-or-test-1234567890',
    log,
    fetchImpl,
  })
  const feature = wireStt(ctx, { http })
  const invoke = (payload: unknown) => {
    const fn = listeners.get('audio:testTranscribe')
    if (!fn) throw new Error('audio:testTranscribe not registered')
    return fn({ senderFrame: { url: 'bluely://app/main/index.html' }, sender: {} }, payload)
  }
  return { feature, settings, fetchImpl, invoke, log }
}

function usageRows(): UsageRow[] {
  return db
    .prepare(
      'SELECT kind, model, provider, cost_usd, audio_seconds, session_id, tokens_in FROM usage_log ORDER BY id',
    )
    .all() as UsageRow[]
}

describe('audio:testTranscribe', () => {
  it('transcribes with the configured model and language and logs usage', async () => {
    const { invoke, settings, fetchImpl } = setup(() =>
      jsonResponse(200, { text: ' Testing one two three. ', usage: { seconds: 9, cost: 0.00099 } }),
    )
    settings.update({
      models: { stt: { model: 'openai/whisper-large-v3' } },
      language: { transcription: 'BN' },
    })
    const env = await invoke({ wav: fixture('speech-en-16k.wav') })
    expect(env.ok).toBe(true)
    if (!env.ok) return
    expect(env.data).toEqual({
      text: 'Testing one two three.',
      latencyMs: expect.any(Number),
      model: 'openai/whisper-large-v3',
    })
    expect(fetchImpl.requests[0]!.body).toMatchObject({
      model: 'openai/whisper-large-v3',
      language: 'bn',
      temperature: 0,
    })
    expect(usageRows()).toEqual([
      {
        kind: 'stt',
        model: 'openai/whisper-large-v3',
        provider: null,
        cost_usd: 0.00099,
        audio_seconds: 9,
        session_id: null,
        tokens_in: null,
      },
    ])
  })

  it('omits language for auto (the default)', async () => {
    const { invoke, fetchImpl } = setup(() => jsonResponse(200, { text: 'Hello.' }))
    await invoke({ wav: speechLikeWav() })
    expect('language' in fetchImpl.requests[0]!.body).toBe(false)
    expect(fetchImpl.requests[0]!.body['model']).toBe('openai/whisper-large-v3-turbo')
  })

  it('maps provider errors to typed AppErrors with AI info', async () => {
    const { invoke } = setup(() =>
      jsonResponse(402, { error: { code: 402, message: 'Insufficient credits' } }),
    )
    const env = await invoke({ wav: speechLikeWav() })
    expect(env).toEqual({
      ok: false,
      error: {
        code: 'credits',
        message: expect.stringMatching(/credits/i),
        ai: {
          code: 'credits',
          message: expect.any(String),
          retryable: false,
          retryAfterSec: null,
        },
      },
    })
    expect(usageRows()).toHaveLength(0)
  })

  it('maps rate limits with retryAfterSec', async () => {
    const { invoke } = setup(() =>
      jsonResponse(429, { error: { message: 'slow down' } }, { 'Retry-After': '4' }),
    )
    const env = await invoke({ wav: speechLikeWav() })
    expect(env.ok).toBe(false)
    if (env.ok) return
    expect(env.error.code).toBe('rate_limit')
    expect(env.error.ai).toMatchObject({ code: 'rate_limit', retryable: true, retryAfterSec: 4 })
  })

  it('returns empty text for a silent sample without calling the API', async () => {
    const { invoke, fetchImpl } = setup(() => jsonResponse(200, { text: 'you' }))
    const env = await invoke({ wav: makeWav(silence(1)) })
    expect(env).toEqual({
      ok: true,
      data: { text: '', latencyMs: 0, model: 'openai/whisper-large-v3-turbo' },
    })
    expect(fetchImpl.requests).toHaveLength(0)
    expect(usageRows()).toHaveLength(0)
  })

  it('returns empty text when the model invents a line, but still logs the billed request', async () => {
    const { invoke } = setup(() =>
      jsonResponse(200, { text: 'Thanks for watching!', usage: { seconds: 1, cost: 0.0001 } }),
    )
    const env = await invoke({ wav: speechLikeWav() })
    expect(env).toMatchObject({ ok: true, data: { text: '' } })
    expect(usageRows()).toHaveLength(1)
  })

  it('rejects invalid audio with invalid_audio', async () => {
    const { invoke, fetchImpl } = setup(() => jsonResponse(200, { text: 'x' }))
    const env = await invoke({ wav: new Uint8Array([1, 2, 3]) })
    expect(env).toMatchObject({ ok: false, error: { code: 'invalid_audio' } })
    expect(fetchImpl.requests).toHaveLength(0)
  })

  it('rejects payloads that are not bytes (registry validation)', async () => {
    const { invoke } = setup(() => jsonResponse(200, { text: 'x' }))
    const env = await invoke({ wav: 'UklGRg==' })
    expect(env).toMatchObject({ ok: false, error: { code: 'invalid_payload' } })
  })
})

describe('runTestTranscription', () => {
  it('rejects oversized samples before parsing', async () => {
    const stt: STTProvider = {
      id: 'x',
      supportsStreaming: false,
      transcribe: () => Promise.resolve(sttResult('x')),
    }
    const settings = new SettingsStore(db)
    await expect(
      runTestTranscription(
        { stt, getSettings: () => settings.get(), recordUsage: () => undefined },
        new Uint8Array(MAX_TEST_WAV_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: 'invalid_audio' })
  })

  it('passes non-provider errors through unchanged', async () => {
    const boom = new Error('boom')
    const stt: STTProvider = {
      id: 'x',
      supportsStreaming: false,
      transcribe: () => Promise.reject(boom),
    }
    const settings = new SettingsStore(db)
    await expect(
      runTestTranscription(
        { stt, getSettings: () => settings.get(), recordUsage: () => undefined },
        speechLikeWav(),
      ),
    ).rejects.toBe(boom)
  })
})

describe('createSttUsageRecorder', () => {
  it('never throws when the insert fails', () => {
    const log = memoryLogger()
    const record = createSttUsageRecorder(db, log, () => 42)
    record(sttResult('ok', { costUsd: null, audioSeconds: null }), 's1')
    db.close()
    expect(() => record(sttResult('ok'), 's1')).not.toThrow()
    expect(log.entries.some((e) => e.level === 'warn')).toBe(true)
    db = openDatabase(':memory:') // afterEach closes it again
  })
})

describe('SttFeature.createQueue', () => {
  const mk = (id: string, startedAt: number, channel: 'me' | 'them' = 'them') => ({
    id,
    sessionId: 'sess-9',
    channel,
    segment: { channel, wav: speechLikeWav(), startedAt, endedAt: startedAt },
    vadEndAt: startedAt,
    forced: false,
  })

  it('uses settings for model/language/concurrency and logs usage per session, including dropped lines', async () => {
    const texts = ['What does the enterprise plan cost?', 'Thanks for watching!']
    const gate = deferred<void>()
    let i = 0
    const { feature, settings, fetchImpl } = setup(async () => {
      await gate.promise
      return jsonResponse(200, {
        text: texts[i++ % texts.length],
        usage: { seconds: 2, cost: 0.0002 },
      })
    })
    settings.update({ language: { transcription: 'en' }, advanced: { sttConcurrency: 1 } })
    const results: string[] = []
    const drops: string[] = []
    const usageSeen: string[] = []
    const q = feature.createQueue({
      onResult: (_job, r) => results.push(r.text),
      onError: () => undefined,
      onDropped: (_job, reason) => drops.push(reason),
      onUsage: (job) => usageSeen.push(job.id),
    })
    q.enqueue(mk('a', 1))
    q.enqueue(mk('b', 2))
    await flushMicrotasks()
    // Concurrency comes from settings.advanced.sttConcurrency (1).
    expect(fetchImpl.requests).toHaveLength(1)
    expect(q.stats()).toMatchObject({ inFlight: 1, queued: 1 })
    gate.resolve()
    expect(await q.drain(5_000)).toBe(true)

    expect(results).toEqual(['What does the enterprise plan cost?'])
    expect(drops).toEqual(['hallucination'])
    expect(usageSeen).toEqual(['a', 'b'])
    expect(fetchImpl.requests.map((r) => r.body['language'])).toEqual(['en', 'en'])
    expect(fetchImpl.requests.map((r) => r.body['model'])).toEqual([
      'openai/whisper-large-v3-turbo',
      'openai/whisper-large-v3-turbo',
    ])
    const rows = usageRows()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.session_id === 'sess-9' && r.kind === 'stt')).toBe(true)
    expect(rows.every((r) => r.cost_usd === 0.0002 && r.audio_seconds === 2)).toBe(true)
  })

  it('accepts explicit getOptions and concurrency', async () => {
    const gate = deferred<void>()
    const { feature, fetchImpl } = setup(async () => {
      await gate.promise
      return jsonResponse(200, { text: 'Hello there.' })
    })
    const q = feature.createQueue({
      getOptions: () => ({ model: 'custom/stt', language: 'de' }),
      concurrencyPerChannel: 3,
      onResult: () => undefined,
      onError: () => undefined,
    })
    for (let n = 0; n < 4; n++) q.enqueue(mk(`j${n}`, n, 'me'))
    await flushMicrotasks()
    expect(fetchImpl.requests).toHaveLength(3)
    gate.resolve()
    expect(await q.drain(5_000)).toBe(true)
    expect(q.stats().completed).toBe(4)
    expect(fetchImpl.requests.every((r) => r.body['model'] === 'custom/stt')).toBe(true)
    expect(fetchImpl.requests.every((r) => r.body['language'] === 'de')).toBe(true)
  })

  it('exposes the provider', () => {
    const { feature } = setup(() => jsonResponse(200, { text: 'x' }))
    expect(feature.stt.id).toBe('openrouter')
    expect(feature.stt.supportsStreaming).toBe(false)
  })
})
