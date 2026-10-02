import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ModelCatalog,
  MODEL_CACHE_MAX_AGE_MS,
  parseModalityString,
  parseModel,
  parseModelList,
  parsePrice,
} from '@main/models/catalog'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import type { RequestInitLike, ResponseLike } from '@main/providers/openrouterHttp'
import { fakeFetch, jsonResponse, silentLogger } from './helpers'
import { RAW_MODELS, rawModel } from './fixtures'

const BASE = 'https://openrouter.test/api/v1'

function tmpCache(): string {
  return join(mkdtempSync(join(tmpdir(), 'bluely-models-')), 'nested', 'models-cache.json')
}

function setup(
  handler: (url: string, init: RequestInitLike, n: number) => ResponseLike | Promise<ResponseLike>,
  opts: { key?: string | null; cacheFile?: string; now?: () => number } = {},
) {
  const fetch = fakeFetch(handler)
  const log = silentLogger()
  const http = new OpenRouterHttp({
    baseUrl: BASE,
    getKey: () => (opts.key === undefined ? null : opts.key),
    log,
    fetchImpl: fetch,
  })
  const cacheFile = opts.cacheFile ?? tmpCache()
  const catalog = new ModelCatalog({
    http,
    log,
    cacheFile,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { catalog, fetch, log, cacheFile }
}

const okList = () => jsonResponse(200, { data: RAW_MODELS })
const offline = () => {
  throw new TypeError('fetch failed')
}

describe('model parsing', () => {
  it('parses price strings to numbers per token; invalid or variable → null', () => {
    expect(parsePrice('0.0000003')).toBeCloseTo(3e-7, 12)
    expect(parsePrice('0')).toBe(0)
    expect(parsePrice(0.000002)).toBe(0.000002)
    expect(parsePrice('-1')).toBeNull()
    expect(parsePrice('abc')).toBeNull()
    expect(parsePrice('')).toBeNull()
    expect(parsePrice(undefined)).toBeNull()
    expect(parsePrice(null)).toBeNull()
  })

  it('parses the legacy modality string', () => {
    expect(parseModalityString('text+image->text')).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(parseModalityString('Audio -> Text')).toEqual({ input: ['audio'], output: ['text'] })
    expect(parseModalityString('text')).toEqual({ input: [], output: [] })
    expect(parseModalityString(undefined)).toEqual({ input: [], output: [] })
  })

  it('parses a full OpenRouter entry', () => {
    const m = parseModel(
      rawModel('google/gemini-2.5-flash', {
        name: 'Google: Gemini 2.5 Flash',
        input: ['text', 'image', 'audio', 'file'],
        prompt: '0.0000003',
        completion: '0.0000025',
        audio: '0.000001',
        ctx: 1048576,
        description: '  Fast multimodal model. ',
      }),
    )
    expect(m).toEqual({
      id: 'google/gemini-2.5-flash',
      name: 'Google: Gemini 2.5 Flash',
      contextLength: 1048576,
      pricing: { prompt: 3e-7, completion: 2.5e-6, request: 0, image: 0, audio: 0.000001 },
      inputModalities: ['text', 'image', 'audio', 'file'],
      outputModalities: ['text'],
      supportsVision: true,
      supportsAudioInput: true,
      isStt: false,
      description: 'Fast multimodal model.',
    })
  })

  it('falls back to the modality string and top_provider context', () => {
    const raw = rawModel('x/vision', {
      modality: 'text+image->text',
      omitModalityArrays: true,
      ctx: null,
    })
    ;(raw['top_provider'] as Record<string, unknown>)['context_length'] = 32000
    const m = parseModel(raw)
    expect(m?.inputModalities).toEqual(['text', 'image'])
    expect(m?.supportsVision).toBe(true)
    expect(m?.contextLength).toBe(32000)
  })

  it('detects speech-to-text models by id or by audio-only input', () => {
    const isStt = (id: string, input: string[] = ['text']) =>
      parseModel(rawModel(id, { input }))?.isStt
    expect(isStt('openai/whisper-large-v3-turbo', ['audio'])).toBe(true)
    expect(isStt('mistralai/voxtral-small-24b-2507', ['text', 'audio'])).toBe(true)
    expect(isStt('openai/gpt-4o-mini-transcribe')).toBe(true)
    expect(isStt('nvidia/parakeet-tdt-0.6b-v2')).toBe(true)
    expect(isStt('elevenlabs/scribe-v1')).toBe(true)
    expect(isStt('acme/new-asr', ['audio'])).toBe(true)
    // Multimodal chat models that also accept audio are not STT models.
    expect(isStt('google/gemini-2.5-flash', ['text', 'image', 'audio'])).toBe(false)
    expect(isStt('meta-llama/llama-3.3-70b-instruct')).toBe(false)
  })

  it('skips invalid entries and duplicate ids', () => {
    const list = parseModelList({
      data: [
        rawModel('a/one'),
        { name: 'no id' },
        null,
        'junk',
        rawModel('a/one'),
        rawModel('b/two'),
      ],
    })
    expect(list.map((m) => m.id)).toEqual(['a/one', 'b/two'])
    expect(parseModelList({})).toEqual([])
    expect(parseModelList(null)).toEqual([])
    expect(parseModel({ id: 'bare' })).toMatchObject({
      id: 'bare',
      name: 'bare',
      contextLength: null,
      inputModalities: [],
      supportsVision: false,
      description: null,
      pricing: { prompt: null, completion: null, request: null, image: null, audio: null },
    })
  })
})

describe('ModelCatalog', () => {
  it('fetches /models anonymously when there is no key, and caches in memory', async () => {
    const { catalog, fetch } = setup(okList)
    const first = await catalog.list()
    expect(first).toHaveLength(RAW_MODELS.length)
    expect(fetch.calls[0]?.url).toBe(`${BASE}/models`)
    expect(fetch.calls[0]?.init.headers?.['Authorization']).toBeUndefined()
    expect(fetch.calls[0]?.init.headers?.['X-Title']).toBe('Bluely')
    const second = await catalog.list()
    expect(second).toBe(first)
    expect(fetch.calls).toHaveLength(1)
  })

  it('includes the key when present and falls back to anonymous on 401', async () => {
    const { catalog, fetch } = setup(
      (_u, init) =>
        init.headers?.['Authorization']
          ? jsonResponse(401, { error: { code: 401, message: 'User not found.' } })
          : okList(),
      { key: 'sk-or-v1-revoked-123456' },
    )
    expect(await catalog.list()).toHaveLength(RAW_MODELS.length)
    expect(fetch.calls).toHaveLength(2)
    expect(fetch.calls[0]?.init.headers?.['Authorization']).toBe('Bearer sk-or-v1-revoked-123456')
    expect(fetch.calls[1]?.init.headers?.['Authorization']).toBeUndefined()
  })

  it('refetches when refresh is set or the cache is older than 6 h', async () => {
    let now = 1_000_000
    const { catalog, fetch } = setup(okList, { now: () => now })
    await catalog.list()
    await catalog.list({ refresh: true })
    expect(fetch.calls).toHaveLength(2)
    now += MODEL_CACHE_MAX_AGE_MS - 1
    await catalog.list()
    expect(fetch.calls).toHaveLength(2)
    now += 2
    await catalog.list()
    expect(fetch.calls).toHaveLength(3)
    expect(catalog.fetchedAt).toBe(now)
  })

  it('shares one request between concurrent callers', async () => {
    const { catalog, fetch } = setup(okList)
    const [a, b, c] = await Promise.all([
      catalog.list(),
      catalog.list(),
      catalog.list({ refresh: true }),
    ])
    expect(fetch.calls).toHaveLength(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('writes a disk cache that a later (offline) instance serves', async () => {
    const cacheFile = tmpCache()
    const online = setup(okList, { cacheFile, now: () => 5000 })
    await online.catalog.list()
    expect(existsSync(cacheFile)).toBe(true)
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      fetchedAt: number
      models: { id: string }[]
    }
    expect(onDisk.fetchedAt).toBe(5000)
    expect(onDisk.models.map((m) => m.id)).toContain('openai/whisper-large-v3-turbo')

    // Fresh disk cache: served without any request.
    const fresh = setup(offline, { cacheFile, now: () => 6000 })
    expect(await fresh.catalog.list()).toHaveLength(RAW_MODELS.length)
    expect(fresh.fetch.calls).toHaveLength(0)

    // Stale cache + offline: the fetch fails, the stale cache is served with a warning.
    const stale = setup(offline, { cacheFile, now: () => 5000 + MODEL_CACHE_MAX_AGE_MS + 1 })
    expect(await stale.catalog.list()).toHaveLength(RAW_MODELS.length)
    expect(stale.fetch.calls).toHaveLength(1)
    expect(stale.log.lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('returns [] with a warning when offline without a cache (never throws)', async () => {
    const { catalog, log } = setup(offline)
    await expect(catalog.list()).resolves.toEqual([])
    expect(log.lines.find((l) => l.level === 'warn')?.message).toMatch(/no cache/)
  })

  it('keeps the cached list when the server returns an error or an empty list', async () => {
    let mode: 'ok' | 'empty' | 'error' = 'ok'
    const { catalog } = setup(() =>
      mode === 'ok'
        ? okList()
        : mode === 'empty'
          ? jsonResponse(200, { data: [] })
          : jsonResponse(500, { error: { code: 500 } }),
    )
    await catalog.list()
    mode = 'empty'
    expect(await catalog.list({ refresh: true })).toHaveLength(RAW_MODELS.length)
    mode = 'error'
    expect(await catalog.list({ refresh: true })).toHaveLength(RAW_MODELS.length)
  })

  it('ignores a corrupt or invalid cache file', async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), 'bluely-models-')), 'models-cache.json')
    writeFileSync(cacheFile, '{ not json')
    const a = setup(offline, { cacheFile })
    expect(await a.catalog.list()).toEqual([])
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 1, models: [{ id: 42 }] }))
    const b = setup(offline, { cacheFile })
    expect(await b.catalog.list()).toEqual([])
  })

  it('offers role accessors over the cached list', async () => {
    const { catalog } = setup(okList)
    expect(catalog.snapshot()).toEqual([])
    await catalog.list()
    expect(catalog.getById('google/gemini-2.5-flash')?.supportsVision).toBe(true)
    expect(catalog.getById('nope')).toBeNull()
    expect(catalog.sttModels().map((m) => m.id)).toEqual([
      'openai/whisper-large-v3-turbo',
      'openai/whisper-large-v3',
    ])
    expect(catalog.visionModels().map((m) => m.id)).toContain('anthropic/claude-sonnet-4.5')
    expect(catalog.visionModels().map((m) => m.id)).not.toContain('openai/gpt-oss-120b')
    expect(catalog.chatModels().some((m) => m.isStt)).toBe(false)
    expect(catalog.chatModels()).toHaveLength(RAW_MODELS.length - 2)
  })
})
