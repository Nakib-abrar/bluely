import { describe, expect, it, vi } from 'vitest'
import {
  CHUNK_MAX_TOKENS,
  PART_MAX_TOKENS,
  generatePostCall,
  parseActionItems,
  parseEmail,
  parseNotes,
  splitTranscript,
  type PostCallInput,
} from '@main/ai/postCall'
import { POST_CALL_MESSAGES } from '@main/ai/labels'
import { estimateTokens } from '@main/ai/tokens'
import { ProviderError } from '@main/providers/errors'
import type { ChatRequest } from '@main/providers/llm/LLMProvider'
import {
  EMPTY_PROFILE,
  FakeLLM,
  SALES,
  deferred,
  recordingLogger,
  systemText,
  userText,
  type Deferred,
} from './helpers'

const TRANSCRIPT = [
  '[00:01] Them: Thanks for joining. What does the enterprise plan cost per seat?',
  '[00:08] Me: It is forty dollars per seat. I will send the pricing sheet by Friday.',
  '[00:20] Them: Great, we would like a pilot for the ops team.',
].join('\n')

const NOTES_JSON = JSON.stringify({
  title: 'Enterprise pricing and pilot',
  summary: 'Discussed enterprise pricing. They want a pilot.',
  keyPoints: ['$40 per seat', 'Ops team pilot'],
  decisions: ['Run a pilot'],
})
const ACTIONS_JSON = JSON.stringify({
  items: [{ text: 'Send the pricing sheet', owner: 'Me', due: 'Friday' }],
})
const EMAIL_JSON = JSON.stringify({ subject: 'Next steps', body: 'Hi,\n\nThanks!\n\nBest,\nAda' })

type Part = 'notes' | 'actions' | 'email' | 'chunk'

function partOf(req: ChatRequest): Part {
  if (req.tag === 'post_notes') return 'notes'
  if (req.tag === 'post_actions') return 'actions'
  if (req.tag === 'post_email') return 'email'
  return 'chunk'
}

function input(overrides: Partial<PostCallInput> = {}): PostCallInput {
  return {
    model: 'anthropic/claude-sonnet-4.5',
    routing: { sort: 'price' },
    transcriptText: TRANSCRIPT,
    mode: SALES,
    profile: { ...EMPTY_PROFILE, name: 'Ada' },
    answerLanguage: 'conversation',
    ...overrides,
  }
}

function happyLLM(): FakeLLM {
  return new FakeLLM((req) => {
    const part = partOf(req)
    if (part === 'notes') return NOTES_JSON
    if (part === 'actions') return ACTIONS_JSON
    if (part === 'email') return EMAIL_JSON
    return 'Chunk notes.'
  })
}

describe('generatePostCall', () => {
  it('produces notes, action items and an email', async () => {
    const llm = happyLLM()
    const res = await generatePostCall({ llm }, input())
    expect(res.errors).toEqual([])
    expect(res.notes).toEqual({
      title: 'Enterprise pricing and pilot',
      summary: 'Discussed enterprise pricing. They want a pilot.',
      keyPoints: ['$40 per seat', 'Ops team pilot'],
      decisions: ['Run a pilot'],
    })
    expect(res.actionItems).toEqual([
      { text: 'Send the pricing sheet', owner: 'Me', due: 'Friday' },
    ])
    expect(res.email).toEqual({ subject: 'Next steps', body: 'Hi,\n\nThanks!\n\nBest,\nAda' })
    expect(res.mapReduce).toBeNull()
    expect(res.stats.map((s) => s.part)).toEqual(['notes', 'actions', 'email'])
    for (const s of res.stats) {
      expect(s.promptText).toContain(TRANSCRIPT)
      expect(s.stats.model).toBe('anthropic/claude-sonnet-4.5')
      expect(s.usage?.promptTokens).toBe(50)
    }
    expect(res.stats[0]?.responseText).toBe(NOTES_JSON)
  })

  it('sends three JSON requests with the right settings and prompts', async () => {
    const llm = happyLLM()
    await generatePostCall({ llm }, input())
    expect(llm.calls).toHaveLength(3)
    for (const req of llm.calls) {
      expect(req.responseFormat).toBe('json_object')
      expect(req.temperature).toBe(0.2)
      expect(req.model).toBe('anthropic/claude-sonnet-4.5')
      expect(req.routing).toEqual({ sort: 'price' })
      expect(userText(req)).toContain(TRANSCRIPT)
      expect(systemText(req)).toContain('Meeting type: Sales call.')
      expect(systemText(req)).toContain('Name: Ada')
      expect(systemText(req)).toContain('Respond with only a JSON object')
      expect(systemText(req)).toContain('main language of the conversation')
    }
    const byPart = Object.fromEntries(llm.calls.map((r) => [partOf(r), systemText(r)]))
    expect(byPart['notes']).toContain('"keyPoints"')
    expect(byPart['actions']).toContain('"items"')
    expect(byPart['email']).toContain('"subject"')
    // Email uses the Mode's tone (Sales call = friendly) and signs with the profile name.
    expect(byPart['email']).toContain('warm, friendly')
    expect(byPart['email']).toContain('Sign off with my name: Ada.')
  })

  it('caps every request with max_tokens (none means the model’s full 64k output)', async () => {
    const llm = happyLLM()
    await generatePostCall({ llm }, input())
    const caps = Object.fromEntries(llm.calls.map((r) => [partOf(r), r.maxTokens]))
    expect(caps).toEqual({
      notes: PART_MAX_TOKENS.notes,
      actions: PART_MAX_TOKENS.actions,
      email: PART_MAX_TOKENS.email,
    })
    for (const cap of Object.values(caps)) expect(cap).toBeLessThanOrEqual(4000)
    // Claude does not think unless asked: no reasoning parameter, which would switch it on.
    for (const req of llm.calls) expect(req.reasoning).toBeUndefined()
  })

  it('gives a reasoning Notes model headroom on top of the cap', async () => {
    const llm = happyLLM()
    await generatePostCall({ llm }, input({ model: 'google/gemini-2.5-pro' }))
    for (const req of llm.calls) {
      const cap = PART_MAX_TOKENS[partOf(req) as 'notes' | 'actions' | 'email']
      expect(req.maxTokens).toBeGreaterThanOrEqual(cap * 2)
      expect(req.reasoning).toEqual({ effort: 'medium', exclude: true })
    }
  })

  it('generates only the requested parts', async () => {
    const llm = happyLLM()
    const res = await generatePostCall({ llm }, input({ parts: ['actions'] }))
    expect(llm.calls.map(partOf)).toEqual(['actions'])
    expect(res.notes).toBeNull()
    expect(res.email).toBeNull()
    expect(res.actionItems).toHaveLength(1)
    // Parts that were not requested are not errors.
    expect(res.errors).toEqual([])

    const empty = await generatePostCall(
      { llm },
      input({ parts: ['notes', 'email'], transcriptText: ' ' }),
    )
    expect(empty.errors.map((e) => e.part)).toEqual(['notes', 'email'])
  })

  it('says when a reply was cut off at the length limit', async () => {
    const llm = new FakeLLM((req) =>
      partOf(req) === 'notes' ? '{"title": "Pricing", "summary": "We disc' : EMAIL_JSON,
    )
    llm.finishReason = (req) => (partOf(req) === 'notes' ? 'length' : 'stop')
    const res = await generatePostCall({ llm, log: recordingLogger() }, input({ parts: ['notes'] }))
    expect(res.errors).toEqual([{ part: 'notes', message: POST_CALL_MESSAGES.truncatedResponse }])
  })

  it('reads action items returned as a bare array or wrapped one level deep', async () => {
    const bare = new FakeLLM(
      () => '[{"text":"Send the deck","owner":"Me","due":"Friday"},{"text":"Book a demo"}]',
    )
    const res = await generatePostCall({ llm: bare }, input({ parts: ['actions'] }))
    expect(res.errors).toEqual([])
    expect(res.actionItems).toEqual([
      { text: 'Send the deck', owner: 'Me', due: 'Friday' },
      { text: 'Book a demo', owner: null, due: null },
    ])

    const wrapped = new FakeLLM(() => '{"result": {"items": [{"text": "Send the deck"}]}}')
    const res2 = await generatePostCall({ llm: wrapped }, input({ parts: ['actions'] }))
    expect(res2.actionItems).toEqual([{ text: 'Send the deck', owner: null, due: null }])
  })

  it('reports an unrecognizable action-items reply as unreadable, not as "no items"', async () => {
    const llm = new FakeLLM(() => '{"summary": "We talked about pricing."}')
    const res = await generatePostCall(
      { llm, log: recordingLogger() },
      input({ parts: ['actions'] }),
    )
    expect(res.actionItems).toBeNull()
    expect(res.errors).toEqual([{ part: 'actions', message: POST_CALL_MESSAGES.invalidResponse }])
  })

  it('starts all three calls before any of them resolves', async () => {
    const pending: Deferred<string>[] = []
    const llm = new FakeLLM(() => {
      const d = deferred<string>()
      pending.push(d)
      return d.promise
    })
    const done = generatePostCall({ llm }, input())
    await vi.waitFor(() => expect(llm.calls).toHaveLength(3))
    expect(llm.settled).toBe(0)
    const answers: Record<string, string> = {
      post_notes: NOTES_JSON,
      post_actions: ACTIONS_JSON,
      post_email: EMAIL_JSON,
    }
    llm.calls.forEach((req, i) => pending[i]?.resolve(answers[req.tag ?? ''] ?? ''))
    const res = await done
    expect(res.errors).toEqual([])
    expect(res.notes?.title).toBe('Enterprise pricing and pilot')
  })

  it('lets each part fail independently', async () => {
    const log = recordingLogger()
    const llm = new FakeLLM((req) => {
      const part = partOf(req)
      if (part === 'notes') throw new ProviderError('rate_limit')
      if (part === 'actions') return 'Sorry, I cannot do that.'
      return EMAIL_JSON
    })
    const res = await generatePostCall({ llm, log }, input())
    expect(res.notes).toBeNull()
    expect(res.actionItems).toBeNull()
    expect(res.email).toEqual({ subject: 'Next steps', body: 'Hi,\n\nThanks!\n\nBest,\nAda' })
    expect(res.errors).toEqual([
      { part: 'notes', message: new ProviderError('rate_limit').message },
      { part: 'actions', message: POST_CALL_MESSAGES.invalidResponse },
    ])
    // The failed call has no stats; the unparseable one keeps its raw response for debugging.
    expect(res.stats.map((s) => s.part)).toEqual(['actions', 'email'])
    expect(res.stats[0]?.responseText).toBe('Sorry, I cannot do that.')
    expect(log.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('reports empty replies and unknown errors with friendly messages', async () => {
    const llm = new FakeLLM((req) => {
      const part = partOf(req)
      if (part === 'notes') return '   '
      if (part === 'actions') throw new Error('socket hang up')
      return EMAIL_JSON
    })
    const res = await generatePostCall({ llm, log: recordingLogger() }, input())
    expect(res.errors).toContainEqual({ part: 'notes', message: POST_CALL_MESSAGES.emptyResponse })
    const actionsError = res.errors.find((e) => e.part === 'actions')
    expect(actionsError?.message).toBeTruthy()
    expect(actionsError?.message).not.toContain('socket hang up')
  })

  it('coerces sloppy JSON (fences, aliases, strings for arrays, empty owner/due)', async () => {
    const llm = new FakeLLM((req) => {
      const part = partOf(req)
      if (part === 'notes')
        return '```json\n{"notes": {"title": "  Pricing call.  ", "summary": " Talked pricing. ", "key_points": "Priced per seat", "decisions": null,}}\n```'
      if (part === 'actions')
        return 'Here you go: {"action_items": [{"task": " Send deck ", "owner": "", "due": "N/A"}, "Call Sam", {"text": "send deck", "owner": "Them"}, {"text": ""}, {"description": "Book demo", "assignee": "Sam", "deadline": 42}]}'
      return '{"Subject": " Hello  there ", "Body": "Line one\\\\nLine two"}'
    })
    const res = await generatePostCall({ llm }, input())
    expect(res.errors).toEqual([])
    expect(res.notes).toEqual({
      title: 'Pricing call',
      summary: 'Talked pricing.',
      keyPoints: ['Priced per seat'],
      decisions: [],
    })
    expect(res.actionItems).toEqual([
      { text: 'Send deck', owner: null, due: null },
      { text: 'Call Sam', owner: null, due: null },
      { text: 'Book demo', owner: 'Sam', due: '42' },
    ])
    expect(res.email).toEqual({ subject: 'Hello there', body: 'Line one\nLine two' })
  })

  it('returns "No transcript" for an empty transcript without calling the model', async () => {
    const llm = happyLLM()
    const res = await generatePostCall({ llm }, input({ transcriptText: '  \n ' }))
    expect(llm.calls).toHaveLength(0)
    expect(res.notes).toBeNull()
    expect(res.actionItems).toBeNull()
    expect(res.email).toBeNull()
    expect(res.errors.map((e) => e.part)).toEqual(['notes', 'actions', 'email'])
    for (const e of res.errors) expect(e.message).toContain('No transcript')
    expect(res.stats).toEqual([])
  })

  it('reports cancellation for every part when aborted', async () => {
    const controller = new AbortController()
    const llm = new FakeLLM(() => new Promise<string>(() => undefined))
    const done = generatePostCall({ llm }, input({ signal: controller.signal }))
    await vi.waitFor(() => expect(llm.calls).toHaveLength(3))
    controller.abort()
    const res = await done
    expect(res.errors).toHaveLength(3)
    for (const e of res.errors) expect(e.message).toBe(new ProviderError('aborted').message)
  })

  it('map-reduces a transcript over maxTranscriptTokens', async () => {
    const lines: string[] = []
    for (let i = 0; i < 400; i++) {
      lines.push(`[${String(i).padStart(2, '0')}:00] Them: Topic ${i} ${'detail '.repeat(30)}`)
    }
    const huge = lines.join('\n')
    const maxTranscriptTokens = 20_000
    expect(estimateTokens(huge)).toBeGreaterThan(maxTranscriptTokens)

    const llm = new FakeLLM((req) => {
      const part = partOf(req)
      if (part === 'chunk') {
        const m = /part (\d+) of (\d+)/.exec(userText(req))
        return `Summary of part ${m?.[1]}.`
      }
      if (part === 'notes') return NOTES_JSON
      if (part === 'actions') return ACTIONS_JSON
      return EMAIL_JSON
    })
    const res = await generatePostCall(
      { llm },
      input({ transcriptText: huge, maxTranscriptTokens }),
    )
    expect(res.errors).toEqual([])
    expect(res.mapReduce).not.toBeNull()
    const chunkCalls = llm.calls.filter((r) => partOf(r) === 'chunk')
    const expectedChunks = splitTranscript(huge, maxTranscriptTokens).length
    expect(expectedChunks).toBeGreaterThan(1)
    expect(chunkCalls).toHaveLength(expectedChunks)
    expect(res.mapReduce?.chunks).toBe(expectedChunks)
    expect(res.mapReduce?.stats).toHaveLength(expectedChunks)
    for (const req of chunkCalls) {
      expect(req.model).toBe('anthropic/claude-sonnet-4.5')
      expect(estimateTokens(userText(req))).toBeLessThanOrEqual(maxTranscriptTokens + 50)
    }
    // Every chunk call happens before the three final prompts, which see only the summaries.
    const finals = llm.calls.slice(-3)
    expect(finals.map(partOf).sort()).toEqual(['actions', 'email', 'notes'])
    for (const req of finals) {
      const text = userText(req)
      expect(text).toContain('Summary of part 1.')
      expect(text).toContain(`Summary of part ${expectedChunks}.`)
      expect(text).not.toContain('Topic 0 detail')
    }
    expect(res.notes?.title).toBe('Enterprise pricing and pilot')
  })

  it('caps the chunk summaries too', async () => {
    const huge = Array.from(
      { length: 300 },
      (_, i) => `[00:00] Me: ${'word '.repeat(40)}${i}`,
    ).join('\n')
    const llm = happyLLM()
    await generatePostCall({ llm }, input({ transcriptText: huge, maxTranscriptTokens: 4000 }))
    const chunks = llm.calls.filter((r) => partOf(r) === 'chunk')
    expect(chunks.length).toBeGreaterThan(1)
    for (const req of chunks) expect(req.maxTokens).toBe(CHUNK_MAX_TOKENS)
  })

  it('fails every part when a chunk summary fails', async () => {
    const huge = Array.from(
      { length: 300 },
      (_, i) => `[00:00] Me: ${'word '.repeat(40)}${i}`,
    ).join('\n')
    const llm = new FakeLLM((req) => {
      if (partOf(req) === 'chunk') throw new ProviderError('server')
      return NOTES_JSON
    })
    const res = await generatePostCall(
      { llm, log: recordingLogger() },
      input({ transcriptText: huge, maxTranscriptTokens: 4000 }),
    )
    expect(res.notes).toBeNull()
    expect(res.errors).toHaveLength(3)
    expect(res.errors[0]?.message).toContain(POST_CALL_MESSAGES.longTranscriptFailed)
    expect(llm.calls.some((r) => partOf(r) !== 'chunk')).toBe(false)
  })
})

describe('splitTranscript', () => {
  it('returns the text unchanged when it fits', () => {
    expect(splitTranscript('a\nb', 100)).toEqual(['a\nb'])
  })

  it('splits on line boundaries into balanced chunks under the limit', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(36)}`).join('\n')
    const chunks = splitTranscript(text, 400)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n')).toBe(text)
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(400)
  })

  it('hard-splits a single enormous line', () => {
    const chunks = splitTranscript('y'.repeat(10_000), 1000)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.join('')).toBe('y'.repeat(10_000))
    for (const c of chunks) expect(estimateTokens(c)).toBeLessThanOrEqual(1000)
  })
})

describe('parsers', () => {
  it('parseNotes needs a summary or key points and derives a missing title', () => {
    expect(parseNotes({ title: 'Only a title' })).toBeNull()
    expect(parseNotes('nope')).toBeNull()
    expect(parseNotes(null)).toBeNull()
    expect(
      parseNotes({
        summary: 'Reviewed the Q3 roadmap with the design team today. Then lunch.',
        keyPoints: [],
      }),
    ).toEqual({
      title: 'Reviewed the Q3 roadmap with the design team',
      summary: 'Reviewed the Q3 roadmap with the design team today. Then lunch.',
      keyPoints: [],
      decisions: [],
    })
    expect(
      parseNotes({ summary: 'x', keyPoints: '- one\n- two\n- three', decisions: [{ text: 'Go' }] }),
    ).toMatchObject({ keyPoints: ['one', 'two', 'three'], decisions: ['Go'] })
    expect(
      parseNotes({ summary: 'x', keyPoints: ['a', 5, null, { point: 'b' }] })?.keyPoints,
    ).toEqual(['a', '5', 'b'])
  })

  it('parseActionItems: empty lists are none; no recognizable list is unreadable', () => {
    expect(parseActionItems({ items: [] })).toEqual([])
    expect(parseActionItems({ items: null })).toEqual([])
    expect(parseActionItems({ items: 'None' })).toEqual([])
    expect(parseActionItems([])).toEqual([])
    expect(parseActionItems({ items: { text: 'Solo', owner: 'Unknown', due: 'TBD' } })).toEqual([
      { text: 'Solo', owner: null, due: null },
    ])
    // A bare array (the first element used to be taken as the whole reply → zero items).
    expect(parseActionItems([{ text: 'Send the deck', owner: 'Me', due: 'Friday' }])).toEqual([
      { text: 'Send the deck', owner: 'Me', due: 'Friday' },
    ])
    // Wrapped one level deep, a single item instead of a list, or the object's only list.
    expect(parseActionItems({ result: { items: ['Call Sam'] } })).toEqual([
      { text: 'Call Sam', owner: null, due: null },
    ])
    expect(parseActionItems({ task: 'Call Sam', owner: 'Me' })).toEqual([
      { text: 'Call Sam', owner: 'Me', due: null },
    ])
    expect(parseActionItems({ data: [{ text: 'Call Sam' }] })).toEqual([
      { text: 'Call Sam', owner: null, due: null },
    ])
    // Nothing usable: null (an error) instead of [] (which would wipe the session's items).
    expect(parseActionItems({})).toBeNull()
    expect(parseActionItems({ summary: 'We talked.' })).toBeNull()
    expect(parseActionItems({ items: [{ foo: 'bar' }, 'Call Sam'] })).toHaveLength(1)
    expect(parseActionItems({ items: [{ foo: 'bar' }] })).toBeNull()
    expect(parseActionItems(null)).toBeNull()
  })

  it('parseEmail requires a body and unwraps {"email": {...}}', () => {
    expect(parseEmail({ subject: 'Hi', body: '' })).toBeNull()
    expect(parseEmail({ email: { subject: 'Hi', body: 'Text' } })).toEqual({
      subject: 'Hi',
      body: 'Text',
    })
    expect(parseEmail({ subject: 'Hi', email: 'Text body' })).toEqual({
      subject: 'Hi',
      body: 'Text body',
    })
    expect(parseEmail({ body: 'No subject' })).toEqual({ subject: '', body: 'No subject' })
  })
})
