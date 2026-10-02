import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@main/errors'
import { ProviderError } from '@main/providers/errors'
import { OpenRouterHttp, type FetchLike, type ResponseLike } from '@main/providers/openrouterHttp'
import {
  normalizeSttLanguage,
  OpenRouterSTT,
  STT_TIMEOUT_MS,
} from '@main/providers/stt/openrouterStt'
import type { AudioSegment } from '@main/providers/stt/STTProvider'
import {
  deferred,
  fixture,
  jsonResponse,
  makeWav,
  memoryLogger,
  recordingFetch,
  speechLikeWav,
  type RecordedRequest,
} from './helpers'

const KEY = 'sk-or-test-1234567890'
const MODEL = 'openai/whisper-large-v3-turbo'

function setup(
  respond: (req: RecordedRequest) => ResponseLike | Promise<ResponseLike>,
  opts: { now?: () => number; timeoutMs?: number; key?: string | null } = {},
) {
  const fetchImpl = recordingFetch(respond)
  const log = memoryLogger()
  const http = new OpenRouterHttp({
    baseUrl: 'https://openrouter.test/api/v1/',
    getKey: () => (opts.key === undefined ? KEY : opts.key),
    log,
    fetchImpl,
  })
  const stt = new OpenRouterSTT({ http, log, now: opts.now, timeoutMs: opts.timeoutMs })
  return { stt, fetchImpl, log }
}

function segment(wav: Uint8Array): AudioSegment {
  return { channel: 'them', wav, startedAt: 1_000, endedAt: 2_000 }
}

const ok = (body: unknown = { text: 'Hello there', usage: { seconds: 1, cost: 0.0001 } }) =>
  jsonResponse(200, body)

afterEach(() => {
  vi.useRealTimers()
})

describe('OpenRouterSTT request', () => {
  it('posts base64 WAV, model and temperature 0 with attribution headers', async () => {
    const { stt, fetchImpl } = setup(() => ok())
    const wav = fixture('speech-en-16k.wav')
    await stt.transcribe(segment(wav), { model: MODEL, language: 'auto' })

    expect(fetchImpl.requests).toHaveLength(1)
    const req = fetchImpl.requests[0]!
    expect(req.url).toBe('https://openrouter.test/api/v1/audio/transcriptions')
    expect(req.init.method).toBe('POST')
    expect(req.init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/nakib-abrar/bluely',
      'X-Title': 'Bluely',
      Authorization: `Bearer ${KEY}`,
    })
    expect(req.body).toEqual({
      model: MODEL,
      input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
      temperature: 0,
    })
    const decoded = new Uint8Array(
      Buffer.from((req.body['input_audio'] as { data: string }).data, 'base64'),
    )
    expect(decoded).toEqual(wav)
  })

  it('encodes byte views without including bytes outside the view', async () => {
    const { stt, fetchImpl } = setup(() => ok())
    const wav = speechLikeWav(0.2)
    const big = new Uint8Array(wav.byteLength + 64).fill(0x7f)
    big.set(wav, 32)
    await stt.transcribe(segment(big.subarray(32, 32 + wav.byteLength)), { model: MODEL })
    const data = (fetchImpl.requests[0]!.body['input_audio'] as { data: string }).data
    expect(data).toBe(Buffer.from(wav).toString('base64'))
  })

  it.each<[string | null | undefined, string | undefined]>([
    ['auto', undefined],
    ['AUTO', undefined],
    [null, undefined],
    [undefined, undefined],
    ['', undefined],
    ['bn', 'bn'],
    ['EN', 'en'],
    [' de ', 'de'],
    ['pt-BR', 'pt'],
    ['zh_TW', 'zh'],
  ])('language %j → %j', async (language, expected) => {
    const { stt, fetchImpl } = setup(() => ok())
    await stt.transcribe(segment(speechLikeWav()), { model: MODEL, language })
    const body = fetchImpl.requests[0]!.body
    if (expected === undefined) expect('language' in body).toBe(false)
    else expect(body['language']).toBe(expected)
    expect(normalizeSttLanguage(language)).toBe(expected)
  })

  it('rejects invalid audio before any request', async () => {
    const { stt, fetchImpl } = setup(() => ok())
    await expect(
      stt.transcribe(segment(new Uint8Array([1, 2, 3, 4])), { model: MODEL }),
    ).rejects.toMatchObject({ code: 'invalid_audio' })
    await expect(stt.transcribe(segment(makeWav([])), { model: MODEL })).rejects.toBeInstanceOf(
      AppError,
    )
    expect(fetchImpl.requests).toHaveLength(0)
  })
})

describe('OpenRouterSTT response', () => {
  it('parses duration-priced usage', async () => {
    let t = 1000
    const { stt } = setup(
      () => {
        t += 340
        return ok({ text: '  - Hello   there ', usage: { seconds: 20, cost: 0.005333 } })
      },
      { now: () => t },
    )
    const r = await stt.transcribe(segment(speechLikeWav()), { model: MODEL })
    expect(r).toEqual({
      text: 'Hello there',
      model: MODEL,
      latencyMs: 340,
      costUsd: 0.005333,
      audioSeconds: 20,
      language: null,
    })
  })

  it('parses token-priced usage and falls back to the WAV duration', async () => {
    const { stt } = setup(() =>
      ok({
        text: 'Hello',
        usage: { total_tokens: 113, input_tokens: 83, output_tokens: 30, cost: 0.000508 },
      }),
    )
    const r = await stt.transcribe(segment(fixture('speech-en-16k.wav')), { model: MODEL })
    expect(r.costUsd).toBe(0.000508)
    expect(r.audioSeconds).toBeCloseTo(273202 / 32000, 6)
  })

  it('tolerates missing or odd usage fields', async () => {
    const { stt } = setup(() => ok({ text: 'Hi' }))
    const r = await stt.transcribe(segment(speechLikeWav(2)), { model: MODEL })
    expect(r.costUsd).toBeNull()
    expect(r.audioSeconds).toBeCloseTo(2, 6)

    const { stt: stt2 } = setup(() =>
      ok({ text: 'Hi', usage: { seconds: '3', cost: 'n/a' }, language: 'english' }),
    )
    const r2 = await stt2.transcribe(segment(speechLikeWav(2)), { model: MODEL })
    expect(r2.costUsd).toBeNull()
    expect(r2.audioSeconds).toBe(3)
    expect(r2.language).toBe('english')

    const { stt: stt3 } = setup(() => ok({ text: 'Hi', usage: null }))
    const r3 = await stt3.transcribe(segment(speechLikeWav(1)), { model: MODEL })
    expect(r3.costUsd).toBeNull()
  })

  it('returns empty text as-is (the queue decides what to drop)', async () => {
    const { stt } = setup(() => ok({ text: '   ' }))
    const r = await stt.transcribe(segment(speechLikeWav()), { model: MODEL })
    expect(r.text).toBe('')
  })

  it('maps a 200 without text to a server error', async () => {
    const { stt } = setup(() => ok({ error: { message: 'Upstream failed' } }))
    await expect(stt.transcribe(segment(speechLikeWav()), { model: MODEL })).rejects.toMatchObject({
      code: 'server',
      detail: 'Upstream failed',
      retryable: true,
    })
    const { stt: stt2 } = setup(() => ok({ foo: 1 }))
    await expect(
      stt2.transcribe(segment(speechLikeWav()), { model: MODEL }),
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('maps invalid JSON to a server error', async () => {
    const { stt } = setup(() => jsonResponse(200, '<html>oops</html>'))
    await expect(stt.transcribe(segment(speechLikeWav()), { model: MODEL })).rejects.toMatchObject({
      code: 'server',
    })
  })
})

describe('OpenRouterSTT errors', () => {
  it.each<[number, string, boolean, Record<string, string>, number | null]>([
    [401, 'auth', false, {}, null],
    [402, 'credits', false, {}, null],
    [429, 'rate_limit', true, { 'Retry-After': '3' }, 3],
    [500, 'server', true, {}, null],
    [503, 'server', true, {}, null],
    [400, 'bad_request', false, {}, null],
    [404, 'model_unavailable', false, {}, null],
  ])('HTTP %i → %s', async (status, code, retryable, headers, retryAfter) => {
    const { stt } = setup(() =>
      jsonResponse(status, { error: { code: status, message: `upstream ${status}` } }, headers),
    )
    const err = await stt
      .transcribe(segment(speechLikeWav()), { model: MODEL })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code, retryable, status, retryAfterSec: retryAfter })
    expect((err as ProviderError).message.length).toBeGreaterThan(0)
  })

  it('maps a missing key to no_key without a request', async () => {
    const { stt, fetchImpl } = setup(() => ok(), { key: null })
    await expect(stt.transcribe(segment(speechLikeWav()), { model: MODEL })).rejects.toMatchObject({
      code: 'no_key',
    })
    expect(fetchImpl.requests).toHaveLength(0)
  })

  it('maps network failures', async () => {
    const { stt } = setup(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    })
    await expect(stt.transcribe(segment(speechLikeWav()), { model: MODEL })).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    })
  })

  it('times out when the server never answers (short timeout)', async () => {
    const { stt } = setup(() => new Promise<ResponseLike>(() => undefined), { timeoutMs: 30 })
    await expect(stt.transcribe(segment(speechLikeWav()), { model: MODEL })).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    })
  })

  it('times out after 20 s by default (fake timers)', async () => {
    vi.useFakeTimers()
    const { stt } = setup(() => new Promise<ResponseLike>(() => undefined))
    let settled: unknown = null
    const p = stt.transcribe(segment(speechLikeWav()), { model: MODEL }).catch((e: unknown) => {
      settled = e
    })
    await vi.advanceTimersByTimeAsync(STT_TIMEOUT_MS - 1)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(settled).toBeInstanceOf(ProviderError)
    expect(settled).toMatchObject({ code: 'timeout' })
    expect(STT_TIMEOUT_MS).toBe(20_000)
  })

  it('times out when the body stalls after headers', async () => {
    const stalled: ResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      text: () => new Promise<string>(() => undefined),
      json: () => new Promise<unknown>(() => undefined),
    }
    const { stt } = setup(() => stalled, { timeoutMs: 30 })
    await expect(stt.transcribe(segment(speechLikeWav()), { model: MODEL })).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('aborts when the caller signal fires, and passes the abort to fetch', async () => {
    const seen = deferred<AbortSignal>()
    const fetchImpl: FetchLike = (_url, init) => {
      seen.resolve(init.signal as AbortSignal)
      return new Promise<ResponseLike>(() => undefined)
    }
    const log = memoryLogger()
    const http = new OpenRouterHttp({
      baseUrl: 'https://x.test',
      getKey: () => KEY,
      log,
      fetchImpl,
    })
    const stt = new OpenRouterSTT({ http, log })
    const controller = new AbortController()
    const p = stt.transcribe(segment(speechLikeWav()), {
      model: MODEL,
      signal: controller.signal,
    })
    const fetchSignal = await seen.promise
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchSignal.aborted).toBe(true)
  })

  it('rejects immediately for an already-aborted signal', async () => {
    const { stt } = setup(() => new Promise<ResponseLike>(() => undefined))
    const controller = new AbortController()
    controller.abort()
    await expect(
      stt.transcribe(segment(speechLikeWav()), { model: MODEL, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' })
  })

  it('reports itself as a non-streaming provider', () => {
    const { stt } = setup(() => ok())
    expect(stt.id).toBe('openrouter')
    expect(stt.supportsStreaming).toBe(false)
  })
})
