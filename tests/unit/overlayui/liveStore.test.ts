import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiCard,
  LatencyTrace,
  SessionWarningCode,
  SpeedStats,
  TranscriptLine,
} from '@shared/types'
import {
  createLiveStore,
  IDLE_STATE,
  MAX_TRACES,
  WARNING_MIN_VISIBLE_MS,
} from '../../../src/renderer/overlay/stores/liveStore'

/** A scheduler the test flushes by hand (stands in for requestAnimationFrame). */
function manualScheduler() {
  const queue: (() => void)[] = []
  return {
    schedule: (cb: () => void) => {
      queue.push(cb)
    },
    runFrame: () => {
      for (const cb of queue.splice(0)) cb()
    },
    get pending() {
      return queue.length
    },
  }
}

function card(id: string, createdAt: number, patch: Partial<AiCard> = {}): AiCard {
  return {
    id,
    scope: 'live',
    sessionId: 's1',
    kind: 'assist',
    label: 'Assist',
    question: null,
    usedScreen: false,
    tier: 'smart',
    status: 'streaming',
    text: '',
    error: null,
    stats: null,
    citations: [],
    createdAt,
    ...patch,
  }
}

function line(id: string, startMs: number, patch: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    id,
    sessionId: 's1',
    channel: 'them',
    startMs,
    endMs: startMs + 1000,
    text: id,
    isFinal: true,
    ...patch,
  }
}

const stats: SpeedStats = {
  ttftMs: 300,
  totalMs: 1200,
  tokensPerSec: 120,
  tokensIn: 10,
  tokensOut: 20,
  costUsd: null,
  provider: 'groq',
  model: 'x/y',
  generationId: null,
}

function liveStore() {
  const sched = manualScheduler()
  const store = createLiveStore(sched.schedule)
  store.getState().setState({ ...IDLE_STATE, status: 'live', sessionId: 's1', startedAt: 1 })
  return { store, sched }
}

describe('liveStore: streamed deltas', () => {
  it('batches deltas into one update per frame', () => {
    const { store, sched } = liveStore()
    store.getState().upsertCard(card('a', 1))
    let updates = 0
    const unsub = store.subscribe(() => updates++)
    store.getState().appendDelta('a', 'Hel')
    store.getState().appendDelta('a', 'lo ')
    store.getState().appendDelta('a', 'there')
    expect(store.getState().cards[0]?.text).toBe('')
    expect(sched.pending).toBe(1)
    sched.runFrame()
    unsub()
    expect(store.getState().cards[0]?.text).toBe('Hello there')
    expect(updates).toBe(1)
  })

  it('done replaces text (dropping unflushed deltas) and sets stats', () => {
    const { store, sched } = liveStore()
    store.getState().upsertCard(card('a', 1))
    store.getState().appendDelta('a', 'partial')
    store.getState().finishCard('a', 'Final answer.', stats)
    sched.runFrame()
    const c = store.getState().cards[0]
    expect(c?.text).toBe('Final answer.')
    expect(c?.status).toBe('done')
    expect(c?.stats).toEqual(stats)
  })

  it('a replacing card event is authoritative over buffered deltas', () => {
    const { store, sched } = liveStore()
    store.getState().upsertCard(card('a', 1))
    store.getState().appendDelta('a', 'abc')
    store.getState().upsertCard(card('a', 1, { text: 'abc' }))
    sched.runFrame()
    expect(store.getState().cards[0]?.text).toBe('abc')
  })

  it('error and cancel keep streamed text and set the status', () => {
    const { store } = liveStore()
    store.getState().upsertCard(card('a', 1))
    store.getState().upsertCard(card('b', 2))
    store.getState().appendDelta('a', 'so far')
    store.getState().failCard('a', { code: 'server', message: 'boom', retryable: true })
    store.getState().cancelCard('b')
    const [a, b] = store.getState().cards
    expect(a).toMatchObject({ text: 'so far', status: 'error', error: { code: 'server' } })
    expect(b?.status).toBe('cancelled')
  })

  it('drops deltas for cards it never saw (other scopes)', () => {
    const { store, sched } = liveStore()
    store.getState().appendDelta('ghost', 'x')
    sched.runFrame()
    store.getState().upsertCard(card('ghost', 1))
    sched.runFrame()
    expect(store.getState().cards[0]?.text).toBe('')
  })

  it('refined stats update a finished card', () => {
    const { store } = liveStore()
    store.getState().upsertCard(card('a', 1, { status: 'done', text: 't', stats }))
    store.getState().setStats('a', { ...stats, costUsd: 0.001 })
    expect(store.getState().cards[0]?.stats?.costUsd).toBe(0.001)
  })
})

describe('liveStore: cards', () => {
  it('keeps cards ordered oldest first and replaces by id', () => {
    const { store } = liveStore()
    store.getState().upsertCard(card('b', 20))
    store.getState().upsertCard(card('a', 10))
    store.getState().upsertCard(card('c', 30))
    store.getState().upsertCard(card('b', 20, { text: 'updated' }))
    expect(store.getState().cards.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(store.getState().cards[1]?.text).toBe('updated')
  })

  it('ignores non-live scopes and other sessions', () => {
    const { store } = liveStore()
    store.getState().upsertCard(card('m', 1, { scope: 'meeting_chat' }))
    store.getState().upsertCard(card('o', 2, { sessionId: 'other' }))
    expect(store.getState().cards).toHaveLength(0)
  })

  it('merging fetched cards never overwrites newer event data', () => {
    const { store } = liveStore()
    store.getState().upsertCard(card('a', 1, { text: 'from event' }))
    store.getState().mergeCards([card('a', 1, { text: 'stale' }), card('z', 0, { text: 'old' })])
    expect(store.getState().cards.map((c) => [c.id, c.text])).toEqual([
      ['z', 'old'],
      ['a', 'from event'],
    ])
  })

  it('clear and remove', () => {
    const { store } = liveStore()
    store.getState().upsertCard(card('a', 1))
    store.getState().upsertCard(card('b', 2))
    store.getState().removeCard('a')
    expect(store.getState().cards.map((c) => c.id)).toEqual(['b'])
    store.getState().clearCards()
    expect(store.getState().cards).toEqual([])
  })
})

describe('liveStore: transcript and sessions', () => {
  it('upserts lines in time order; partial → final replaces in place', () => {
    const { store } = liveStore()
    store.getState().upsertLine(line('l2', 2000, { isFinal: false, text: 'hel' }))
    store.getState().upsertLine(line('l1', 1000))
    store.getState().upsertLine(line('l2', 2000, { isFinal: true, text: 'hello' }))
    expect(store.getState().lines.map((l) => [l.id, l.text, l.isFinal])).toEqual([
      ['l1', 'l1', true],
      ['l2', 'hello', true],
    ])
    store.getState().removeLine('l1', 's1')
    expect(store.getState().lines.map((l) => l.id)).toEqual(['l2'])
  })

  it('merges a fetched transcript without clobbering live events', () => {
    const { store } = liveStore()
    store.getState().upsertLine(line('l3', 3000, { text: 'live' }))
    store.getState().mergeTranscript('s1', [line('l1', 1000), line('l3', 3000, { text: 'old' })])
    expect(store.getState().lines.map((l) => [l.id, l.text])).toEqual([
      ['l1', 'l1'],
      ['l3', 'live'],
    ])
  })

  it('a new session starts with an empty transcript and no cards', () => {
    const { store } = liveStore()
    store.getState().upsertLine(line('l1', 1000))
    store.getState().upsertCard(card('a', 1))
    store.getState().setState({ ...IDLE_STATE, status: 'idle' })
    // Going idle keeps the last session visible…
    expect(store.getState().cards).toHaveLength(1)
    store.getState().setState({ ...IDLE_STATE, status: 'starting', sessionId: 's2' })
    // …a new session clears it.
    expect(store.getState().lines).toEqual([])
    expect(store.getState().cards).toEqual([])
    store.getState().upsertLine(line('x', 1, { sessionId: 's1' }))
    expect(store.getState().lines).toEqual([])
  })
})

describe('liveStore: latency traces', () => {
  const trace = (id: string, firstTokenAt: number | null = null): LatencyTrace => ({
    id,
    kind: 'auto',
    model: 'm',
    vadEndAt: 0,
    sttDoneAt: 1,
    promptBuiltAt: 2,
    requestSentAt: 3,
    firstTokenAt,
    doneAt: null,
    promptTokensEstimate: 100,
  })

  it('keeps the last MAX_TRACES and updates a trace in place', () => {
    const { store } = liveStore()
    for (let i = 0; i < MAX_TRACES + 3; i++) store.getState().addTrace(trace(`t${i}`))
    const ids = store.getState().traces.map((t) => t.id)
    expect(ids).toHaveLength(MAX_TRACES)
    expect(ids[0]).toBe('t3')
    store.getState().addTrace(trace('t5', 999))
    expect(store.getState().traces.find((t) => t.id === 't5')?.firstTokenAt).toBe(999)
    expect(store.getState().traces).toHaveLength(MAX_TRACES)
  })
})

describe('liveStore: flapping warnings', () => {
  const live = (store: ReturnType<typeof liveStore>['store'], warnings: SessionWarningCode[]) =>
    store.getState().setState({ ...IDLE_STATE, status: 'live', sessionId: 's1', warnings })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps "Transcription error (retrying)" up for a minimum time instead of flapping', () => {
    vi.useFakeTimers()
    const { store } = liveStore()
    live(store, ['stt_error_retrying', 'mic_muted'])
    expect(store.getState().shownWarnings).toEqual(['stt_error_retrying', 'mic_muted'])
    vi.advanceTimersByTime(1000)
    // The next segment succeeded: main clears it; a few seconds later it fails again.
    live(store, ['mic_muted'])
    expect(store.getState().shownWarnings).toEqual(['mic_muted', 'stt_error_retrying'])
    vi.advanceTimersByTime(2000)
    live(store, ['mic_muted', 'stt_error_retrying'])
    vi.advanceTimersByTime(1500)
    live(store, ['mic_muted'])
    expect(store.getState().shownWarnings).toContain('stt_error_retrying')
    // Once its minimum time is up it goes away by itself.
    vi.advanceTimersByTime(WARNING_MIN_VISIBLE_MS.stt_error_retrying ?? 0)
    expect(store.getState().shownWarnings).toEqual(['mic_muted'])
  })

  it('other warnings follow main immediately', () => {
    const { store } = liveStore()
    live(store, ['mic_muted'])
    live(store, [])
    expect(store.getState().shownWarnings).toEqual([])
  })
})

describe('liveStore: forget a deleted meeting', () => {
  it('drops the kept transcript and cards once the session is over', () => {
    const { store } = liveStore()
    store.getState().upsertLine(line('l1', 1))
    store.getState().upsertCard(card('a', 1))
    store.getState().forget('s1') // still live: kept
    expect(store.getState().lines).toHaveLength(1)
    store.getState().setState({ ...IDLE_STATE })
    store.getState().forget('other')
    expect(store.getState().cards).toHaveLength(1)
    store.getState().forget('s1')
    expect(store.getState()).toMatchObject({ sessionId: null, lines: [], cards: [] })
  })
})
