import { describe, expect, it } from 'vitest'
import { testKey } from '@main/models/keyInfo'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import type { RequestInitLike, ResponseLike } from '@main/providers/openrouterHttp'
import { t } from '@shared/i18n'
import { fakeFetch, jsonResponse, silentLogger, steppedClock } from './helpers'

const BASE = 'https://openrouter.test/api/v1'

function setup(
  handler: (url: string, init: RequestInitLike, n: number) => ResponseLike | Promise<ResponseLike>,
  key: string | null = 'sk-or-v1-good-123456',
) {
  const fetch = fakeFetch(handler)
  const http = new OpenRouterHttp({
    baseUrl: BASE,
    getKey: () => key,
    log: silentLogger(),
    fetchImpl: fetch,
  })
  return { http, fetch }
}

const keyBody = (data: Record<string, unknown>) => jsonResponse(200, { data })

describe('testKey', () => {
  it('uses limit_remaining for keys with a spending limit (no /credits call)', async () => {
    const { http, fetch } = setup(() =>
      keyBody({
        label: 'sk-or-v1-abc…',
        limit: 20,
        usage: 3.21,
        limit_remaining: 16.79,
        is_free_tier: false,
      }),
    )
    const res = await testKey(http, steppedClock([100, 342.4]))
    expect(res).toEqual({
      ok: true,
      label: 'sk-or-v1-abc…',
      limit: 20,
      usage: 3.21,
      remaining: 16.79,
      isFreeTier: false,
      latencyMs: 242,
      error: null,
    })
    expect(fetch.calls.map((c) => c.url)).toEqual([`${BASE}/key`])
    expect(fetch.calls[0]?.init.headers?.['Authorization']).toBe('Bearer sk-or-v1-good-123456')
  })

  it('computes limit − usage when limit_remaining is missing', async () => {
    const { http } = setup(() => keyBody({ limit: 10, usage: 2.5 }))
    expect((await testKey(http)).remaining).toBe(7.5)
  })

  it('uses account credits − usage from /credits when the key has no limit', async () => {
    const { http, fetch } = setup((url) =>
      url.endsWith('/key')
        ? keyBody({ label: 'main', limit: null, usage: 3.21, is_free_tier: false })
        : jsonResponse(200, { data: { total_credits: 20, total_usage: 3.21 } }),
    )
    const res = await testKey(http)
    expect(res).toMatchObject({ ok: true, limit: null, usage: 3.21, remaining: 16.79 })
    expect(fetch.calls.map((c) => c.url)).toEqual([`${BASE}/key`, `${BASE}/credits`])
  })

  it('reports remaining null (still ok) when /credits fails', async () => {
    const { http } = setup((url) =>
      url.endsWith('/key')
        ? keyBody({ limit: null, usage: 1, is_free_tier: true })
        : jsonResponse(403, { error: { code: 403, message: 'Only provisioning keys' } }),
    )
    expect(await testKey(http)).toMatchObject({ ok: true, remaining: null, isFreeTier: true })
  })

  it.each([
    [401, 'auth'],
    [402, 'credits'],
    [429, 'rate_limit'],
    [500, 'server'],
  ] as const)('returns ok=false with a friendly error for HTTP %i', async (status, code) => {
    const { http } = setup(() => jsonResponse(status, { error: { code: status, message: 'x' } }))
    const res = await testKey(http)
    expect(res.ok).toBe(false)
    expect(res.error).toMatchObject({ code, message: t(`errors.${code}`) })
    expect(res).toMatchObject({ label: null, limit: null, remaining: null, latencyMs: null })
  })

  it('never throws: network failure, missing key, malformed body', async () => {
    const offline = setup(() => {
      throw new TypeError('fetch failed')
    })
    expect((await testKey(offline.http)).error?.code).toBe('network')

    const noKey = setup(() => keyBody({}), null)
    const res = await testKey(noKey.http)
    expect(res.error).toMatchObject({ code: 'no_key', message: t('errors.no_key') })
    expect(noKey.fetch.calls).toHaveLength(0)

    const weird = setup(() => jsonResponse(200, { nope: true }))
    expect(await testKey(weird.http)).toMatchObject({ ok: false, error: { code: 'server' } })
  })
})
