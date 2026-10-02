import type { AiCard, AiErrorInfo, SpeedStats } from '@shared/types'

/** The ai:* events, normalized into one union the reducer understands. */
export type AiEvent =
  | { type: 'card'; card: AiCard }
  | { type: 'delta'; id: string; delta: string }
  | { type: 'done'; id: string; text: string; stats: SpeedStats }
  | { type: 'error'; id: string; error: AiErrorInfo }
  | { type: 'cancelled'; id: string }
  | { type: 'stats'; id: string; stats: SpeedStats }

type PendingEvent = Exclude<AiEvent, { type: 'card' }>

export interface AiState {
  cards: Record<string, AiCard>
  /** Insertion order, oldest first (used to cap memory). */
  order: string[]
  /**
   * Events that arrived before their ai:card. Main may stream before the invoke that
   * created the card has even resolved, so nothing is dropped while the card is unknown.
   */
  pending: Record<string, PendingEvent[]>
}

export const MAX_CARDS = 300
const MAX_PENDING_IDS = 50

export const emptyAiState: AiState = { cards: {}, order: [], pending: {} }

function applyToCard(card: AiCard, ev: PendingEvent): AiCard {
  switch (ev.type) {
    case 'delta':
      // Deltas after a terminal state are late duplicates; ignore them.
      if (card.status !== 'streaming') return card
      return { ...card, text: card.text + ev.delta }
    case 'done':
      return { ...card, status: 'done', text: ev.text, stats: ev.stats, error: null }
    case 'error':
      return { ...card, status: 'error', error: ev.error }
    case 'cancelled':
      return { ...card, status: 'cancelled' }
    case 'stats':
      return { ...card, stats: ev.stats }
  }
}

/** Merges an incoming full card with what we already streamed for the same id. */
function upsertCard(existing: AiCard | undefined, incoming: AiCard): AiCard {
  if (!existing || incoming.status !== 'streaming') return incoming
  // A late streaming snapshot never reopens a finished card.
  if (existing.status !== 'streaming') {
    return {
      ...incoming,
      text: existing.text,
      status: existing.status,
      stats: existing.stats,
      error: existing.error,
    }
  }
  // A re-sent streaming snapshot must not wipe text we already received as deltas.
  if (existing.text.length > incoming.text.length && existing.text.startsWith(incoming.text)) {
    return { ...incoming, text: existing.text }
  }
  return incoming
}

function trim(state: AiState): AiState {
  if (state.order.length <= MAX_CARDS) return state
  const drop = state.order.slice(0, state.order.length - MAX_CARDS)
  const cards = { ...state.cards }
  for (const id of drop) delete cards[id]
  return { ...state, cards, order: state.order.slice(drop.length) }
}

/** Pure reducer: folds one ai:* event into the card map. */
export function reduceAi(state: AiState, ev: AiEvent): AiState {
  if (ev.type === 'card') {
    const id = ev.card.id
    let card = upsertCard(state.cards[id], ev.card)
    const queued = state.pending[id]
    let pending = state.pending
    if (queued) {
      for (const p of queued) card = applyToCard(card, p)
      pending = { ...state.pending }
      delete pending[id]
    }
    const isNew = !(id in state.cards)
    return trim({
      cards: { ...state.cards, [id]: card },
      order: isNew ? [...state.order, id] : state.order,
      pending,
    })
  }
  const existing = state.cards[ev.id]
  if (!existing) {
    const queued = state.pending[ev.id] ?? []
    const pending = { ...state.pending, [ev.id]: [...queued, ev] }
    const ids = Object.keys(pending)
    if (ids.length > MAX_PENDING_IDS) delete pending[ids[0] as string]
    return { ...state, pending }
  }
  const next = applyToCard(existing, ev)
  if (next === existing) return state
  return { ...state, cards: { ...state.cards, [ev.id]: next } }
}

/** Placeholder card shown between "asked" and the first ai:card from main. */
export function pendingCard(
  id: string,
  scope: AiCard['scope'],
  question: string,
  sessionId: string | null,
): AiCard {
  return {
    id,
    scope,
    sessionId,
    kind: scope === 'search' ? 'search_ask' : 'meeting_chat',
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
}
