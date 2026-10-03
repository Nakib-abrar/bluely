import { describe, expect, it, vi } from 'vitest'
import type { FollowUpEmail, Mode, SessionSummaryJson } from '@shared/types'
import { PostCallRunner } from '@main/live/postCallRunner'
import { ProviderError } from '@main/providers/errors'
import type { ChatRequest, ChatStreamEvent } from '@main/providers/llm/LLMProvider'
import { createHarness, FakeLLM } from '../live/harness'

type Part = 'notes' | 'actions' | 'email'

const NOTES = (title: string) =>
  JSON.stringify({ title, summary: `${title} summary.`, keyPoints: ['Point'], decisions: [] })
const ACTIONS = JSON.stringify({ items: [{ text: 'Send pricing', owner: 'Me', due: null }] })
const EMAIL = (subject: string) => JSON.stringify({ subject, body: `${subject} body` })

/** Answers each post-call part from `replies`, or fails it when `failing` has it. */
class PostCallLLM extends FakeLLM {
  failing = new Set<Part>()
  /** Message of the failures (default: the friendly 'credits' text). */
  failMessage: string | undefined
  replies: Record<Part, string> = { notes: NOTES('First'), actions: ACTIONS, email: EMAIL('Hi') }
  gate: Promise<void> | null = null

  override async *streamChat(req: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const part = req.tag?.replace('post_', '') as Part
    this.requests.push(req)
    if (this.gate) await this.gate
    if (this.failing.has(part)) {
      throw new ProviderError('credits', { status: 402, message: this.failMessage })
    }
    yield { type: 'delta', text: this.replies[part] }
    const stats = {
      ttftMs: 1,
      totalMs: 2,
      tokensPerSec: null,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: null,
      provider: null,
      model: req.model,
      generationId: null,
    }
    yield { type: 'done', finishReason: 'stop', usage: null, stats }
  }
}

function setup() {
  const h = createHarness()
  const llm = new PostCallLLM()
  ;(h.models as { llm: unknown }).llm = llm
  const runner = new PostCallRunner(h.ctx, h.models, h.history)
  const mode = h.modes.modes.get('builtin-general') as Mode
  const session = h.history.sessions.create({ modeId: mode.id, startedAt: Date.now() })
  h.history.transcript.upsert({
    id: 'l1',
    sessionId: session.id,
    channel: 'them',
    startMs: 0,
    endMs: 3000,
    text: 'Can you send the pricing sheet?',
    isFinal: true,
  })
  // What sessions:updateEmail does. The flag is owned by the data layer; until it persists
  // there, this test reports it the way getSummaryJson will.
  const edited = new Set<string>()
  const getSummaryJson = h.history.sessions.getSummaryJson.bind(h.history.sessions)
  vi.spyOn(h.history.sessions, 'getSummaryJson').mockImplementation((id): SessionSummaryJson => {
    const stored = getSummaryJson(id)
    return { ...stored, emailEdited: stored.emailEdited === true || edited.has(id) }
  })
  const editEmail = (email: FollowUpEmail) => {
    h.history.sessions.updateSummaryJson(session.id, { email, emailEdited: true })
    h.history.aiMessages.upsertPostCall(session.id, 'post_email', `${email.subject}\n${email.body}`)
    edited.add(session.id)
  }
  const run = (parts?: Part[]) => runner.run(session.id, mode, parts ? { parts } : {})
  const detail = () => h.history.sessions.getDetail(session.id)!
  const requestedParts = () => llm.requests.map((r) => r.tag?.replace('post_', ''))
  return { ...h, llm, runner, mode, session, editEmail, run, detail, requestedParts }
}

describe('PostCallRunner', () => {
  it('a failed regenerate never wipes earlier notes or email (and keeps the status)', async () => {
    const h = setup()
    await h.run()
    expect(h.detail()).toMatchObject({ status: 'done', notes: { title: 'First' } })
    // Out of credits now: every part fails.
    h.llm.failing = new Set(['notes', 'actions', 'email'])
    await h.run(['notes', 'actions', 'email'])
    const d = h.detail()
    expect(d.notes?.title).toBe('First')
    expect(d.email).toEqual({ subject: 'Hi', body: 'Hi body' })
    expect(d.actionItems.map((a) => a.text)).toEqual(['Send pricing'])
    expect(d.status).toBe('done')
    expect(d.postCallError).toMatch(/^notes: .+ · actions: .+ · email: .+$/)
    // Search rows and the page still agree.
    const notesRow = h.history.aiMessages.listBySession(h.session.id, ['post_notes'])[0]
    expect(notesRow?.responseText).toContain('First')
  })

  it('Retry regenerates only the parts that are missing', async () => {
    const h = setup()
    h.llm.failing = new Set(['actions'])
    await h.run()
    expect(h.detail().postCallError).toMatch(/^actions: /)
    h.llm.failing.clear()
    h.llm.replies.notes = NOTES('Second')
    h.llm.requests = []
    await h.run()
    expect(h.requestedParts()).toEqual(['actions'])
    const d = h.detail()
    expect(d.notes?.title).toBe('First')
    expect(d.actionItems.map((a) => a.text)).toEqual(['Send pricing'])
    expect(d.postCallError).toBeNull()
  })

  it('never replaces an email the user edited unless the email is explicitly regenerated', async () => {
    const h = setup()
    h.llm.failing = new Set(['actions'])
    await h.run()
    h.editEmail({ subject: 'My subject', body: 'My own words' })
    // Retry after a partial failure: the edited email is not touched.
    h.llm.failing.clear()
    h.llm.replies.email = EMAIL('Generated again')
    h.llm.requests = []
    await h.run()
    expect(h.requestedParts()).toEqual(['actions'])
    expect(h.detail().email).toEqual({ subject: 'My subject', body: 'My own words' })
    // Nothing missing: regenerate everything except the edited email.
    h.llm.requests = []
    await h.run()
    expect(h.requestedParts().sort()).toEqual(['actions', 'notes'])
    expect(h.detail().email?.body).toBe('My own words')
    // Asked for explicitly: replaced.
    await h.run(['email'])
    expect(h.detail().email).toEqual({
      subject: 'Generated again',
      body: 'Generated again body',
    })
  })

  it('keeps an email the user saves while generation is running', async () => {
    const h = setup()
    h.llm.failing = new Set(['email'])
    await h.run()
    expect(h.detail().email).toBeNull()
    h.llm.failing.clear()
    let release!: () => void
    h.llm.gate = new Promise<void>((r) => (release = r))
    const running = h.run()
    await vi.waitFor(() => expect(h.llm.requests.length).toBeGreaterThan(3))
    h.editEmail({ subject: 'Typed meanwhile', body: 'Mine' })
    release()
    await running
    expect(h.detail().email).toEqual({ subject: 'Typed meanwhile', body: 'Mine' })
  })

  it('keeps the error of a part that did not run this time', async () => {
    const h = setup()
    h.llm.failing = new Set(['notes', 'actions'])
    await h.run()
    h.llm.failing = new Set(['notes'])
    await h.run(['actions'])
    const d = h.detail()
    expect(d.actionItems).toHaveLength(1)
    expect(d.postCallError).toMatch(/^notes: /)
    expect(d.postCallError).not.toContain('actions:')
  })

  it('keeps a carried-over error whole when its message contains " · "', async () => {
    const h = setup()
    h.llm.failing = new Set(['notes', 'actions'])
    h.llm.failMessage = 'Provider said no · request id abc'
    await h.run()
    expect(h.detail().postCallError).toBe(
      'notes: Provider said no · request id abc · actions: Provider said no · request id abc',
    )
    h.llm.failing = new Set()
    await h.run(['actions'])
    // Used to be cut to "notes: Provider said no" (split on every " · ").
    expect(h.detail().postCallError).toBe('notes: Provider said no · request id abc')
  })

  it('keeps ticked action items ticked across a regenerate', async () => {
    const h = setup()
    await h.run()
    const item = h.detail().actionItems[0]!
    h.history.actionItems.setDone(item.id, true)
    await h.run(['actions'])
    expect(h.detail().actionItems[0]).toMatchObject({ text: 'Send pricing', done: true })
    const row = h.history.aiMessages.listBySession(h.session.id, ['post_actions'])[0]
    expect(row?.responseText).toContain('[x]')
  })

  it('marks the session failed only when it has no output at all', async () => {
    const h = setup()
    h.llm.failing = new Set(['notes', 'actions', 'email'])
    await h.run()
    expect(h.detail().status).toBe('failed')
    expect(h.detail().title).not.toBe('')
  })
})
