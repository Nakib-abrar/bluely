import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@main/db/database'
import { median, percentile } from '@main/models/percentiles'
import {
  ModelStatsRepo,
  STATS_WINDOW,
  startOfLocalMonth,
  summarizeSamples,
} from '@main/models/statsRepo'

describe('percentile (nearest rank)', () => {
  it('matches the textbook nearest-rank example', () => {
    const v = [15, 20, 35, 40, 50]
    expect(percentile(v, 5)).toBe(15)
    expect(percentile(v, 30)).toBe(20)
    expect(percentile(v, 40)).toBe(20)
    expect(percentile(v, 50)).toBe(35)
    expect(percentile(v, 100)).toBe(50)
  })

  it('is exact where floating point would round the rank up (0.7 × 10)', () => {
    const v = Array.from({ length: 10 }, (_, i) => i + 1)
    expect(percentile(v, 70)).toBe(7)
    expect(percentile(v, 90)).toBe(9)
    expect(percentile(v, 50)).toBe(5)
    expect(percentile(v, 91)).toBe(10)
  })

  it('handles empty, single, unsorted and invalid input without mutating it', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([42], 90)).toBe(42)
    const input = [300, 100, NaN, 200, Infinity]
    expect(percentile(input, 50)).toBe(200)
    expect(input).toEqual([300, 100, NaN, 200, Infinity])
    expect(percentile([1, 2, 3], 0)).toBe(1)
    expect(percentile([1, 2, 3], 250)).toBe(3)
    expect(percentile([1, 2, 3], -5)).toBe(1)
    expect(median([5, 1, 3])).toBe(3)
  })
})

describe('summarizeSamples', () => {
  it('ignores null TTFT / throughput but counts every sample', () => {
    const s = summarizeSamples(
      'm',
      'Groq',
      [
        { ttftMs: 100, totalMs: 900, tokensPerSec: 150, at: 1 },
        { ttftMs: null, totalMs: 1100, tokensPerSec: null, at: 2 },
        { ttftMs: 300, totalMs: 700, tokensPerSec: 250, at: 3 },
      ],
      99,
    )
    expect(s).toEqual({
      model: 'm',
      provider: 'Groq',
      samples: 3,
      ttftP50: 100,
      ttftP90: 300,
      totalP50: 900,
      tokensPerSecP50: 150,
      updatedAt: 99,
    })
  })
})

describe('ModelStatsRepo', () => {
  const sample = (ttftMs: number | null, provider: string | null = 'Groq', model = 'm/a') => ({
    model,
    provider,
    ttftMs,
    totalMs: (ttftMs ?? 0) + 1000,
    tokensPerSec: ttftMs === null ? null : 100 + ttftMs,
  })

  it('records samples and recomputes the row percentiles', () => {
    let now = 1000
    const repo = new ModelStatsRepo(openDatabase(':memory:'), () => now)
    for (const t of [400, 100, 300, 200, 500]) {
      now += 1
      repo.recordSample(sample(t))
    }
    const [row] = repo.list()
    expect(row).toEqual({
      model: 'm/a',
      provider: 'Groq',
      samples: 5,
      ttftP50: 300,
      ttftP90: 500,
      totalP50: 1300,
      tokensPerSecP50: 400,
      updatedAt: 1005,
    })
    expect(repo.get('m/a', 'Groq')).toEqual(row)
  })

  it('keeps only the last 50 samples per (model, provider)', () => {
    const db = openDatabase(':memory:')
    const repo = new ModelStatsRepo(db)
    let last = null
    for (let i = 1; i <= 60; i++) last = repo.recordSample(sample(i))
    expect(STATS_WINDOW).toBe(50)
    expect(last?.samples).toBe(50)
    // Window holds 11..60: p50 = 25th value = 35, p90 = 45th value = 55.
    expect(last?.ttftP50).toBe(35)
    expect(last?.ttftP90).toBe(55)
    const raw = db.prepare('SELECT recent_json FROM model_stats').get() as { recent_json: string }
    const recent = JSON.parse(raw.recent_json) as { ttftMs: number }[]
    expect(recent).toHaveLength(50)
    expect(recent[0]?.ttftMs).toBe(11)
    expect(recent.at(-1)?.ttftMs).toBe(60)
  })

  it('keeps providers apart, maps unknown provider to null and aggregates per model', () => {
    let now = 0
    const repo = new ModelStatsRepo(openDatabase(':memory:'), () => ++now)
    repo.recordSample(sample(100, 'Groq'))
    repo.recordSample(sample(200, 'Cerebras'))
    repo.recordSample(sample(300, null))
    repo.recordSample(sample(50, 'Groq', 'm/b'))
    const rows = repo.list()
    expect(rows.map((r) => [r.model, r.provider])).toEqual([
      ['m/b', 'Groq'],
      ['m/a', null],
      ['m/a', 'Cerebras'],
      ['m/a', 'Groq'],
    ])
    const agg = repo.listByModel()
    expect(agg).toHaveLength(2)
    const a = agg.find((s) => s.model === 'm/a')
    expect(a).toMatchObject({ provider: null, samples: 3, ttftP50: 200, ttftP90: 300 })
    expect(agg.find((s) => s.model === 'm/b')).toMatchObject({ provider: 'Groq', samples: 1 })
  })

  it('sanitises invalid numbers and survives a corrupt recent_json', () => {
    const db = openDatabase(':memory:')
    const repo = new ModelStatsRepo(db)
    repo.recordSample({
      model: 'x',
      provider: 'P',
      ttftMs: -5,
      totalMs: NaN,
      tokensPerSec: Infinity,
    })
    expect(repo.list()[0]).toMatchObject({
      samples: 1,
      ttftP50: null,
      totalP50: 0,
      tokensPerSecP50: null,
    })
    db.prepare("UPDATE model_stats SET recent_json = '{oops'").run()
    expect(repo.recordSample(sample(10, 'P', 'x')).samples).toBe(1)
  })
})

describe('usage log and month spend', () => {
  const originalTz = process.env['TZ']
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ']
    else process.env['TZ'] = originalTz
  })

  it('sums costs from the first day of the local month with an LLM/STT split', () => {
    let now = 0
    const repo = new ModelStatsRepo(openDatabase(':memory:'), () => now)
    const monthStart = new Date(2026, 9, 1, 0, 0, 0, 0).getTime()
    const log = (at: number, kind: 'llm' | 'stt', costUsd: number | null) => {
      now = at
      repo.logUsage({ kind, model: 'm', provider: 'Groq', costUsd, tokensIn: 10, tokensOut: 5 })
    }
    log(monthStart - 1, 'llm', 5) // last millisecond of September: excluded
    log(monthStart, 'llm', 0.25) // first millisecond of October: included
    log(monthStart + 86_400_000, 'stt', 0.1)
    log(monthStart + 2 * 86_400_000, 'llm', null) // unknown cost still counts as a request
    log(monthStart + 3 * 86_400_000, 'llm', 0.05)
    const spend = repo.monthSpend(new Date(2026, 9, 15, 12).getTime())
    expect(spend.sinceMs).toBe(monthStart)
    expect(spend.totalUsd).toBeCloseTo(0.4, 10)
    expect(spend.llmUsd).toBeCloseTo(0.3, 10)
    expect(spend.sttUsd).toBeCloseTo(0.1, 10)
    expect(spend.requests).toBe(4)
  })

  it('is zero for an empty month and handles the January boundary', () => {
    let now = new Date(2025, 11, 31, 23, 59).getTime()
    const repo = new ModelStatsRepo(openDatabase(':memory:'), () => now)
    repo.logUsage({ kind: 'llm', costUsd: 1 })
    now = new Date(2026, 0, 3).getTime()
    expect(repo.monthSpend()).toEqual({
      sinceMs: new Date(2026, 0, 1).getTime(),
      totalUsd: 0,
      llmUsd: 0,
      sttUsd: 0,
      requests: 0,
    })
  })

  it('uses LOCAL midnight (not UTC) for the month start', () => {
    process.env['TZ'] = 'America/New_York'
    const now = Date.UTC(2026, 9, 15, 12)
    const since = startOfLocalMonth(now)
    // Oct 1 00:00 in New York is 04:00 UTC (EDT).
    expect(since).toBe(Date.UTC(2026, 9, 1, 4))
    const d = new Date(since)
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([1, 0, 0])
    let clock = Date.UTC(2026, 9, 1, 3) // Sept 30, 23:00 local
    const repo = new ModelStatsRepo(openDatabase(':memory:'), () => clock)
    repo.logUsage({ kind: 'stt', costUsd: 2, audioSeconds: 12.5, sessionId: 's1' })
    clock = Date.UTC(2026, 9, 1, 5) // Oct 1, 01:00 local
    repo.logUsage({ kind: 'stt', costUsd: 0.5, audioSeconds: 3 })
    expect(repo.monthSpend(now)).toMatchObject({ totalUsd: 0.5, sttUsd: 0.5, requests: 1 })
  })

  it('stores the usage columns', () => {
    const db = openDatabase(':memory:')
    const repo = new ModelStatsRepo(db, () => 123)
    repo.logUsage({
      kind: 'stt',
      model: 'openai/whisper-large-v3-turbo',
      provider: 'Groq',
      costUsd: 0.0011,
      audioSeconds: 9.5,
      tokensIn: 12.6,
      tokensOut: -1,
      sessionId: 'sess-1',
    })
    expect(db.prepare('SELECT * FROM usage_log').get()).toEqual({
      id: 1,
      created_at: 123,
      kind: 'stt',
      model: 'openai/whisper-large-v3-turbo',
      provider: 'Groq',
      cost_usd: 0.0011,
      tokens_in: 13,
      tokens_out: null,
      audio_seconds: 9.5,
      session_id: 'sess-1',
    })
  })
})
