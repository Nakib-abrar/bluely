import { ProviderError } from '@main/providers/errors'
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  LLMProvider,
} from '@main/providers/llm/LLMProvider'
import { createLogger, type Logger } from '@main/log'
import { BUILTIN_MODES } from '@shared/builtinModes'
import type { Settings } from '@shared/settings'
import type { Channel, Mode, SpeedStats, TranscriptLine } from '@shared/types'

export const EMPTY_PROFILE: Settings['profile'] = { name: '', role: '', company: '', about: '' }

export function builtinMode(id: string): Mode {
  const mode = BUILTIN_MODES.find((m) => m.id === id)
  if (!mode) throw new Error(`no builtin mode ${id}`)
  return { ...mode }
}

export const GENERAL = builtinMode('builtin-general')
export const SALES = builtinMode('builtin-sales')
export const INTERVIEW = builtinMode('builtin-interview')

let lineSeq = 0

/** Transcript line starting at `startSec` seconds (4 s long unless `durSec` is given). */
export function line(
  channel: Channel,
  startSec: number,
  text: string,
  opts: { durSec?: number; isFinal?: boolean; id?: string } = {},
): TranscriptLine {
  const startMs = Math.round(startSec * 1000)
  return {
    id: opts.id ?? `line-${++lineSeq}`,
    sessionId: 's1',
    channel,
    startMs,
    endMs: startMs + Math.round((opts.durSec ?? 4) * 1000),
    text,
    isFinal: opts.isFinal ?? true,
  }
}

export function speedStats(model = 'fake/model'): SpeedStats {
  return {
    ttftMs: 10,
    totalMs: 20,
    tokensPerSec: 100,
    tokensIn: 50,
    tokensOut: 10,
    costUsd: 0.0001,
    provider: 'Fake',
    model,
    generationId: 'gen-1',
  }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Handler = (req: ChatRequest, index: number) => string | Promise<string>

/** In-memory LLMProvider: records requests and answers through `handler`. Honors abort signals. */
export class FakeLLM implements LLMProvider {
  readonly id = 'fake'
  readonly calls: ChatRequest[] = []
  /** Requests whose promise has settled (resolved or rejected). */
  settled = 0
  /** finish_reason reported for a request ('length' = cut off at max_tokens). */
  finishReason: (req: ChatRequest) => string = () => 'stop'

  constructor(public handler: Handler = () => 'ok') {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    const index = this.calls.length
    this.calls.push(req)
    try {
      if (req.signal?.aborted) throw new ProviderError('aborted')
      const answer = Promise.resolve(this.handler(req, index))
      const text = await (req.signal
        ? Promise.race([
            answer,
            new Promise<never>((_, reject) =>
              req.signal?.addEventListener('abort', () => reject(new ProviderError('aborted')), {
                once: true,
              }),
            ),
          ])
        : answer)
      return {
        text,
        stats: speedStats(req.model),
        usage: { promptTokens: 50, completionTokens: 10, costUsd: 0.0001 },
        finishReason: this.finishReason(req),
      }
    } finally {
      this.settled++
    }
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const res = await this.complete(req)
    yield { type: 'delta', text: res.text }
    yield { type: 'done', finishReason: res.finishReason, usage: res.usage, stats: res.stats }
  }

  async listModels() {
    return []
  }

  async prewarm() {}
}

/** Concatenated text of every message (images as "[image]"), like the mock server scans it. */
export function allText(req: Pick<ChatRequest, 'messages'>): string {
  return req.messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n'),
    )
    .join('\n')
}

export function systemText(req: Pick<ChatRequest, 'messages'>): string {
  const sys = req.messages.find((m) => m.role === 'system')
  return typeof sys?.content === 'string' ? sys.content : ''
}

export function userText(req: Pick<ChatRequest, 'messages'>): string {
  const user = req.messages.find((m) => m.role === 'user')
  if (!user) return ''
  if (typeof user.content === 'string') return user.content
  return user.content
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
}

/** Logger that records warnings so tests can assert failures were logged, not thrown. */
export function recordingLogger(): Logger & { warnings: string[] } {
  const base = createLogger(null, 'test')
  const warnings: string[] = []
  const logger: Logger & { warnings: string[] } = {
    ...base,
    warnings,
    warn: (message: string) => {
      warnings.push(message)
    },
    child: () => logger,
  }
  return logger
}
