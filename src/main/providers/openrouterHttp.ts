import { Agent, fetch as undiciFetch } from 'undici'
import { ATTRIBUTION_REFERER, ATTRIBUTION_TITLE } from '@shared/constants'
import type { Logger } from '../log'
import { mapHttpError, mapNetworkError, ProviderError } from './errors'

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>

export interface RequestInitLike {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  dispatcher?: unknown
}

/** The subset of the WHATWG Response we use (undici and test fakes both satisfy it). */
export interface ResponseLike {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  json(): Promise<unknown>
}

export interface OpenRouterHttpOptions {
  baseUrl: string
  getKey: () => string | null
  log: Logger
  /** Injected in tests. Defaults to undici fetch with a keep-alive agent. */
  fetchImpl?: FetchLike
  /** Default request timeout (ms) until response headers arrive. */
  timeoutMs?: number
}

export interface HttpRequest {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  /** Skip the API key (public endpoints such as /models). */
  anonymous?: boolean
}

/**
 * Shared HTTP layer for every OpenRouter call (chat, STT, models, key, generation).
 * One persistent keep-alive agent avoids TLS handshakes on the latency-critical path.
 * Runs only in the main process: the API key never reaches a renderer.
 */
export class OpenRouterHttp {
  readonly baseUrl: string
  private readonly agent: Agent | null
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(private readonly opts: OpenRouterHttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
    if (opts.fetchImpl) {
      this.agent = null
      this.fetchImpl = opts.fetchImpl
    } else {
      this.agent = new Agent({
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 10 * 60_000,
        connections: 16,
        connectTimeout: 10_000,
      })
      this.fetchImpl = undiciFetch as unknown as FetchLike
    }
  }

  hasKey(): boolean {
    return !!this.opts.getKey()
  }

  headers(anonymous = false): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'HTTP-Referer': ATTRIBUTION_REFERER,
      'X-Title': ATTRIBUTION_TITLE,
    }
    if (!anonymous) {
      const key = this.opts.getKey()
      if (!key) throw new ProviderError('no_key')
      h['Authorization'] = `Bearer ${key}`
    }
    return h
  }

  /**
   * Sends a request and returns the response once headers arrive. Non-2xx responses are
   * mapped to ProviderError. The returned body is still readable (for SSE streaming).
   */
  async request(path: string, req: HttpRequest = {}): Promise<ResponseLike> {
    const headers = this.headers(req.anonymous)
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, req.timeoutMs ?? this.timeoutMs)
    const onAbort = () => controller.abort()
    if (req.signal) {
      if (req.signal.aborted) controller.abort()
      else req.signal.addEventListener('abort', onAbort, { once: true })
    }
    let res: ResponseLike
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
        ...(this.agent ? { dispatcher: this.agent } : {}),
      })
    } catch (err) {
      clearTimeout(timeout)
      req.signal?.removeEventListener('abort', onAbort)
      if (req.signal?.aborted) throw new ProviderError('aborted')
      throw mapNetworkError(err, timedOut)
    }
    clearTimeout(timeout)
    // Keep forwarding caller aborts while the body streams.
    if (!res.ok) {
      req.signal?.removeEventListener('abort', onAbort)
      const body = await res.text().catch(() => '')
      const err = mapHttpError(res.status, body, res.headers.get('retry-after'))
      this.opts.log.warn(`OpenRouter ${path} → ${res.status} ${err.code}`, err.detail)
      throw err
    }
    return res
  }

  async json<T>(path: string, req: HttpRequest = {}): Promise<T> {
    const res = await this.request(path, req)
    try {
      return (await res.json()) as T
    } catch (err) {
      throw new ProviderError('server', { detail: `Invalid JSON from ${path}: ${String(err)}` })
    }
  }

  /** Opens the TLS connection early (cheap GET) so the first real request is fast. */
  async prewarm(): Promise<void> {
    try {
      const res = await this.request('/key', { timeoutMs: 8_000, anonymous: !this.hasKey() })
      await res.text().catch(() => '')
    } catch (err) {
      this.opts.log.debug('Prewarm failed (ignored)', err)
    }
  }

  async close(): Promise<void> {
    await this.agent?.close().catch(() => undefined)
  }
}
