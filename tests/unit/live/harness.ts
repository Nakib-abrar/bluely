import { vi } from 'vitest'
import type { Channel, ModelInfo, SpeedStats } from '@shared/types'
import { openDatabase, type Db } from '@main/db/database'
import { SettingsStore } from '@main/settings/settingsStore'
import { SecretStore } from '@main/settings/secrets'
import { EventBus } from '@main/ipc/events'
import { WindowRegistry } from '@main/windows/registry'
import { createLogger } from '@main/log'
import { SessionsRepo } from '@main/db/repos/sessionsRepo'
import { TranscriptRepo } from '@main/db/repos/transcriptRepo'
import { AiMessagesRepo } from '@main/db/repos/aiMessagesRepo'
import { ActionItemsRepo } from '@main/db/repos/actionItemsRepo'
import { SearchService } from '@main/db/search'
import { ModesRepo } from '@main/modes/modesRepo'
import { KnowledgeService } from '@main/knowledge/ingest'
import { Fts5Retriever } from '@main/knowledge/retriever'
import { ModelStatsRepo } from '@main/models/statsRepo'
import type { CoreContext } from '@main/context'
import type { HistoryFeature } from '@main/history/wire'
import type { ModesFeature } from '@main/modes/wire'
import type { ModelsFeature } from '@main/models/wire'
import type { SttFeature } from '@main/stt/wire'
import type {
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
  ChatResult,
} from '@main/providers/llm/LLMProvider'
import { ProviderError } from '@main/providers/errors'
import type {
  TranscriptionJob,
  TranscriptionQueueOptions,
} from '@main/providers/stt/transcriptionQueue'

export interface EmittedEvent {
  event: string
  payload: unknown
}

/** Scripted LLM: answers with `reply(req)` split into words; supports abort and errors. */
export class FakeLLM implements LLMProvider {
  readonly id = 'fake'
  requests: ChatRequest[] = []
  reply: (req: ChatRequest) => string = () => 'Sure, the enterprise plan is priced per seat.'
  failWith: ProviderError | null = null
  delayMs = 0

  async *streamChat(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    this.requests.push(req)
    if (this.failWith) throw this.failWith
    yield { type: 'meta', generationId: 'gen-1', model: req.model, provider: 'FakeProvider' }
    const words = this.reply(req).match(/\s*\S+/g) ?? []
    for (const w of words) {
      if (req.signal?.aborted) throw new ProviderError('aborted')
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      if (req.signal?.aborted) throw new ProviderError('aborted')
      yield { type: 'delta', text: w }
    }
    const stats: SpeedStats = {
      ttftMs: 100,
      totalMs: 500,
      tokensPerSec: 50,
      tokensIn: 10,
      tokensOut: words.length,
      costUsd: 0.0001,
      provider: 'FakeProvider',
      model: req.model,
      generationId: 'gen-1',
    }
    yield { type: 'done', finishReason: 'stop', usage: null, stats }
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    let text = ''
    let stats: SpeedStats | null = null
    for await (const ev of this.streamChat(req)) {
      if (ev.type === 'delta') text += ev.text
      if (ev.type === 'done') stats = ev.stats
    }
    return { text, stats: stats as SpeedStats, usage: null, finishReason: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return []
  }
  async prewarm(): Promise<void> {}
  async getGenerationStats(): Promise<Partial<SpeedStats> | null> {
    return null
  }
}

/** Captures queue jobs; tests resolve them by calling `deliver`. */
export class FakeQueue {
  jobs: TranscriptionJob[] = []
  constructor(readonly opts: Partial<TranscriptionQueueOptions>) {}
  enqueue(job: TranscriptionJob): void {
    this.jobs.push(job)
  }
  deliver(job: TranscriptionJob, text: string): void {
    this.opts.onResult?.(job, {
      text,
      model: 'stt',
      latencyMs: 100,
      costUsd: null,
      audioSeconds: 1,
      language: null,
      endToTextMs: 300,
      receivedAt: Date.now(),
      attempts: 1,
    })
  }
  setConcurrency(): void {}
  async drain(): Promise<boolean> {
    return true
  }
  cancelAll(): void {}
  isIdle(): boolean {
    return true
  }
}

export function wav(): Uint8Array {
  return new Uint8Array(100)
}

export function createHarness() {
  const db: Db = openDatabase(':memory:')
  const settings = new SettingsStore(db)
  settings.update({ general: { onboardingComplete: true } })
  const secrets = new SecretStore('/nonexistent/key.bin', 'sk-or-test-1234567890')
  const windows = new WindowRegistry()
  const events = new EventBus(windows)
  const emitted: EmittedEvent[] = []
  const origBroadcast = events.broadcast.bind(events)
  events.broadcast = ((event: string, payload: unknown) => {
    emitted.push({ event, payload })
    origBroadcast(event as never, payload as never)
  }) as EventBus['broadcast']
  events.sendTo = ((_kind: string, event: string, payload: unknown) => {
    emitted.push({ event, payload })
  }) as EventBus['sendTo']
  const log = createLogger(null)
  const rendererGoneListeners = new Set<(info: { restarting: boolean }) => void>()
  const overlay = {
    window: null,
    show: vi.fn(),
    hide: vi.fn(),
    toggle: vi.fn(),
    focus: vi.fn(),
    isVisible: () => true,
    currentDisplay: vi.fn(),
    withHidden: async <T>(fn: () => Promise<T>) => fn(),
    onRendererGone: (fn: (info: { restarting: boolean }) => void) => {
      rendererGoneListeners.add(fn)
      return () => rendererGoneListeners.delete(fn)
    },
    /** Test helper: the overlay renderer crashed (and is reloaded when `restarting`). */
    rendererGone: (restarting: boolean) => {
      for (const fn of rendererGoneListeners) fn({ restarting })
    },
  }
  const ctx = {
    env: {
      isDev: true,
      isPackaged: false,
      isTest: true,
      rendererUrl: null,
      openRouterBaseUrl: 'http://x',
      verbose: false,
    },
    paths: {
      userData: '/tmp',
      dbFile: ':memory:',
      keyFile: '/tmp/k',
      logsDir: '/tmp',
      screenshotsDir: '/tmp/shots',
    },
    log,
    db,
    settings,
    secrets,
    events,
    windows,
    overlay,
    showMainWindow: vi.fn(),
  } as unknown as CoreContext

  const history: HistoryFeature = {
    sessions: new SessionsRepo(db),
    transcript: new TranscriptRepo(db),
    aiMessages: new AiMessagesRepo(db),
    actionItems: new ActionItemsRepo(db),
    search: new SearchService(db),
    recovered: [],
    retention: { dispose: () => undefined } as unknown as HistoryFeature['retention'],
  }
  const modesRepo = new ModesRepo({ db, events })
  modesRepo.ensureBuiltins()
  const modes: ModesFeature = {
    modes: modesRepo,
    knowledge: new KnowledgeService({ db, events, log }),
    retriever: new Fts5Retriever(db),
  }
  const llm = new FakeLLM()
  const visionless = new Set<string>()
  const models = {
    llm,
    catalog: {
      getById: (id: string) =>
        ({ id, supportsVision: !visionless.has(id) }) as unknown as ModelInfo,
    },
    stats: new ModelStatsRepo(db),
    http: { close: async () => undefined },
    dispose: async () => undefined,
    onValidation: () => () => undefined,
    lastValidation: () => [],
  } as unknown as ModelsFeature
  const queues: FakeQueue[] = []
  const stt = {
    stt: {},
    createQueue: (opts: Partial<TranscriptionQueueOptions>) => {
      const q = new FakeQueue(opts)
      queues.push(q)
      return q
    },
  } as unknown as SttFeature

  const eventsOf = (name: string) => emitted.filter((e) => e.event === name).map((e) => e.payload)
  return {
    db,
    ctx,
    settings,
    events,
    emitted,
    eventsOf,
    history,
    modes,
    models,
    llm,
    visionless,
    stt,
    queues,
    overlay,
  }
}

export function segment(sessionId: string, channel: Channel, startedAt: number, endedAt: number) {
  return { sessionId, channel, startedAt, endedAt, vadEndAt: endedAt, forced: false, wav: wav() }
}
