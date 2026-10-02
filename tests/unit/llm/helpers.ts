import { vi } from 'vitest'
import type { Logger } from '@main/log'
import type { FetchLike, RequestInitLike, ResponseLike } from '@main/providers/openrouterHttp'

/** Logger that records but prints nothing. */
export function silentLogger(): Logger & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = []
  const make = (): Logger => ({
    debug: (message) => void lines.push({ level: 'debug', message }),
    info: (message) => void lines.push({ level: 'info', message }),
    warn: (message) => void lines.push({ level: 'warn', message }),
    error: (message) => void lines.push({ level: 'error', message }),
    child: () => make(),
    setDebug: () => undefined,
  })
  return Object.assign(make(), { lines })
}

const encoder = new TextEncoder()

export interface FakeStream {
  stream: ReadableStream<Uint8Array>
  /** Resolves with the cancel reason when the consumer cancels the stream. */
  cancelled: Promise<unknown>
  cancelSpy: ReturnType<typeof vi.fn>
  /** Push more data (only for `hang: true` streams). */
  push(chunk: string | Uint8Array): void
  close(): void
}

/**
 * A ReadableStream that emits `chunks` and then closes, or stays open (`hang`) so tests can
 * exercise aborts and idle timeouts.
 */
export function fakeStream(
  chunks: (string | Uint8Array)[],
  opts: { hang?: boolean } = {},
): FakeStream {
  let resolveCancel: (r: unknown) => void = () => undefined
  const cancelled = new Promise<unknown>((r) => {
    resolveCancel = r
  })
  const cancelSpy = vi.fn((reason: unknown) => resolveCancel(reason))
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c)
      if (!opts.hang) controller.close()
    },
    cancel(reason) {
      cancelSpy(reason)
    },
  })
  return {
    stream,
    cancelled,
    cancelSpy,
    push: (c) => ctrl?.enqueue(typeof c === 'string' ? encoder.encode(c) : c),
    close: () => ctrl?.close(),
  }
}

export function fakeResponse(init: {
  status?: number
  headers?: Record<string, string>
  body?: ReadableStream<Uint8Array> | null
  text?: string
}): ResponseLike {
  const status = init.status ?? 200
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: init.body ?? null,
    text: async () => init.text ?? '',
    json: async () => JSON.parse(init.text ?? '') as unknown,
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ResponseLike {
  return fakeResponse({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    text: JSON.stringify(body),
  })
}

export function sseResponse(stream: ReadableStream<Uint8Array>): ResponseLike {
  return fakeResponse({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: stream,
  })
}

export interface FetchCall {
  url: string
  init: RequestInitLike
  body: Record<string, unknown> | null
}

/** A fetch fake that records calls and answers from a queue (or a handler). */
export function fakeFetch(
  handler: (url: string, init: RequestInitLike, n: number) => ResponseLike | Promise<ResponseLike>,
): FetchLike & { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fn = async (url: string, init: RequestInitLike) => {
    calls.push({
      url,
      init,
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    return handler(url, init, calls.length - 1)
  }
  return Object.assign(fn, { calls })
}

/** One OpenRouter stream chunk as an SSE `data:` line. */
export function chunk(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export const META = { id: 'gen-123', model: 'meta-llama/llama-3.3-70b-instruct', provider: 'Groq' }

export function deltaChunk(content: string, extra: Record<string, unknown> = {}): string {
  return chunk({
    ...META,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  })
}

/** A typical successful OpenRouter stream: keep-alive comment, role chunk, text, usage, [DONE]. */
export function typicalStream(
  parts: string[],
  usage = { prompt_tokens: 12, completion_tokens: 3, cost: 0.000012 },
): string[] {
  return [
    ': OPENROUTER PROCESSING\n\n',
    chunk({ ...META, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    ...parts.map((p) => deltaChunk(p)),
    chunk({ ...META, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    chunk({ ...META, choices: [], usage }),
    'data: [DONE]\n\n',
  ]
}

/** Clock that advances by the given steps on each call (then stays at the last value). */
export function steppedClock(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}
