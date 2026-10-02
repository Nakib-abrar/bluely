/**
 * Runs the real prompts through scripts/mock-openrouter.mjs. The mock picks canned answers by
 * keywords in the prompt text, and E2E tests rely on that, so this guards against a prompt edit
 * that would silently make (say) every action return the follow-up questions answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockOpenRouter, type MockOpenRouter } from '../../../scripts/mock-openrouter.mjs'
import { buildContext } from '@main/ai/contextBuilder'
import { formatTranscript } from '@main/ai/format'
import { generatePostCall } from '@main/ai/postCall'
import type { PromptKind } from '@main/ai/prompts'
import { RunningSummarizer } from '@main/ai/runningSummary'
import { createLogger } from '@main/log'
import { OpenRouterHttp } from '@main/providers/openrouterHttp'
import type {
  ChatRequest,
  ChatResult,
  ChatStreamEvent,
  LLMProvider,
} from '@main/providers/llm/LLMProvider'
import { BUILTIN_MODES } from '@shared/builtinModes'
import { EMPTY_PROFILE, GENERAL, line, speedStats } from './helpers'

/** Minimal non-streaming LLMProvider over the shared HTTP layer (the real one lives elsewhere). */
class HttpLLM implements LLMProvider {
  readonly id = 'mock-http'
  constructor(private readonly http: OpenRouterHttp) {}

  async complete(req: ChatRequest): Promise<ChatResult> {
    const res = await this.http.json<{ choices: { message: { content: string } }[] }>(
      '/chat/completions',
      {
        method: 'POST',
        signal: req.signal,
        body: {
          model: req.model,
          messages: req.messages,
          stream: false,
          ...(req.responseFormat === 'json_object'
            ? { response_format: { type: 'json_object' } }
            : {}),
        },
      },
    )
    return {
      text: res.choices[0]?.message.content ?? '',
      stats: speedStats(req.model),
      usage: null,
      finishReason: 'stop',
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

const MODEL = 'meta-llama/llama-3.3-70b-instruct'
const TRANSCRIPT = [
  line('them', 2, 'Thanks for joining. What does the enterprise plan cost per seat?'),
  line('me', 9, 'Good question, let me pull that up.'),
  line('them', 15, 'We currently track everything in spreadsheets, which takes hours every week.'),
  line('them', 30, 'Could you walk me through how the onboarding works?'),
]

/** A distinctive fragment of each canned mock answer. */
const EXPECTED: Record<Exclude<PromptKind, 'summary'>, string> = {
  say: 'Great question. The enterprise plan',
  auto: 'Great question. The enterprise plan',
  ask: 'Great question. The enterprise plan',
  assist: 'Great question. The enterprise plan',
  meeting_chat: 'Great question. The enterprise plan',
  search_ask: 'Great question. The enterprise plan',
  followups: '1. Which manual process',
  factcheck: '✅',
  recap: 'Discussed enterprise pricing per seat',
  who: 'Inferred from the conversation only',
}

let mock: MockOpenRouter
let http: OpenRouterHttp
let llm: HttpLLM

beforeAll(async () => {
  mock = await startMockOpenRouter({ ttftMs: 0, tokenMs: 0 })
  http = new OpenRouterHttp({
    baseUrl: mock.baseUrl,
    getKey: () => 'sk-or-test-1234567890',
    log: createLogger(null),
  })
  llm = new HttpLLM(http)
})

afterAll(async () => {
  await http.close()
  await mock.close()
})

describe('prompts against the dev mock server', () => {
  it('route every live action to its canned answer in every built-in mode', async () => {
    for (const mode of BUILTIN_MODES) {
      for (const [kind, expected] of Object.entries(EXPECTED)) {
        const ctx = buildContext({
          kind: kind as PromptKind,
          mode,
          profile: { ...EMPTY_PROFILE, name: 'Alex', role: 'Account executive' },
          answerLanguage: 'conversation',
          transcript: TRANSCRIPT,
          nowMs: 40_000,
          question: 'How long does onboarding take?',
          trigger: { text: 'Could you walk me through how the onboarding works?' },
          notesMarkdown: '## Summary\nPricing call.',
          excerpts: [{ title: 'Pricing call', startedAt: Date.now(), text: 'Per-seat pricing.' }],
        })
        const res = await llm.complete({ model: MODEL, messages: ctx.messages })
        expect(res.text, `${mode.id} / ${kind}`).toContain(expected)
      }
    }
  })

  it('routes Assist with a screenshot to the screen answer', async () => {
    const ctx = buildContext({
      kind: 'assist',
      mode: GENERAL,
      profile: EMPTY_PROFILE,
      answerLanguage: 'en',
      transcript: TRANSCRIPT,
      nowMs: 40_000,
      screenshot: { dataUrl: 'data:image/jpeg;base64,/9j/AAAA' },
    })
    const res = await llm.complete({ model: MODEL, messages: ctx.messages })
    expect(res.text).toContain('I can see your screen')
  })

  it('routes the running summary to the summary answer', async () => {
    let summary: string | null = null
    const summarizer = new RunningSummarizer({
      llm,
      getModel: () => ({ model: MODEL }),
      intervalMs: 0,
      windowMs: 10_000,
      log: createLogger(null),
      onUpdate: (s) => {
        summary = s
      },
    })
    summarizer.maybeUpdate(TRANSCRIPT, 60_000)
    await summarizer.whenIdle()
    expect(summary).toContain('Earlier: introductions')
  })

  it('routes the three post-call prompts to notes, action items and email', async () => {
    for (const mode of BUILTIN_MODES) {
      const res = await generatePostCall(
        { llm },
        {
          model: 'anthropic/claude-sonnet-4.5',
          transcriptText: formatTranscript(TRANSCRIPT),
          mode,
          profile: { ...EMPTY_PROFILE, name: 'Alex' },
          answerLanguage: 'conversation',
        },
      )
      expect(res.errors, mode.id).toEqual([])
      expect(res.notes?.title).toBe('Enterprise plan pricing discussion')
      expect(res.notes?.keyPoints).toHaveLength(3)
      expect(res.actionItems).toEqual([
        { text: 'Send the enterprise pricing sheet', owner: 'Me', due: 'Friday' },
        { text: 'Schedule onboarding walkthrough with the ops team', owner: 'Them', due: null },
      ])
      expect(res.email?.subject).toBe('Great speaking today: next steps')
    }
  })
})
