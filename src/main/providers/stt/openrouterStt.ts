import { AppError } from '../../errors'
import type { Logger } from '../../log'
import { mapNetworkError, ProviderError } from '../errors'
import type { OpenRouterHttp } from '../openrouterHttp'
import { cleanTranscript } from './hallucinations'
import type {
  AudioSegment,
  STTProvider,
  TranscribeOptions,
  TranscriptionResult,
} from './STTProvider'
import { parseWavHeader } from './wav'

/** Upper bound for one transcription round trip (headers and body). */
export const STT_TIMEOUT_MS = 20_000

export interface OpenRouterSTTOptions {
  http: OpenRouterHttp
  log: Logger
  /** Clock used for latency measurement (injected in tests). */
  now?: () => number
  /** Overrides STT_TIMEOUT_MS (tests). */
  timeoutMs?: number
}

/** Request body of POST /audio/transcriptions. */
export interface SttRequestBody {
  model: string
  input_audio: { data: string; format: 'wav' }
  temperature: number
  language?: string
}

/**
 * Response of POST /audio/transcriptions. Duration-priced providers report `seconds`,
 * token-priced ones report token counts; either may carry `cost`.
 */
interface SttResponseBody {
  text?: unknown
  language?: unknown
  usage?: {
    seconds?: unknown
    cost?: unknown
    total_tokens?: unknown
    input_tokens?: unknown
    output_tokens?: unknown
  } | null
  error?: { message?: unknown } | string | null
}

/**
 * Normalises the configured transcription language to what the API expects: undefined for
 * auto-detect, otherwise the lower-case primary ISO-639 subtag ("EN" → "en", "pt-BR" → "pt").
 */
export function normalizeSttLanguage(language: string | null | undefined): string | undefined {
  if (!language) return undefined
  const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  if (!primary || primary === 'auto') return undefined
  return primary
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

function toBase64(bytes: Uint8Array): string {
  // View, not copy: segments can be a few hundred KB.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** Rejects with the signal's abort as soon as it fires, even if `promise` never settles. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderError('aborted'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * Segment-based speech-to-text through OpenRouter's /audio/transcriptions endpoint
 * (Whisper-family and other STT models). Audio is sent once and never stored.
 */
export class OpenRouterSTT implements STTProvider {
  readonly id = 'openrouter'
  readonly supportsStreaming = false
  private readonly http: OpenRouterHttp
  private readonly log: Logger
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(opts: OpenRouterSTTOptions) {
    this.http = opts.http
    this.log = opts.log
    this.now = opts.now ?? Date.now
    this.timeoutMs = opts.timeoutMs ?? STT_TIMEOUT_MS
  }

  /**
   * Transcribes one WAV segment. Throws AppError('invalid_audio') for unusable audio and
   * ProviderError for everything that goes wrong on the way to/from OpenRouter
   * ('timeout' after 20 s, 'aborted' when `signal` fires).
   */
  async transcribe(segment: AudioSegment, opts: TranscribeOptions): Promise<TranscriptionResult> {
    const header = parseWavHeader(segment.wav)
    if (header.dataBytes === 0) throw new AppError('invalid_audio', 'Invalid WAV audio: no samples')

    const language = normalizeSttLanguage(opts.language)
    const body: SttRequestBody = {
      model: opts.model,
      input_audio: { data: toBase64(segment.wav), format: 'wav' },
      temperature: 0,
      ...(language ? { language } : {}),
    }

    // One controller covers the whole round trip: the HTTP layer's own timeout stops at
    // response headers, but a stalled body must not hold a transcription slot forever.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const onCallerAbort = () => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    else opts.signal?.addEventListener('abort', onCallerAbort, { once: true })

    const started = this.now()
    let json: SttResponseBody
    try {
      json = await raceAbort(
        this.http.json<SttResponseBody>('/audio/transcriptions', {
          body,
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
        }),
        controller.signal,
      )
    } catch (err) {
      if (opts.signal?.aborted) throw new ProviderError('aborted')
      if (timedOut) {
        throw new ProviderError('timeout', { detail: `STT exceeded ${this.timeoutMs} ms` })
      }
      // HTTP errors arrive as ProviderError already; mapNetworkError passes them through.
      throw mapNetworkError(err)
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onCallerAbort)
    }
    const latencyMs = Math.max(0, this.now() - started)

    if (!json || typeof json !== 'object' || typeof json.text !== 'string') {
      const detail =
        typeof json?.error === 'string'
          ? json.error
          : typeof json?.error?.message === 'string'
            ? json.error.message
            : 'Transcription response had no text'
      throw new ProviderError('server', { detail })
    }

    const usage = json.usage && typeof json.usage === 'object' ? json.usage : null
    const text = cleanTranscript(json.text)
    const result: TranscriptionResult = {
      text,
      model: opts.model,
      latencyMs,
      costUsd: toNumber(usage?.cost),
      audioSeconds: toNumber(usage?.seconds) ?? header.durationSec,
      // Only verbose formats report it; Bluely asks for plain JSON.
      language: typeof json.language === 'string' ? json.language : null,
    }
    this.log.debug('STT done', {
      model: opts.model,
      latencyMs,
      audioSec: Number(header.durationSec.toFixed(2)),
      chars: text.length,
      costUsd: result.costUsd,
    })
    return result
  }
}
