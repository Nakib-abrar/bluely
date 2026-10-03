import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionState, TranscriptLine } from '@shared/types'
import { AiService } from '@main/live/aiService'
import { PostCallRunner } from '@main/live/postCallRunner'
import { SessionManager, type SegmentInput } from '@main/live/sessionManager'
import { ProviderError } from '@main/providers/errors'
import type { ChatRequest, ChatResult } from '@main/providers/llm/LLMProvider'
import type {
  TranscriptionDropReason,
  TranscriptionJob,
  TranscriptionQueueOptions,
} from '@main/providers/stt/transcriptionQueue'
import { SecretStore } from '@main/settings/secrets'
import type { SttFeature } from '@main/stt/wire'
import { createHarness, wav } from './harness'

/**
 * A transcription queue the test drives: results, failures and drops are delivered by hand,
 * and drain() really waits for outstanding jobs (like the real queue).
 */
class ControlledQueue {
  jobs: TranscriptionJob[] = []
  readonly pending = new Set<string>()
  private waiters = new Set<() => void>()
  constructor(readonly opts: Partial<TranscriptionQueueOptions>) {}

  enqueue(job: TranscriptionJob): void {
    this.jobs.push(job)
    this.pending.add(job.id)
  }

  deliver(job: TranscriptionJob, text: string): void {
    this.pending.delete(job.id)
    this.opts.onResult?.(job, {
      text,
      model: 'stt',
      latencyMs: 100,
      costUsd: null,
      audioSeconds: 1,
      language: null,
      endToTextMs: 300,
      receivedAt: Date.now(),
      attempts: 1,
    })
    this.check()
  }

  fail(job: TranscriptionJob, err: ProviderError, willRetry: boolean): void {
    if (!willRetry) this.pending.delete(job.id)
    this.opts.onError?.(job, err, { willRetry, attempt: 1, retryInMs: willRetry ? 500 : null })
    this.check()
  }

  drop(job: TranscriptionJob, reason: TranscriptionDropReason): void {
    this.pending.delete(job.id)
    this.opts.onDropped?.(job, reason)
    this.check()
  }

  setConcurrency(): void {}

  drain(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer)
        this.waiters.delete(onIdle)
        resolve(ok)
      }
      const onIdle = () => done(true)
      const timer = setTimeout(() => done(false), timeoutMs)
      this.waiters.add(onIdle)
    })
  }

  cancelAll(): void {
    for (const job of this.jobs) if (this.pending.has(job.id)) this.drop(job, 'cancelled')
  }

  isIdle(): boolean {
    return this.pending.size === 0
  }

  private check(): void {
    if (this.pending.size === 0) for (const w of [...this.waiters]) w()
  }
}

const POST_CALL_REPLY = (req: ChatRequest) => {
  const text = JSON.stringify(req.messages)
  if (text.includes('action item'))
    return JSON.stringify({ items: [{ text: 'Send pricing', owner: 'Me', due: null }] })
  if (text.toLowerCase().includes('email'))
    return JSON.stringify({ subject: 'Next steps', body: 'Thanks!' })
  return JSON.stringify({
    title: 'Pricing call',
    summary: 'We discussed pricing.',
    keyPoints: ['Per seat'],
    decisions: [],
  })
}

function setup(opts: { secrets?: SecretStore } = {}) {
  const h = createHarness()
  if (opts.secrets) (h.ctx as { secrets: SecretStore }).secrets = opts.secrets
  h.llm.reply = POST_CALL_REPLY
  const queues: ControlledQueue[] = []
  h.stt.createQueue = ((o: Partial<TranscriptionQueueOptions>) => {
    const q = new ControlledQueue(o)
    queues.push(q)
    return q
  }) as unknown as SttFeature['createQueue']
  const ai = new AiService(h.ctx, h.models, h.modes, h.history)
  const postCall = new PostCallRunner(h.ctx, h.models, h.history)
  const session = new SessionManager(h.ctx, {
    models: h.models,
    stt: h.stt,
    history: h.history,
    modes: h.modes,
    ai,
    postCall,
  })
  const lastState = () => h.eventsOf('session:state').at(-1) as LiveSessionState
  const queue = () => queues.at(-1) as ControlledQueue
  /** Starts a call and reports both channels listening. */
  const live = async () => {
    const { sessionId } = await session.start()
    session.setChannelStatus(sessionId, 'me', 'listening', null)
    session.setChannelStatus(sessionId, 'them', 'listening', null)
    return { sessionId, t0: lastState().startedAt as number }
  }
  /** Sends a segment that ended `endedAgoMs` ago and returns its queue job. */
  const segment = (
    sessionId: string,
    channel: 'me' | 'them',
    endedAgoMs: number,
    durationMs = 1500,
  ): TranscriptionJob => {
    const endedAt = Date.now() - endedAgoMs
    const input: SegmentInput = {
      sessionId,
      channel,
      startedAt: endedAt - durationMs,
      endedAt,
      vadEndAt: endedAt,
      forced: false,
      wav: wav(),
    }
    expect(session.acceptSegment(input)).toBe(true)
    return queue().jobs.at(-1) as TranscriptionJob
  }
  /** A transcribed Them line, so post-call has something to summarize. */
  const say = (sessionId: string, text: string) => {
    const job = segment(sessionId, 'them', 0)
    queue().deliver(job, text)
  }
  /** Holds every post-call (Notes model) request until release() is called. */
  const gatePostCall = () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const complete = h.llm.complete.bind(h.llm)
    h.llm.complete = async (req: ChatRequest): Promise<ChatResult> => {
      await gate
      return complete(req)
    }
    return () => release()
  }
  const autoRequests = () => h.llm.requests.filter((r) => r.tag === 'auto')
  const autoCards = () =>
    h.eventsOf('ai:card').filter((c) => (c as { kind: string }).kind === 'auto')
  return {
    ...h,
    ai,
    postCall,
    session,
    lastState,
    queue,
    live,
    segment,
    say,
    gatePostCall,
    autoRequests,
    autoCards,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionManager: stop and post-call (live F2, platform F11, F12/F4, mainui F3)', () => {
  it('stop() resolves when the call has ended; the notes keep generating in the background', async () => {
    const h = setup()
    const release = h.gatePostCall()
    const { sessionId } = await h.live()
    h.say(sessionId, 'We should send the pricing sheet tomorrow.')
    // Would never resolve if stop() still waited for the Notes model.
    await h.session.stop()
    expect(h.lastState()).toMatchObject({ status: 'processing', sessionId })
    expect(h.session.isLive()).toBe(false)
    // features.isBusy(): closing the main window now minimizes instead of quitting.
    expect(h.session.isPostCallRunning()).toBe(true)
    release()
    await h.session.whenPostCallIdle()
    expect(h.session.isPostCallRunning()).toBe(false)
    expect(h.history.sessions.get(sessionId)?.status).toBe('done')
    expect(h.lastState().status).toBe('idle')
  })

  it('the tray / global toggle starts the next call while notes are generating, and stops it', async () => {
    const h = setup()
    const release = h.gatePostCall()
    const first = await h.live()
    h.say(first.sessionId, 'We should send the pricing sheet tomorrow.')
    await h.session.stop()
    expect(h.lastState().status).toBe('processing')
    expect(h.session.isPostCallRunning()).toBe(true)

    h.session.toggle()
    const second = h.lastState()
    expect(second.status).toBe('starting')
    expect(second.sessionId).not.toBe(first.sessionId)
    h.session.setChannelStatus(second.sessionId as string, 'me', 'listening', null)

    // stop() acts on the new call, not on the previous call's pending work.
    const stopping = h.session.stop()
    expect(h.lastState()).toMatchObject({ status: 'stopping', sessionId: second.sessionId })
    await stopping
    expect(h.history.sessions.get(second.sessionId as string)?.endedAt).not.toBeNull()

    release()
    await h.session.whenPostCallIdle()
    expect(h.history.sessions.get(first.sessionId)?.status).toBe('done')
    expect(h.history.sessions.get(second.sessionId as string)?.status).not.toBe('active')
    expect(h.lastState()).toMatchObject({ status: 'idle', sessionId: null })
  })

  it('finishing the previous notes does not reset a call that started meanwhile', async () => {
    const h = setup()
    const release = h.gatePostCall()
    const first = await h.live()
    h.say(first.sessionId, 'We should send the pricing sheet tomorrow.')
    await h.session.stop()
    const next = await h.live()
    release()
    await vi.waitFor(() => expect(h.session.isPostCallRunning()).toBe(false))
    expect(h.lastState()).toMatchObject({ status: 'live', sessionId: next.sessionId })
  })

  it('regenerate passes the requested parts to the post-call runner', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    await h.session.stop()
    await h.session.whenPostCallIdle()
    const run = vi.spyOn(h.postCall, 'run')
    h.session.regenerate(sessionId, ['email'])
    expect(run).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ id: 'builtin-general' }),
      {
        parts: ['email'],
      },
    )
    await h.session.whenPostCallIdle()
  })
})

describe('SessionManager: auto-suggest around stop and echo (live F3, F4)', () => {
  it('a question transcribed while stopping never starts an auto-suggestion', async () => {
    const h = setup()
    ;(h.overlay as { window: unknown }).window = {}
    const { sessionId } = await h.live()
    const stopping = h.session.stop()
    expect(h.lastState().status).toBe('stopping')
    // The overlay flushes the trailing Them segment, then reports audio stopped.
    const job = h.segment(sessionId, 'them', 1000)
    h.session.audioStopped(sessionId)
    await sleep(0)
    // Transcribed during the STT drain.
    h.queue().deliver(job, 'Does that timeline work for you?')
    await stopping
    await h.session.whenPostCallIdle()
    await sleep(800)
    expect(h.autoRequests()).toHaveLength(0)
    expect(h.autoCards()).toHaveLength(0)
  })

  it('speaker echo of their continuation does not cancel the pending auto-suggestion', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    // Them: "What budget do you have for this?" … and they keep talking.
    const question = h.segment(sessionId, 'them', 2500)
    h.session.setSpeaking(sessionId, 'them', true)
    h.queue().deliver(question, 'What budget do you have for this?')
    // They stop; the continuation and its echo on the mic go to speech-to-text.
    h.session.setSpeaking(sessionId, 'them', false)
    const echo = h.segment(sessionId, 'me', 150, 1300)
    const continuation = h.segment(sessionId, 'them', 100, 1400)
    // The echo comes back first: nothing to match it against yet, so it is kept for now…
    h.queue().deliver(echo, 'I mean for Q3 specifically')
    expect((h.eventsOf('transcript:line') as TranscriptLine[]).map((l) => l.id)).toContain(echo.id)
    // …and retracted when the Them copy arrives.
    h.queue().deliver(continuation, 'I mean for Q3 specifically.')
    expect(h.eventsOf('transcript:remove')).toContainEqual({ id: echo.id, sessionId })
    await vi.waitFor(() => expect(h.autoCards()).toHaveLength(1), { timeout: 3000 })
    const req = h.autoRequests()[0] as ChatRequest
    expect(JSON.stringify(req.messages)).toContain('I mean for Q3 specifically')
  })

  it('my real reply still cancels the pending auto-suggestion right away', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    const question = h.segment(sessionId, 'them', 0)
    h.queue().deliver(question, 'How long does onboarding usually take?')
    const reply = h.segment(sessionId, 'me', 0, 800)
    h.queue().deliver(reply, 'Usually about two weeks for a team your size')
    await sleep(1000)
    expect(h.autoRequests()).toHaveLength(0)
  })

  it('a deferred Me line that is not an echo cancels once their line has arrived', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    const question = h.segment(sessionId, 'them', 0)
    h.queue().deliver(question, 'Can you walk me through the pricing?')
    // They say something short while I answer (crosstalk): my line waits for theirs.
    const theirs = h.segment(sessionId, 'them', 0, 600)
    const mine = h.segment(sessionId, 'me', 0, 900)
    h.queue().deliver(mine, 'Sure, we price per seat with volume discounts')
    h.queue().deliver(theirs, 'Okay.')
    await sleep(1000)
    expect(h.autoRequests()).toHaveLength(0)
  })
})

describe('SessionManager: key and error state (live F7, F10)', () => {
  it('clears the no-key warning when a key is saved mid-call, and after a successful line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bluely-key-'))
    const secrets = new SecretStore(join(dir, 'key.bin'))
    const h = setup({ secrets })
    const { sessionId } = await h.live()
    expect(h.lastState().warnings).toContain('no_key')
    secrets.setKey('sk-or-v1-abcdefghijklmnop')
    expect(h.lastState().warnings).not.toContain('no_key')

    // A no_key / credits error from speech-to-text…
    const a = h.segment(sessionId, 'them', 0)
    h.queue().fail(a, new ProviderError('credits'), false)
    expect(h.lastState().lastError).toBeTruthy()
    // …is resolved once a line is transcribed again.
    const b = h.segment(sessionId, 'them', 0)
    h.queue().deliver(b, 'Thanks for topping up.')
    expect(h.lastState().lastError).toBeNull()
    expect(h.lastState().warnings).not.toContain('no_key')
  })

  it('keeps "Transcription error (retrying)" while any job retries and reports lost speech', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const a = h.segment(sessionId, 'them', 0)
    const b = h.segment(sessionId, 'them', 0)
    const c = h.segment(sessionId, 'me', 0)
    h.queue().fail(a, new ProviderError('server'), true)
    h.queue().fail(b, new ProviderError('server'), true)
    expect(h.lastState().warnings).toContain('stt_error_retrying')
    // A successful line on another job, and a's final failure, leave b retrying.
    h.queue().deliver(c, 'Can you hear me now?')
    expect(h.lastState().warnings).toContain('stt_error_retrying')
    h.queue().fail(a, new ProviderError('server'), false)
    expect(h.lastState().warnings).toContain('stt_error_retrying')
    // The lost segment is reported instead of vanishing silently.
    expect(h.lastState().lastError).toBe('Some speech could not be transcribed (lost: 1).')
    h.queue().deliver(b, 'Yes, loud and clear.')
    expect(h.lastState().warnings).not.toContain('stt_error_retrying')
    expect(h.lastState().lastError).toBe('Some speech could not be transcribed (lost: 1).')
    vi.advanceTimersByTime(30_000)
    expect(h.lastState().lastError).toBeNull()
  })
})

describe('SessionManager: capture start and loss (live F11, OV-12, F6/OV-04)', () => {
  it('goes live once both channels have failed, instead of starting forever', async () => {
    const h = setup()
    const { sessionId } = await h.session.start()
    h.session.setChannelStatus(sessionId, 'me', 'error', 'No microphone', 'mic_not_found')
    expect(h.lastState().status).toBe('starting')
    h.session.setChannelStatus(sessionId, 'them', 'error', 'No loopback', 'loopback_unavailable')
    expect(h.lastState().status).toBe('live')
    expect(h.lastState().audio.me).toEqual({
      state: 'error',
      error: 'No microphone',
      code: 'mic_not_found',
    })
    expect(h.eventsOf('audio:channelStatus').at(-1)).toEqual({
      channel: 'them',
      status: { state: 'error', error: 'No loopback', code: 'loopback_unavailable' },
    })
  })

  it('marks channels that never report as failed after the start timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = setup()
    const { sessionId } = await h.session.start()
    vi.advanceTimersByTime(20_000)
    expect(h.lastState()).toMatchObject({ status: 'live', sessionId })
    expect(h.lastState().audio.me).toMatchObject({ state: 'error', code: 'unknown' })
    expect(h.lastState().audio.them.error).toBe('Audio capture did not start.')
  })

  it('a crashed overlay renderer shows both channels failed until capture restarts', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    h.session.captureLost()
    expect(h.lastState().status).toBe('live')
    expect(h.lastState().audio.me).toMatchObject({ state: 'error', code: 'unknown' })
    expect(h.lastState().audio.them).toMatchObject({ state: 'error', code: 'unknown' })
    // The reloaded renderer restarts capture and reports in.
    h.session.setChannelStatus(sessionId, 'me', 'listening', null)
    expect(h.lastState().audio.me.state).toBe('listening')
  })

  it('stop does not wait for a crashed renderer to flush its audio', async () => {
    const h = setup()
    ;(h.overlay as { window: unknown }).window = {}
    await h.live()
    const started = Date.now()
    const stopping = h.session.stop()
    h.session.captureLost()
    await stopping
    expect(Date.now() - started).toBeLessThan(2000)
    await h.session.whenPostCallIdle()
  })
})

describe('SessionManager: after the call (ai F3)', () => {
  it('live actions after the call has ended get no transcript of it', async () => {
    const h = setup()
    const { sessionId } = await h.live()
    const job = h.segment(sessionId, 'them', 0)
    h.queue().deliver(job, 'Please send me the pricing sheet after this call')
    expect(h.session.transcript()).toHaveLength(1)
    await h.session.stop()
    await h.session.whenPostCallIdle()
    expect(h.lastState().status).toBe('idle')
    expect(h.session.transcript()).toEqual([])
    h.llm.reply = () => 'Nothing to recap yet.'
    await h.ai.startLive({ kind: 'recap' }).finished
    const req = h.llm.requests.at(-1) as ChatRequest
    expect(JSON.stringify(req.messages)).not.toContain('pricing sheet')
  })
})

describe('SessionManager: auto-suggest toggle (OV-09)', () => {
  it('the overlay toggle turns auto-suggest on for this call even when the Mode has it off', async () => {
    const h = setup()
    h.settings.update({ activeModeId: 'builtin-standup' })
    const { sessionId } = await h.live()
    expect(h.lastState().autoSuggest).toBe(false)
    h.session.setAutoSuggest(true)
    expect(h.lastState().autoSuggest).toBe(true)
    // Not persisted: Settings › General keeps its value.
    expect(h.settings.get().general.autoSuggest).toBe(true)
    const q = h.segment(sessionId, 'them', 1000)
    h.queue().deliver(q, 'What did you get done yesterday?')
    await vi.waitFor(() => expect(h.autoCards()).toHaveLength(1), { timeout: 3000 })
    // The override ends with the call.
    await h.session.stop()
    expect(h.lastState().autoSuggest).toBe(false)
    await h.session.whenPostCallIdle()
  })

  it('turning it off for this call does not change the global setting', async () => {
    const h = setup()
    await h.live()
    h.session.setAutoSuggest(false)
    expect(h.lastState().autoSuggest).toBe(false)
    expect(h.settings.get().general.autoSuggest).toBe(true)
  })
})

describe('SessionManager: quitting during a call (platform F10)', () => {
  it('lets the overlay flush and drains speech-to-text before marking the call recovered', async () => {
    const h = setup()
    ;(h.overlay as { window: unknown }).window = {}
    const { sessionId } = await h.live()
    const inFlight = h.segment(sessionId, 'them', 500)
    const shutdown = h.session.shutdown()
    // The overlay sees 'stopping', stops capture and flushes its trailing speech.
    expect(h.lastState().status).toBe('stopping')
    const trailing = h.segment(sessionId, 'me', 0)
    h.session.audioStopped(sessionId)
    await sleep(0)
    h.queue().deliver(inFlight, 'So we agree on the March launch')
    h.queue().deliver(trailing, 'Yes, March works for us')
    await shutdown
    expect(
      h.history.transcript
        .listBySession(sessionId, { finalOnly: true })
        .map((l) => l.text)
        .sort(),
    ).toEqual(['So we agree on the March launch', 'Yes, March works for us'])
    expect(h.history.sessions.get(sessionId)?.status).toBe('recovered')
  })

  it('stays within the quit budget when nothing answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = setup()
    ;(h.overlay as { window: unknown }).window = {}
    const { sessionId } = await h.live()
    h.segment(sessionId, 'them', 0)
    let done = false
    void h.session.shutdown().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(3_199)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(h.history.sessions.get(sessionId)?.status).toBe('recovered')
  })
})

describe('SessionManager: deleted sessions (SEC-4)', () => {
  it('forgetLastSession() returns a call whose notes are generating to idle', async () => {
    const h = setup()
    const release = h.gatePostCall()
    const { sessionId } = await h.live()
    h.say(sessionId, 'We should send the pricing sheet tomorrow.')
    await h.session.stop()
    expect(h.lastState().status).toBe('processing')
    expect(h.session.lastSessionId()).toBe(sessionId)
    h.session.forgetLastSession()
    expect(h.session.lastSessionId()).toBeNull()
    expect(h.lastState()).toMatchObject({ status: 'idle', sessionId: null })
    expect(h.session.transcript()).toEqual([])
    release()
    await h.session.whenPostCallIdle()
    expect(h.lastState().status).toBe('idle')
  })
})
