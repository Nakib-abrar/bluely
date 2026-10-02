import { describe, expect, it } from 'vitest'
import { recoverUnfinishedSessions } from '@main/data/recovery'
import { DAY, ftsRefs, line, makeRepos, seedSession } from './fixtures'

const NOW = 500 * DAY

describe('recoverUnfinishedSessions', () => {
  it('ends a crashed live session at its last transcript line and marks it recovered', () => {
    const r = makeRepos()
    const startedAt = NOW - 2 * 60 * 60 * 1000
    r.sessions.create({ id: 'crashed', modeId: null, startedAt })
    r.transcript.upsert(line('crashed', 'them', 0, 'hello', { endMs: 4000 }))
    r.transcript.upsert(line('crashed', 'me', 600_000, 'long talk', { endMs: 1_234_567 }))
    r.transcript.upsert(line('crashed', 'them', 900_000, 'interrupt', { endMs: 905_000 }))

    const out = recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW)
    expect(out).toEqual([
      {
        id: 'crashed',
        title: '',
        modeId: null,
        startedAt,
        endedAt: startedAt + 1_234_567,
        durationMs: 1_234_567,
        status: 'recovered',
      },
    ])
    expect(r.sessions.get('crashed')).toEqual(out[0])
    // Idempotent: nothing left to recover.
    expect(
      recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW),
    ).toEqual([])
  })

  it('uses started_at when there are no lines', () => {
    const r = makeRepos()
    r.sessions.create({ id: 'empty', modeId: 'builtin-general', startedAt: NOW - 1000 })
    const [s] = recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW)
    expect(s).toMatchObject({ endedAt: NOW - 1000, durationMs: 0, status: 'recovered' })
  })

  it('keeps the real end of a session that crashed while generating notes', () => {
    const r = makeRepos()
    r.sessions.create({ id: 'proc', modeId: null, startedAt: NOW - 10_000 })
    r.transcript.upsert(line('proc', 'me', 0, 'hi', { endMs: 2000 }))
    r.sessions.end('proc', NOW - 1000)
    r.sessions.setStatus('proc', 'processing')
    const [s] = recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW)
    expect(s).toMatchObject({ endedAt: NOW - 1000, durationMs: 9000, status: 'recovered' })
  })

  it('computes the end for a processing session that never recorded ended_at', () => {
    const r = makeRepos()
    r.sessions.create({ id: 'proc', modeId: null, startedAt: NOW - 10_000 })
    r.transcript.upsert(line('proc', 'me', 0, 'hi', { endMs: 2500 }))
    r.sessions.setStatus('proc', 'processing')
    const [s] = recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW)
    expect(s).toMatchObject({ endedAt: NOW - 7500, durationMs: 2500 })
  })

  it('leaves finished sessions alone and finalizes partial lines', () => {
    const r = makeRepos()
    seedSession(r, { id: 'done', startedAt: NOW - DAY, durationMs: 5000 })
    seedSession(r, { id: 'failed', startedAt: NOW - DAY, status: 'failed' })
    r.sessions.create({ id: 'live', modeId: null, startedAt: NOW - 60_000 })
    r.transcript.upsert(
      line('live', 'them', 1000, 'the budget is', { id: 'p', endMs: 3000, isFinal: false }),
    )
    r.transcript.upsert(line('live', 'me', 3000, '', { id: 'e', endMs: 9000, isFinal: false }))

    const out = recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW)
    expect(out.map((s) => s.id)).toEqual(['live'])
    expect(out[0]?.endedAt).toBe(NOW - 60_000 + 3000) // the empty partial was dropped first
    expect(r.transcript.listBySession('live').map((l) => l.id)).toEqual(['p'])
    expect(ftsRefs(r.db, 'budget')).toEqual(['p'])
    expect(r.sessions.get('done')?.status).toBe('done')
    expect(r.sessions.get('failed')?.status).toBe('failed')
  })

  it('never ends a session in the future', () => {
    const r = makeRepos()
    r.sessions.create({ id: 'skew', modeId: null, startedAt: NOW - 1000 })
    r.transcript.upsert(line('skew', 'me', 0, 'x', { endMs: 60_000 }))
    const [s] = recoverUnfinishedSessions({ sessions: r.sessions, transcript: r.transcript }, NOW)
    expect(s?.endedAt).toBe(NOW)
  })
})
