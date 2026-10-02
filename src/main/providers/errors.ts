import { t } from '@shared/i18n'
import type { AiErrorInfo, ProviderErrorCode } from '@shared/types'

/** Provider failure mapped to a stable code plus a friendly message. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status: number | null
  readonly retryable: boolean
  readonly retryAfterSec: number | null
  /** Raw provider message (for logs; may be technical). */
  readonly detail: string | null

  constructor(
    code: ProviderErrorCode,
    opts: {
      status?: number | null
      retryAfterSec?: number | null
      detail?: string | null
      message?: string
    } = {},
  ) {
    super(opts.message ?? t(`errors.${code}`))
    this.name = 'ProviderError'
    this.code = code
    this.status = opts.status ?? null
    this.retryAfterSec = opts.retryAfterSec ?? null
    this.detail = opts.detail ?? null
    this.retryable = RETRYABLE.has(code)
  }

  toInfo(): AiErrorInfo {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryAfterSec: this.retryAfterSec,
    }
  }
}

const RETRYABLE = new Set<ProviderErrorCode>(['rate_limit', 'server', 'timeout', 'network'])

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  if (Number.isFinite(n)) return Math.max(0, n)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : null
}

/** Extracts OpenRouter's `{ error: { code, message } }` body when present. */
export function extractErrorMessage(body: string): string | null {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof json.error === 'string') return json.error
    if (json.error && typeof json.error.message === 'string') return json.error.message
    if (typeof json.message === 'string') return json.message
  } catch {
    /* not JSON */
  }
  return body ? body.slice(0, 300) : null
}

/** Maps an HTTP status (+ body) from OpenRouter to a ProviderError. */
export function mapHttpError(
  status: number,
  body: string,
  retryAfterHeader: string | null = null,
): ProviderError {
  const detail = extractErrorMessage(body)
  const lower = (detail ?? '').toLowerCase()
  const base = { status, detail }
  if (status === 401) return new ProviderError('auth', base)
  if (status === 402) return new ProviderError('credits', base)
  if (status === 403) {
    if (lower.includes('moderation') || lower.includes('flagged'))
      return new ProviderError('moderation', base)
    return new ProviderError('auth', base)
  }
  if (
    status === 404 ||
    lower.includes('no endpoints found') ||
    lower.includes('not a valid model')
  ) {
    return new ProviderError('model_unavailable', base)
  }
  if (status === 408) return new ProviderError('timeout', base)
  if (status === 429)
    return new ProviderError('rate_limit', {
      ...base,
      retryAfterSec: parseRetryAfter(retryAfterHeader),
    })
  if (status === 400 || status === 413 || status === 422)
    return new ProviderError('bad_request', base)
  if (status >= 500) return new ProviderError('server', base)
  return new ProviderError('unknown', base)
}

/** Maps thrown fetch/undici errors (network down, DNS, abort, timeout). */
export function mapNetworkError(err: unknown, timedOut = false): ProviderError {
  if (err instanceof ProviderError) return err
  if (timedOut) return new ProviderError('timeout', { detail: errMessage(err) })
  const name = err instanceof Error ? err.name : ''
  if (name === 'AbortError') return new ProviderError('aborted', { detail: errMessage(err) })
  const code =
    (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
    (err as { code?: string })?.code
  if (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return new ProviderError('timeout', { detail: errMessage(err) })
  }
  return new ProviderError('network', { detail: errMessage(err) })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
