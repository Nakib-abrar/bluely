import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockOpenRouter, type MockOpenRouter } from '../../../scripts/mock-openrouter.mjs'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import { OpenRouterSTT } from '@main/providers/stt/openrouterStt'
import {
  TranscriptionQueue,
  type QueuedTranscriptionResult,
  type TranscriptionDropReason,
  type TranscriptionJob,
} from '@main/providers/stt/transcriptionQueue'
import { fixture, makeWav, memoryLogger, silence } from './helpers'

/** End-to-end against scripts/mock-openrouter.mjs with the real HTTP layer (undici). */

let mock: MockOpenRouter
let http: OpenRouterHttp
let stt: OpenRouterSTT
const MODEL = 'openai/whisper-large-v3-turbo'

beforeAll(async () => {
  mock = await startMockOpenRouter({ sttMs: 5 })
  const log = memoryLogger()
  http = new OpenRouterHttp({ baseUrl: mock.baseUrl, getKey: () => 'sk-or-test-1234567890', log })
  stt = new OpenRouterSTT({ http, log })
})

afterAll(async () => {
  await http.close()
  await mock.close()
})

beforeEach(() => {
  mock.requests.length = 0
})

interface SttRecord {
  model: string
  temperature: number
  language?: string
  input_audio: { format: string; bytes: number }
}

describe('OpenRouterSTT against the mock server', () => {
  it('transcribes the 16 kHz speech fixture', async () => {
    const wav = fixture('speech-en-16k.wav')
    const r = await stt.transcribe(
      { channel: 'them', wav, startedAt: Date.now() - 8500, endedAt: Date.now() },
      { model: MODEL, language: 'auto' },
    )
    expect(r.text.length).toBeGreaterThan(0)
    expect(r.model).toBe(MODEL)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    // The mock bills ceil(duration) seconds at $0.00011/s of actual duration.
    expect(r.audioSeconds).toBe(9)
    expect(r.costUsd).toBeCloseTo((273202 / 32000) * 0.00011, 6)

    const rec = mock.requests.find((x) => x.path === '/audio/transcriptions')
    expect(rec).toBeDefined()
    expect(rec?.method).toBe('POST')
    expect(rec?.headers).toMatchObject({ referer: 'https://github.com/nakib-abrar/bluely' })
    expect(rec?.headers.title).toBe('Bluely')
    const body = rec?.body as SttRecord
    expect(body.model).toBe(MODEL)
    expect(body.temperature).toBe(0)
    expect('language' in body).toBe(false)
    expect(body.input_audio).toEqual({
      format: 'wav',
      bytes: Buffer.from(wav).toString('base64').length,
    })
  })

  it('transcribes the 48 kHz fixture and forwards an explicit language', async () => {
    const wav = fixture('speech-en-48k.wav')
    const r = await stt.transcribe(
      { channel: 'me', wav, startedAt: 0, endedAt: 1 },
      { model: MODEL, language: 'EN' },
    )
    expect(r.text.length).toBeGreaterThan(0)
    expect((mock.requests.at(-1)?.body as SttRecord).language).toBe('en')
  })

  it('surfaces auth errors from the server', async () => {
    const bad = new OpenRouterHttp({
      baseUrl: mock.baseUrl,
      getKey: () => 'sk-or-bad-1234567890',
      log: memoryLogger(),
    })
    const badStt = new OpenRouterSTT({ http: bad, log: memoryLogger() })
    await expect(
      badStt.transcribe(
        { channel: 'me', wav: fixture('speech-en-16k.wav'), startedAt: 0, endedAt: 1 },
        { model: MODEL },
      ),
    ).rejects.toMatchObject({ code: 'auth', status: 401 })
    await bad.close()
  })
})

describe('TranscriptionQueue against the mock server', () => {
  it('delivers speech and drops a 0.2 s silent segment without a request', async () => {
    const results: { job: TranscriptionJob; result: QueuedTranscriptionResult }[] = []
    const drops: { job: TranscriptionJob; reason: TranscriptionDropReason }[] = []
    const errors: unknown[] = []
    const q = new TranscriptionQueue({
      stt,
      log: memoryLogger(),
      getOptions: () => ({ model: MODEL, language: null }),
      onResult: (job, result) => results.push({ job, result }),
      onError: (_job, err) => errors.push(err),
      onDropped: (job, reason) => drops.push({ job, reason }),
    })
    const now = Date.now()
    const speech: TranscriptionJob = {
      id: 'speech',
      sessionId: 's1',
      channel: 'them',
      segment: {
        channel: 'them',
        wav: fixture('speech-en-16k.wav'),
        startedAt: now - 9000,
        endedAt: now,
      },
      vadEndAt: now,
      forced: false,
    }
    const quiet: TranscriptionJob = {
      id: 'quiet',
      sessionId: 's1',
      channel: 'them',
      segment: { channel: 'them', wav: makeWav(silence(0.2)), startedAt: now, endedAt: now + 200 },
      vadEndAt: now + 200,
      forced: false,
    }
    q.enqueue(speech)
    q.enqueue(quiet)
    expect(await q.drain(10_000)).toBe(true)

    expect(errors).toEqual([])
    expect(results).toHaveLength(1)
    expect(results[0]!.job.id).toBe('speech')
    expect(results[0]!.result.text.length).toBeGreaterThan(0)
    expect(results[0]!.result.endToTextMs).toBeGreaterThanOrEqual(0)
    expect(drops).toEqual([{ job: quiet, reason: 'silent' }])
    expect(mock.requests.filter((x) => x.path === '/audio/transcriptions')).toHaveLength(1)
    expect(q.stats()).toMatchObject({ completed: 1, dropped: 1, failed: 0, inFlight: 0 })
  })
})
