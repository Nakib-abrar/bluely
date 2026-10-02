import { t } from '@shared/i18n'
import type {
  AiCard,
  AiCardScope,
  AiMessageKind,
  Citation,
  LatencyTrace,
  LiveRequestKind,
  Mode,
  ModelRole,
  SpeedStats,
  Tier,
  TranscriptLine,
} from '@shared/types'
import { newId } from '../db/database'
import { AppError } from '../errors'
import type { CoreContext } from '../context'
import type { ChatMessage, ProviderRouting } from '../providers/llm/LLMProvider'
import { ProviderError } from '../providers/errors'
import { buildContext, retrievalQueryFrom } from '../ai/contextBuilder'
import { renderNotesMarkdown } from '../ai/markdown'
import { messagesToText } from '../ai/tokens'
import type { ModelsFeature } from '../models/wire'
import { routingFor } from '../models/wire'
import type { ModesFeature } from '../modes/wire'
import type { HistoryFeature } from '../history/wire'
import { captureScreen, saveScreenshot, type Screenshot } from '../screen'
import { DeltaCoalescer } from './deltaCoalescer'

/** What the AI service needs from the live session (implemented by SessionManager). */
export interface LiveContextSource {
  sessionId(): string | null
  /** Milliseconds since the session started (0 when no session). */
  elapsedMs(): number
  /** Finalized transcript lines of the current session. */
  transcript(): TranscriptLine[]
  runningSummary(): { text: string | null; coveredUntilMs: number }
}

export interface LiveRequest {
  kind: LiveRequestKind
  question?: string
  includeScreen?: boolean
  tier?: Tier
}

export interface AutoOrigin {
  triggerText: string
  vadEndAt: number | null
  sttDoneAt: number | null
}

interface StreamJob {
  card: AiCard
  model: string
  routing: ProviderRouting | undefined
  messages: ChatMessage[]
  maxTokens: number
  temperature: number
  persistKind: AiMessageKind
  trace: LatencyTrace | null
  promptTokens: number
}

const FAST_KINDS: ReadonlySet<LiveRequestKind> = new Set([
  'auto',
  'say',
  'followups',
  'factcheck',
  'who',
  'recap',
])

const MAX_TOKENS: Record<string, number> = {
  auto: 220,
  say: 220,
  followups: 220,
  factcheck: 600,
  who: 450,
  recap: 400,
  assist: 700,
  ask: 800,
  meeting_chat: 900,
  search_ask: 900,
}

const MAX_LIVE_CARDS = 100

/**
 * Runs every AI request (live actions, Ask/Assist, auto-suggest, meeting chat, ask-across-
 * meetings), streams answers to the renderers as AiCards and records cost + latency.
 */
export class AiService {
  private liveCards: AiCard[] = []
  private searchCards: AiCard[] = []
  private chatStreaming = new Map<string, AiCard>()
  private inflight = new Map<string, { controller: AbortController; scope: AiCardScope }>()
  private coalescer: DeltaCoalescer
  private live: LiveContextSource | null = null

  constructor(
    private readonly ctx: CoreContext,
    private readonly models: ModelsFeature,
    private readonly modes: ModesFeature,
    private readonly history: HistoryFeature,
  ) {
    this.coalescer = new DeltaCoalescer((id, delta) =>
      this.ctx.events.broadcast('ai:delta', { id, delta }),
    )
  }

  attachLive(source: LiveContextSource): void {
    this.live = source
  }

  /** True while a live (overlay) request is streaming. */
  isLiveBusy(): boolean {
    for (const v of this.inflight.values()) if (v.scope === 'live') return true
    return false
  }

  /** A new session starts with an empty overlay chat. */
  resetLive(): void {
    this.cancelScope('live')
    this.liveCards = []
    this.ctx.events.broadcast('ai:cleared', { scope: 'live' })
  }

  clearLive(): void {
    this.resetLive()
  }

  cancel(id: string): void {
    this.inflight.get(id)?.controller.abort()
  }

  cancelScope(scope: AiCardScope): void {
    for (const v of this.inflight.values()) if (v.scope === scope) v.controller.abort()
  }

  getCards(scope: AiCardScope, sessionId?: string): AiCard[] {
    if (scope === 'live') return this.liveCards.map((c) => ({ ...c }))
    if (scope === 'search') return this.searchCards.map((c) => ({ ...c }))
    if (!sessionId) return []
    const stored = this.history.aiMessages.chatHistory(sessionId)
    const streaming = [...this.chatStreaming.values()].filter((c) => c.sessionId === sessionId)
    const ids = new Set(streaming.map((c) => c.id))
    return [...stored.filter((c) => !ids.has(c.id)), ...streaming].sort(
      (a, b) => a.createdAt - b.createdAt,
    )
  }

  /**
   * Starts a live request. Newer requests supersede (cancel) older live streams. Returns the card
   * id immediately and a promise that settles when the stream ends.
   */
  startLive(
    req: LiveRequest,
    auto?: AutoOrigin,
    signal?: AbortSignal,
  ): { id: string; finished: Promise<void> } {
    const settings = this.ctx.settings.get()
    const mode = this.activeMode()
    const kind = req.kind
    const tier: Tier = FAST_KINDS.has(kind) ? 'fast' : (req.tier ?? settings.models.activeTier)
    const includeScreen = !!req.includeScreen && (kind === 'assist' || kind === 'ask')
    const question = req.question?.trim() || null
    if (kind === 'ask' && !question) throw new AppError('invalid_request', 'Type a question first.')

    this.cancelScope('live')
    const id = newId()
    const card: AiCard = {
      id,
      scope: 'live',
      sessionId: this.live?.sessionId() ?? null,
      kind,
      label: labelFor(kind, question),
      question,
      usedScreen: false,
      tier,
      status: 'streaming',
      text: '',
      error: null,
      stats: null,
      citations: [],
      createdAt: Date.now(),
    }
    this.liveCards.push(card)
    if (this.liveCards.length > MAX_LIVE_CARDS)
      this.liveCards.splice(0, this.liveCards.length - MAX_LIVE_CARDS)
    this.ctx.events.broadcast('ai:card', { ...card })
    const controller = new AbortController()
    this.inflight.set(id, { controller, scope: 'live' })
    // The auto-suggest scheduler aborts its run when I trigger something manually.
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const finished = (async () => {
      let screenshot: Screenshot | null = null
      if (includeScreen) {
        try {
          screenshot = await captureScreen(this.ctx.overlay)
          card.usedScreen = true
          this.ctx.events.broadcast('ai:card', { ...card })
          if (settings.privacy.saveScreenshots) {
            saveScreenshot(this.ctx.paths.screenshotsDir, card.sessionId, id, screenshot)
          }
        } catch (err) {
          this.ctx.log.warn('Screen capture failed', err)
        }
      }
      if (controller.signal.aborted) return this.finishCancelled(card)
      const role: ModelRole = tier === 'fast' ? 'fast' : 'smart'
      const { model, routing } = this.resolveModel(role, mode, !!screenshot)
      const transcript = this.live?.transcript() ?? []
      const summary = this.live?.runningSummary() ?? { text: null, coveredUntilMs: 0 }
      const query = [question ?? '', retrievalQueryFrom(transcript)].filter(Boolean).join(' ')
      const knowledge = query ? this.safeRetrieve(mode.id, query) : []
      const built = buildContext({
        kind,
        mode,
        profile: settings.profile,
        answerLanguage: settings.language.answer,
        transcript,
        nowMs: this.live?.elapsedMs() ?? 0,
        contextMinutes: settings.advanced.contextMinutes,
        runningSummary: summary.text,
        summaryCoveredUntilMs: summary.text ? summary.coveredUntilMs : null,
        knowledge,
        question,
        screenshot: screenshot ? { dataUrl: screenshot.dataUrl } : null,
        trigger: auto ? { text: auto.triggerText } : null,
      })
      const trace: LatencyTrace = {
        id,
        kind,
        model,
        vadEndAt: auto?.vadEndAt ?? null,
        sttDoneAt: auto?.sttDoneAt ?? null,
        promptBuiltAt: Date.now(),
        requestSentAt: null,
        firstTokenAt: null,
        doneAt: null,
        promptTokensEstimate: built.promptTokens,
      }
      if (settings.advanced.devLogging) {
        this.ctx.log.info(`[ai] ${kind} prompt ≈ ${built.promptTokens} tokens, model ${model}`)
      }
      await this.stream(
        {
          card,
          model,
          routing,
          messages: built.messages,
          maxTokens: MAX_TOKENS[kind] ?? 600,
          temperature: kind === 'say' || kind === 'auto' ? 0.4 : 0.3,
          persistKind: kind,
          trace,
          promptTokens: built.promptTokens,
        },
        controller,
      )
    })()
      .catch((err: unknown) => {
        this.failCard(card, err)
      })
      .finally(() => {
        // Covers early exits (cancelled during screen capture, context errors).
        this.inflight.delete(id)
      })
    return { id, finished }
  }

  /** "Ask about this meeting" on the session page. */
  startMeetingChat(sessionId: string, question: string): string {
    const detail = this.history.sessions.getDetail(sessionId)
    if (!detail) throw new AppError('not_found', 'Session not found')
    const settings = this.ctx.settings.get()
    const mode = (detail.modeId && this.modes.modes.get(detail.modeId)) || this.activeMode()
    const id = newId()
    const card: AiCard = {
      id,
      scope: 'meeting_chat',
      sessionId,
      kind: 'meeting_chat',
      label: question,
      question,
      usedScreen: false,
      tier: 'smart',
      status: 'streaming',
      text: '',
      error: null,
      stats: null,
      citations: [],
      createdAt: Date.now(),
    }
    this.chatStreaming.set(id, card)
    this.ctx.events.broadcast('ai:card', { ...card })
    const controller = new AbortController()
    this.inflight.set(id, { controller, scope: 'meeting_chat' })
    const { model, routing } = this.resolveModel('smart', mode, false)
    const lastEnd = detail.transcript.at(-1)?.endMs ?? 0
    const built = buildContext({
      kind: 'meeting_chat',
      mode,
      profile: settings.profile,
      answerLanguage: settings.language.answer,
      transcript: detail.transcript,
      nowMs: lastEnd,
      contextMinutes: 600,
      runningSummary: null,
      question,
      notesMarkdown: detail.notes ? renderNotesMarkdown(detail.notes) : null,
      maxPromptTokens: 24_000,
    })
    void this.stream(
      {
        card,
        model,
        routing,
        messages: built.messages,
        maxTokens: MAX_TOKENS['meeting_chat'] ?? 900,
        temperature: 0.3,
        persistKind: 'meeting_chat',
        trace: null,
        promptTokens: built.promptTokens,
      },
      controller,
    )
      .catch((err: unknown) => this.failCard(card, err))
      .finally(() => this.chatStreaming.delete(id))
    return id
  }

  /** "Ask Bluely across your meetings" from the search bar. */
  startSearchAsk(question: string): string {
    const settings = this.ctx.settings.get()
    const mode = this.activeMode()
    const excerpts = this.history.search.retrieveForQuestion(question, 12)
    const citations: Citation[] = []
    const seen = new Set<string>()
    for (const e of excerpts) {
      if (seen.has(e.sessionId)) continue
      seen.add(e.sessionId)
      citations.push({ sessionId: e.sessionId, title: e.title, startedAt: e.startedAt })
    }
    const id = newId()
    const card: AiCard = {
      id,
      scope: 'search',
      sessionId: null,
      kind: 'search_ask',
      label: question,
      question,
      usedScreen: false,
      tier: 'smart',
      status: 'streaming',
      text: '',
      error: null,
      stats: null,
      citations,
      createdAt: Date.now(),
    }
    this.searchCards = [...this.searchCards.slice(-19), card]
    this.ctx.events.broadcast('ai:card', { ...card })
    const controller = new AbortController()
    this.inflight.set(id, { controller, scope: 'search' })
    const { model, routing } = this.resolveModel('smart', mode, false)
    const built = buildContext({
      kind: 'search_ask',
      mode,
      profile: settings.profile,
      answerLanguage: settings.language.answer,
      transcript: [],
      nowMs: 0,
      question,
      excerpts: excerpts.map((e) => ({
        title: e.title || t('live.untitledMeeting', { date: shortDate(e.startedAt) }),
        startedAt: e.startedAt,
        text: e.text,
      })),
      maxPromptTokens: 12_000,
    })
    void this.stream(
      {
        card,
        model,
        routing,
        messages: built.messages,
        maxTokens: MAX_TOKENS['search_ask'] ?? 900,
        temperature: 0.2,
        persistKind: 'search_ask',
        trace: null,
        promptTokens: built.promptTokens,
      },
      controller,
    ).catch((err: unknown) => this.failCard(card, err))
    return id
  }

  /** Resolves the model for a role: Mode override → Settings role; upgrades to Smart when vision is needed. */
  resolveModel(
    role: ModelRole,
    mode: Mode,
    needVision: boolean,
  ): { model: string; routing: ProviderRouting } {
    const s = this.ctx.settings.get().models
    let effective: ModelRole = role
    let model = mode.modelOverrides[role] || s[role].model
    if (needVision) {
      const info = this.models.catalog.getById(model)
      if (info && !info.supportsVision) {
        effective = 'smart'
        model = mode.modelOverrides.smart || s.smart.model
      }
    }
    return { model, routing: routingFor(s[effective]) }
  }

  activeMode(): Mode {
    const id = this.ctx.settings.get().activeModeId
    return (
      this.modes.modes.get(id) ??
      this.modes.modes.get('builtin-general') ??
      this.modes.modes.list()[0]!
    )
  }

  private safeRetrieve(modeId: string, query: string) {
    try {
      // Chunks are up to ~800 tokens each; 4 keeps live prompts small and fast.
      return this.modes.retriever.search(modeId, query, 4)
    } catch (err) {
      this.ctx.log.warn('Knowledge retrieval failed', err)
      return []
    }
  }

  private async stream(job: StreamJob, controller: AbortController): Promise<void> {
    const { card } = job
    const { events } = this.ctx
    if (!this.inflight.has(card.id)) this.inflight.set(card.id, { controller, scope: card.scope })
    this.history.aiMessages.insert({
      id: card.id,
      sessionId: card.sessionId,
      kind: job.persistKind,
      label: card.label,
      promptText: messagesToText(job.messages),
      status: 'streaming',
      createdAt: card.createdAt,
      usedScreen: card.usedScreen,
    })
    let text = ''
    let stats: SpeedStats | null = null
    try {
      if (job.trace) job.trace.requestSentAt = Date.now()
      for await (const ev of this.models.llm.streamChat({
        model: job.model,
        messages: job.messages,
        routing: job.routing,
        maxTokens: job.maxTokens,
        temperature: job.temperature,
        signal: controller.signal,
        tag: job.persistKind,
      })) {
        if (ev.type === 'delta') {
          if (!text && job.trace) job.trace.firstTokenAt = Date.now()
          text += ev.text
          card.text = text
          this.coalescer.push(card.id, ev.text)
        } else if (ev.type === 'done') {
          stats = ev.stats
        }
      }
      this.coalescer.flush(card.id)
      card.status = 'done'
      card.text = text
      card.stats = stats
      events.broadcast('ai:done', { id: card.id, text, stats: stats ?? emptyStats(job.model) })
      if (job.trace) {
        job.trace.doneAt = Date.now()
        events.broadcast('dev:latency', { ...job.trace, model: stats?.model ?? job.model })
      }
      this.history.aiMessages.complete(card.id, {
        responseText: text,
        model: stats?.model ?? job.model,
        provider: stats?.provider ?? null,
        ttftMs: stats?.ttftMs ?? null,
        totalMs: stats?.totalMs ?? null,
        tokensIn: stats?.tokensIn ?? null,
        tokensOut: stats?.tokensOut ?? null,
        costUsd: stats?.costUsd ?? null,
        status: 'done',
        error: null,
      })
      if (stats?.generationId) void this.refineStats(card, stats)
    } catch (err) {
      this.coalescer.flush(card.id)
      if (err instanceof ProviderError && err.code === 'aborted') {
        this.finishCancelled(card)
      } else {
        this.failCard(card, err)
      }
    } finally {
      this.inflight.delete(card.id)
    }
  }

  /** Fetches exact provider stats (GET /generation) after the stream and pushes them to the UI. */
  private async refineStats(card: AiCard, stats: SpeedStats): Promise<void> {
    const getStats = this.models.llm.getGenerationStats?.bind(this.models.llm)
    if (!getStats || !stats.generationId) return
    try {
      const extra = await getStats(stats.generationId)
      if (!extra) return
      const merged: SpeedStats = {
        ...stats,
        provider: extra.provider ?? stats.provider,
        costUsd: extra.costUsd ?? stats.costUsd,
        tokensIn: extra.tokensIn ?? stats.tokensIn,
        tokensOut: extra.tokensOut ?? stats.tokensOut,
      }
      card.stats = merged
      this.ctx.events.broadcast('ai:stats', { id: card.id, stats: merged })
    } catch {
      /* optional refinement */
    }
  }

  private finishCancelled(card: AiCard): void {
    card.status = 'cancelled'
    this.ctx.events.broadcast('ai:cancelled', { id: card.id })
    try {
      this.history.aiMessages.complete(card.id, {
        responseText: card.text,
        model: null,
        provider: null,
        ttftMs: null,
        totalMs: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        status: 'cancelled',
        error: null,
      })
    } catch {
      /* row may not exist yet */
    }
  }

  private failCard(card: AiCard, err: unknown): void {
    const info =
      err instanceof ProviderError
        ? err.toInfo()
        : err instanceof AppError && err.ai
          ? err.ai
          : {
              code: 'unknown' as const,
              message: err instanceof Error ? err.message : t('errors.unknown'),
              retryable: true,
              retryAfterSec: null,
            }
    card.status = 'error'
    card.error = info
    this.ctx.events.broadcast('ai:error', { id: card.id, error: info })
    this.ctx.log.warn(
      `AI request ${card.kind} failed: ${info.code}`,
      err instanceof ProviderError ? err.detail : err,
    )
    try {
      this.history.aiMessages.complete(card.id, {
        responseText: card.text || null,
        model: null,
        provider: null,
        ttftMs: null,
        totalMs: null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        status: 'error',
        error: info.message,
      })
    } catch {
      /* row may not exist yet */
    }
  }
}

function labelFor(kind: LiveRequestKind, question: string | null): string {
  if (kind === 'ask') return question ?? t('actions.ask')
  if (kind === 'auto') return t('actions.autoLabel')
  return t(`actions.${kind}`)
}

function emptyStats(model: string): SpeedStats {
  return {
    ttftMs: null,
    totalMs: 0,
    tokensPerSec: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
    provider: null,
    model,
    generationId: null,
  }
}

function shortDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
