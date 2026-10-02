import { describe, expect, it } from 'vitest'
import { parseStoredError, tokensPerSecond } from '@main/db/repos/aiMessagesRepo'
import { parseSummaryJson } from '@main/db/repos/sessionsRepo'
import { AppError } from '@main/errors'
import { count, DAY, ftsRefs, line, makeRepos, seedSession } from './fixtures'

describe('SessionsRepo', () => {
  it('creates an active, untitled session and reads it back', () => {
    const r = makeRepos()
    const s = r.sessions.create({ modeId: 'builtin-sales', startedAt: 1000 })
    expect(s).toEqual({
      id: s.id,
      title: '',
      modeId: 'builtin-sales',
      startedAt: 1000,
      endedAt: null,
      durationMs: null,
      status: 'active',
    })
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.sessions.get(s.id)).toEqual(s)
    expect(r.sessions.create({ id: 'fixed', modeId: null, startedAt: 5 }).id).toBe('fixed')
    expect(r.sessions.get('missing')).toBeNull()
  })

  it('lists newest first and pages with `before`', () => {
    const r = makeRepos()
    for (const t of [3000, 1000, 5000, 2000, 4000]) {
      r.sessions.create({ id: `s${t}`, modeId: null, startedAt: t })
    }
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
    expect(ids(r.sessions.list())).toEqual(['s5000', 's4000', 's3000', 's2000', 's1000'])
    const page1 = r.sessions.list({ limit: 2 })
    expect(ids(page1)).toEqual(['s5000', 's4000'])
    const page2 = r.sessions.list({ limit: 2, before: page1[1]?.startedAt })
    expect(ids(page2)).toEqual(['s3000', 's2000'])
    expect(ids(r.sessions.list({ limit: 2, before: page2[1]?.startedAt }))).toEqual(['s1000'])
    expect(r.sessions.list({ before: 1000 })).toEqual([])
    expect(r.sessions.list({ limit: 0 })).toHaveLength(1)
    expect(r.sessions.list({ limit: 10_000 })).toHaveLength(5)
  })

  it('renames, auto-titles only empty titles, and keeps the title search index current', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 1 })
    expect(r.sessions.setTitleIfEmpty('s1', '   ')).toBe(false)
    expect(r.sessions.setTitleIfEmpty('s1', '  Pricing\n review ')).toBe(true)
    expect(r.sessions.get('s1')?.title).toBe('Pricing review')
    expect(r.sessions.setTitleIfEmpty('s1', 'Other')).toBe(false)
    expect(ftsRefs(r.db, 'pricing')).toEqual(['s1'])

    expect(r.sessions.rename('s1', 'Hiring sync')).toBe(true)
    expect(r.sessions.get('s1')?.title).toBe('Hiring sync')
    expect(ftsRefs(r.db, 'pricing')).toEqual([])
    expect(ftsRefs(r.db, 'hiring')).toEqual(['s1'])
    expect(r.sessions.rename('missing', 'x')).toBe(false)
  })

  it('ends a session with duration and updates status', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 10_000 })
    const ended = r.sessions.end('s1', 15_500)
    expect(ended).toMatchObject({ endedAt: 15_500, durationMs: 5500, status: 'active' })
    expect(r.sessions.end('s1', 5)?.durationMs).toBe(0) // clock skew never yields negatives
    expect(r.sessions.setStatus('s1', 'done')).toBe(true)
    expect(r.sessions.get('s1')?.status).toBe('done')
    expect(r.sessions.end('missing', 1)).toBeNull()
    expect(r.sessions.setStatus('missing', 'done')).toBe(false)
  })

  it('merges summary_json patches and tolerates missing or corrupt data', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 1 })
    expect(r.sessions.getSummaryJson('s1')).toEqual({
      notes: null,
      email: null,
      runningSummary: null,
      postCallError: null,
    })
    const notes = { title: 'T', summary: 'S', keyPoints: ['k'], decisions: [] }
    r.sessions.updateSummaryJson('s1', { notes, runningSummary: 'so far' })
    const merged = r.sessions.updateSummaryJson('s1', {
      email: { subject: 'Hi', body: 'Body' },
      runningSummary: undefined,
    })
    expect(merged).toEqual({
      notes,
      email: { subject: 'Hi', body: 'Body' },
      runningSummary: 'so far',
      postCallError: null,
    })
    expect(r.sessions.getSummaryJson('s1')).toEqual(merged)
    expect(
      r.sessions.updateSummaryJson('s1', { postCallError: 'boom', notes: null }),
    ).toMatchObject({ notes: null, postCallError: 'boom', runningSummary: 'so far' })
    expect(r.sessions.getSummaryJson('missing').notes).toBeNull()
    expect(() => r.sessions.updateSummaryJson('missing', { postCallError: 'x' })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )

    expect(parseSummaryJson('{not json')).toMatchObject({ notes: null, email: null })
    expect(parseSummaryJson('42').notes).toBeNull()
    expect(
      parseSummaryJson(JSON.stringify({ notes: { title: 5, keyPoints: 'x' }, email: 'bad' })),
    ).toEqual({
      notes: { title: '', summary: '', keyPoints: [], decisions: [] },
      email: null,
      runningSummary: null,
      postCallError: null,
    })
  })

  it('builds the session detail with mode name, ordered final transcript and action items', () => {
    const r = makeRepos()
    const now = Date.now()
    r.db
      .prepare(
        "INSERT INTO modes(id, name, created_at, updated_at) VALUES ('custom-1', 'My mode', ?, ?)",
      )
      .run(now, now)
    r.sessions.create({ id: 's1', modeId: 'custom-1', startedAt: 1000 })
    r.transcript.upsert(line('s1', 'me', 2000, 'second (me, same start)', { id: 'b' }))
    r.transcript.upsert(line('s1', 'them', 2000, 'first (them wins ties)', { id: 'a' }))
    r.transcript.upsert(line('s1', 'them', 0, 'opening', { id: 'z' }))
    r.transcript.upsert(line('s1', 'me', 9000, 'still talking', { id: 'p', isFinal: false }))
    r.actions.replaceForSession('s1', [
      { text: 'One', owner: 'Me', due: null },
      { text: 'Two', owner: null, due: 'Friday' },
    ])
    r.sessions.updateSummaryJson('s1', {
      notes: { title: 'N', summary: 'Sum', keyPoints: [], decisions: ['D'] },
      email: { subject: 'S', body: 'B' },
      postCallError: 'Notes failed',
    })

    const d = r.sessions.getDetail('s1')
    expect(d?.modeName).toBe('My mode')
    expect(d?.transcript.map((l) => l.id)).toEqual(['z', 'a', 'b'])
    expect(d?.actionItems.map((a) => a.text)).toEqual(['One', 'Two'])
    expect(d?.notes?.decisions).toEqual(['D'])
    expect(d?.email).toEqual({ subject: 'S', body: 'B' })
    expect(d?.postCallError).toBe('Notes failed')

    r.sessions.create({ id: 's2', modeId: 'builtin-sales', startedAt: 1 })
    expect(r.sessions.getDetail('s2')?.modeName).toBe('Sales call') // not seeded yet
    r.sessions.create({ id: 's3', modeId: 'deleted-mode', startedAt: 1 })
    expect(r.sessions.getDetail('s3')?.modeName).toBeNull()
    expect(r.sessions.getDetail('missing')).toBeNull()
  })

  it('cascades deletes to transcript, AI messages, action items and the search index', () => {
    const r = makeRepos()
    seedSession(r, {
      id: 's1',
      title: 'Roadmap planning',
      startedAt: 1,
      lines: [['them', 'roadmap for the quarter']],
      notesMarkdown: '## Summary\nroadmap agreed',
      emailMarkdown: 'roadmap follow-up',
      actionItems: [{ text: 'Share roadmap' }],
    })
    r.ai.insert({
      id: 'live1',
      sessionId: 's1',
      kind: 'say',
      label: 'What should I say?',
      promptText: 'p',
      createdAt: 1,
      usedScreen: false,
    })
    expect(ftsRefs(r.db, 'roadmap')).toHaveLength(5)
    expect(count(r.db, 'SELECT count(*) c FROM search_trigram')).toBe(5)

    expect(r.sessions.delete('s1')).toBe(true)
    expect(r.sessions.delete('s1')).toBe(false)
    for (const t of [
      'transcript_lines',
      'ai_messages',
      'action_items',
      'search_fts',
      'search_trigram',
    ]) {
      expect(count(r.db, `SELECT count(*) c FROM ${t}`)).toBe(0)
    }
  })

  it('deletes sessions older than a cutoff but never the live one', () => {
    const r = makeRepos()
    const now = 100 * DAY
    seedSession(r, { id: 'old', startedAt: now - 40 * DAY })
    seedSession(r, { id: 'live', startedAt: now - 40 * DAY, status: 'active' })
    seedSession(r, { id: 'new', startedAt: now - 10 * DAY })
    expect(r.sessions.deleteOlderThan(now - 30 * DAY)).toBe(1)
    expect(
      r.sessions
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['live', 'new'])
  })

  it('finds unfinished sessions oldest first', () => {
    const r = makeRepos()
    seedSession(r, { id: 'a', startedAt: 3, status: 'processing' })
    seedSession(r, { id: 'b', startedAt: 1, status: 'active' })
    seedSession(r, { id: 'c', startedAt: 2, status: 'done' })
    seedSession(r, { id: 'd', startedAt: 4, status: 'recovered' })
    expect(r.sessions.findUnfinished().map((s) => s.id)).toEqual(['b', 'a'])
  })
})

describe('TranscriptRepo', () => {
  it('upserts partial → final as one row and keeps the search index in step', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    const partial = line('s1', 'them', 1000, 'what does the enter', { id: 'l1', isFinal: false })
    r.transcript.upsert(partial)
    expect(ftsRefs(r.db, 'enter*')).toEqual([]) // partials are not searchable
    r.transcript.upsert({
      ...partial,
      text: 'What does the enterprise plan cost?',
      endMs: 3200,
      isFinal: true,
    })
    expect(count(r.db, 'SELECT count(*) c FROM transcript_lines')).toBe(1)
    expect(ftsRefs(r.db, 'enterprise')).toEqual(['l1'])
    const [stored] = r.transcript.listBySession('s1')
    expect(stored).toMatchObject({ id: 'l1', endMs: 3200, isFinal: true, startMs: 1000 })

    r.transcript.upsert({ ...partial, text: 'What does the team plan cost?', isFinal: true })
    expect(ftsRefs(r.db, 'enterprise')).toEqual([])
    expect(ftsRefs(r.db, 'team')).toEqual(['l1'])
    expect(count(r.db, "SELECT count(*) c FROM search_fts WHERE kind = 'transcript'")).toBe(1)
    expect(count(r.db, "SELECT count(*) c FROM search_trigram WHERE kind = 'transcript'")).toBe(1)
  })

  it('removes lines, lists final-only by default, counts and finds the last line', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    r.transcript.upsert(line('s1', 'me', 0, 'hello', { id: 'a', endMs: 1500 }))
    r.transcript.upsert(line('s1', 'them', 2000, 'long answer', { id: 'b', endMs: 9000 }))
    r.transcript.upsert(line('s1', 'me', 4000, 'interrupting', { id: 'c', endMs: 5000 }))
    r.transcript.upsert(line('s1', 'me', 9500, 'part', { id: 'd', endMs: 9800, isFinal: false }))
    expect(r.transcript.listBySession('s1').map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(r.transcript.listBySession('s1', { finalOnly: false }).map((l) => l.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
    expect(r.transcript.countBySession('s1')).toBe(3)
    expect(r.transcript.countBySession('s1', { finalOnly: false })).toBe(4)
    expect(r.transcript.lastLine('s1')?.id).toBe('d')
    expect(r.transcript.remove('d')).toBe(true)
    expect(r.transcript.lastLine('s1')?.id).toBe('b') // ends last, although it started earlier
    expect(r.transcript.remove('b')).toBe(true)
    expect(r.transcript.remove('b')).toBe(false)
    expect(ftsRefs(r.db, 'answer')).toEqual([])
    expect(r.transcript.lastLine('missing')).toBeNull()
  })

  it('finalizes leftover partial lines of a crashed session', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    r.transcript.upsert(line('s1', 'them', 0, 'budget is tight', { id: 'a', isFinal: false }))
    r.transcript.upsert(line('s1', 'me', 1000, '   ', { id: 'b', isFinal: false }))
    r.transcript.upsert(line('s1', 'me', 2000, 'ok', { id: 'c' }))
    expect(r.transcript.finalizeSession('s1')).toBe(1)
    expect(r.transcript.listBySession('s1').map((l) => l.id)).toEqual(['a', 'c'])
    expect(r.transcript.countBySession('s1', { finalOnly: false })).toBe(2)
    expect(ftsRefs(r.db, 'budget')).toEqual(['a'])
  })

  it('rejects lines for unknown sessions (foreign key)', () => {
    const r = makeRepos()
    expect(() => r.transcript.upsert(line('nope', 'me', 0, 'x'))).toThrow(/FOREIGN KEY/)
  })
})

describe('AiMessagesRepo', () => {
  it('inserts a streaming message and completes it with stats and errors', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    r.ai.insert({
      id: 'm1',
      sessionId: 's1',
      kind: 'assist',
      label: 'Assist',
      promptText: 'prompt',
      createdAt: 10,
      usedScreen: true,
    })
    expect(r.ai.get('m1')).toMatchObject({
      status: 'streaming',
      usedScreen: true,
      responseText: null,
    })
    expect(
      r.ai.complete('m1', {
        responseText: 'Say this',
        model: 'groq/llama',
        provider: 'Groq',
        ttftMs: 420.4,
        totalMs: 1900,
        tokensIn: 300,
        tokensOut: 186,
        costUsd: 0.0001,
        status: 'done',
      }),
    ).toBe(true)
    expect(r.ai.get('m1')).toMatchObject({
      responseText: 'Say this',
      ttftMs: 420,
      totalMs: 1900,
      tokensOut: 186,
      costUsd: 0.0001,
      status: 'done',
      error: null,
      promptText: 'prompt',
    })
    expect(r.ai.complete('missing', { status: 'cancelled' })).toBe(false)

    r.ai.insert({
      id: 'm2',
      sessionId: 's1',
      kind: 'ask',
      label: 'Q?',
      promptText: null,
      createdAt: 11,
      usedScreen: false,
    })
    const error = {
      code: 'rate_limit' as const,
      message: 'Slow down',
      retryable: true,
      retryAfterSec: 3,
    }
    r.ai.complete('m2', { status: 'error', error })
    expect(r.ai.get('m2')?.error).toEqual(error)
    r.ai.complete('m2', { status: 'error', error: 'plain failure' })
    expect(r.ai.get('m2')?.error).toEqual({
      code: 'unknown',
      message: 'plain failure',
      retryable: false,
      retryAfterSec: null,
    })
    expect(parseStoredError(JSON.stringify({ code: 'weird', message: 'm' }))?.code).toBe('unknown')
    expect(parseStoredError(null)).toBeNull()
  })

  it('lists messages oldest first, optionally by kind', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    const add = (id: string, kind: 'say' | 'recap' | 'meeting_chat', createdAt: number) =>
      r.ai.insert({
        id,
        sessionId: 's1',
        kind,
        label: id,
        promptText: null,
        createdAt,
        usedScreen: false,
      })
    add('c', 'recap', 30)
    add('a', 'say', 10)
    add('b', 'meeting_chat', 20)
    expect(r.ai.listBySession('s1').map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(r.ai.listBySession('s1', ['say', 'recap']).map((m) => m.id)).toEqual(['a', 'c'])
    expect(r.ai.listBySession('s1', [])).toEqual([])
  })

  it('keeps exactly one current row per post-call kind so search stays correct', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    const id1 = r.ai.upsertPostCall('s1', 'post_notes', 'Summary about llamas', {
      model: 'm',
      provider: 'p',
      totalMs: 2000,
      ttftMs: 500,
      tokensOut: 300,
      promptText: 'notes prompt',
    })
    expect(ftsRefs(r.db, 'llamas')).toEqual([id1])
    const id2 = r.ai.upsertPostCall('s1', 'post_notes', 'Summary about alpacas')
    expect(id2).toBe(id1)
    expect(ftsRefs(r.db, 'llamas')).toEqual([])
    expect(ftsRefs(r.db, 'alpacas')).toEqual([id1])
    // Stats survive a text-only update (e.g. the user edited the output).
    expect(r.ai.get(id1)).toMatchObject({ model: 'm', totalMs: 2000, promptText: 'notes prompt' })

    // A duplicate written by other code is collapsed on the next upsert.
    r.ai.insert({
      id: 'dup',
      sessionId: 's1',
      kind: 'post_notes',
      label: null,
      promptText: null,
      createdAt: Date.now() + 1000,
      usedScreen: false,
    })
    r.ai.complete('dup', { responseText: 'Summary about camels', status: 'done' })
    const id3 = r.ai.upsertPostCall('s1', 'post_notes', 'Summary about vicuñas', { model: 'm2' })
    expect(id3).toBe('dup')
    expect(r.ai.listBySession('s1', ['post_notes'])).toHaveLength(1)
    expect(r.ai.get('dup')).toMatchObject({ model: 'm2', status: 'done' })
    expect(ftsRefs(r.db, 'camels')).toEqual([])
    expect(ftsRefs(r.db, 'vicunas')).toEqual(['dup'])

    r.ai.upsertPostCall('s1', 'post_actions', '- [ ] thing')
    expect(r.ai.listBySession('s1', ['post_actions'])).toHaveLength(1)
    expect(ftsRefs(r.db, 'thing')).toEqual([]) // post_actions are indexed via action_items rows
  })

  it('rebuilds meeting chat and live cards', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    r.ai.insert({
      id: 'q1',
      sessionId: 's1',
      kind: 'meeting_chat',
      label: 'What was decided?',
      promptText: 'p',
      createdAt: 5,
      usedScreen: false,
    })
    r.ai.complete('q1', {
      responseText: 'We agreed.',
      model: 'smart/model',
      provider: 'X',
      ttftMs: 1000,
      totalMs: 3000,
      tokensOut: 100,
      status: 'done',
    })
    r.ai.insert({
      id: 'l1',
      sessionId: 's1',
      kind: 'say',
      label: 'What should I say?',
      promptText: 'p',
      createdAt: 1,
      usedScreen: true,
    })
    r.ai.insert({
      id: 'l2',
      sessionId: 's1',
      kind: 'auto',
      label: 'Auto · they asked a question',
      promptText: 'p',
      createdAt: 2,
      usedScreen: false,
    })
    r.ai.upsertPostCall('s1', 'post_email', 'mail')

    const chat = r.ai.chatHistory('s1')
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatchObject({
      id: 'q1',
      scope: 'meeting_chat',
      sessionId: 's1',
      kind: 'meeting_chat',
      label: 'What was decided?',
      question: 'What was decided?',
      tier: 'smart',
      status: 'done',
      text: 'We agreed.',
      error: null,
      citations: [],
      createdAt: 5,
    })
    expect(chat[0]?.stats).toMatchObject({
      ttftMs: 1000,
      totalMs: 3000,
      tokensPerSec: 50,
      model: 'smart/model',
    })

    const live = r.ai.liveCards('s1')
    expect(live.map((c) => c.id)).toEqual(['l1', 'l2'])
    expect(live[0]).toMatchObject({
      scope: 'live',
      tier: 'fast',
      question: null,
      usedScreen: true,
      status: 'streaming',
      text: '',
      stats: null,
    })
  })

  it('marks messages left streaming by a crash as cancelled', () => {
    const r = makeRepos()
    r.ai.insert({
      id: 'x',
      sessionId: null,
      kind: 'search_ask',
      label: 'q',
      promptText: null,
      createdAt: 1,
      usedScreen: false,
    })
    r.ai.insert({
      id: 'y',
      sessionId: null,
      kind: 'search_ask',
      label: 'q',
      promptText: null,
      createdAt: 1,
      usedScreen: false,
      status: 'done',
    })
    expect(r.ai.markInterrupted()).toBe(1)
    expect(r.ai.get('x')?.status).toBe('cancelled')
    expect(r.ai.get('y')?.status).toBe('done')
  })

  it('computes tokens per second over the generation phase', () => {
    expect(tokensPerSecond(100, 3000, 1000)).toBe(50)
    expect(tokensPerSecond(100, 2000, null)).toBe(50)
    expect(tokensPerSecond(0, 2000, 100)).toBeNull()
    expect(tokensPerSecond(10, 0, null)).toBeNull()
    expect(tokensPerSecond(null, 1000, 10)).toBeNull()
  })
})

describe('ActionItemsRepo', () => {
  it('replaces items atomically in order, normalizing text, owner and due', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    const items = r.actions.replaceForSession('s1', [
      { text: '  Send the deck ', owner: 'Me', due: 'Friday' },
      { text: '', owner: null, due: null },
      { text: 'Book follow-up', owner: '  ', due: '' },
      { text: 'Already done', owner: null, due: null, done: true },
    ])
    expect(items.map((i) => [i.text, i.owner, i.due, i.done])).toEqual([
      ['Send the deck', 'Me', 'Friday', false],
      ['Book follow-up', null, null, false],
      ['Already done', null, null, true],
    ])
    expect(r.actions.listBySession('s1')).toEqual(items)
    expect(ftsRefs(r.db, 'deck')).toEqual([items[0]?.id])

    // Regenerating keeps checkbox state for unchanged items unless told otherwise.
    const first = items[0]
    if (!first) throw new Error('missing item')
    r.actions.setDone(first.id, true)
    const next = r.actions.replaceForSession('s1', [
      { text: 'New task', owner: null, due: null },
      { text: 'send the  DECK', owner: 'Me', due: null },
      { text: 'Already done', owner: null, due: null, done: false },
    ])
    expect(next.map((i) => [i.text, i.done])).toEqual([
      ['New task', false],
      ['send the  DECK', true],
      ['Already done', false],
    ])
    expect(count(r.db, 'SELECT count(*) c FROM action_items')).toBe(3)
    expect(ftsRefs(r.db, 'book')).toEqual([])
    expect(r.actions.replaceForSession('s1', [])).toEqual([])
  })

  it('persists checkbox state and edits, with not_found for unknown ids', () => {
    const r = makeRepos()
    r.sessions.create({ id: 's1', modeId: null, startedAt: 0 })
    const [item] = r.actions.replaceForSession('s1', [{ text: 'Call Sam', owner: null, due: null }])
    if (!item) throw new Error('missing item')
    expect(r.actions.setDone(item.id, true)).toEqual({ ...item, done: true })
    expect(r.actions.listBySession('s1')[0]?.done).toBe(true)
    expect(r.actions.setDone(item.id, false).done).toBe(false)

    expect(r.actions.updateText(item.id, ' Call Alex ').text).toBe('Call Alex')
    expect(ftsRefs(r.db, 'sam')).toEqual([])
    expect(ftsRefs(r.db, 'alex')).toEqual([item.id])

    const err = (() => {
      try {
        r.actions.setDone('nope', true)
      } catch (e) {
        return e
      }
      return null
    })()
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('not_found')
    expect(() => r.actions.updateText('nope', 'x')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
    expect(() => r.actions.updateText(item.id, '  ')).toThrow(
      expect.objectContaining({ code: 'invalid_payload' }),
    )
  })
})
