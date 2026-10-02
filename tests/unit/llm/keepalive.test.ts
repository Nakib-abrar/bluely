import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import { OpenRouterLLM } from '@main/providers/llm/openrouter'
import { openDatabase } from '@main/db/database'
import { LatencyTester } from '@main/models/latency'
import { ModelStatsRepo } from '@main/models/statsRepo'
import { collect, silentLogger, typicalStream } from './helpers'

/**
 * The shared undici agent exists to skip TCP/TLS setup on the latency-critical path, so
 * consecutive streams must reuse one socket. After `data: [DONE]` the provider keeps reading to
 * EOF instead of cancelling the body; cancelling while the response is still open (the server
 * here ends it 30 ms after [DONE]) would destroy the socket and force a new handshake.
 */
let server: Server
let baseUrl = ''
let connections = 0
const requestPorts: number[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    requestPorts.push(req.socket.remotePort ?? -1)
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
      for (const part of typicalStream(['Hello', ' world'])) res.write(part)
      setTimeout(() => res.end(), 30)
    })
  })
  server.on('connection', () => connections++)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('keep-alive reuse', () => {
  it('runs sequential streams over a single socket', async () => {
    const log = silentLogger()
    const http = new OpenRouterHttp({ baseUrl, getKey: () => 'sk-or-test-keepalive', log })
    const llm = new OpenRouterLLM({ http, log })
    connections = 0
    requestPorts.length = 0
    for (let i = 0; i < 4; i++) {
      const events = await collect(
        llm.streamChat({ model: 'x/y', messages: [{ role: 'user', content: 'hi' }] }),
      )
      expect(events.at(-1)?.type).toBe('done')
      // One event-loop turn lets undici put the socket back into the pool (see LatencyTester).
      await new Promise((r) => setImmediate(r))
    }
    expect(requestPorts).toHaveLength(4)
    expect(new Set(requestPorts).size).toBe(1)
    expect(connections).toBe(1)
    await http.close()
  })

  it('latency-test requests run back-to-back on one warm socket', async () => {
    const log = silentLogger()
    const http = new OpenRouterHttp({ baseUrl, getKey: () => 'sk-or-test-keepalive', log })
    const llm = new OpenRouterLLM({ http, log })
    const tester = new LatencyTester({
      llm,
      stats: new ModelStatsRepo(openDatabase(':memory:')),
      events: { broadcast: () => undefined },
      log,
      getRouting: () => ({}),
    })
    connections = 0
    requestPorts.length = 0
    tester.start(['x/y'], 5)
    await tester.whenIdle()
    expect(requestPorts).toHaveLength(5)
    expect(connections).toBe(1)
    await http.close()
  })
})
