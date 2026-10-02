import type { KeyTestResult } from '@shared/types'
import { mapNetworkError, ProviderError } from '../providers/errors'
import type { OpenRouterHttp } from '../providers/openrouterHttp'

interface KeyResponse {
  data?: {
    label?: unknown
    limit?: unknown
    usage?: unknown
    limit_remaining?: unknown
    is_free_tier?: unknown
  } | null
}

interface CreditsResponse {
  data?: { total_credits?: unknown; total_usage?: unknown } | null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Rounds away floating-point noise from subtractions such as 20 - 3.21. */
const usd = (n: number) => Math.round(n * 1e6) / 1e6

const empty = (): Omit<KeyTestResult, 'ok' | 'error' | 'latencyMs'> => ({
  label: null,
  limit: null,
  usage: null,
  remaining: null,
  isFreeTier: null,
})

/**
 * "Test connection" in Settings › AI Models: GET /key (validates the key, shows label, limit
 * and usage). Remaining credit is `limit_remaining` for keys with a spending limit, otherwise
 * account credits − usage from GET /credits (null if that call fails). Never throws.
 */
export async function testKey(
  http: OpenRouterHttp,
  now: () => number = () => performance.now(),
): Promise<KeyTestResult> {
  const started = now()
  let key: KeyResponse
  try {
    key = await http.json<KeyResponse>('/key', { timeoutMs: 15_000 })
  } catch (err) {
    const pe = err instanceof ProviderError ? err : mapNetworkError(err)
    return { ok: false, ...empty(), latencyMs: null, error: pe.toInfo() }
  }
  const latencyMs = Math.round(now() - started)
  const data = key && typeof key === 'object' ? key.data : null
  if (!data || typeof data !== 'object') {
    const pe = new ProviderError('server', { detail: 'Unexpected /key response' })
    return { ok: false, ...empty(), latencyMs, error: pe.toInfo() }
  }
  const limit = num(data.limit)
  const usage = num(data.usage)
  let remaining: number | null = null
  if (limit !== null) {
    remaining = num(data.limit_remaining) ?? (usage !== null ? usd(limit - usage) : null)
  } else {
    remaining = await accountCreditsRemaining(http)
  }
  return {
    ok: true,
    label: typeof data.label === 'string' && data.label ? data.label : null,
    limit,
    usage,
    remaining,
    isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
    latencyMs,
    error: null,
  }
}

async function accountCreditsRemaining(http: OpenRouterHttp): Promise<number | null> {
  try {
    const credits = await http.json<CreditsResponse>('/credits', { timeoutMs: 15_000 })
    const total = num(credits?.data?.total_credits)
    const used = num(credits?.data?.total_usage)
    return total !== null && used !== null ? usd(total - used) : null
  } catch {
    return null
  }
}
