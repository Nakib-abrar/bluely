import { describe, expect, it } from 'vitest'
import {
  buildContext,
  formatTimestamp,
  retrievalQueryFrom,
  type ContextInput,
} from '@main/ai/contextBuilder'
import { formatTranscript, mergeTranscriptLines } from '@main/ai/format'
import { estimateMessagesTokens } from '@main/ai/tokens'
import type { KnowledgeSnippet, TranscriptLine } from '@shared/types'
import { EMPTY_PROFILE, GENERAL, INTERVIEW, line, systemText, userText } from './helpers'

function input(overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    kind: 'say',
    mode: GENERAL,
    profile: EMPTY_PROFILE,
    answerLanguage: 'conversation',
    transcript: [],
    nowMs: 0,
    ...overrides,
  }
}

/** One line every 30 s for `minutes`, alternating Them/Me, each tagged with its start second. */
function conversation(minutes: number): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (let s = 0; s < minutes * 60; s += 30) {
    lines.push(line(s % 60 === 0 ? 'them' : 'me', s, `utterance at second ${s}.`))
  }
  return lines
}

function snippet(filename: string, text: string, i = 0): KnowledgeSnippet {
  return { fileId: `f-${filename}`, filename, chunkIdx: i, text, score: 1 - i * 0.1 }
}

describe('formatTimestamp', () => {
  it('formats mm:ss and h:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00')
    expect(formatTimestamp(65_400)).toBe('01:05')
    expect(formatTimestamp(59 * 60_000 + 59_999)).toBe('59:59')
    expect(formatTimestamp(3_725_000)).toBe('1:02:05')
    expect(formatTimestamp(-5)).toBe('00:00')
    expect(formatTimestamp(Number.NaN)).toBe('00:00')
  })
})

describe('buildContext: system prompt', () => {
  it('combines base + mode + tone + profile + language + action instruction', () => {
    const ctx = buildContext(
      input({
        profile: { name: 'Ada', role: 'AE', company: 'Acme', about: '' },
        answerLanguage: 'bn',
      }),
    )
    expect(ctx.messages).toHaveLength(2)
    expect(ctx.messages[0]?.role).toBe('system')
    expect(ctx.messages[1]?.role).toBe('user')
    const sys = systemText(ctx)
    const order = [
      'You are Bluely',
      '## Mode: General meeting',
      'Tone: concise',
      '## About me',
      'always reply in Bangla',
      '## Task: What should I say?',
    ].map((s) => sys.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('omits the profile section when the profile is empty', () => {
    expect(systemText(buildContext(input()))).not.toContain('## About me')
  })

  it('applies the interview guardrail only in the interview mode', () => {
    expect(systemText(buildContext(input({ mode: INTERVIEW })))).toContain('Do NOT write a script')
    expect(systemText(buildContext(input()))).not.toContain('Do NOT write a script')
  })
})

describe('buildContext: transcript', () => {
  it('keeps only the last 6 minutes verbatim of a 10-minute call', () => {
    const transcript = conversation(10)
    const ctx = buildContext(input({ transcript, nowMs: 600_000 }))
    const text = userText(ctx)
    expect(text).toContain('## Transcript (last 6 min)')
    expect(text).toContain('[04:00] Them: utterance at second 240.')
    expect(text).toContain('[09:30] Me: utterance at second 570.')
    expect(text).not.toContain('second 210.')
    expect(text).not.toContain('second 0.')
    expect(ctx.transcriptLines).toBe(transcript.filter((l) => l.startMs >= 240_000).length)
    expect(ctx.truncated).toBe(false)
  })

  it('honors contextMinutes', () => {
    const ctx = buildContext(
      input({ transcript: conversation(10), nowMs: 600_000, contextMinutes: 2 }),
    )
    expect(userText(ctx)).toContain('## Transcript (last 2 min)')
    expect(ctx.transcriptLines).toBe(4)
  })

  it('labels Me/Them and merges consecutive same-speaker lines', () => {
    const transcript = [
      line('them', 1, 'Hi there.'),
      line('them', 5, 'How are you?'),
      line('me', 10, 'Good, thanks.'),
      line('me', 15, 'And you?'),
      line('them', 20, 'Great.'),
      // More than 30 s after the previous Them line: a new block.
      line('them', 60, 'So, pricing?'),
    ]
    const ctx = buildContext(input({ transcript, nowMs: 70_000 }))
    expect(userText(ctx)).toContain(
      [
        '## Transcript',
        '[00:01] Them: Hi there. How are you?',
        '[00:10] Me: Good, thanks. And you?',
        '[00:20] Them: Great.',
        '[01:00] Them: So, pricing?',
      ].join('\n'),
    )
    expect(ctx.transcriptLines).toBe(6)
    expect(mergeTranscriptLines(transcript)).toHaveLength(4)
  })

  it('skips non-final and empty lines and sorts by start time', () => {
    const transcript = [
      line('me', 20, 'second'),
      line('them', 10, 'first'),
      line('them', 30, 'still typing', { isFinal: false }),
      line('me', 40, '   '),
    ]
    const ctx = buildContext(input({ transcript, nowMs: 50_000 }))
    const text = userText(ctx)
    expect(text).toContain('[00:10] Them: first\n[00:20] Me: second')
    expect(text).not.toContain('still typing')
    expect(ctx.transcriptLines).toBe(2)
    expect(formatTranscript(transcript)).toBe('[00:10] Them: first\n[00:20] Me: second')
  })

  it('says when nothing has been transcribed yet', () => {
    expect(userText(buildContext(input()))).toContain('(Nothing transcribed yet.)')
  })

  it('includes older lines not yet covered by the running summary', () => {
    const transcript = conversation(10)
    const ctx = buildContext(
      input({
        transcript,
        nowMs: 600_000,
        runningSummary: 'Intro and pricing.',
        summaryCoveredUntilMs: 180_000,
      }),
    )
    const text = userText(ctx)
    expect(text).toContain('second 180.')
    expect(text).toContain('second 210.')
    expect(text).not.toContain('second 150.')
    expect(ctx.transcriptLines).toBe(transcript.filter((l) => l.startMs >= 180_000).length)
  })
})

describe('buildContext: sections', () => {
  it('adds the summary section only when there is a summary', () => {
    const transcript = conversation(8)
    const without = userText(buildContext(input({ transcript, nowMs: 480_000 })))
    expect(without).not.toContain('## Earlier in the call (summary)')
    const withSummary = userText(
      buildContext(input({ transcript, nowMs: 480_000, runningSummary: 'They need 40 seats.' })),
    )
    expect(withSummary).toContain('## Earlier in the call (summary)\nThey need 40 seats.')
    expect(withSummary.indexOf('## Earlier')).toBeLessThan(withSummary.indexOf('## Transcript'))
    const blank = userText(buildContext(input({ transcript, nowMs: 480_000, runningSummary: ' ' })))
    expect(blank).not.toContain('## Earlier in the call')
  })

  it('numbers knowledge snippets with their file names', () => {
    const ctx = buildContext(
      input({
        transcript: [line('them', 1, 'What does it cost?')],
        nowMs: 10_000,
        knowledge: [
          snippet('pricing.pdf', 'Enterprise is $40 per seat\nper month.'),
          snippet('faq.md', 'Onboarding takes two weeks.', 1),
        ],
      }),
    )
    const text = userText(ctx)
    expect(text).toContain(
      '## Knowledge snippets\n[1] (pricing.pdf) Enterprise is $40 per seat per month.\n[2] (faq.md) Onboarding takes two weeks.',
    )
    expect(text.indexOf('## Transcript')).toBeLessThan(text.indexOf('## Knowledge snippets'))
  })

  it('attaches the screenshot as an image_url part and sets usedScreen', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/AAAA'
    const ctx = buildContext(
      input({
        kind: 'assist',
        transcript: [line('them', 1, 'Can you see my screen?')],
        nowMs: 5_000,
        screenshot: { dataUrl },
      }),
    )
    expect(ctx.usedScreen).toBe(true)
    const content = ctx.messages[1]?.content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    expect(content[0]?.type).toBe('text')
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: dataUrl } })
    expect(userText(ctx)).toMatch(
      /Help me with this exact moment\.\nMy current screen is attached\.$/,
    )
    expect(ctx.promptTokens).toBe(estimateMessagesTokens(ctx.messages))
    expect(ctx.promptTokens).toBeGreaterThan(800)
  })

  it('never attaches a non-data screenshot URL', () => {
    const ctx = buildContext(
      input({ kind: 'assist', screenshot: { dataUrl: 'https://example.com/x.png' } }),
    )
    expect(ctx.usedScreen).toBe(false)
    expect(typeof ctx.messages[1]?.content).toBe('string')
    const none = buildContext(input({ kind: 'assist', screenshot: null }))
    expect(none.usedScreen).toBe(false)
  })
})

describe('buildContext: task lines', () => {
  const transcript = [
    line('them', 10, 'We use spreadsheets today.'),
    line('me', 20, 'Got it.'),
    line('them', 100, 'What does the enterprise plan cost?'),
  ]

  it('auto: They just asked "…"', () => {
    const ctx = buildContext(
      input({
        kind: 'auto',
        transcript,
        nowMs: 110_000,
        trigger: { text: 'What does the enterprise plan cost?' },
      }),
    )
    expect(userText(ctx).endsWith('They just asked: "What does the enterprise plan cost?"')).toBe(
      true,
    )
    // Without an explicit trigger it falls back to the last Them line.
    const fallback = buildContext(input({ kind: 'auto', transcript, nowMs: 110_000 }))
    expect(userText(fallback)).toContain('They just asked: "What does the enterprise plan cost?"')
  })

  it('ask: the typed question goes last', () => {
    const ctx = buildContext(
      input({ kind: 'ask', transcript, nowMs: 110_000, question: '  What is our churn?  ' }),
    )
    expect(userText(ctx).endsWith('My question: What is our churn?')).toBe(true)
  })

  it('factcheck: focus on claims from the last 60 s', () => {
    const ctx = buildContext(input({ kind: 'factcheck', transcript, nowMs: 130_000 }))
    expect(userText(ctx).endsWith('Focus on claims from [01:10] onward.')).toBe(true)
    // Quiet for over a minute: focus on the latest line instead of an empty window.
    const quiet = buildContext(input({ kind: 'factcheck', transcript, nowMs: 400_000 }))
    expect(userText(quiet)).toContain('Focus on claims from [01:40] onward.')
  })

  it('assist: help with this exact moment', () => {
    const ctx = buildContext(input({ kind: 'assist', transcript, nowMs: 110_000 }))
    expect(userText(ctx).endsWith('Help me with this exact moment.')).toBe(true)
  })
})

describe('buildContext: token budget', () => {
  // ~30 tokens per line, one line every 5 s for 6 minutes ≈ 2,200 tokens of transcript.
  const transcript: TranscriptLine[] = []
  for (let s = 0; s < 360; s += 5) {
    transcript.push(
      line(s % 10 === 0 ? 'them' : 'me', s, `Line ${s}: ${'blah '.repeat(22)}end.`, { durSec: 4 }),
    )
  }
  const nowMs = 360_000

  it('drops the oldest lines first and always keeps the last 90 s', () => {
    const full = buildContext(input({ transcript, nowMs }))
    expect(full.truncated).toBe(false)
    const ctx = buildContext(input({ transcript, nowMs, maxPromptTokens: 1500 }))
    expect(ctx.truncated).toBe(true)
    expect(ctx.promptTokens).toBeLessThanOrEqual(1500)
    expect(ctx.transcriptLines).toBeLessThan(full.transcriptLines)
    const text = userText(ctx)
    for (const l of transcript.filter((x) => x.startMs >= nowMs - 90_000)) {
      expect(text).toContain(`Line ${l.startMs / 1000}:`)
    }
    expect(text).not.toContain('Line 0:')
    // It drops only as much as needed: one more line would not fit (the untruncated heading
    // is a few tokens shorter, hence the small margin).
    const kept = transcript.slice(transcript.length - ctx.transcriptLines - 1)
    const oneMore = buildContext(input({ transcript: kept, nowMs, maxPromptTokens: 100_000 }))
    expect(oneMore.promptTokens).toBeGreaterThan(1490)
  })

  it('never drops the last 90 s even when that overflows the budget', () => {
    const ctx = buildContext(input({ transcript, nowMs, maxPromptTokens: 200 }))
    expect(ctx.truncated).toBe(true)
    expect(ctx.transcriptLines).toBe(transcript.filter((l) => l.startMs >= nowMs - 90_000).length)
    expect(ctx.promptTokens).toBeGreaterThan(200)
  })

  it('then trims snippets to 4, then shortens the summary', () => {
    const knowledge = Array.from({ length: 6 }, (_, i) =>
      snippet(`doc${i + 1}.md`, `Snippet ${i + 1}: ${'fact '.repeat(60)}`, i),
    )
    const summary = `Start of call. ${'Earlier discussion details. '.repeat(60)}Most recent point.`
    const recent = transcript.filter((l) => l.startMs >= nowMs - 90_000)
    const base = { transcript: recent, nowMs, knowledge, runningSummary: summary }
    const roomy = buildContext(input(base))
    expect(roomy.truncated).toBe(false)
    expect(userText(roomy)).toContain('[6] (doc6.md)')

    // Budget that fits after dropping two snippets: the summary stays intact.
    const fourSnippets = buildContext(input({ ...base, knowledge: knowledge.slice(0, 4) }))
    const snippetsOnly = buildContext(
      input({ ...base, maxPromptTokens: fourSnippets.promptTokens }),
    )
    expect(snippetsOnly.truncated).toBe(true)
    expect(userText(snippetsOnly)).toContain('[4] (doc4.md)')
    expect(userText(snippetsOnly)).not.toContain('[5] (doc5.md)')
    expect(userText(snippetsOnly)).toContain(summary)

    // Tighter: the summary is shortened, keeping its most recent part.
    const tight = buildContext(input({ ...base, maxPromptTokens: fourSnippets.promptTokens - 150 }))
    expect(tight.truncated).toBe(true)
    expect(tight.promptTokens).toBeLessThanOrEqual(fourSnippets.promptTokens - 150)
    const text = userText(tight)
    expect(text).toContain('## Earlier in the call (summary)\n…')
    expect(text).toContain('Most recent point.')
    expect(text).not.toContain('Start of call.')
    expect(text).not.toContain('[5] (doc5.md)')
  })
})

describe('buildContext: review kinds', () => {
  it('meeting_chat uses the whole transcript and the notes', () => {
    const transcript = conversation(30)
    const ctx = buildContext(
      input({
        kind: 'meeting_chat',
        transcript,
        nowMs: 1_800_000,
        notesMarkdown: '## Summary\nWe agreed on a pilot.',
        question: 'What did we agree on?',
      }),
    )
    const text = userText(ctx)
    expect(ctx.transcriptLines).toBe(transcript.length)
    expect(text).toContain('## Meeting notes\n## Summary\nWe agreed on a pilot.')
    expect(text).toContain('## Transcript\n[00:00] Them: utterance at second 0.')
    expect(text.endsWith('My question: What did we agree on?')).toBe(true)
    expect(systemText(ctx)).toContain('## Task: Ask about this meeting')
  })

  it('search_ask lists excerpts with titles and dates and drops the weakest when over budget', () => {
    const startedAt = Date.UTC(2026, 2, 4, 14, 5)
    const excerpts = [
      { title: 'Weekly sync', startedAt, text: 'We moved the launch to May.' },
      { title: 'Pricing review', startedAt, text: `Long excerpt ${'detail '.repeat(400)}` },
    ]
    const ctx = buildContext(
      input({ kind: 'search_ask', question: 'When is the launch?', excerpts }),
    )
    const text = userText(ctx)
    expect(text).toContain('## Meeting excerpts\n[1] Weekly sync (')
    expect(text).toContain('2026')
    expect(text).toContain('[2] Pricing review')
    expect(text).not.toContain('## Transcript')

    const tight = buildContext(
      input({ kind: 'search_ask', question: 'When?', excerpts, maxPromptTokens: 700 }),
    )
    expect(tight.truncated).toBe(true)
    expect(userText(tight)).toContain('[1] Weekly sync')
    expect(userText(tight)).not.toContain('[2] Pricing review')
  })
})

describe('retrievalQueryFrom', () => {
  it('uses the last 1–2 Them lines', () => {
    const transcript = [
      line('them', 1, 'Old question about onboarding?'),
      line('them', 10, 'We have 40 people.'),
      line('me', 15, 'Great.'),
      line('them', 20, 'What does enterprise cost?'),
      line('me', 25, 'Let me check.'),
    ]
    expect(retrievalQueryFrom(transcript)).toBe('We have 40 people. What does enterprise cost?')
  })

  it('falls back to the last line of any channel', () => {
    expect(retrievalQueryFrom([line('me', 1, 'First'), line('me', 5, 'Our pricing page')])).toBe(
      'Our pricing page',
    )
    expect(retrievalQueryFrom([])).toBe('')
  })

  it('caps the query at 300 chars, keeping the most recent words', () => {
    const long = `${'word '.repeat(100)}final question here?`
    const q = retrievalQueryFrom([line('them', 1, long)])
    expect(q.length).toBeLessThanOrEqual(300)
    expect(q.endsWith('final question here?')).toBe(true)
    expect(q.startsWith('word')).toBe(true)
  })

  it('ignores non-final lines', () => {
    const transcript = [
      line('them', 1, 'Final question?'),
      line('them', 5, 'partial wor', { isFinal: false }),
    ]
    expect(retrievalQueryFrom(transcript)).toBe('Final question?')
  })
})
