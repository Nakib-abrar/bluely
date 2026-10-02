import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  actionItemLine,
  emailToMarkdown,
  exportAllZip,
  exportZipFileName,
  formatDuration,
  formatExportDateTime,
  formatOffset,
  MAILTO_MAX_LENGTH,
  mailtoUrl,
  markdownFileName,
  safeFileName,
  sessionToMarkdown,
  slugify,
} from '@main/data/export'
import { SettingsStore } from '@main/settings/settingsStore'
import type { SessionDetail } from '@shared/types'
import { JAN_10_2026, line, makeRepos, seedSession } from './fixtures'

const UTC = { timeZone: 'UTC' }

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 's1',
    title: 'Quarterly pricing review',
    modeId: 'builtin-sales',
    modeName: 'Sales call',
    startedAt: JAN_10_2026,
    endedAt: JAN_10_2026 + 5_255_000,
    durationMs: 5_255_000,
    status: 'done',
    postCallError: null,
    notes: {
      title: 'Pricing',
      summary: 'We reviewed enterprise pricing.\nAcme wants a discount.',
      keyPoints: ['Enterprise is $40/seat', 'Annual billing only'],
      decisions: ['Offer 10% for nonprofits'],
    },
    email: { subject: 'Next steps', body: 'Hi Sam,\r\nThanks for today.\n\nBest,\nMe' },
    actionItems: [
      { id: 'a1', sessionId: 's1', text: 'Send the deck', owner: 'Me', due: 'Friday', done: true },
      { id: 'a2', sessionId: 's1', text: 'Book a demo', owner: null, due: null, done: false },
      { id: 'a3', sessionId: 's1', text: 'Check SSO', owner: null, due: 'next week', done: false },
    ],
    transcript: [
      line('s1', 'them', 7_000, 'What does the enterprise plan cost?'),
      line('s1', 'me', 65_000, 'It starts at\nforty dollars.'),
      line('s1', 'me', 3_723_000, 'Anything else?'),
      line('s1', 'them', 3_724_000, '   '),
    ],
    ...overrides,
  }
}

describe('formatting helpers', () => {
  it('formats dates, durations and transcript offsets', () => {
    expect(formatExportDateTime(JAN_10_2026, 'UTC')).toBe('Sat, Jan 10, 2026 · 3:03am')
    expect(formatExportDateTime(Date.UTC(2026, 0, 10, 0, 5), 'UTC')).toBe(
      'Sat, Jan 10, 2026 · 12:05am',
    )
    expect(formatExportDateTime(Date.UTC(2026, 0, 10, 12, 0), 'UTC')).toBe(
      'Sat, Jan 10, 2026 · 12:00pm',
    )
    expect(formatExportDateTime(Date.UTC(2026, 0, 10, 23, 59), 'UTC')).toBe(
      'Sat, Jan 10, 2026 · 11:59pm',
    )
    expect(formatExportDateTime(JAN_10_2026, 'Asia/Dhaka')).toBe('Sat, Jan 10, 2026 · 9:03am')
    expect(formatDuration(5_255_000)).toBe('1:27:35')
    expect(formatDuration(83_000)).toBe('1:23')
    expect(formatDuration(null)).toBe('0:00')
    expect(formatOffset(7_000)).toBe('00:07')
    expect(formatOffset(65_400)).toBe('01:05')
    expect(formatOffset(3_723_000)).toBe('1:02:03')
    expect(formatOffset(-5)).toBe('00:00')
  })

  it('slugifies titles and makes safe file names', () => {
    expect(slugify('Q3 Pricing — Acme!')).toBe('q3-pricing-acme')
    expect(slugify('Café crème')).toBe('cafe-creme')
    expect(slugify('বিক্রয় মিটিং')).toBe('বিক্রয়-মিটিং')
    expect(slugify('   ')).toBe('meeting')
    expect(slugify('***')).toBe('meeting')
    expect(slugify('a'.repeat(100))).toHaveLength(60)
    expect(safeFileName('2026-01-10 Q3: "Pricing" <draft>/v2?')).toBe(
      '2026-01-10 Q3 Pricing draft v2',
    )
    expect(safeFileName('notes...  ')).toBe('notes')
    expect(safeFileName('a\u0000b\tc')).toBe('a b c')
    expect(safeFileName('')).toBe('Bluely')
    expect(markdownFileName({ title: 'Pricing / review', startedAt: JAN_10_2026 }, 'UTC')).toBe(
      '2026-01-10 Pricing review.md',
    )
    expect(markdownFileName({ title: '', startedAt: JAN_10_2026 }, 'UTC')).toBe(
      '2026-01-10 Untitled meeting.md',
    )
    expect(exportZipFileName(JAN_10_2026, 'UTC')).toBe('bluely-export-2026-01-10.zip')
  })

  it('formats action items and emails', () => {
    expect(actionItemLine({ text: 'Send deck', owner: 'Me', due: 'Fri', done: true })).toBe(
      '- [x] Send deck (Me, Fri)',
    )
    expect(actionItemLine({ text: 'Plan\nnext', owner: null, due: null, done: false })).toBe(
      '- [ ] Plan next',
    )
    expect(emailToMarkdown({ subject: ' Hi ', body: 'a\r\nb\n' })).toBe('**Subject:** Hi\n\na\nb')
  })
})

describe('sessionToMarkdown', () => {
  it('renders all sections in order', () => {
    const md = sessionToMarkdown(detail(), UTC)
    expect(md).toBe(
      [
        '# Quarterly pricing review',
        '',
        'Sat, Jan 10, 2026 · 3:03am · Duration 1:27:35 · Mode: Sales call',
        '',
        '## Summary',
        '',
        'We reviewed enterprise pricing.\nAcme wants a discount.',
        '',
        '## Key points',
        '',
        '- Enterprise is $40/seat\n- Annual billing only',
        '',
        '## Decisions',
        '',
        '- Offer 10% for nonprofits',
        '',
        '## Action items',
        '',
        '- [x] Send the deck (Me, Friday)\n- [ ] Book a demo\n- [ ] Check SSO (next week)',
        '',
        '## Follow-up email',
        '',
        '**Subject:** Next steps\n\nHi Sam,\nThanks for today.\n\nBest,\nMe',
        '',
        '## Transcript',
        '',
        '**Them** [00:07]: What does the enterprise plan cost?',
        '',
        '**Me** [01:05]: It starts at forty dollars.',
        '',
        '**Me** [1:02:03]: Anything else?',
        '',
      ].join('\n'),
    )
  })

  it('omits empty sections and falls back for missing title, mode and duration', () => {
    const md = sessionToMarkdown(
      detail({
        title: '  ',
        modeName: null,
        durationMs: null,
        notes: null,
        email: null,
        actionItems: [],
        transcript: [],
      }),
      UTC,
    )
    expect(md).toBe('# Untitled meeting\n\nSat, Jan 10, 2026 · 3:03am\n')
    const partial = sessionToMarkdown(
      detail({ notes: { title: '', summary: ' ', keyPoints: [], decisions: ['Go'] } }),
      UTC,
    )
    expect(partial).not.toContain('## Summary')
    expect(partial).not.toContain('## Key points')
    expect(partial).toContain('## Decisions\n\n- Go')
  })
})

describe('mailtoUrl', () => {
  it('encodes subject and body with CRLF line breaks', () => {
    const url = mailtoUrl({ subject: 'Q&A follow-up', body: 'Hi Sam,\nLine 2\r\nBye' })
    expect(url).toBe(
      `mailto:?subject=Q%26A%20follow-up&body=${encodeURIComponent('Hi Sam,\r\nLine 2\r\nBye')}`,
    )
    expect(url).toContain('%0D%0ALine%202%0D%0ABye')
    expect(mailtoUrl({ subject: 's', body: 'b' }, 'sam@acme.com, ana@acme.com')).toBe(
      'mailto:sam@acme.com,%20ana@acme.com?subject=s&body=b',
    )
    const decoded = new URL(url)
    expect(decoded.protocol).toBe('mailto:')
  })

  it('truncates long bodies to ≤ 1900 chars with a note', () => {
    const body = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of the email.`).join(
      '\n',
    )
    const url = mailtoUrl({ subject: 'Recap', body })
    expect(url.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH)
    const decodedBody = decodeURIComponent(url.split('&body=')[1] ?? '')
    expect(decodedBody.endsWith('\r\n\r\n[Truncated: copy the full email from Bluely]')).toBe(true)
    expect(
      body.replace(/\n/g, '\r\n').startsWith(decodedBody.split('\r\n\r\n[Truncated')[0] ?? ''),
    ).toBe(true)
    const short = mailtoUrl({ subject: 'Recap', body: 'short' })
    expect(short).not.toContain('Truncated')
  })

  it('never splits multi-byte characters and survives lone surrogates and huge subjects', () => {
    const body = '😀 বাংলা '.repeat(400)
    const url = mailtoUrl({ subject: 'বিষয়', body })
    expect(url.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH)
    expect(() => decodeURIComponent(url.slice('mailto:?'.length))).not.toThrow()
    expect(() => mailtoUrl({ subject: '\ud800 bad', body: 'x\udc00' })).not.toThrow()
    const huge = mailtoUrl({ subject: '“'.repeat(500), body: 'b'.repeat(3000) })
    expect(huge.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH)
    expect(decodeURIComponent(huge.split('&body=')[1] ?? '')).toContain('[Truncated')
  })
})

describe('exportAllZip', () => {
  it('writes the JSON export and one Markdown file per session, without prompts or keys', () => {
    const r = makeRepos()
    const settings = new SettingsStore(r.db)
    settings.update({ profile: { name: 'Ada', about: 'my key is sk-or-v1-abcdefghijklmnop' } })
    const now = Date.now()
    r.db
      .prepare(
        "INSERT INTO modes(id, name, icon, is_builtin, sort, model_overrides_json, created_at, updated_at) VALUES ('builtin-general', 'General meeting', '💬', 1, 0, '{}', ?, ?), ('c1', 'Custom', '🧪', 0, 9, '{\"fast\":\"x/y\"}', ?, ?)",
      )
      .run(now, now, now, now)
    r.db
      .prepare(
        "INSERT INTO knowledge_files(id, mode_id, filename, size, status, chunk_count, added_at) VALUES ('f1', 'c1', 'pricing.pdf', 1234, 'parsed', 1, ?)",
      )
      .run(now)
    r.db
      .prepare(
        "INSERT INTO knowledge_chunks(file_id, idx, text) VALUES ('f1', 0, 'SECRET CHUNK TEXT')",
      )
      .run()

    seedSession(r, {
      id: 's1',
      title: 'Pricing review',
      startedAt: JAN_10_2026,
      durationMs: 60_000,
      lines: [['them', 'How much?']],
      notes: { title: 'N', summary: 'Summary text', keyPoints: [], decisions: [] },
      notesMarkdown: '## Summary\nSummary text',
      actionItems: [{ text: 'Follow up', done: true }],
    })
    seedSession(r, { id: 's2', title: 'Pricing review', startedAt: JAN_10_2026 + 10_000 })
    seedSession(r, { id: 's3', startedAt: JAN_10_2026 + 86_400_000 })
    r.ai.insert({
      id: 'm1',
      sessionId: 's1',
      kind: 'say',
      label: 'What should I say?',
      promptText: 'PROMPT WITH TRANSCRIPT',
      createdAt: 1,
      usedScreen: false,
    })
    r.ai.complete('m1', { responseText: 'Say hi', status: 'done' })
    r.ai.insert({
      id: 'q1',
      sessionId: null,
      kind: 'search_ask',
      label: 'What did we decide?',
      promptText: 'PROMPT WITH EXCERPTS',
      createdAt: 2,
      usedScreen: false,
    })

    const zip = exportAllZip(r.db, { version: '1.2.3', nowMs: JAN_10_2026, timeZone: 'UTC' })
    const files = unzipSync(zip)
    expect(Object.keys(files).sort()).toEqual([
      'bluely-export.json',
      'sessions/2026-01-10-0303-pricing-review-2.md',
      'sessions/2026-01-10-0303-pricing-review.md',
      'sessions/2026-01-11-0303-untitled-meeting.md',
    ])
    const jsonText = strFromU8(files['bluely-export.json'] ?? new Uint8Array())
    expect(jsonText).not.toContain('PROMPT WITH')
    expect(jsonText).not.toContain('promptText')
    expect(jsonText).not.toContain('sk-or-v1-abcdefghijklmnop')
    expect(jsonText).not.toContain('SECRET CHUNK TEXT')

    const json = JSON.parse(jsonText) as {
      exportedAt: string
      app: string
      version: string
      sessions: {
        id: string
        title: string
        notes: unknown
        actionItems: { text: string; done: boolean }[]
        transcript: { text: string }[]
        aiMessages: { id: string; responseText: string }[]
      }[]
      unattachedAiMessages: { id: string }[]
      modes: { id: string; isBuiltin: boolean; modelOverrides: Record<string, string> }[]
      knowledgeFiles: { filename: string; chunkCount: number }[]
      settings: { profile: { name: string; about: string } }
    }
    expect(json.app).toBe('Bluely')
    expect(json.version).toBe('1.2.3')
    expect(json.exportedAt).toBe(new Date(JAN_10_2026).toISOString())
    expect(json.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    const s1 = json.sessions[0]
    expect(s1?.notes).toMatchObject({ summary: 'Summary text' })
    expect(s1?.actionItems).toMatchObject([{ text: 'Follow up', done: true }])
    expect(s1?.transcript.map((l) => l.text)).toEqual(['How much?'])
    expect(s1?.aiMessages.map((m) => m.id)).toHaveLength(2) // live card + post_notes
    expect(s1?.aiMessages.find((m) => m.id === 'm1')?.responseText).toBe('Say hi')
    expect(json.unattachedAiMessages.map((m) => m.id)).toEqual(['q1'])
    expect(json.modes.map((m) => [m.id, m.isBuiltin])).toEqual([
      ['builtin-general', true],
      ['c1', false],
    ])
    expect(json.modes[1]?.modelOverrides).toEqual({ fast: 'x/y' })
    expect(json.knowledgeFiles).toMatchObject([{ filename: 'pricing.pdf', chunkCount: 1 }])
    expect(json.settings.profile.name).toBe('Ada')
    expect(json.settings.profile.about).toBe('my key is [redacted]')

    const md = strFromU8(files['sessions/2026-01-10-0303-pricing-review.md'] ?? new Uint8Array())
    expect(md).toContain('# Pricing review')
    expect(md).toContain('**Them** [00:00]: How much?')
    expect(md).toContain('- [x] Follow up')
  })

  it('exports an empty database', () => {
    const r = makeRepos()
    const files = unzipSync(exportAllZip(r.db))
    expect(Object.keys(files)).toEqual(['bluely-export.json'])
    const json = JSON.parse(strFromU8(files['bluely-export.json'] ?? new Uint8Array())) as {
      sessions: unknown[]
      version: string
    }
    expect(json.sessions).toEqual([])
    expect(json.version).toBe('unknown')
  })
})
