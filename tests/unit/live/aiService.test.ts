import { describe, expect, it } from 'vitest'
import type { AiCard } from '@shared/types'
import { AiService } from '@main/live/aiService'
import { ProviderError } from '@main/providers/errors'
import { createHarness } from './harness'

function setup() {
  const h = createHarness()
  const ai = new AiService(h.ctx, h.models, h.modes, h.history)
  return { ...h, ai }
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
})
