import { describe, expect, it, vi } from 'vitest'
import { RunningSummarizer, summaryMessages } from '@main/ai/runningSummary'
import { ProviderError } from '@main/providers/errors'
import type { SpeedStats, TranscriptLine } from '@shared/types'
import { FakeLLM, deferred, line, recordingLogger, systemText, userText } from './helpers'

const MIN = 60_000
const WINDOW = 6 * MIN
const INTERVAL = 3 * MIN

/** One Them/Me line every 30 s up to `untilSec` (exclusive). */
function linesUntil(untilSec: number): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (let s = 0; s < untilSec; s += 30) {
    out.push(line(s % 60 === 0 ? 'them' : 'me', s, `said at ${s}s`, { id: `l${s}` }))
  }
  return out
}

function setup(handler?: ConstructorParameters<typeof FakeLLM>[0]) {
  const clock = { t: 1_000_000 }
  const llm = new FakeLLM(handler ?? ((_req, i) => `Summary #${i + 1}`))
  const log = recordingLogger()
  const updates: { summary: string; stats: SpeedStats }[] = []
  const getModel = vi.fn(() => ({ model: 'fast/model', routing: { sort: 'latency' as const } }))
  const summarizer = new RunningSummarizer({
    llm,
    getModel,
    intervalMs: INTERVAL,
    windowMs: WINDOW,
    log,
    now: () => clock.t,
    onUpdate: (summary, stats) => updates.push({ summary, stats }),
  })
  return { clock, llm, log, updates, summarizer, getModel }
}

describe('RunningSummarizer', () => {
  it('does nothing while every line is still inside the window', async () => {
    const { llm, summarizer } = setup()
    summarizer.maybeUpdate(linesUntil(300), 300_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(0)
    expect(summarizer.current()).toBeNull()
    expect(summarizer.coveredUntilMs()).toBe(0)
  })

  it('summarizes lines that aged out of the window, in the background', async () => {
    const { llm, summarizer, updates } = setup()
    const lines = linesUntil(450)
    // At 7:30 the window starts at 1:30, so the lines at 0, 30 and 60 s have aged out.
    summarizer.maybeUpdate(lines, 450_000)
    expect(summarizer.isUpdating()).toBe(true)
    expect(llm.calls).toHaveLength(1)
    await summarizer.whenIdle()
    expect(summarizer.isUpdating()).toBe(false)

    const req = llm.calls[0]
    if (!req) throw new Error('no request')
    expect(req.model).toBe('fast/model')
    expect(req.routing).toEqual({ sort: 'latency' })
    expect(req.tag).toBe('summary')
    expect(systemText(req)).toContain('≤ 150 words')
    expect(systemText(req)).toMatch(/running summary/)
    const user = userText(req)
    expect(user).toContain('## Previous summary\n(none yet)')
    expect(user).toContain('[00:00] Them: said at 0s')
    expect(user).toContain('[01:00] Them: said at 60s')
    expect(user).not.toContain('said at 90s')

    expect(summarizer.current()).toBe('Summary #1')
    expect(summarizer.coveredUntilMs()).toBe(60_001)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.summary).toBe('Summary #1')
    expect(updates[0]?.stats.model).toBe('fast/model')
  })

  it('gives a reasoning Fast model room to think before writing the summary', async () => {
    const { llm, summarizer, getModel } = setup()
    getModel.mockReturnValue({ model: 'openai/gpt-oss-120b', routing: { sort: 'latency' } })
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    await summarizer.whenIdle()
    expect(llm.calls[0]?.reasoning).toEqual({ effort: 'low', exclude: true })
    expect(llm.calls[0]?.maxTokens).toBeGreaterThanOrEqual(800 + 1024)
    expect(summarizer.current()).toBe('Summary #1')
  })

  it('waits for the interval and only runs when new lines aged out', async () => {
    const { clock, llm, summarizer } = setup()
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(1)

    // Two minutes later: more lines aged out, but the interval has not passed.
    clock.t += 2 * MIN
    summarizer.maybeUpdate(linesUntil(570), 570_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(1)

    // Interval passed: summarize the previous summary plus only the newly aged lines.
    clock.t += 1 * MIN
    summarizer.maybeUpdate(linesUntil(630), 630_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(2)
    const user = userText(llm.calls[1] ?? { messages: [] })
    expect(user).toContain('## Previous summary\nSummary #1')
    expect(user).not.toContain('said at 60s')
    expect(user).toContain('said at 90s')
    expect(user).toContain('said at 240s')
    expect(user).not.toContain('said at 270s')
    expect(summarizer.current()).toBe('Summary #2')
    expect(summarizer.coveredUntilMs()).toBe(240_001)

    // Interval passed again but nothing new aged out: no request.
    clock.t += 5 * MIN
    summarizer.maybeUpdate(linesUntil(630), 630_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(2)
  })

  it('never overlaps requests', async () => {
    const pending = deferred<string>()
    const { clock, llm, summarizer } = setup(() => pending.promise)
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    expect(summarizer.isUpdating()).toBe(true)
    clock.t += 10 * MIN
    summarizer.maybeUpdate(linesUntil(900), 900_000)
    summarizer.maybeUpdate(linesUntil(900), 900_000)
    expect(llm.calls).toHaveLength(1)
    pending.resolve('First')
    await summarizer.whenIdle()
    expect(summarizer.current()).toBe('First')
    expect(summarizer.isUpdating()).toBe(false)
  })

  it('tolerates failures: keeps the previous summary and retries after the interval', async () => {
    let fail = true
    const { clock, llm, log, summarizer, updates } = setup((_req, i) => {
      if (fail) throw new ProviderError('server')
      return `Summary #${i + 1}`
    })
    expect(() => summarizer.maybeUpdate(linesUntil(450), 450_000)).not.toThrow()
    await summarizer.whenIdle()
    expect(summarizer.current()).toBeNull()
    expect(summarizer.coveredUntilMs()).toBe(0)
    expect(updates).toHaveLength(0)
    expect(log.warnings.some((w) => w.includes('update failed'))).toBe(true)

    // Retried only once the interval has passed, with the same (still unsummarized) lines.
    fail = false
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(1)
    clock.t += INTERVAL
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    await summarizer.whenIdle()
    expect(llm.calls).toHaveLength(2)
    expect(userText(llm.calls[1] ?? { messages: [] })).toContain('said at 0s')
    expect(summarizer.current()).toBe('Summary #2')
  })

  it('ignores empty responses and survives a throwing onUpdate or getModel', async () => {
    const { clock, summarizer, log } = setup(() => '   ')
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    await summarizer.whenIdle()
    expect(summarizer.current()).toBeNull()

    const log2 = recordingLogger()
    const throwing = new RunningSummarizer({
      llm: new FakeLLM(() => 'ok'),
      getModel: () => {
        throw new Error('no model')
      },
      intervalMs: INTERVAL,
      windowMs: WINDOW,
      log: log2,
      now: () => clock.t,
    })
    expect(() => throwing.maybeUpdate(linesUntil(450), 450_000)).not.toThrow()
    await throwing.whenIdle()
    expect(throwing.current()).toBeNull()

    const badCallback = new RunningSummarizer({
      llm: new FakeLLM(() => 'Fine'),
      getModel: () => ({ model: 'm' }),
      intervalMs: INTERVAL,
      windowMs: WINDOW,
      log,
      now: () => clock.t,
      onUpdate: () => {
        throw new Error('listener bug')
      },
    })
    badCallback.maybeUpdate(linesUntil(450), 450_000)
    await badCallback.whenIdle()
    expect(badCallback.current()).toBe('Fine')
    expect(log.warnings.some((w) => w.includes('onUpdate'))).toBe(true)
  })

  it('dispose() aborts the in-flight request and ignores later calls', async () => {
    const { llm, summarizer, updates } = setup(() => new Promise<string>(() => undefined))
    summarizer.maybeUpdate(linesUntil(450), 450_000)
    const req = llm.calls[0]
    expect(req?.signal?.aborted).toBe(false)
    summarizer.dispose()
    expect(req?.signal?.aborted).toBe(true)
    await summarizer.whenIdle()
    expect(summarizer.current()).toBeNull()
    expect(updates).toHaveLength(0)
    summarizer.maybeUpdate(linesUntil(900), 900_000)
    expect(llm.calls).toHaveLength(1)
  })

  it('skips partial lines and caps a large backlog per run', async () => {
    const { llm, summarizer } = setup()
    const lines = [
      ...linesUntil(450),
      line('them', 10, 'not final yet', { isFinal: false, id: 'partial' }),
    ]
    summarizer.maybeUpdate(lines, 450_000)
    await summarizer.whenIdle()
    expect(userText(llm.calls[0] ?? { messages: [] })).not.toContain('not final yet')

    const capped = new RunningSummarizer({
      llm,
      getModel: () => ({ model: 'm' }),
      intervalMs: 0,
      windowMs: WINDOW,
      log: recordingLogger(),
      maxNewTokens: 30,
    })
    capped.maybeUpdate(linesUntil(1200), 1_200_000)
    await capped.whenIdle()
    const first = userText(llm.calls[1] ?? { messages: [] })
    expect(first).toContain('said at 0s')
    expect(first).not.toContain('said at 300s')
    const covered = capped.coveredUntilMs()
    expect(covered).toBeGreaterThan(0)
    expect(covered).toBeLessThan(1_200_000 - WINDOW)
    // The rest of the backlog is folded in by the next runs, oldest first.
    capped.maybeUpdate(linesUntil(1200), 1_200_000)
    await capped.whenIdle()
    expect(capped.coveredUntilMs()).toBeGreaterThan(covered)
  })

  it('restore() seeds the summary and skips covered lines', async () => {
    const { llm, summarizer } = setup()
    summarizer.restore('Earlier: intros.', 120_000)
    expect(summarizer.current()).toBe('Earlier: intros.')
    expect(summarizer.coveredUntilMs()).toBe(120_000)
    summarizer.maybeUpdate(linesUntil(600), 600_000)
    await summarizer.whenIdle()
    const user = userText(llm.calls[0] ?? { messages: [] })
    expect(user).toContain('## Previous summary\nEarlier: intros.')
    expect(user).not.toContain('said at 90s')
    expect(user).toContain('said at 120s')
    expect(summarizer.coveredUntilMs()).toBe(210_001)
  })
})

describe('summaryMessages', () => {
  it('uses the summary prompt words the dev mock recognises', () => {
    const msgs = summaryMessages(null, [line('me', 0, 'hello')])
    const text = `${systemText({ messages: msgs })}\n${userText({ messages: msgs })}`.toLowerCase()
    expect(text).toContain('summarize')
    expect(text).toContain('running summary')
  })
})
