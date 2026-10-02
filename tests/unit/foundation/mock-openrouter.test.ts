import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockOpenRouter, type MockOpenRouter } from '../../../scripts/mock-openrouter.mjs'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import { ProviderError } from '@main/providers/errors'
import { createLogger } from '@main/log'

let mock: MockOpenRouter

beforeAll(async () => {
  mock = await startMockOpenRouter({ ttftMs: 5, tokenMs: 0 })
})
afterAll(async () => {
  await mock.close()
})

describe('OpenRouterHttp against the mock server', () => {
  it('sends attribution headers and the key', async () => {
    const http = new OpenRouterHttp({
      baseUrl: mock.baseUrl,
      getKey: () => 'sk-or-test-1234567890',
      log: createLogger(null),
    })
    const key = await http.json<{ data: { limit_remaining: number } }>('/key')
    expect(key.data.limit_remaining).toBeCloseTo(16.79)
    const rec = mock.requests.at(-1)
    expect(rec?.headers.referer).toBe('https://github.com/nakib-abrar/bluely')
    expect(rec?.headers.title).toBe('Bluely')
    await http.close()
  })

  it('maps 401 and missing keys to ProviderError codes', async () => {
    const bad = new OpenRouterHttp({
      baseUrl: mock.baseUrl,
      getKey: () => 'sk-or-bad-1234567890',
      log: createLogger(null),
    })
    await expect(bad.json('/key')).rejects.toMatchObject({ code: 'auth' })
    const none = new OpenRouterHttp({
      baseUrl: mock.baseUrl,
      getKey: () => null,
      log: createLogger(null),
    })
    await expect(none.json('/key')).rejects.toBeInstanceOf(ProviderError)
    await expect(none.json('/key')).rejects.toMatchObject({ code: 'no_key' })
    await bad.close()
    await none.close()
  })
})
