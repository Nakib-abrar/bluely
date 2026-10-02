import { describe, expect, it } from 'vitest'
import type { AiCard, SpeedStats } from '@shared/types'
import {
  emptyAiState,
  MAX_CARDS,
  pendingCard,
  reduceAi,
  type AiEvent,
  type AiState,
} from '@renderer/main/lib/aiReducer'

const stats: SpeedStats = {
  ttftMs: 400,
  totalMs: 1900,
  tokensPerSec: 180,
  tokensIn: 100,
  tokensOut: 50,
  costUsd: null,
  provider: 'groq',
  model: 'meta-llama/llama-3.3-70b-instruct',
  generationId: null,
}

function card(id: string, patch: Partial<AiCard> = {}): AiCard {
  return { ...pendingCard(id, 'search', 'q?', null), createdAt: 1, ...patch }
}

function run(events: AiEvent[], state: AiState = emptyAiState): AiState {
  return events.reduce(reduceAi, state)
}

describe('reduceAi', () => {
  it('streams deltas into the card and finishes with done', () => {
    const s = run([
      { type: 'card', card: card('x') },
      { type: 'delta', id: 'x', delta: 'Hel' },
      { type: 'delta', id: 'x', delta: 'lo' },
    ])
    expect(s.cards['x']?.text).toBe('Hello')
    expect(s.cards['x']?.status).toBe('streaming')
    const done = reduceAi(s, { type: 'done', id: 'x', text: 'Hello!', stats })
    expect(done.cards['x']).toMatchObject({ status: 'done', text: 'Hello!', stats })
  })

  it('buffers events that arrive before their card and replays them', () => {
    const s = run([
      { type: 'delta', id: 'x', delta: 'Hi ' },
      { type: 'delta', id: 'x', delta: 'there' },
    ])
    expect(s.cards['x']).toBeUndefined()
    const after = reduceAi(s, { type: 'card', card: card('x') })
    expect(after.cards['x']?.text).toBe('Hi there')
    expect(after.pending['x']).toBeUndefined()
  })

  it('keeps streamed text when a stale streaming snapshot is re-sent', () => {
    const s = run([
      { type: 'card', card: card('x') },
      { type: 'delta', id: 'x', delta: 'abc' },
      { type: 'card', card: card('x', { text: 'a' }) },
    ])
    expect(s.cards['x']?.text).toBe('abc')
  })

  it('does not reopen a finished card on a late streaming snapshot or delta', () => {
    const s = run([
      { type: 'card', card: card('x') },
      { type: 'done', id: 'x', text: 'final', stats },
      { type: 'delta', id: 'x', delta: ' late' },
      { type: 'card', card: card('x', { text: '' }) },
    ])
    expect(s.cards['x']).toMatchObject({ status: 'done', text: 'final', stats })
  })

  it('records errors, cancellation and refined stats', () => {
    const err = { code: 'credits' as const, message: 'Out of credits', retryable: false }
    expect(
      run([
        { type: 'card', card: card('x') },
        { type: 'error', id: 'x', error: err },
      ]).cards['x'],
    ).toMatchObject({ status: 'error', error: err })
    expect(
      run([
        { type: 'card', card: card('x') },
        { type: 'cancelled', id: 'x' },
      ]).cards['x']?.status,
    ).toBe('cancelled')
    const refined = { ...stats, costUsd: 0.001 }
    expect(
      run([
        { type: 'card', card: card('x') },
        { type: 'done', id: 'x', text: 't', stats },
        { type: 'stats', id: 'x', stats: refined },
      ]).cards['x']?.stats,
    ).toEqual(refined)
  })

  it('caps the number of kept cards', () => {
    const events: AiEvent[] = []
    for (let i = 0; i < MAX_CARDS + 5; i++) events.push({ type: 'card', card: card(`c${i}`) })
    const s = run(events)
    expect(s.order).toHaveLength(MAX_CARDS)
    expect(s.cards['c0']).toBeUndefined()
    expect(s.cards[`c${MAX_CARDS + 4}`]).toBeDefined()
  })
})
