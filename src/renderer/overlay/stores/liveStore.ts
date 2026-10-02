import { create } from 'zustand'
import { DEFAULT_MODE_ID } from '@shared/builtinModes'
import type {
  AiCard,
  AiErrorInfo,
  LatencyTrace,
  LiveSessionState,
  SpeedStats,
  TranscriptLine,
} from '@shared/types'
import { nextFrame, type FrameScheduler } from '../lib/frame'

/** How many dev latency traces the overlay keeps. */
export const MAX_TRACES = 10

export const IDLE_STATE: LiveSessionState = {
  status: 'idle',
  sessionId: null,
  startedAt: null,
  modeId: DEFAULT_MODE_ID,
  audio: { me: { state: 'off', error: null }, them: { state: 'off', error: null } },
  warnings: [],
  autoSuggest: true,
  showConsentReminder: false,
  lastError: null,
}

export interface LiveStore {
  state: LiveSessionState
  /** Session the transcript and cards belong to (survives the session going idle). */
  sessionId: string | null
  /** Sorted by startMs. */
  lines: TranscriptLine[]
  /** Live-scope answer cards, oldest first (newest renders at the bottom). */
  cards: AiCard[]
  /** Newest last, at most MAX_TRACES. */
  traces: LatencyTrace[]

  setState(state: LiveSessionState): void
  mergeTranscript(sessionId: string, lines: TranscriptLine[]): void
  upsertLine(line: TranscriptLine): void
  removeLine(id: string, sessionId: string): void
  mergeCards(cards: AiCard[]): void
  upsertCard(card: AiCard): void
  /** Buffers streamed text; applied in one batch per animation frame. */
  appendDelta(id: string, delta: string): void
  finishCard(id: string, text: string, stats: SpeedStats): void
  failCard(id: string, error: AiErrorInfo): void
  cancelCard(id: string): void
  setStats(id: string, stats: SpeedStats): void
  removeCard(id: string): void
  clearCards(): void
  addTrace(trace: LatencyTrace): void
  /** Applies buffered deltas now (also called by the frame scheduler). */
  flushDeltas(): void
}

/** Inserts or replaces `item` (by id) keeping `list` sorted by `key`. Returns a new array. */
function upsertSorted<T extends { id: string }>(list: T[], item: T, key: (v: T) => number): T[] {
  const idx = list.findIndex((v) => v.id === item.id)
  const next = idx >= 0 ? list.filter((_, i) => i !== idx) : list.slice()
  // New items almost always belong at the end; walk backwards from there.
  let at = next.length
  while (at > 0 && key(next[at - 1] as T) > key(item)) at--
  next.splice(at, 0, item)
  return next
}

function patchCard(cards: AiCard[], id: string, patch: (c: AiCard) => AiCard): AiCard[] {
  const idx = cards.findIndex((c) => c.id === id)
  if (idx < 0) return cards
  const next = cards.slice()
  next[idx] = patch(cards[idx] as AiCard)
  return next
}

const lineKey = (l: TranscriptLine) => l.startMs
const cardKey = (c: AiCard) => c.createdAt

/**
 * Creates the live-session store. The scheduler is injectable so unit tests can flush
 * streamed deltas deterministically.
 */
export function createLiveStore(schedule: FrameScheduler = nextFrame) {
  /** Streamed text not yet applied to the cards, by card id. */
  const pending = new Map<string, string>()
  let scheduled = false

  return create<LiveStore>((set, get) => {
    /** Adopts a new session: transcript and cards from the previous one are dropped. */
    const adopt = (sessionId: string) => {
      if (get().sessionId === sessionId) return
      pending.clear()
      set({ sessionId, lines: [], cards: [] })
    }
    /** Live cards belong to the current session (or to none when main does not say). */
    const belongs = (sessionId: string | null) => {
      const current = get().sessionId
      return sessionId == null || current == null || sessionId === current
    }

    return {
      state: IDLE_STATE,
      sessionId: null,
      lines: [],
      cards: [],
      traces: [],

      setState(state) {
        if (state.sessionId) adopt(state.sessionId)
        set({ state })
      },

      mergeTranscript(sessionId, lines) {
        if (get().sessionId !== sessionId) adopt(sessionId)
        // Lines that arrived as events while the request was in flight are newer; keep them.
        const known = new Set(get().lines.map((l) => l.id))
        let next = get().lines
        for (const line of lines) {
          if (!known.has(line.id) && line.sessionId === sessionId) {
            next = upsertSorted(next, line, lineKey)
          }
        }
        set({ lines: next })
      },

      upsertLine(line) {
        if (!get().sessionId) adopt(line.sessionId)
        if (line.sessionId !== get().sessionId) return
        set({ lines: upsertSorted(get().lines, line, lineKey) })
      },

      removeLine(id, sessionId) {
        if (sessionId !== get().sessionId) return
        set({ lines: get().lines.filter((l) => l.id !== id) })
      },

      mergeCards(cards) {
        const known = new Set(get().cards.map((c) => c.id))
        let next = get().cards
        for (const card of cards) {
          if (card.scope === 'live' && !known.has(card.id) && belongs(card.sessionId)) {
            next = upsertSorted(next, card, cardKey)
          }
        }
        set({ cards: next })
      },

      upsertCard(card) {
        if (card.scope !== 'live' || !belongs(card.sessionId)) return
        // The card event is authoritative for text up to the moment main sent it, which
        // includes any deltas received before it.
        pending.delete(card.id)
        set({ cards: upsertSorted(get().cards, card, cardKey) })
      },

      appendDelta(id, delta) {
        if (!delta) return
        pending.set(id, (pending.get(id) ?? '') + delta)
        if (scheduled) return
        scheduled = true
        schedule(() => {
          scheduled = false
          get().flushDeltas()
        })
      },

      flushDeltas() {
        if (pending.size === 0) return
        const cards = get().cards
        let changed = false
        const next = cards.map((c) => {
          const add = pending.get(c.id)
          if (add == null) return c
          pending.delete(c.id)
          changed = true
          return { ...c, text: c.text + add }
        })
        // Deltas for cards this window never saw (other scopes) are dropped.
        pending.clear()
        if (changed) set({ cards: next })
      },

      finishCard(id, text, stats) {
        pending.delete(id)
        set({
          cards: patchCard(get().cards, id, (c) => ({ ...c, text, stats, status: 'done' })),
        })
      },

      failCard(id, error) {
        get().flushDeltas()
        set({
          cards: patchCard(get().cards, id, (c) => ({ ...c, error, status: 'error' })),
        })
      },

      cancelCard(id) {
        get().flushDeltas()
        set({ cards: patchCard(get().cards, id, (c) => ({ ...c, status: 'cancelled' })) })
      },

      setStats(id, stats) {
        set({ cards: patchCard(get().cards, id, (c) => ({ ...c, stats })) })
      },

      removeCard(id) {
        pending.delete(id)
        set({ cards: get().cards.filter((c) => c.id !== id) })
      },

      clearCards() {
        pending.clear()
        set({ cards: [] })
      },

      addTrace(trace) {
        // Traces are re-sent as stages complete; keep the latest copy in its original slot.
        const traces = get().traces
        const idx = traces.findIndex((t) => t.id === trace.id)
        if (idx >= 0) {
          const next = traces.slice()
          next[idx] = trace
          set({ traces: next })
        } else {
          set({ traces: [...traces, trace].slice(-MAX_TRACES) })
        }
      },
    }
  })
}

/** The overlay's live-session store. */
export const useLive = createLiveStore()
