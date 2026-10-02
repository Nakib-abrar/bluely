import { describe, expect, it } from 'vitest'
import {
  emailToText,
  notesToMarkdown,
  transcriptStamp,
  transcriptToText,
} from '@renderer/main/lib/copyText'
import {
  formatShortDate,
  looksLikeQuestion,
  profileInitial,
  shortModelId,
  tabForHit,
} from '@renderer/main/lib/text'

describe('text helpers', () => {
  it('shortens model ids for the Start subtitle', () => {
    expect(shortModelId('google/gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(shortModelId('local-model')).toBe('local-model')
  })

  it('derives the avatar initial', () => {
    expect(profileInitial('  sam')).toBe('S')
    expect(profileInitial('')).toBeNull()
  })

  it('recognizes question-like queries', () => {
    expect(looksLikeQuestion('What did Acme say about pricing')).toBe(true)
    expect(looksLikeQuestion('pricing?')).toBe(true)
    expect(looksLikeQuestion('pricing')).toBe(false)
    expect(looksLikeQuestion('how')).toBe(false)
  })

  it('maps hit kinds to session tabs', () => {
    expect(tabForHit('transcript')).toBe('transcript')
    expect(tabForHit('action_item')).toBe('actions')
    expect(tabForHit('email')).toBe('email')
    expect(tabForHit('notes')).toBe('notes')
    expect(tabForHit('title')).toBeUndefined()
  })

  it('formats citation dates', () => {
    const now = new Date(2026, 0, 12).getTime()
    expect(formatShortDate(new Date(2026, 0, 10).getTime(), now)).toBe('Jan 10')
    expect(formatShortDate(new Date(2025, 11, 29).getTime(), now)).toBe('Dec 29, 2025')
  })
})

describe('copy helpers', () => {
  it('stamps transcript lines as [mm:ss] or [h:mm:ss]', () => {
    expect(transcriptStamp(4_000)).toBe('[00:04]')
    expect(transcriptStamp(187_000)).toBe('[03:07]')
    expect(transcriptStamp(3_723_000)).toBe('[1:02:03]')
  })

  it('renders notes, transcript and email as text', () => {
    expect(
      notesToMarkdown('Sync', {
        title: 'Sync',
        summary: 'We met.',
        keyPoints: ['One'],
        decisions: [],
      }),
    ).toBe('# Sync\n\nWe met.\n\n## Key points\n- One')
    expect(
      transcriptToText([
        {
          id: '1',
          sessionId: 's',
          channel: 'them',
          startMs: 0,
          endMs: 1,
          text: 'Hi',
          isFinal: true,
        },
        {
          id: '2',
          sessionId: 's',
          channel: 'me',
          startMs: 65_000,
          endMs: 1,
          text: 'Yo',
          isFinal: true,
        },
      ]),
    ).toBe('[00:00] Them: Hi\n[01:05] Me: Yo')
    expect(emailToText({ subject: 'Next steps', body: 'Hello' })).toBe(
      'Subject: Next steps\n\nHello',
    )
    expect(emailToText({ subject: ' ', body: 'Hello' })).toBe('Hello')
  })
})
