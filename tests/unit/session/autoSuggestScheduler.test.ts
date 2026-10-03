import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoSuggestScheduler, type AutoTrigger } from '@main/session/autoSuggestScheduler'
import type { TranscriptLine } from '@shared/types'

let seq = 0
function them(text: string, startMs = 0, isFinal = true): TranscriptLine {
  return {
    id: `t${++seq}`,
    sessionId: 's1',
    channel: 'them',
    startMs,
    endMs: startMs + 1000,
    text,
    isFinal,
  }
}

interface Deferred {
  resolve: () => void
  reject: (err: unknown) => void
  signal: AbortSignal
  trigger: AutoTrigger
}

function setup(opts: { enabled?: boolean; debounceMs?: number; cooldownMs?: number } = {}) {
  let enabled = opts.enabled ?? true
  const runs: Deferred[] = []
  const skips: string[] = []
  const errors: unknown[] = []
  const run = vi.fn(
    (trigger: AutoTrigger, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => runs.push({ resolve, reject, signal, trigger })),
  )
  const scheduler = new AutoSuggestScheduler({
    debounceMs: opts.debounceMs,
    cooldownMs: opts.cooldownMs,
    isEnabled: () => enabled,
    run,
    onSkip: (reason) => skips.push(reason),
    onError: (err) => errors.push(err),
  })
  return {
    scheduler,
    run,
    runs,
    skips,
    errors,
    setEnabled: (v: boolean) => {
      enabled = v
    },
  }
}

/** Lets promise callbacks (finally) run under fake timers. */
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('AutoSuggestScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs after the debounce when the other person asks a question', () => {
    const { scheduler, run } = setup()
    const line = them('How would you approach it?')
    expect(scheduler.onThemLine(line, { vadEndAt: 123 })).toBe('pending')
    expect(scheduler.state().pending).toBe(true)
    vi.advanceTimersByTime(699)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    const trigger = run.mock.calls[0]?.[0]
    expect(trigger).toEqual({
      lineIds: [line.id],
      text: 'How would you approach it?',
      vadEndAt: 123,
      detectedAt: new Date('2026-01-01T10:00:00Z').getTime(),
    })
    expect(scheduler.state()).toMatchObject({ pending: false, inFlight: true })
  })

  it('ignores statements, partial lines and empty text', () => {
    const { scheduler, run } = setup()
    expect(scheduler.onThemLine(them('We shipped it last week.'), { vadEndAt: null })).toBe(
      'ignored',
    )
    expect(scheduler.onThemLine(them('How would you', 0, false), { vadEndAt: null })).toBe(
      'ignored',
    )
    expect(scheduler.onThemLine(them('   '), { vadEndAt: null })).toBe('ignored')
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
    expect(scheduler.state().pending).toBe(false)
  })

  it('merges continuation lines and restarts the debounce', () => {
    const { scheduler, run } = setup()
    const a = them('How would you approach the migration?')
    const b = them('Given that we only have two engineers.')
    const c = them('And the deadline is in March.')
    scheduler.onThemLine(a, { vadEndAt: 100 })
    vi.advanceTimersByTime(600)
    // Not a question on its own, but it continues the pending one.
    expect(scheduler.onThemLine(b, { vadEndAt: 200 })).toBe('merged')
    vi.advanceTimersByTime(600)
    expect(scheduler.onThemLine(c, { vadEndAt: null })).toBe('merged')
    // Re-delivery of a merged line is ignored.
    expect(scheduler.onThemLine(c, { vadEndAt: 999 })).toBe('ignored')
    vi.advanceTimersByTime(699)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      lineIds: [a.id, b.id, c.id],
      text: 'How would you approach the migration? Given that we only have two engineers. And the deadline is in March.',
      // The latest known VAD end (c had none).
      vadEndAt: 200,
    })
  })

  it('cancels the pending trigger when I start talking', () => {
    const { scheduler, run } = setup()
    scheduler.onThemLine(them('What do you think?', 10_000), { vadEndAt: null })
    vi.advanceTimersByTime(300)
    scheduler.onMeLine()
    expect(scheduler.state().pending).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores Me speech that ended before the question started', () => {
    const { scheduler, run } = setup()
    scheduler.onThemLine(them('What do you think?', 10_000), { vadEndAt: null })
    // A Me line finalized late by speech-to-text but spoken before the question.
    scheduler.onMeLine({ startMs: 8_000, endMs: 9_500 })
    expect(scheduler.state().pending).toBe(true)
    // Speech overlapping or after the question cancels.
    scheduler.onMeLine({ startMs: 9_800, endMs: 10_400 })
    expect(scheduler.state().pending).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(run).not.toHaveBeenCalled()
  })

  it('cancels the pending trigger and aborts the in-flight run on a manual request', async () => {
    const { scheduler, run, runs } = setup()
    scheduler.onThemLine(them('Can you walk me through it?'), { vadEndAt: null })
    scheduler.notifyManualRequest()
    vi.advanceTimersByTime(2000)
    expect(run).not.toHaveBeenCalled()

    scheduler.onThemLine(them('What is your timeline?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(1)
    const inflight = runs[0] as Deferred
    expect(inflight.signal.aborted).toBe(false)
    scheduler.notifyManualRequest()
    expect(inflight.signal.aborted).toBe(true)
    inflight.reject(new DOMException('aborted', 'AbortError'))
    await flush()
    expect(scheduler.state().inFlight).toBe(false)
  })

  it('enforces the cooldown from the start of the last auto run', async () => {
    const { scheduler, run, runs, skips } = setup({ cooldownMs: 8000 })
    scheduler.onThemLine(them('First question?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(1)
    const startedAt = Date.now()
    vi.advanceTimersByTime(1000)
    ;(runs[0] as Deferred).resolve()
    await flush()
    expect(scheduler.state()).toMatchObject({ inFlight: false, lastRunAt: startedAt })
    expect(scheduler.state().cooldownRemainingMs).toBe(7000)

    // Debounce ends 1.7 s after the first run started → skipped.
    scheduler.onThemLine(them('Second question?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(1)
    expect(skips).toEqual(['cooldown'])

    // 8 s after the first run started, a new question runs again.
    vi.setSystemTime(startedAt + 8000 - 700)
    scheduler.onThemLine(them('Third question?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(2)
    expect(scheduler.state().cooldownRemainingMs).toBe(8000)
  })

  it('never has more than one auto run in flight', async () => {
    const { scheduler, run, runs, skips } = setup({ cooldownMs: 0 })
    scheduler.onThemLine(them('First question?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.onThemLine(them('Second question?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(1)
    expect(skips).toEqual(['in-flight'])
    ;(runs[0] as Deferred).resolve()
    await flush()
    scheduler.onThemLine(them('Third question?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does nothing while disabled, and checks again when the timer fires', () => {
    const { scheduler, run, skips, setEnabled } = setup({ enabled: false })
    expect(scheduler.onThemLine(them('What do you think?'), { vadEndAt: null })).toBe('ignored')
    vi.advanceTimersByTime(1000)
    expect(run).not.toHaveBeenCalled()

    setEnabled(true)
    scheduler.onThemLine(them('What do you think?'), { vadEndAt: null })
    setEnabled(false)
    vi.advanceTimersByTime(700)
    expect(run).not.toHaveBeenCalled()
    expect(skips).toEqual(['disabled'])
  })

  it('reports errors from run() and clears the in-flight flag', async () => {
    const errors: unknown[] = []
    const scheduler = new AutoSuggestScheduler({
      isEnabled: () => true,
      cooldownMs: 0,
      run: () => {
        throw new Error('boom')
      },
      onError: (err) => errors.push(err),
    })
    scheduler.onThemLine(them('Why?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    await flush()
    expect(errors).toHaveLength(1)
    expect(scheduler.state().inFlight).toBe(false)

    const rejecting = new AutoSuggestScheduler({
      isEnabled: () => true,
      run: () => Promise.reject(new Error('network')),
    })
    rejecting.onThemLine(them('Why?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    await flush()
    expect(rejecting.state().inFlight).toBe(false)
  })

  it('applies setConfig to later triggers', () => {
    const { scheduler, run } = setup()
    scheduler.setConfig({ debounceMs: 200, cooldownMs: 1000 })
    scheduler.onThemLine(them('Is that okay?'), { vadEndAt: null })
    vi.advanceTimersByTime(200)
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.state().cooldownRemainingMs).toBe(1000)
  })

  it('passes the language hint and uses an injected detector', () => {
    const detect = vi.fn(() => ({ isQuestion: true, confidence: 0.9, reason: 'test' }))
    const run = vi.fn(async () => undefined)
    const scheduler = new AutoSuggestScheduler({
      isEnabled: () => true,
      detect,
      language: () => 'bn',
      run,
    })
    scheduler.onThemLine(them('anything'), { vadEndAt: null })
    expect(detect).toHaveBeenCalledWith('anything', { language: 'bn' })
    vi.advanceTimersByTime(700)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses injected clock and timers', () => {
    let now = 1_000
    const queue: { fn: () => void; ms: number; cleared: boolean }[] = []
    const run = vi.fn(async () => undefined)
    const scheduler = new AutoSuggestScheduler({
      isEnabled: () => true,
      run,
      now: () => now,
      timers: {
        setTimeout: (fn, ms) => {
          const h = { fn, ms, cleared: false }
          queue.push(h)
          return h
        },
        clearTimeout: (h) => {
          ;(h as { cleared: boolean }).cleared = true
        },
      },
    })
    scheduler.onThemLine(them('Where are you based?'), { vadEndAt: null })
    scheduler.onThemLine(them('Remote or office?'), { vadEndAt: null })
    expect(queue).toHaveLength(2)
    expect(queue[0]?.cleared).toBe(true)
    expect(queue[1]?.ms).toBe(700)
    now = 5_000
    queue[1]?.fn()
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.state().lastRunAt).toBe(5_000)
  })

  it('dispose() stops everything', () => {
    const { scheduler, run, runs } = setup()
    scheduler.onThemLine(them('First?'), { vadEndAt: null })
    vi.advanceTimersByTime(700)
    scheduler.onThemLine(them('Second?'), { vadEndAt: null })
    scheduler.dispose()
    expect((runs[0] as Deferred).signal.aborted).toBe(true)
    expect(scheduler.state().pending).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(scheduler.onThemLine(them('Third?'), { vadEndAt: null })).toBe('ignored')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('AutoSuggestScheduler: VAD-anchored debounce and speaking hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
  })
  afterEach(() => vi.useRealTimers())

  function anchored() {
    const runs: AutoTrigger[] = []
    const scheduler = new AutoSuggestScheduler({
      debounceMs: 700,
      cooldownMs: 0,
      anchorToVadEnd: true,
      isEnabled: () => true,
      run: async (t) => {
        runs.push(t)
      },
    })
    return { scheduler, runs }
  }

  it('counts the debounce from the end of speech, not from transcription', () => {
    const { scheduler, runs } = anchored()
    // Speech ended 500 ms ago (VAD pause + speech-to-text time); 200 ms of debounce remain.
    scheduler.onThemLine(them('How much does it cost?'), { vadEndAt: Date.now() - 500 })
    vi.advanceTimersByTime(199)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(runs).toHaveLength(1)
  })

  it('fires right away when the speaker has already been silent for the whole debounce', () => {
    const { scheduler, runs } = anchored()
    scheduler.onThemLine(them('Can you send the deck?'), { vadEndAt: Date.now() - 900 })
    vi.advanceTimersByTime(0)
    expect(runs).toHaveLength(1)
  })

  it('holds while they keep talking, merges the continuation, then waits a full debounce', () => {
    const { scheduler, runs } = anchored()
    scheduler.onThemLine(them('How would you approach it?'), { vadEndAt: Date.now() - 600 })
    scheduler.setThemSpeaking(true)
    vi.advanceTimersByTime(5_000)
    expect(runs).toHaveLength(0)
    scheduler.onThemLine(them('given our budget'), { vadEndAt: Date.now() })
    expect(runs).toHaveLength(0)
    scheduler.setThemSpeaking(false)
    vi.advanceTimersByTime(699)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.text).toBe('How would you approach it? given our budget')
  })

  it('waits for a continuation that is still being transcribed, then answers the whole question', () => {
    const { scheduler, runs } = anchored()
    const t0 = Date.now()
    // "What's your budget?" ends at t0; they go on at +300 ms; its line arrives at +1000 ms.
    vi.advanceTimersByTime(300)
    scheduler.setThemSpeaking(true)
    vi.advanceTimersByTime(700)
    const question = them('What is your budget?')
    expect(scheduler.onThemLine(question, { vadEndAt: t0 })).toBe('pending')
    // They stop at +2500 ms; that segment goes to speech-to-text (≈1 s).
    vi.advanceTimersByTime(1500)
    const continuation = them('for the Q3 rollout, including training?')
    scheduler.setThemSpeaking(false)
    scheduler.onThemSegment(continuation.id, t0 + 2500)
    // The plain debounce would have fired at +3200 ms with only the first fragment.
    vi.advanceTimersByTime(999)
    expect(runs).toHaveLength(0)
    expect(scheduler.onThemLine(continuation, { vadEndAt: t0 + 2500 })).toBe('merged')
    // They have been silent for 1 s already: no further debounce.
    vi.advanceTimersByTime(0)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.text).toBe('What is your budget? for the Q3 rollout, including training?')
    expect(runs[0]?.lineIds).toEqual([question.id, continuation.id])
  })

  it('stops waiting for the continuation after continuationWaitMs', () => {
    const { scheduler, runs } = anchored()
    const t0 = Date.now()
    scheduler.onThemLine(them('Where are you based?'), { vadEndAt: t0 - 1000 })
    scheduler.onThemSegment('slow-segment', t0 - 200)
    // Waits up to 2 s after that segment ended…
    vi.advanceTimersByTime(1799)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    // …then answers with what it has.
    expect(runs).toHaveLength(1)
    expect(runs[0]?.text).toBe('Where are you based?')
  })

  it('a continuation segment that produced no line counts as their last speech', () => {
    const { scheduler, runs } = anchored()
    const t0 = Date.now()
    scheduler.onThemLine(them('Can you share the deck?'), { vadEndAt: t0 - 900 })
    scheduler.onThemSegment('cough', t0)
    vi.advanceTimersByTime(100)
    scheduler.onThemSegmentDone('cough') // dropped as silence
    vi.advanceTimersByTime(599)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(runs).toHaveLength(1)
  })

  it('does not wait for segments that ended before the question', () => {
    const { scheduler, runs } = anchored()
    const t0 = Date.now()
    scheduler.onThemSegment('older', t0 - 5000)
    scheduler.onThemLine(them('Does Tuesday work?'), { vadEndAt: t0 - 900 })
    vi.advanceTimersByTime(0)
    expect(runs).toHaveLength(1)
  })

  it('does not merge a line from before the question that was transcribed late', () => {
    const { scheduler, runs } = anchored()
    scheduler.onThemLine(them('Does Tuesday work?', 10_000), { vadEndAt: Date.now() - 900 })
    expect(scheduler.onThemLine(them('Earlier statement.', 4_000), { vadEndAt: null })).toBe(
      'ignored',
    )
    vi.advanceTimersByTime(0)
    expect(runs[0]?.text).toBe('Does Tuesday work?')
  })

  it('without the option keeps the classic debounce from now', () => {
    const runs: AutoTrigger[] = []
    const scheduler = new AutoSuggestScheduler({
      debounceMs: 700,
      isEnabled: () => true,
      run: async (t) => {
        runs.push(t)
      },
    })
    scheduler.onThemLine(them('What is the timeline?'), { vadEndAt: Date.now() - 900 })
    vi.advanceTimersByTime(699)
    expect(runs).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(runs).toHaveLength(1)
  })
})
