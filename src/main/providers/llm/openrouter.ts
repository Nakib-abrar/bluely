import type { ModelInfo, SpeedStats } from '@shared/types'
import type { Logger } from '../../log'
import type { ModelCatalog } from '../../models/catalog'
import { mapHttpError, mapNetworkError, ProviderError } from '../errors'
import type { OpenRouterHttp, ResponseLike } from '../openrouterHttp'
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  ChatUsage,
  LLMProvider,
  ProviderRouting,
} from './LLMProvider'
import { readSse, SSE_DONE } from './sse'

/** Mid-stream inactivity limit: no bytes for this long → ProviderError('timeout'). */
export const STREAM_IDLE_TIMEOUT_MS = 30_000
/** After `data: [DONE]` we keep reading briefly so the keep-alive connection is reused. */
const DRAIN_AFTER_DONE_MS = 1_000
/** complete() backs off at most this long before its single retry. */
const MAX_RETRY_DELAY_MS = 5_000
const DEFAULT_RETRY_DELAY_MS = 1_000
/** /generation stats appear shortly after the stream ends; one retry after this delay. */
const GENERATION_RETRY_DELAY_MS = 800

/** Information passed to `onFinished` after every successfully completed stream. */
export interface ChatFinishedInfo {
  request: ChatRequest
  stats: SpeedStats
  usage: ChatUsage | null
  finishReason: string | null
}

export interface OpenRouterLLMOptions {
  http: OpenRouterHttp
  log: Logger
  catalog?: ModelCatalog
  /** Monotonic clock in ms (injected in tests). Defaults to performance.now(). */
  now?: () => number
  /** Override the mid-stream idle timeout (ms). */
  idleTimeoutMs?: number
  /** Abortable sleep used for retry backoff (injected in tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /**
   * Called once per successfully finished stream (before the `done` event is yielded), e.g.
   * to log usage/cost and feed the rolling latency stats. Exceptions are swallowed.
   */
  onFinished?: (info: ChatFinishedInfo) => void
}

/** The OpenRouter `provider` routing object. Empty `order` is omitted. Never adds ":nitro". */
export interface ProviderPreferences {
  sort?: string
  order?: string[]
  allow_fallbacks?: boolean
}

export function toProviderPreferences(routing: ProviderRouting): ProviderPreferences {
  const prefs: ProviderPreferences = {}
  if (routing.sort) prefs.sort = routing.sort
  const order = (routing.order ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  if (order.length > 0) prefs.order = order
  if (routing.allowFallbacks !== undefined) prefs.allow_fallbacks = routing.allowFallbacks
  return prefs
}

/** Request body for POST /chat/completions (OpenAI-compatible + OpenRouter extensions). */
export function buildChatBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  }
  if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens
  if (req.temperature !== undefined) body['temperature'] = req.temperature
  if (req.responseFormat === 'json_object') body['response_format'] = { type: 'json_object' }
  if (req.routing) body['provider'] = toProviderPreferences(req.routing)
  // Ask OpenRouter to append token counts and cost to the final chunk.
  body['usage'] = { include: true }
  return body
}

export interface SpeedStatsInput {
  requestedModel: string
  servedModel: string | null
  provider: string | null
  generationId: string | null
  /** Clock reading just before the request was sent. */
  startedAt: number
  /** Clock reading at the first non-empty content delta (null: no content). */
  firstTokenAt: number | null
  endedAt: number
  deltaCount: number
  usage: ChatUsage | null
}

/**
 * Builds the numbers behind "⚡ 0.42 s to first word · 1.9 s total · 186 tok/s · groq · llama".
 * Throughput counts generation time only (after the first token); without usage numbers the
 * number of content chunks stands in for tokens.
 */
export function computeSpeedStats(input: SpeedStatsInput): SpeedStats {
  const totalMs = Math.max(0, input.endedAt - input.startedAt)
  const ttftMs =
    input.firstTokenAt === null ? null : Math.max(0, input.firstTokenAt - input.startedAt)
  const tokens = input.usage?.completionTokens ?? (input.deltaCount > 0 ? input.deltaCount : null)
  let tokensPerSec: number | null = null
  if (ttftMs !== null && tokens !== null && tokens > 0) {
    const genMs = totalMs - ttftMs
    if (genMs > 0) tokensPerSec = Math.round((tokens / (genMs / 1000)) * 10) / 10
  }
  return {
    ttftMs: ttftMs === null ? null : Math.round(ttftMs),
    totalMs: Math.round(totalMs),
    tokensPerSec,
    tokensIn: input.usage?.promptTokens ?? null,
    tokensOut: input.usage?.completionTokens ?? null,
    costUsd: input.usage?.costUsd ?? null,
    provider: input.provider,
    model: input.servedModel ?? input.requestedModel,
    generationId: input.generationId,
  }
}

// ───────────────────────── wire shapes (only what we read) ─────────────────────────

interface WireError {
  code?: unknown
  message?: unknown
  metadata?: unknown
}

interface WireUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  cost?: unknown
}

interface WireChoice {
  delta?: { content?: unknown } | null
  message?: { content?: unknown } | null
  finish_reason?: unknown
}

interface WireChunk {
  id?: unknown
  model?: unknown
  provider?: unknown
  choices?: unknown
  usage?: WireUsage | null
  error?: WireError | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function firstChoice(chunk: WireChunk): WireChoice | null {
  if (!Array.isArray(chunk.choices)) return null
  const c: unknown = chunk.choices[0]
  return c && typeof c === 'object' ? (c as WireChoice) : null
}

function mergeUsage(prev: ChatUsage | null, raw: WireUsage): ChatUsage {
  return {
    promptTokens: num(raw.prompt_tokens) ?? prev?.promptTokens ?? null,
    completionTokens: num(raw.completion_tokens) ?? prev?.completionTokens ?? null,
    costUsd: num(raw.cost) ?? prev?.costUsd ?? null,
  }
}

/** Maps an `{ error: { code, message } }` object (mid-stream or JSON body) to a ProviderError. */
export function errorFromPayload(error: WireError): ProviderError {
  const code = num(error.code)
  // Mid-stream errors without a numeric code are upstream provider failures.
  const status = code !== null && code >= 100 && code < 600 ? code : 502
  return mapHttpError(status, JSON.stringify({ error }))
}

function parseChunk(data: string): WireChunk | null {
  try {
    const v: unknown = JSON.parse(data)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as WireChunk) : null
  } catch {
    return null
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ProviderError('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const RETRY_ONCE = new Set(['rate_limit', 'server', 'network'])

/**
 * OpenRouter chat provider: streamed /chat/completions over the shared keep-alive agent,
 * with provider routing, usage/cost capture and local speed measurement.
 */
export class OpenRouterLLM implements LLMProvider {
  readonly id = 'openrouter'
  private readonly http: OpenRouterHttp
  private readonly log: Logger
  private readonly catalog: ModelCatalog | null
  private readonly now: () => number
  private readonly idleTimeoutMs: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly onFinished: ((info: ChatFinishedInfo) => void) | null

  constructor(opts: OpenRouterLLMOptions) {
    this.http = opts.http
    this.log = opts.log
    this.catalog = opts.catalog ?? null
    this.now = opts.now ?? (() => performance.now())
    this.idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    this.sleep = opts.sleep ?? defaultSleep
    this.onFinished = opts.onFinished ?? null
  }

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, undefined> {
    const external = req.signal
    if (external?.aborted) throw new ProviderError('aborted')
    // One controller for the whole request: caller aborts, the idle timeout and the post-[DONE]
    // drain all cancel the fetch + body reader through it.
    const inner = new AbortController()
    const onExternalAbort = () => inner.abort(external?.reason)
    external?.addEventListener('abort', onExternalAbort, { once: true })

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let drainTimer: ReturnType<typeof setTimeout> | null = null
    let idleFired = false
    let drainExpired = false
    let completed = false
    const clearIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = null
    }
    const armIdle = () => {
      clearIdle()
      idleTimer = setTimeout(() => {
        idleFired = true
        inner.abort()
      }, this.idleTimeoutMs)
    }
    const fail = (err: unknown): ProviderError => {
      if (external?.aborted) return new ProviderError('aborted')
      if (idleFired) {
        return new ProviderError('timeout', {
          detail: `No data for ${Math.round(this.idleTimeoutMs / 1000)} s mid-stream`,
        })
      }
      return mapNetworkError(err)
    }

    const tag = req.tag ? `[${req.tag}] ` : ''
    const startedAt = this.now()
    let firstTokenAt: number | null = null
    let endedAt: number | null = null
    let generationId: string | null = null
    let servedModel: string | null = null
    let provider: string | null = null
    let finishReason: string | null = null
    let usage: ChatUsage | null = null
    let deltaCount = 0
    let metaSent = false

    try {
      let res: ResponseLike
      try {
        res = await this.http.request('/chat/completions', {
          body: buildChatBody(req),
          signal: inner.signal,
        })
      } catch (err) {
        throw fail(err)
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        // Some gateways answer a stream request with a plain completion (or an error) body.
        let raw: string
        try {
          raw = await res.text()
        } catch (err) {
          throw fail(err)
        }
        const chunk = parseChunk(raw)
        if (!chunk) throw new ProviderError('server', { detail: 'Invalid JSON completion body' })
        if (chunk.error) throw errorFromPayload(chunk.error)
        generationId = str(chunk.id)
        servedModel = str(chunk.model)
        provider = str(chunk.provider)
        yield { type: 'meta', generationId, model: servedModel, provider }
        const choice = firstChoice(chunk)
        const content = choice?.message?.content ?? choice?.delta?.content
        if (typeof content === 'string' && content.length > 0) {
          firstTokenAt = this.now()
          deltaCount = 1
          yield { type: 'delta', text: content }
        }
        finishReason = str(choice?.finish_reason)
        if (chunk.usage) usage = mergeUsage(null, chunk.usage)
      } else {
        if (!res.body) throw new ProviderError('server', { detail: 'Empty response body' })
        armIdle()
        let sawDone = false
        const onChunk = () => {
          if (!sawDone) armIdle()
        }
        try {
          for await (const ev of readSse(res.body, inner.signal, { onChunk })) {
            if (sawDone) continue
            if (ev.data === SSE_DONE) {
              sawDone = true
              endedAt = this.now()
              clearIdle()
              // Keep reading until the server closes so the socket goes back to the pool,
              // but never wait long for it.
              drainTimer = setTimeout(() => {
                drainExpired = true
                inner.abort()
              }, DRAIN_AFTER_DONE_MS)
              continue
            }
            const chunk = parseChunk(ev.data)
            if (!chunk) {
              this.log.debug(`${tag}Skipping non-JSON SSE data`, ev.data.slice(0, 120))
              continue
            }
            if (chunk.error) throw errorFromPayload(chunk.error)
            generationId ??= str(chunk.id)
            servedModel ??= str(chunk.model)
            provider ??= str(chunk.provider)
            // The idle timer measures network silence only: it is paused while the consumer
            // handles a yielded event, so a slow consumer never looks like a stalled stream.
            if (!metaSent && (generationId || servedModel || provider)) {
              metaSent = true
              clearIdle()
              yield { type: 'meta', generationId, model: servedModel, provider }
              armIdle()
            }
            const choice = firstChoice(chunk)
            if (choice) {
              // `reasoning` / `reasoning_details` deltas are deliberately ignored.
              const content = choice.delta?.content
              if (typeof content === 'string' && content.length > 0) {
                if (firstTokenAt === null) firstTokenAt = this.now()
                deltaCount++
                clearIdle()
                yield { type: 'delta', text: content }
                armIdle()
              }
              const reason = str(choice.finish_reason)
              if (reason) finishReason = reason
              if (reason === 'error') {
                throw new ProviderError('server', { detail: 'The stream finished with an error' })
              }
            }
            if (chunk.usage && typeof chunk.usage === 'object')
              usage = mergeUsage(usage, chunk.usage)
          }
        } catch (err) {
          // A drain cut short after [DONE] is not an error: the answer is complete.
          if (!(sawDone && drainExpired)) {
            throw err instanceof ProviderError && !external?.aborted && !idleFired ? err : fail(err)
          }
        }
        if (!sawDone) this.log.debug(`${tag}Stream ended without [DONE]`)
      }

      endedAt ??= this.now()
      const stats = computeSpeedStats({
        requestedModel: req.model,
        servedModel,
        provider,
        generationId,
        startedAt,
        firstTokenAt,
        endedAt,
        deltaCount,
        usage,
      })
      completed = true
      if (this.onFinished) {
        try {
          this.onFinished({ request: req, stats, usage, finishReason })
        } catch (err) {
          this.log.warn(`${tag}onFinished hook failed`, err)
        }
      }
      yield { type: 'done', finishReason, usage, stats }
    } finally {
      clearIdle()
      if (drainTimer !== null) clearTimeout(drainTimer)
      external?.removeEventListener('abort', onExternalAbort)
      // Consumer stopped early or something failed: make sure the HTTP request is torn down.
      if (!completed && !inner.signal.aborted) inner.abort()
    }
  }

  /**
   * Runs a stream to completion. Retries once on rate_limit/server/network errors that happen
   * before any text arrived (honouring Retry-After, capped at 5 s).
   */
  async complete(req: ChatRequest): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
      let text = ''
      let emitted = false
      try {
        for await (const ev of this.streamChat(req)) {
          if (ev.type === 'delta') {
            emitted = true
            text += ev.text
          } else if (ev.type === 'done') {
            return { text, stats: ev.stats, usage: ev.usage, finishReason: ev.finishReason }
          }
        }
        throw new ProviderError('server', { detail: 'Stream ended without a done event' })
      } catch (err) {
        const pe = err instanceof ProviderError ? err : mapNetworkError(err)
        if (attempt > 0 || emitted || !RETRY_ONCE.has(pe.code) || req.signal?.aborted) throw pe
        const delay =
          pe.retryAfterSec != null
            ? Math.min(pe.retryAfterSec * 1000, MAX_RETRY_DELAY_MS)
            : DEFAULT_RETRY_DELAY_MS
        this.log.info(
          `${req.tag ? `[${req.tag}] ` : ''}Retrying ${req.model} after ${pe.code} in ${delay} ms`,
        )
        await this.sleep(delay, req.signal)
      }
    }
  }

  /**
   * Exact numbers from GET /generation (provider-side TTFT, generation time, cost). Stats are
   * written shortly after a stream ends, so a 404 is retried once. Never throws.
   */
  async getGenerationStats(generationId: string): Promise<Partial<SpeedStats> | null> {
    const path = `/generation?id=${encodeURIComponent(generationId)}`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = await this.http.json<{ data?: Record<string, unknown> | null }>(path, {
          timeoutMs: 10_000,
        })
        return json?.data ? mapGenerationStats(generationId, json.data) : null
      } catch (err) {
        const notReadyYet = err instanceof ProviderError && err.status === 404
        if (attempt === 0 && notReadyYet) {
          try {
            await this.sleep(GENERATION_RETRY_DELAY_MS)
          } catch {
            return null
          }
          continue
        }
        this.log.debug(`Generation stats for ${generationId} unavailable`, err)
        return null
      }
    }
    return null
  }

  async listModels(opts?: { refresh?: boolean }): Promise<ModelInfo[]> {
    if (!this.catalog) {
      this.log.warn('listModels called without a model catalog')
      return []
    }
    return this.catalog.list(opts)
  }

  prewarm(): Promise<void> {
    return this.http.prewarm()
  }
}

/** Maps GET /generation `data` to the SpeedStats fields it knows exactly. */
export function mapGenerationStats(
  generationId: string,
  data: Record<string, unknown>,
): Partial<SpeedStats> {
  const out: Partial<SpeedStats> = { generationId }
  const provider = str(data['provider_name'])
  if (provider) out.provider = provider
  const model = str(data['model'])
  if (model) out.model = model
  const latency = num(data['latency'])
  if (latency !== null) out.ttftMs = Math.round(latency)
  const genTime = num(data['generation_time'])
  if (genTime !== null) out.totalMs = Math.round(genTime)
  const tokensIn = num(data['tokens_prompt'])
  if (tokensIn !== null) out.tokensIn = tokensIn
  const tokensOut = num(data['tokens_completion'])
  if (tokensOut !== null) out.tokensOut = tokensOut
  const cost = num(data['total_cost'])
  if (cost !== null) out.costUsd = cost
  if (tokensOut !== null && tokensOut > 0 && genTime !== null) {
    const genMs = genTime - (latency ?? 0)
    if (genMs > 0) out.tokensPerSec = Math.round((tokensOut / (genMs / 1000)) * 10) / 10
  }
  return out
}
