import { useMemo } from 'react'
import { create } from 'zustand'
import type { AiCard } from '@shared/types'
import { on } from '../../lib/ipc'
import { emptyAiState, reduceAi, type AiEvent, type AiState } from '../lib/aiReducer'

interface AiStore extends AiState {
  dispatch(ev: AiEvent): void
  /** Seeds cards loaded from history ('ai:getCards'). */
  seed(cards: AiCard[]): void
}

const useAiStore = create<AiStore>((set, get) => ({
  ...emptyAiState,
  dispatch(ev) {
    const { cards, order, pending } = get()
    const next = reduceAi({ cards, order, pending }, ev)
    if (next.cards !== cards || next.pending !== pending || next.order !== order) set(next)
  },
  seed(list) {
    for (const card of list) get().dispatch({ type: 'card', card })
  },
}))

let subscribed = false

/**
 * Subscribes the main window to ai:* events once. Every answer streamed to this window is
 * folded into one card map by id, so components only need the id the invoke returned.
 */
export function initAiStream(): void {
  if (subscribed) return
  subscribed = true
  const dispatch = (ev: AiEvent) => useAiStore.getState().dispatch(ev)
  on('ai:card', (card) => {
    // Live overlay cards are not shown in the main window.
    if (card.scope !== 'live') dispatch({ type: 'card', card })
  })
  on('ai:delta', (p) => dispatch({ type: 'delta', id: p.id, delta: p.delta }))
  on('ai:done', (p) => dispatch({ type: 'done', id: p.id, text: p.text, stats: p.stats }))
  on('ai:error', (p) => dispatch({ type: 'error', id: p.id, error: p.error }))
  on('ai:cancelled', (p) => dispatch({ type: 'cancelled', id: p.id }))
  on('ai:stats', (p) => dispatch({ type: 'stats', id: p.id, stats: p.stats }))
}

/** The streamed card for one id (null until main sends it). */
export function useAiStream(id: string | null): AiCard | null {
  return useAiStore((s) => (id ? (s.cards[id] ?? null) : null))
}

/** Meeting-chat cards of one session, oldest first. */
export function useMeetingChatCards(sessionId: string): AiCard[] {
  const cards = useAiStore((s) => s.cards)
  return useMemo(
    () =>
      Object.values(cards)
        .filter((c) => c.scope === 'meeting_chat' && c.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt),
    [cards, sessionId],
  )
}

export function seedAiCards(cards: AiCard[]): void {
  useAiStore.getState().seed(cards)
}

/** Marks a card as failed locally (e.g. the invoke that should create it was rejected). */
export function failAiCard(card: AiCard, message: string): void {
  const st = useAiStore.getState()
  st.dispatch({ type: 'card', card })
  st.dispatch({
    type: 'error',
    id: card.id,
    error: { code: 'unknown', message, retryable: true },
  })
}
