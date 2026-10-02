import { describe, expect, it } from 'vitest'
import { formatDateTime } from '@main/ai/format'
import {
  renderActionItemsMarkdown,
  renderEmailText,
  renderNotesMarkdown,
  sessionMarkdown,
} from '@main/ai/markdown'
import type { MeetingNotes, SessionDetail } from '@shared/types'
import { line } from './helpers'

const NOTES: MeetingNotes = {
  title: 'Enterprise pricing call',
  summary: 'We walked through pricing. They want a pilot.',
  keyPoints: ['Priced per seat', 'Budget is $50k'],
  decisions: ['Start a pilot in May'],
}

describe('renderNotesMarkdown', () => {
  it('renders summary, key points and decisions', () => {
    expect(renderNotesMarkdown(NOTES)).toBe(
      [
        '## Summary',
        'We walked through pricing. They want a pilot.',
        '',
        '## Key points',
        '- Priced per seat',
        '- Budget is $50k',
        '',
        '## Decisions',
        '- Start a pilot in May',
      ].join('\n'),
    )
  })

  it('adds the title on request and omits empty sections', () => {
    const md = renderNotesMarkdown(
      { ...NOTES, decisions: [], keyPoints: [' ', 'One\nline'] },
      {
        title: true,
      },
    )
    expect(md.startsWith('# Enterprise pricing call\n\n## Summary')).toBe(true)
    expect(md).toContain('## Key points\n- One line')
    expect(md).not.toContain('## Decisions')
  })

  it('accepts label overrides', () => {
    expect(renderNotesMarkdown(NOTES, { labels: { summary: 'Résumé' } })).toContain('## Résumé')
  })
})

describe('renderActionItemsMarkdown', () => {
  it('renders checkboxes with owner and due', () => {
    expect(
      renderActionItemsMarkdown([
        { text: 'Send the pricing sheet', owner: 'Me', due: 'Friday', done: true },
        { text: 'Book onboarding', owner: 'Them', due: null },
        { text: 'Share deck', owner: null, due: 'next week', done: false },
        { text: 'Think about it', owner: null, due: null },
        { text: '   ', owner: 'Me', due: null },
      ]),
    ).toBe(
      [
        '- [x] Send the pricing sheet — Me, Friday',
        '- [ ] Book onboarding — Them',
        '- [ ] Share deck — next week',
        '- [ ] Think about it',
      ].join('\n'),
    )
    expect(renderActionItemsMarkdown([])).toBe('')
  })
})

describe('renderEmailText', () => {
  it('puts the subject line first', () => {
    expect(renderEmailText({ subject: 'Next steps', body: 'Hi Sam,\r\n\r\nThanks!\n' })).toBe(
      'Subject: Next steps\n\nHi Sam,\n\nThanks!',
    )
    expect(renderEmailText({ subject: '', body: 'Body only' })).toBe('Body only')
  })
})

describe('sessionMarkdown', () => {
  const startedAt = Date.UTC(2026, 2, 4, 14, 5)
  const detail: SessionDetail = {
    id: 's1',
    title: 'Acme intro',
    modeId: 'builtin-sales',
    modeName: 'Sales call',
    startedAt,
    endedAt: startedAt + 1_925_000,
    durationMs: 1_925_000,
    status: 'done',
    notes: NOTES,
    email: {
      subject: 'Great speaking today',
      body: 'Hi Sam,\n\nThanks for the time.\n\nBest,\nAda',
    },
    actionItems: [
      {
        id: 'a1',
        sessionId: 's1',
        text: 'Send the pricing sheet',
        owner: 'Me',
        due: 'Friday',
        done: false,
      },
      { id: 'a2', sessionId: 's1', text: 'Intro call', owner: null, due: null, done: true },
    ],
    transcript: [
      line('them', 5, 'Hi, thanks for joining.'),
      line('them', 9, 'Shall we start?'),
      line('me', 15, 'Sure, let us go.'),
      line('them', 20, 'draft', { isFinal: false }),
    ],
    postCallError: null,
  }

  it('exports every section in order', () => {
    const md = sessionMarkdown(detail)
    expect(md).toBe(
      [
        '# Acme intro',
        '',
        `**Date:** ${formatDateTime(startedAt)} · **Duration:** 32:05 · **Mode:** Sales call`,
        '',
        '## Summary',
        'We walked through pricing. They want a pilot.',
        '',
        '## Key points',
        '- Priced per seat',
        '- Budget is $50k',
        '',
        '## Decisions',
        '- Start a pilot in May',
        '',
        '## Action items',
        '- [ ] Send the pricing sheet — Me, Friday',
        '- [x] Intro call',
        '',
        '## Follow-up email',
        '**Subject:** Great speaking today',
        '',
        'Hi Sam,',
        '',
        'Thanks for the time.',
        '',
        'Best,',
        'Ada',
        '',
        '## Transcript',
        '',
        '**Them** [00:05]: Hi, thanks for joining. Shall we start?',
        '',
        '**Me** [00:15]: Sure, let us go.',
        '',
      ].join('\n'),
    )
  })

  it('omits missing sections and falls back for the title', () => {
    const md = sessionMarkdown({
      ...detail,
      title: '',
      notes: null,
      email: null,
      actionItems: [],
      transcript: [],
      modeName: null,
      durationMs: null,
      endedAt: null,
    })
    expect(md).toBe(`# Untitled meeting\n\n**Date:** ${formatDateTime(startedAt)}\n`)
    const titled = sessionMarkdown({ ...detail, title: '  ', notes: NOTES })
    expect(titled.startsWith('# Enterprise pricing call\n')).toBe(true)
  })

  it('derives the duration from endedAt when durationMs is missing', () => {
    expect(sessionMarkdown({ ...detail, durationMs: null })).toContain('**Duration:** 32:05')
  })
})
