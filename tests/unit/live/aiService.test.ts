import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { AiCard, AiErrorInfo, ModelInfo, SpeedStats, TranscriptLine } from '@shared/types'
import { AiService, meetingChatBudget, type LiveContextSource } from '@main/live/aiService'
import { ProviderError } from '@main/providers/errors'
import type { ChatRequest, ChatStreamEvent } from '@main/providers/llm/LLMProvider'
import { createHarness, FakeLLM } from './harness'

/** One scripted reply: text (word by word) + finish reason, or an error. */
type Step = { text: string; finishReason?: string } | ProviderError

/** FakeLLM whose next replies are scripted; falls back to the default reply. */
class ScriptedLLM extends FakeLLM {
  script: Step[] = []

  override async *streamChat(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const step = this.script.shift()
    if (!step) {
      yield* super.streamChat(req)
      return
    }
    this.requests.push(req)
    if (step instanceof ProviderError) throw step
    yield { type: 'meta', generationId: 'gen-s', model: req.model, provider: 'FakeProvider' }
    for (const w of step.text.match(/\s*\S+/g) ?? []) yield { type: 'delta', text: w }
    const stats: SpeedStats = {
      ttftMs: 100,
      totalMs: 500,
      tokensPerSec: 50,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.0001,
      provider: 'FakeProvider',
      model: req.model,
      generationId: 'gen-s',
    }
    yield { type: 'done', finishReason: step.finishReason ?? 'stop', usage: null, stats }
  }
}

function setup() {
  const h = createHarness()
  const llm = new ScriptedLLM()
  // AiService reads models.llm on every request.
  ;(h.models as { llm: unknown }).llm = llm
  const ai = new AiService(h.ctx, h.models, h.modes, h.history)
  return { ...h, llm, ai }
}

function liveSource(sessionId: string | null, lines: TranscriptLine[], nowMs: number) {
  const source: LiveContextSource = {
    sessionId: () => sessionId,
    elapsedMs: () => nowMs,
    transcript: () => lines,
    runningSummary: () => ({ text: null, coveredUntilMs: 0 }),
  }
  return source
}

function tline(sessionId: string, startSec: number, text: string): TranscriptLine {
  return {
    id: `l-${startSec}`,
    sessionId,
    channel: startSec % 60 === 0 ? 'them' : 'me',
    startMs: startSec * 1000,
    endMs: startSec * 1000 + 4000,
    text,
    isFinal: true,
  }
}

function promptOf(req: ChatRequest | undefined): string {
  return (req?.messages ?? [])
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    )
    .join('\n')
}

function errorOf(h: ReturnType<typeof setup>, id: string): AiErrorInfo | undefined {
  const ev = (h.eventsOf('ai:error') as { id: string; error: AiErrorInfo }[]).find(
    (e) => e.id === id,
  )
  return ev?.error
}

describe('AiService', () => {
  it('streams a live card: ai:card → ai:delta → ai:done, persisted with stats', async () => {
    const h = setup()
    const { id, finished } = h.ai.startLive({ kind: 'say' })
    await finished
    const cards = h.eventsOf('ai:card') as AiCard[]
    expect(cards[0]).toMatchObject({
      id,
      kind: 'say',
      status: 'streaming',
      scope: 'live',
      label: 'What should I say?',
    })
    const deltas = (h.eventsOf('ai:delta') as { delta: string }[]).map((d) => d.delta).join('')
    expect(deltas).toBe('Sure, the enterprise plan is priced per seat.')
    const done = h.eventsOf('ai:done')[0] as { id: string; stats: { provider: string } }
    expect(done.id).toBe(id)
    expect(done.stats.provider).toBe('FakeProvider')
    const row = h.history.aiMessages.get(id)
    expect(row?.status).toBe('done')
    expect(h.ai.getCards('live')[0]?.text).toContain('enterprise plan')
  })

  it('uses the Fast model for quick actions and the active tier for Ask', async () => {
    const h = setup()
    await h.ai.startLive({ kind: 'recap' }).finished
    await h.ai.startLive({
      kind: 'ask',
      question: 'What did they say about pricing?',
      tier: 'smart',
    }).finished
    const s = h.settings.get().models
    expect(h.llm.requests[0]?.model).toBe(s.fast.model)
    expect(h.llm.requests[1]?.model).toBe(s.smart.model)
    expect(h.llm.requests[0]?.routing?.sort).toBe('latency')
  })

  it('a newer live request supersedes (cancels) the previous stream', async () => {
    const h = setup()
    h.llm.delayMs = 5
    const first = h.ai.startLive({ kind: 'say' })
    await new Promise((r) => setTimeout(r, 12))
    const second = h.ai.startLive({ kind: 'followups' })
    await Promise.all([first.finished, second.finished])
    expect(h.eventsOf('ai:cancelled')).toEqual([{ id: first.id }])
    expect((h.eventsOf('ai:done') as { id: string }[]).map((d) => d.id)).toEqual([second.id])
    expect(h.ai.isLiveBusy()).toBe(false)
  })

  it('maps provider errors to a friendly ai:error', async () => {
    const h = setup()
    h.llm.failWith = new ProviderError('credits', { status: 402 })
    const { id, finished } = h.ai.startLive({ kind: 'say' })
    await finished
    expect(h.eventsOf('ai:error')).toEqual([
      { id, error: expect.objectContaining({ code: 'credits', retryable: false }) },
    ])
    expect(h.history.aiMessages.get(id)?.status).toBe('error')
  })

  it('requires a question for Ask', () => {
    const h = setup()
    expect(() => h.ai.startLive({ kind: 'ask', question: '   ' })).toThrow(/question/i)
  })

  it('upgrades to the Smart model when the screen is attached and Fast has no vision', () => {
    const h = setup()
    const s = h.settings.get().models
    h.visionless.add(s.fast.model)
    const mode = h.ai.activeMode()
    expect(h.ai.resolveModel('fast', mode, true).model).toBe(s.smart.model)
    expect(h.ai.resolveModel('fast', mode, false).model).toBe(s.fast.model)
  })

  it('aborting the auto-suggest signal cancels the auto card', async () => {
    const h = setup()
    h.llm.delayMs = 5
    const controller = new AbortController()
    const { id, finished } = h.ai.startLive(
      { kind: 'auto' },
      { triggerText: 'How much?', vadEndAt: null, sttDoneAt: null },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 8)
    await finished
    expect(h.eventsOf('ai:cancelled')).toEqual([{ id }])
  })

  it('never stores screenshot bytes in prompt_text', async () => {
    const h = setup()
    await h.ai.startLive({ kind: 'recap' }).finished
    const row = h.history.aiMessages.get(h.ai.getCards('live')[0]!.id)
    expect(row?.promptText ?? '').not.toContain('base64')
  })

  it('caps say/auto with room for two Bangla replies', async () => {
    const h = setup()
    await h.ai.startLive({ kind: 'say' }).finished
    await h.ai.startLive({ kind: 'auto' }, { triggerText: 'Q?', vadEndAt: null, sttDoneAt: null })
      .finished
    for (const req of h.llm.requests) expect(req.maxTokens).toBeGreaterThanOrEqual(450)
  })

  it('marks an answer cut off at the token cap instead of showing it as complete', async () => {
    const h = setup()
    h.llm.script.push({ text: '"Thanks for asking. The plan', finishReason: 'length' })
    const { id, finished } = h.ai.startLive({ kind: 'say' })
    await finished
    const done = h.eventsOf('ai:done')[0] as { id: string; text: string }
    expect(done.id).toBe(id)
    // Marked by a trailing ellipsis only: the text is stored and copied as it is, so no
    // explanatory note is mixed into it.
    expect(done.text).toBe('"Thanks for asking. The plan…')
    expect(h.ai.getCards('live')[0]).toMatchObject({ status: 'done', text: done.text })
    expect(h.history.aiMessages.get(id)?.responseText).toBe(done.text)
  })

  it('sends a cut-off meeting-chat answer back as the model wrote it (plus "…")', async () => {
    const h = setup()
    const session = h.history.sessions.create({ modeId: null, startedAt: Date.now() })
    h.history.transcript.upsert(tline(session.id, 0, 'Priya will own the pricing follow-up.'))
    h.llm.script.push({ text: 'Priya owns it, and she', finishReason: 'length' })
    h.ai.startMeetingChat(session.id, 'Who owns the pricing follow-up?')
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(1))
    expect(h.ai.getCards('meeting_chat', session.id)[0]?.text).toBe('Priya owns it, and she…')
    h.ai.startMeetingChat(session.id, 'And when is it due?')
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(2))
    expect(h.llm.requests[1]?.messages[2]).toEqual({
      role: 'assistant',
      content: 'Priya owns it, and she…',
    })
  })

  it('fails an empty answer (e.g. a reasoning model that used its budget) instead of "done"', async () => {
    const h = setup()
    h.llm.script.push({ text: '', finishReason: 'length' }, { text: '   ', finishReason: 'stop' })
    const first = h.ai.startLive({ kind: 'say' })
    await first.finished
    expect(errorOf(h, first.id)).toMatchObject({
      message: t('models.answerBudgetUsed'),
      retryable: true,
    })
    const second = h.ai.startLive({ kind: 'recap' })
    await second.finished
    expect(errorOf(h, second.id)?.message).toBe(t('models.answerEmpty'))
    expect(h.eventsOf('ai:done')).toEqual([])
    expect(h.history.aiMessages.get(first.id)?.status).toBe('error')
  })

  it('gives reasoning models low effort, hidden reasoning and headroom; others unchanged', async () => {
    const h = setup()
    h.settings.update({ models: { fast: { model: 'openai/gpt-oss-120b' } } })
    await h.ai.startLive({ kind: 'say' }).finished
    expect(h.llm.requests[0]).toMatchObject({
      model: 'openai/gpt-oss-120b',
      reasoning: { effort: 'low', exclude: true },
    })
    expect(h.llm.requests[0]?.maxTokens).toBeGreaterThanOrEqual(450 + 1024)
    h.settings.update({ models: { fast: { model: 'meta-llama/llama-3.3-70b-instruct' } } })
    await h.ai.startLive({ kind: 'say' }).finished
    expect(h.llm.requests[1]?.reasoning).toBeUndefined()
    expect(h.llm.requests[1]?.maxTokens).toBe(450)
  })

  it('retries a rate-limited answer once by itself before the first word', async () => {
    const h = setup()
    h.llm.script.push(new ProviderError('rate_limit', { status: 429, retryAfterSec: 0 }))
    const { id, finished } = h.ai.startLive({ kind: 'say' })
    await finished
    expect(h.llm.requests).toHaveLength(2)
    expect(h.eventsOf('ai:error')).toEqual([])
    expect((h.eventsOf('ai:done') as { id: string }[]).map((d) => d.id)).toEqual([id])
  })

  it('a second rate limit fails the card with a message that does not promise a retry', async () => {
    const h = setup()
    const limited = () => new ProviderError('rate_limit', { status: 429, retryAfterSec: 0 })
    h.llm.script.push(limited(), limited())
    const { id, finished } = h.ai.startLive({ kind: 'say' })
    await finished
    expect(h.llm.requests).toHaveLength(2)
    const error = errorOf(h, id)
    expect(error).toMatchObject({ code: 'rate_limit', retryable: true })
    expect(error?.message).toBe(t('errors.rate_limit'))
    expect(error?.message).not.toMatch(/retrying/i)
    // Credits and other non-transient errors are not retried.
    h.llm.script.push(new ProviderError('credits', { status: 402 }))
    await h.ai.startLive({ kind: 'say' }).finished
    expect(h.llm.requests).toHaveLength(3)
  })

  it('a newer request during the retry wait cancels the waiting one', async () => {
    const h = setup()
    h.llm.script.push(new ProviderError('rate_limit', { status: 429, retryAfterSec: 5 }))
    const first = h.ai.startLive({ kind: 'say' })
    await vi.waitFor(() => expect(h.llm.requests).toHaveLength(1))
    const second = h.ai.startLive({ kind: 'recap' })
    await Promise.all([first.finished, second.finished])
    expect(h.eventsOf('ai:cancelled')).toEqual([{ id: first.id }])
    expect(h.llm.requests).toHaveLength(2)
  })

  it('keeps lines older than the window verbatim while there is no running summary', async () => {
    const h = setup()
    const lines = Array.from({ length: 20 }, (_, i) => tline('s', i * 30, `utterance ${i * 30}.`))
    h.ai.attachLive(liveSource(null, lines, 10 * 60_000))
    await h.ai.startLive({ kind: 'recap' }).finished
    const prompt = promptOf(h.llm.requests[0])
    // Minute 0 is far outside the 6-minute window; with no summary it must not vanish.
    expect(prompt).toContain('utterance 0.')
    expect(prompt).toContain('utterance 570.')
  })

  it('does not store ask-across-meetings prompts or answers (they quote other meetings)', async () => {
    const h = setup()
    const session = h.history.sessions.create({ modeId: null, startedAt: Date.now() })
    h.history.transcript.upsert(
      tline(session.id, 0, 'Acme said the pricing for the enterprise plan is too high.'),
    )
    const id = h.ai.startSearchAsk('What did Acme say about pricing?')
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(1))
    expect(promptOf(h.llm.requests[0])).toContain('Acme said the pricing')
    // Shown in the search panel (in memory) …
    expect(h.ai.getCards('search')[0]).toMatchObject({ id, status: 'done' })
    // … but nothing in ai_messages that would outlive the cited meeting.
    expect(h.history.aiMessages.get(id)).toBeNull()
    h.history.sessions.delete(session.id)
    const leftovers = h.db
      .prepare(
        "SELECT count(*) AS n FROM ai_messages WHERE prompt_text LIKE '%Acme%' OR response_text LIKE '%Acme%'",
      )
      .get() as { n: number }
    expect(leftovers.n).toBe(0)
  })

  it('meeting chat sends the earlier questions and answers with a follow-up', async () => {
    const h = setup()
    const session = h.history.sessions.create({ modeId: null, startedAt: Date.now() })
    h.history.transcript.upsert(tline(session.id, 0, 'Priya will own the pricing follow-up.'))
    h.history.transcript.upsert(tline(session.id, 30, 'It is due next Friday.'))
    h.llm.script.push({ text: 'Priya owns it.' })
    h.ai.startMeetingChat(session.id, 'Who owns the pricing follow-up?')
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(1))
    h.ai.startMeetingChat(session.id, 'When is it due?')
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(2))
    const follow = h.llm.requests[1]!
    expect(follow.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(follow.messages[1]?.content).toBe('Who owns the pricing follow-up?')
    expect(follow.messages[2]?.content).toBe('Priya owns it.')
    expect(promptOf(follow)).toContain('My question: When is it due?')
  })

  it('sizes the meeting-chat budget from the model context window', async () => {
    expect(meetingChatBudget(null)).toBe(24_000)
    expect(meetingChatBudget(1_048_576)).toBe(100_000)
    expect(meetingChatBudget(131_072)).toBe(65_536)
    expect(meetingChatBudget(32_768)).toBe(24_000)
    expect(meetingChatBudget(8_192)).toBe(4_096)

    // A long Bangla meeting no longer loses its opening on a large-context model.
    const h = setup()
    h.models.catalog.getById = (id: string) =>
      ({ id, supportsVision: true, contextLength: 1_048_576 }) as unknown as ModelInfo
    const session = h.history.sessions.create({ modeId: null, startedAt: Date.now() })
    const bangla =
      'আমরা মূল্য নির্ধারণ নিয়ে বিস্তারিত আলোচনা করেছি এবং পরবর্তী পদক্ষেপ ঠিক করেছি। '
    h.history.transcript.upsert(tline(session.id, 0, 'OPENING: the launch moves to May.'))
    for (let i = 1; i <= 400; i++)
      h.history.transcript.upsert(tline(session.id, i * 30, bangla.repeat(3)))
    h.ai.startMeetingChat(session.id, 'What did we say at the start?')
    await vi.waitFor(() => expect(h.eventsOf('ai:done')).toHaveLength(1))
    expect(promptOf(h.llm.requests[0])).toContain('OPENING: the launch moves to May.')
  })
})
