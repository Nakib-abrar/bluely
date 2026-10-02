import type { Channel } from '@shared/types'
import { AppError } from '../../errors'
import type { Logger } from '../../log'
import { ProviderError } from '../errors'
import { cleanTranscript, hasSpeechContent, isLikelyHallucination } from './hallucinations'
import type {
  AudioSegment,
  STTProvider,
  TranscribeOptions,
  TranscriptionResult,
} from './STTProvider'
import { isPcm16, parseWavHeader, pcm16Levels, SILENCE_RMS_THRESHOLD, type WavHeader } from './wav'

/** One VAD segment waiting to become a transcript line. */
export interface TranscriptionJob {
  id: string
  sessionId: string
  channel: Channel
  segment: AudioSegment
  /** Epoch ms when VAD reported the end of speech (or the length cap cut the segment). */
  vadEndAt: number
  /** True when the segment was cut by the max-length cap rather than a pause. */
  forced: boolean
}

export type TranscriptionDropReason = 'silent' | 'hallucination' | 'empty' | 'cancelled'

/** What onResult receives: the provider result plus end-to-end timing. */
export interface QueuedTranscriptionResult extends TranscriptionResult {
  /** VAD end → text received, in ms. This is the number for the speed readout. */
  endToTextMs: number
  /** Epoch ms when the text arrived (LatencyTrace.sttDoneAt). */
  receivedAt: number
  /** Attempts it took, 1 = first try. */
  attempts: number
}

export interface TranscriptionErrorInfo {
  /** True while the queue is going to try again (UI: "Transcription error (retrying)"). */
  willRetry: boolean
  /** 1-based attempt that failed; 0 when the job never reached the provider (bad audio). */
  attempt: number
  /** Backoff before the next attempt, when willRetry. */
  retryInMs: number | null
}

export interface TranscriptionQueueStats {
  /** Jobs being transcribed or waiting for a retry. */
  inFlight: number
  /** Jobs waiting for a free slot. */
  queued: number
  /** Results delivered to onResult. */
  completed: number
  /** Jobs that failed for good. */
  failed: number
  /** Jobs dropped (silent, hallucination, empty or cancelled). */
  dropped: number
  /** Mean VAD end → text latency of the last 20 results, null before the first. */
  avgLatencyMs: number | null
}

export interface TranscriptionQueueOptions {
  stt: STTProvider
  log: Logger
  /** Read before every attempt so model/language changes apply immediately. */
  getOptions: () => TranscribeOptions
  /** Parallel requests per channel (default 2). */
  concurrencyPerChannel?: number
  /** Retries after the first attempt for retryable errors (default 2). */
  maxRetries?: number
  now?: () => number
  /** Peak-window RMS below which a segment is skipped as silent (default 0.004). */
  silenceThreshold?: number
  /** Delivered in segment.startedAt order per channel. */
  onResult(job: TranscriptionJob, result: QueuedTranscriptionResult): void
  /** Every failed attempt; `info.willRetry` is false on the final one. */
  onError(job: TranscriptionJob, err: ProviderError, info: TranscriptionErrorInfo): void
  onDropped?(job: TranscriptionJob, reason: TranscriptionDropReason): void
  /**
   * Every successful provider response, including ones later dropped as hallucinations
   * (they are billed all the same). Used for usage/cost logging.
   */
  onUsage?(job: TranscriptionJob, result: TranscriptionResult): void
}

/** Backoff before retry n (1-based); later retries double, capped at MAX_BACKOFF_MS. */
const BACKOFF_MS = [500, 1500]
const MAX_BACKOFF_MS = 5000
const LATENCY_WINDOW = 20

type EntryState = 'queued' | 'running' | 'ready' | 'released'

interface Entry {
  job: TranscriptionJob
  seq: number
  state: EntryState
  header: WavHeader
  rms: number | null
  result: QueuedTranscriptionResult | null
  /** Attempts started so far. */
  attempt: number
  controller: AbortController | null
  /** Cancels a pending retry backoff. */
  wake: (() => void) | null
}

interface ChannelState {
  /** Undelivered entries in segment.startedAt order (the ordering slots). */
  order: Entry[]
  /** Entries waiting for a slot, in the same order. */
  waiting: Entry[]
  running: number
}

/** Retry delay for the attempt that just failed. Honours Retry-After up to 5 s. */
export function retryDelayMs(attempt: number, err: ProviderError): number {
  const base =
    BACKOFF_MS[attempt - 1] ??
    Math.min(MAX_BACKOFF_MS, (BACKOFF_MS[BACKOFF_MS.length - 1] ?? 1500) * 2 ** (attempt - 2))
  if (err.retryAfterSec == null) return base
  return Math.max(base, Math.min(err.retryAfterSec * 1000, MAX_BACKOFF_MS))
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof AppError) {
    return new ProviderError('unknown', { detail: `${err.code}: ${err.message}` })
  }
  return new ProviderError('unknown', { detail: err instanceof Error ? err.message : String(err) })
}

/**
 * Turns VAD segments into transcript text: skips near-silent audio, runs up to N requests per
 * channel in parallel, retries transient failures with backoff, filters empty/hallucinated
 * text and delivers results per channel in the order the segments were spoken.
 *
 * Callbacks never fire synchronously inside enqueue().
 */
export class TranscriptionQueue {
  private readonly opts: TranscriptionQueueOptions
  private readonly log: Logger
  private readonly now: () => number
  private readonly maxRetries: number
  private readonly silenceThreshold: number
  private concurrency: number
  private readonly channels = new Map<Channel, ChannelState>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly latencies: number[] = []
  private pendingCallbacks = 0
  private seq = 0
  private completed = 0
  private failed = 0
  private dropped = 0

  constructor(opts: TranscriptionQueueOptions) {
    this.opts = opts
    this.log = opts.log
    this.now = opts.now ?? Date.now
    this.maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 2))
    this.silenceThreshold = opts.silenceThreshold ?? SILENCE_RMS_THRESHOLD
    this.concurrency = TranscriptionQueue.clampConcurrency(opts.concurrencyPerChannel ?? 2)
  }

  private static clampConcurrency(n: number): number {
    return Number.isFinite(n) ? Math.min(8, Math.max(1, Math.floor(n))) : 2
  }

  /** Adds a segment. Near-silent or unreadable audio is rejected without a request. */
  enqueue(job: TranscriptionJob): void {
    let header: WavHeader
    let rms: number | null = null
    try {
      header = parseWavHeader(job.segment.wav)
      if (isPcm16(header)) {
        const levels = pcm16Levels(job.segment.wav, header)
        rms = levels.rms
        if (levels.peakWindowRms < this.silenceThreshold) {
          this.deferred(() => this.countDrop(job, 'silent'))
          return
        }
      }
      if (header.dataBytes === 0) {
        this.deferred(() => this.countDrop(job, 'silent'))
        return
      }
    } catch (err) {
      const perr = toProviderError(err)
      this.log.warn(`Unusable audio segment ${job.id}`, perr.detail)
      this.deferred(() => {
        this.failed++
        this.safe('onError', () =>
          this.opts.onError(job, perr, { willRetry: false, attempt: 0, retryInMs: null }),
        )
      })
      return
    }

    const entry: Entry = {
      job,
      seq: ++this.seq,
      state: 'queued',
      header,
      rms,
      result: null,
      attempt: 0,
      controller: null,
      wake: null,
    }
    const ch = this.channel(job.channel)
    insertOrdered(ch.order, entry)
    insertOrdered(ch.waiting, entry)
    // Start on a microtask so no callback can run inside enqueue().
    this.pendingCallbacks++
    queueMicrotask(() => {
      this.pendingCallbacks--
      this.pump(ch)
      this.checkIdle()
    })
  }

  /** Changes the per-channel parallelism (e.g. after a settings change). */
  setConcurrency(n: number): void {
    this.concurrency = TranscriptionQueue.clampConcurrency(n)
    for (const ch of this.channels.values()) this.pump(ch)
  }

  /** Resolves true once nothing is queued, running or held for ordering; false on timeout. */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.isIdle()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.idleWaiters.delete(done)
        resolve(true)
      }
      const timer = setTimeout(
        () => {
          this.idleWaiters.delete(done)
          resolve(false)
        },
        Math.max(0, timeoutMs),
      )
      this.idleWaiters.add(done)
    })
  }

  /**
   * Aborts in-flight requests and clears the queue (each job → onDropped 'cancelled').
   * Results that already arrived but were held for ordering are delivered first, since
   * their text is final. The queue stays usable afterwards.
   */
  cancelAll(): void {
    for (const ch of this.channels.values()) {
      for (const entry of [...ch.order]) {
        if (entry.state !== 'queued' && entry.state !== 'running') continue
        entry.controller?.abort()
        entry.controller = null
        entry.wake?.()
        entry.wake = null
        this.release(entry, ch)
        this.countDrop(entry.job, 'cancelled')
      }
      this.flush(ch)
    }
    this.checkIdle()
  }

  isIdle(): boolean {
    if (this.pendingCallbacks > 0) return false
    for (const ch of this.channels.values()) {
      if (ch.order.length > 0 || ch.running > 0 || ch.waiting.length > 0) return false
    }
    return true
  }

  stats(): TranscriptionQueueStats {
    let inFlight = 0
    let queued = 0
    for (const ch of this.channels.values()) {
      inFlight += ch.running
      queued += ch.waiting.length
    }
    const avg = this.latencies.length
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : null
    return {
      inFlight,
      queued,
      completed: this.completed,
      failed: this.failed,
      dropped: this.dropped,
      avgLatencyMs: avg,
    }
  }

  // ───────────────────────────── internals ─────────────────────────────

  private channel(channel: Channel): ChannelState {
    let ch = this.channels.get(channel)
    if (!ch) {
      ch = { order: [], waiting: [], running: 0 }
      this.channels.set(channel, ch)
    }
    return ch
  }

  private pump(ch: ChannelState): void {
    while (ch.running < this.concurrency) {
      const entry = ch.waiting.shift()
      if (!entry) return
      entry.state = 'running'
      ch.running++
      this.run(entry, ch).catch((err: unknown) => this.crashed(entry, ch, err))
    }
  }

  /** A bug or a malformed provider result must still free the slot and surface an error. */
  private crashed(entry: Entry, ch: ChannelState, err: unknown): void {
    this.log.error('TranscriptionQueue job crashed', err)
    if (entry.state !== 'running') return
    entry.controller = null
    this.failed++
    this.release(entry, ch)
    const perr = toProviderError(err)
    this.safe('onError', () =>
      this.opts.onError(entry.job, perr, {
        willRetry: false,
        attempt: entry.attempt,
        retryInMs: null,
      }),
    )
    this.afterRelease(ch)
  }

  private async run(entry: Entry, ch: ChannelState): Promise<void> {
    const { job } = entry
    for (let attempt = 1; ; attempt++) {
      if (entry.state !== 'running') return
      entry.attempt = attempt
      const controller = new AbortController()
      entry.controller = controller
      let result: TranscriptionResult
      try {
        const options = this.opts.getOptions()
        result = await this.opts.stt.transcribe(job.segment, {
          ...options,
          signal: controller.signal,
        })
      } catch (err) {
        entry.controller = null
        // cancelAll() already released and reported this job.
        if (entry.state !== 'running') return
        const perr = toProviderError(err)
        const willRetry = perr.retryable && attempt <= this.maxRetries
        const retryInMs = willRetry ? retryDelayMs(attempt, perr) : null
        this.log.warn(
          `STT attempt ${attempt} failed for ${job.channel} segment: ${perr.code}` +
            (willRetry ? ` (retrying in ${retryInMs} ms)` : ''),
          perr.detail,
        )
        if (!willRetry) {
          this.failed++
          this.release(entry, ch)
        }
        this.safe('onError', () => this.opts.onError(job, perr, { willRetry, attempt, retryInMs }))
        if (!willRetry) {
          this.afterRelease(ch)
          return
        }
        if (!(await this.sleep(entry, retryInMs ?? 0))) return
        continue
      }
      entry.controller = null
      if (entry.state !== 'running') return

      const receivedAt = this.now()
      if (this.opts.onUsage) {
        const onUsage = this.opts.onUsage
        this.safe('onUsage', () => onUsage(job, result))
      }
      const text = cleanTranscript(result.text)
      if (!hasSpeechContent(text)) return this.drop(entry, ch, 'empty')
      if (isLikelyHallucination(text, { durationSec: entry.header.durationSec, rms: entry.rms })) {
        this.log.debug(`Dropped likely hallucination on ${job.channel}`, { chars: text.length })
        return this.drop(entry, ch, 'hallucination')
      }
      entry.result = {
        ...result,
        text,
        endToTextMs: Math.max(0, receivedAt - job.vadEndAt),
        receivedAt,
        attempts: attempt,
      }
      ch.running--
      entry.state = 'ready'
      this.afterRelease(ch)
      return
    }
  }

  /** Waits for a retry backoff. Resolves false when the job was cancelled meanwhile. */
  private sleep(entry: Entry, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        entry.wake = null
        resolve(entry.state === 'running')
      }, ms)
      entry.wake = () => {
        clearTimeout(timer)
        resolve(false)
      }
    })
  }

  private drop(entry: Entry, ch: ChannelState, reason: TranscriptionDropReason): void {
    this.release(entry, ch)
    this.countDrop(entry.job, reason)
    this.afterRelease(ch)
  }

  /** Frees the entry's concurrency/ordering slot. Idempotent. */
  private release(entry: Entry, ch: ChannelState): void {
    if (entry.state === 'released' || entry.state === 'ready') return
    if (entry.state === 'running') ch.running--
    else removeEntry(ch.waiting, entry)
    entry.state = 'released'
  }

  private afterRelease(ch: ChannelState): void {
    this.flush(ch)
    this.pump(ch)
    this.checkIdle()
  }

  /** Delivers ready results from the head of the channel's order; released slots are skipped. */
  private flush(ch: ChannelState): void {
    while (ch.order.length > 0) {
      const head = ch.order[0]
      if (!head || (head.state !== 'ready' && head.state !== 'released')) return
      ch.order.shift()
      if (head.state === 'ready' && head.result) {
        const result = head.result
        head.result = null
        this.completed++
        this.latencies.push(result.endToTextMs)
        if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift()
        this.safe('onResult', () => this.opts.onResult(head.job, result))
      }
    }
  }

  private countDrop(job: TranscriptionJob, reason: TranscriptionDropReason): void {
    this.dropped++
    const onDropped = this.opts.onDropped
    if (onDropped) this.safe('onDropped', () => onDropped(job, reason))
  }

  /** Runs `fn` on a microtask while keeping drain() from resolving early. */
  private deferred(fn: () => void): void {
    this.pendingCallbacks++
    queueMicrotask(() => {
      this.pendingCallbacks--
      fn()
      this.checkIdle()
    })
  }

  private checkIdle(): void {
    if (this.idleWaiters.size === 0 || !this.isIdle()) return
    for (const resolve of [...this.idleWaiters]) resolve()
  }

  /** Consumer callbacks must never break the queue's bookkeeping. */
  private safe(name: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log.error(`TranscriptionQueue ${name} callback threw`, err)
    }
  }
}

function before(a: Entry, b: Entry): boolean {
  const sa = a.job.segment.startedAt
  const sb = b.job.segment.startedAt
  return sa < sb || (sa === sb && a.seq < b.seq)
}

/** Inserts keeping (startedAt, seq) order; segments almost always arrive in order. */
function insertOrdered(list: Entry[], entry: Entry): void {
  let i = list.length
  while (i > 0) {
    const prev = list[i - 1]
    if (!prev || before(prev, entry)) break
    i--
  }
  list.splice(i, 0, entry)
}

function removeEntry(list: Entry[], entry: Entry): void {
  const i = list.indexOf(entry)
  if (i >= 0) list.splice(i, 1)
}
