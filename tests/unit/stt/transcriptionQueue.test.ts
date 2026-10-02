import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Channel } from '@shared/types'
import { ProviderError } from '@main/providers/errors'
import type {
  AudioSegment,
  STTProvider,
  TranscribeOptions,
  TranscriptionResult,
} from '@main/providers/stt/STTProvider'
import {
  retryDelayMs,
  TranscriptionQueue,
  type QueuedTranscriptionResult,
  type TranscriptionDropReason,
  type TranscriptionErrorInfo,
  type TranscriptionJob,
  type TranscriptionQueueOptions,
} from '@main/providers/stt/transcriptionQueue'
import {
  deferred,
  flushMicrotasks,
  makeWav,
  memoryLogger,
  silence,
  speechLikeWav,
  sttResult,
  type Deferred,
} from './helpers'

interface Call {
  segment: AudioSegment
  opts: TranscribeOptions
  d: Deferred<TranscriptionResult>
}

/** STT provider whose calls are resolved by the test. Honours abort like a real one. */
class FakeStt implements STTProvider {
  readonly id = 'fake'
  readonly supportsStreaming = false
  calls: Call[] = []

  transcribe(segment: AudioSegment, opts: TranscribeOptions): Promise<TranscriptionResult> {
    const d = deferred<TranscriptionResult>()
    opts.signal?.addEventListener('abort', () => d.reject(new ProviderError('aborted')), {
      once: true,
    })
    this.calls.push({ segment, opts, d })
    return d.promise
  }

  callFor(jobWav: Uint8Array): Call | undefined {
    return this.calls.find((c) => c.segment.wav === jobWav)
  }
}

interface Harness {
  q: TranscriptionQueue
  stt: FakeStt
  results: { job: TranscriptionJob; result: QueuedTranscriptionResult }[]
  errors: { job: TranscriptionJob; err: ProviderError; info: TranscriptionErrorInfo }[]
  drops: { job: TranscriptionJob; reason: TranscriptionDropReason }[]
  usage: { job: TranscriptionJob; result: TranscriptionResult }[]
  clock: { t: number }
  log: ReturnType<typeof memoryLogger>
}

function harness(over: Partial<TranscriptionQueueOptions> = {}): Harness {
  const stt = new FakeStt()
  const clock = { t: 10_000 }
  const h: Omit<Harness, 'q'> = {
    stt,
    results: [],
    errors: [],
    drops: [],
    usage: [],
    clock,
    log: memoryLogger(),
  }
  const q = new TranscriptionQueue({
    stt,
    log: h.log,
    getOptions: () => ({ model: 'openai/whisper-large-v3-turbo', language: null }),
    now: () => clock.t,
    onResult: (job, result) => h.results.push({ job, result }),
    onError: (job, err, info) => h.errors.push({ job, err, info }),
    onDropped: (job, reason) => h.drops.push({ job, reason }),
    onUsage: (job, result) => h.usage.push({ job, result }),
    ...over,
  })
  return { ...h, q }
}

let nextId = 0
function job(channel: Channel, startedAt: number, wav: Uint8Array = speechLikeWav()) {
  const id = `job-${++nextId}`
  return {
    id,
    sessionId: 'session-1',
    channel,
    segment: { channel, wav, startedAt, endedAt: startedAt + 1000 },
    vadEndAt: startedAt + 1000,
    forced: false,
  } satisfies TranscriptionJob
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TranscriptionQueue concurrency and ordering', () => {
  it('runs at most N requests per channel; the third job waits', async () => {
    const h = harness()
    const [a, b, c] = [job('me', 1), job('me', 2), job('me', 3)]
    h.q.enqueue(a)
    h.q.enqueue(b)
    h.q.enqueue(c)
    expect(h.stt.calls).toHaveLength(0) // nothing starts inside enqueue()
    await flushMicrotasks()
    expect(h.stt.calls.map((x) => x.segment)).toEqual([a.segment, b.segment])
    expect(h.q.stats()).toMatchObject({ inFlight: 2, queued: 1 })

    h.stt.calls[0]!.d.resolve(sttResult('First line here.'))
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(3)
    expect(h.stt.calls[2]!.segment).toBe(c.segment)
    expect(h.q.stats()).toMatchObject({ inFlight: 2, queued: 0, completed: 1 })
  })

  it('honours a custom concurrency and setConcurrency()', async () => {
    const h = harness({ concurrencyPerChannel: 1 })
    h.q.enqueue(job('me', 1))
    h.q.enqueue(job('me', 2))
    h.q.enqueue(job('me', 3))
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(1)
    h.q.setConcurrency(3)
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(3)
  })

  it('holds a later result until the earlier job of the same channel resolves', async () => {
    const h = harness()
    const first = job('them', 100)
    const second = job('them', 200)
    h.q.enqueue(first)
    h.q.enqueue(second)
    await flushMicrotasks()

    h.stt.calls[1]!.d.resolve(sttResult('Second sentence.'))
    await flushMicrotasks()
    expect(h.results).toHaveLength(0)
    // The finished job no longer occupies a request slot while it waits.
    expect(h.q.stats().inFlight).toBe(1)
    expect(h.q.isIdle()).toBe(false)

    h.stt.calls[0]!.d.resolve(sttResult('First sentence.'))
    await flushMicrotasks()
    expect(h.results.map((r) => r.job.id)).toEqual([first.id, second.id])
    expect(h.results.map((r) => r.result.text)).toEqual(['First sentence.', 'Second sentence.'])
  })

  it('orders by segment.startedAt even when jobs are enqueued out of order', async () => {
    const h = harness({ concurrencyPerChannel: 4 })
    const late = job('me', 500)
    const early = job('me', 100)
    h.q.enqueue(late)
    h.q.enqueue(early)
    await flushMicrotasks()
    h.stt.callFor(late.segment.wav)!.d.resolve(sttResult('Late one.'))
    h.stt.callFor(early.segment.wav)!.d.resolve(sttResult('Early one.'))
    await flushMicrotasks()
    expect(h.results.map((r) => r.job.id)).toEqual([early.id, late.id])
  })

  it('keeps channels independent', async () => {
    const h = harness()
    const me1 = job('me', 1)
    const me2 = job('me', 2)
    const me3 = job('me', 3)
    const them1 = job('them', 4)
    for (const j of [me1, me2, me3, them1]) h.q.enqueue(j)
    await flushMicrotasks()
    // Two "me" requests do not block "them".
    expect(h.stt.calls.map((c) => c.segment.channel)).toEqual(['me', 'me', 'them'])

    h.stt.callFor(them1.segment.wav)!.d.resolve(sttResult('They said this.'))
    await flushMicrotasks()
    // Delivered although an earlier-started "me" job is still pending.
    expect(h.results.map((r) => r.job.id)).toEqual([them1.id])
  })

  it('reports end-to-text latency from vadEndAt and averages it in stats', async () => {
    const h = harness()
    const a = job('me', 1_000) // vadEndAt 2_000
    const b = job('me', 3_000) // vadEndAt 4_000
    h.q.enqueue(a)
    h.q.enqueue(b)
    await flushMicrotasks()
    h.clock.t = 2_800
    h.stt.calls[0]!.d.resolve(sttResult('One two three.', { latencyMs: 640 }))
    await flushMicrotasks()
    h.clock.t = 5_000
    h.stt.calls[1]!.d.resolve(sttResult('Four five six.'))
    await flushMicrotasks()
    expect(h.results[0]!.result).toMatchObject({
      text: 'One two three.',
      latencyMs: 640,
      endToTextMs: 800,
      receivedAt: 2_800,
      attempts: 1,
    })
    expect(h.results[1]!.result.endToTextMs).toBe(1_000)
    expect(h.q.stats()).toEqual({
      inFlight: 0,
      queued: 0,
      completed: 2,
      failed: 0,
      dropped: 0,
      avgLatencyMs: 900,
    })
  })

  it('cleans transcript text before delivering it', async () => {
    const h = harness()
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    h.stt.calls[0]!.d.resolve(sttResult('  >> So   what is the  price? '))
    await flushMicrotasks()
    expect(h.results[0]!.result.text).toBe('So what is the price?')
  })

  it('reads options before every attempt and passes its own abort signal', async () => {
    let language: string | null = 'en'
    const h = harness({ getOptions: () => ({ model: 'm1', language }) })
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    language = 'bn'
    h.q.enqueue(job('me', 2))
    await flushMicrotasks()
    expect(h.stt.calls.map((c) => c.opts.language)).toEqual(['en', 'bn'])
    expect(h.stt.calls[0]!.opts.signal).toBeInstanceOf(AbortSignal)
    expect(h.stt.calls[0]!.opts.model).toBe('m1')
  })
})

describe('TranscriptionQueue retries', () => {
  it('retries retryable errors with 500 ms then 1500 ms backoff', async () => {
    vi.useFakeTimers()
    const h = harness()
    const j = job('them', 1)
    h.q.enqueue(j)
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(1)

    h.stt.calls[0]!.d.reject(new ProviderError('server', { status: 502 }))
    await flushMicrotasks()
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.info).toEqual({ willRetry: true, attempt: 1, retryInMs: 500 })
    expect(h.errors[0]!.err.code).toBe('server')
    expect(h.q.stats().inFlight).toBe(1)

    await vi.advanceTimersByTimeAsync(499)
    expect(h.stt.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.stt.calls).toHaveLength(2)

    h.stt.calls[1]!.d.reject(new ProviderError('network'))
    await flushMicrotasks()
    expect(h.errors[1]!.info).toEqual({ willRetry: true, attempt: 2, retryInMs: 1500 })
    await vi.advanceTimersByTimeAsync(1499)
    expect(h.stt.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.stt.calls).toHaveLength(3)

    h.stt.calls[2]!.d.resolve(sttResult('Finally through.'))
    await flushMicrotasks()
    expect(h.results).toHaveLength(1)
    expect(h.results[0]!.result.attempts).toBe(3)
    expect(h.q.stats()).toMatchObject({ completed: 1, failed: 0, inFlight: 0 })
  })

  it('gives up after maxRetries, reports willRetry:false and releases the ordering slot', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = job('me', 1)
    const second = job('me', 2)
    h.q.enqueue(first)
    h.q.enqueue(second)
    await flushMicrotasks()
    h.stt.callFor(second.segment.wav)!.d.resolve(sttResult('Second is fine.'))
    await flushMicrotasks()
    expect(h.results).toHaveLength(0) // held behind the failing first job

    for (let attempt = 1; attempt <= 3; attempt++) {
      const calls = h.stt.calls.filter((c) => c.segment === first.segment)
      calls[calls.length - 1]!.d.reject(new ProviderError('timeout'))
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(h.stt.calls.filter((c) => c.segment === first.segment)).toHaveLength(3)
    expect(h.errors.map((e) => e.info.willRetry)).toEqual([true, true, false])
    expect(h.errors[2]!.info).toEqual({ willRetry: false, attempt: 3, retryInMs: null })
    expect(h.results.map((r) => r.job.id)).toEqual([second.id])
    expect(h.q.stats()).toMatchObject({ failed: 1, completed: 1, inFlight: 0 })
    expect(h.q.isIdle()).toBe(true)
  })

  it('honours Retry-After (up to 5 s)', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.q.enqueue(job('them', 1))
    await flushMicrotasks()
    h.stt.calls[0]!.d.reject(new ProviderError('rate_limit', { status: 429, retryAfterSec: 3 }))
    await flushMicrotasks()
    expect(h.errors[0]!.info.retryInMs).toBe(3000)
    await vi.advanceTimersByTimeAsync(2999)
    expect(h.stt.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.stt.calls).toHaveLength(2)

    h.stt.calls[1]!.d.reject(new ProviderError('rate_limit', { status: 429, retryAfterSec: 120 }))
    await flushMicrotasks()
    expect(h.errors[1]!.info.retryInMs).toBe(5000)
  })

  it('computes backoff delays', () => {
    const server = new ProviderError('server')
    expect(retryDelayMs(1, server)).toBe(500)
    expect(retryDelayMs(2, server)).toBe(1500)
    expect(retryDelayMs(3, server)).toBe(3000)
    expect(retryDelayMs(4, server)).toBe(5000)
    expect(retryDelayMs(1, new ProviderError('rate_limit', { retryAfterSec: 0 }))).toBe(500)
    expect(retryDelayMs(1, new ProviderError('rate_limit', { retryAfterSec: 2 }))).toBe(2000)
    expect(retryDelayMs(2, new ProviderError('rate_limit', { retryAfterSec: 1 }))).toBe(1500)
    expect(retryDelayMs(1, new ProviderError('rate_limit', { retryAfterSec: 9 }))).toBe(5000)
  })

  it('does not retry non-retryable errors', async () => {
    const h = harness()
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    h.stt.calls[0]!.d.reject(new ProviderError('auth', { status: 401 }))
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(1)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.err.code).toBe('auth')
    expect(h.errors[0]!.info).toEqual({ willRetry: false, attempt: 1, retryInMs: null })
    expect(h.q.stats()).toMatchObject({ failed: 1, inFlight: 0 })
    expect(await h.q.drain(10)).toBe(true)
  })

  it('respects maxRetries: 0', async () => {
    const h = harness({ maxRetries: 0 })
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    h.stt.calls[0]!.d.reject(new ProviderError('server'))
    await flushMicrotasks()
    expect(h.errors[0]!.info.willRetry).toBe(false)
    expect(h.stt.calls).toHaveLength(1)
  })

  it('wraps unexpected errors as non-retryable ProviderErrors', async () => {
    const h = harness()
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    h.stt.calls[0]!.d.reject(new Error('kaboom'))
    await flushMicrotasks()
    expect(h.errors[0]!.err).toBeInstanceOf(ProviderError)
    expect(h.errors[0]!.err).toMatchObject({ code: 'unknown', detail: 'kaboom', retryable: false })
  })

  it('fails the job (instead of hanging) when getOptions throws', async () => {
    const h = harness({
      getOptions: () => {
        throw new Error('settings unavailable')
      },
    })
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(0)
    expect(h.errors[0]!.info.willRetry).toBe(false)
    expect(h.q.isIdle()).toBe(true)
  })

  it('survives a malformed provider result', async () => {
    const h = harness()
    h.q.enqueue(job('me', 1))
    h.q.enqueue(job('me', 2))
    await flushMicrotasks()
    h.stt.calls[0]!.d.resolve({ ...sttResult('x'), text: undefined as unknown as string })
    h.stt.calls[1]!.d.resolve(sttResult('The second one works.'))
    await flushMicrotasks()
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.err.code).toBe('unknown')
    expect(h.results.map((r) => r.result.text)).toEqual(['The second one works.'])
    expect(h.q.isIdle()).toBe(true)
  })
})

describe('TranscriptionQueue drop paths', () => {
  it('skips near-silent audio without a request', async () => {
    const h = harness()
    const quiet = job('them', 1, makeWav(silence(0.2)))
    h.q.enqueue(quiet)
    expect(h.drops).toHaveLength(0) // never synchronous
    await flushMicrotasks()
    expect(h.drops).toEqual([{ job: quiet, reason: 'silent' }])
    expect(h.stt.calls).toHaveLength(0)
    expect(h.q.stats()).toMatchObject({ dropped: 1, queued: 0, inFlight: 0 })
  })

  it('honours a custom silence threshold', async () => {
    const h = harness({ silenceThreshold: 0.5 })
    h.q.enqueue(job('them', 1))
    await flushMicrotasks()
    expect(h.drops[0]!.reason).toBe('silent')
  })

  it('drops empty text and records usage for it', async () => {
    const h = harness()
    const a = job('me', 1)
    const b = job('me', 2)
    h.q.enqueue(a)
    h.q.enqueue(b)
    await flushMicrotasks()
    h.stt.calls[0]!.d.resolve(sttResult(''))
    h.stt.calls[1]!.d.resolve(sttResult(' ... '))
    await flushMicrotasks()
    expect(h.drops.map((d) => d.reason)).toEqual(['empty', 'empty'])
    expect(h.usage).toHaveLength(2)
    expect(h.results).toHaveLength(0)
  })

  it('drops hallucinations but still reports their (billed) usage', async () => {
    const h = harness()
    const a = job('them', 1)
    const b = job('them', 2)
    h.q.enqueue(a)
    h.q.enqueue(b)
    await flushMicrotasks()
    h.stt.calls[1]!.d.resolve(sttResult('What is the price per seat?'))
    h.stt.calls[0]!.d.resolve(sttResult('Thanks for watching!'))
    await flushMicrotasks()
    expect(h.drops).toEqual([{ job: a, reason: 'hallucination' }])
    expect(h.results.map((r) => r.job.id)).toEqual([b.id])
    expect(h.usage.map((u) => u.job.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('uses the segment level for filler phrases: quiet "Thank you." is dropped', async () => {
    const h = harness({ silenceThreshold: 0.001 })
    const quietTone = makeWav(
      Array.from({ length: 16000 }, (_, i) => 0.004 * Math.sin((2 * Math.PI * 440 * i) / 16000)),
    )
    const loud = job('me', 2)
    h.q.enqueue(job('me', 1, quietTone))
    h.q.enqueue(loud)
    await flushMicrotasks()
    h.stt.calls[0]!.d.resolve(sttResult('Thank you.'))
    h.stt.calls[1]!.d.resolve(sttResult('Thank you.'))
    await flushMicrotasks()
    expect(h.drops.map((d) => d.reason)).toEqual(['hallucination'])
    expect(h.results.map((r) => r.job.id)).toEqual([loud.id])
  })

  it('reports unreadable audio as a final error without a request', async () => {
    const h = harness()
    const bad = job('me', 1, new Uint8Array(64).fill(1))
    h.q.enqueue(bad)
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(0)
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.info).toEqual({ willRetry: false, attempt: 0, retryInMs: null })
    expect(h.errors[0]!.err.detail).toMatch(/invalid_audio/)
    expect(h.q.stats().failed).toBe(1)
  })

  it('keeps working when a callback throws', async () => {
    const h = harness({
      onResult: () => {
        throw new Error('consumer bug')
      },
    })
    h.q.enqueue(job('me', 1))
    h.q.enqueue(job('me', 2))
    await flushMicrotasks()
    h.stt.calls[0]!.d.resolve(sttResult('One.'))
    h.stt.calls[1]!.d.resolve(sttResult('Two.'))
    await flushMicrotasks()
    expect(h.q.stats().completed).toBe(2)
    expect(h.log.entries.some((e) => e.level === 'error' && /onResult/.test(e.message))).toBe(true)
  })
})

describe('TranscriptionQueue drain and cancelAll', () => {
  it('drain resolves true immediately when idle', async () => {
    const h = harness()
    expect(h.q.isIdle()).toBe(true)
    expect(await h.q.drain(0)).toBe(true)
  })

  it('drain waits for queued, running and held work', async () => {
    const h = harness({ concurrencyPerChannel: 1 })
    h.q.enqueue(job('me', 1))
    h.q.enqueue(job('me', 2))
    let drained: boolean | null = null
    void h.q.drain(5_000).then((v) => {
      drained = v
    })
    await flushMicrotasks()
    h.stt.calls[0]!.d.resolve(sttResult('One.'))
    await flushMicrotasks()
    expect(drained).toBeNull()
    h.stt.calls[1]!.d.resolve(sttResult('Two.'))
    await flushMicrotasks()
    expect(drained).toBe(true)
  })

  it('drain waits for pending drop callbacks', async () => {
    const h = harness()
    h.q.enqueue(job('me', 1, makeWav(silence(0.2))))
    expect(h.q.isIdle()).toBe(false)
    expect(await h.q.drain(1_000)).toBe(true)
    expect(h.drops).toHaveLength(1)
  })

  it('drain resolves false on timeout', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.q.enqueue(job('me', 1))
    let drained: boolean | null = null
    void h.q.drain(1_000).then((v) => {
      drained = v
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(drained).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(drained).toBe(false)
  })

  it('cancelAll aborts in-flight requests, clears the queue and reports cancelled jobs', async () => {
    const h = harness()
    const a = job('me', 1)
    const b = job('me', 2)
    const c = job('me', 3)
    const t = job('them', 4)
    for (const j of [a, b, c, t]) h.q.enqueue(j)
    await flushMicrotasks()
    const signals = h.stt.calls.map((x) => x.opts.signal!)
    expect(signals).toHaveLength(3)

    h.q.cancelAll()
    expect(signals.every((s) => s.aborted)).toBe(true)
    expect(h.drops.map((d) => [d.job.id, d.reason])).toEqual([
      [a.id, 'cancelled'],
      [b.id, 'cancelled'],
      [c.id, 'cancelled'],
      [t.id, 'cancelled'],
    ])
    await flushMicrotasks()
    expect(h.stt.calls).toHaveLength(3) // the queued job never started
    expect(h.errors).toHaveLength(0) // aborts of cancelled jobs are not errors
    expect(h.q.isIdle()).toBe(true)
    expect(await h.q.drain(0)).toBe(true)
    expect(h.q.stats()).toMatchObject({ inFlight: 0, queued: 0, dropped: 4 })
  })

  it('cancelAll delivers results that were only held for ordering', async () => {
    const h = harness()
    const a = job('me', 1)
    const b = job('me', 2)
    h.q.enqueue(a)
    h.q.enqueue(b)
    await flushMicrotasks()
    h.stt.calls[1]!.d.resolve(sttResult('Already transcribed.'))
    await flushMicrotasks()
    h.q.cancelAll()
    expect(h.drops.map((d) => d.job.id)).toEqual([a.id])
    expect(h.results.map((r) => r.job.id)).toEqual([b.id])
  })

  it('cancelAll stops a job waiting for a retry', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    h.stt.calls[0]!.d.reject(new ProviderError('server'))
    await flushMicrotasks()
    expect(h.errors[0]!.info.willRetry).toBe(true)
    h.q.cancelAll()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.stt.calls).toHaveLength(1)
    expect(h.drops.map((d) => d.reason)).toEqual(['cancelled'])
    expect(h.q.isIdle()).toBe(true)
  })

  it('ignores late answers from cancelled requests and stays usable', async () => {
    const stt = new FakeStt()
    // A provider that ignores abort signals entirely.
    stt.transcribe = (segment, opts) => {
      const d = deferred<TranscriptionResult>()
      stt.calls.push({ segment, opts, d })
      return d.promise
    }
    const h = harness({ stt })
    h.q.enqueue(job('me', 1))
    await flushMicrotasks()
    h.q.cancelAll()
    stt.calls[0]!.d.resolve(sttResult('Too late.'))
    await flushMicrotasks()
    expect(h.results).toHaveLength(0)
    expect(h.q.stats()).toMatchObject({ completed: 0, dropped: 1, inFlight: 0 })

    const next = job('me', 10)
    h.q.enqueue(next)
    await flushMicrotasks()
    stt.calls[1]!.d.resolve(sttResult('Fresh start.'))
    await flushMicrotasks()
    expect(h.results.map((r) => r.job.id)).toEqual([next.id])
  })
})
