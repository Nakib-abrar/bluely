import { describe, expect, it } from 'vitest'
import {
  INTERVIEW_MODE_ID,
  actionInstruction,
  answerLanguageRule,
  basePrompt,
  modeSection,
  postActionsPrompt,
  postChunkPrompt,
  postEmailPrompt,
  postLanguageRule,
  postModeContext,
  postNotesPrompt,
  postSystemPrompt,
  profileSection,
  toneGuide,
  type PromptKind,
} from '@main/ai/prompts'
import { estimateTokens } from '@main/ai/tokens'
import { SALES } from './helpers'

const ALL_KINDS: PromptKind[] = [
  'say',
  'auto',
  'followups',
  'factcheck',
  'who',
  'recap',
  'assist',
  'ask',
  'meeting_chat',
  'search_ask',
  'summary',
]
const GENERAL = { modeId: 'builtin-general' }
const INTERVIEW = { modeId: INTERVIEW_MODE_ID }
const GUARDRAIL = 'Do NOT write a script'

describe('basePrompt', () => {
  it('states the core rules compactly', () => {
    const p = basePrompt()
    expect(p).toContain('"Me"')
    expect(p).toContain('"Them"')
    expect(p).toMatch(/never invent facts, numbers, names, prices/i)
    expect(p).toContain('knowledge snippets are the only source')
    expect(p).toMatch(/unsure/i)
    expect(p).toMatch(/brief/i)
    expect(p).toMatch(/markdown/i)
    expect(p).toContain('no preamble like "Sure!"')
    expect(p).toMatch(/visible note-taker/)
    expect(estimateTokens(p)).toBeLessThan(250)
  })
})

describe('modeSection / toneGuide', () => {
  it('includes the mode name and instructions', () => {
    const s = modeSection(SALES)
    expect(s.startsWith('## Mode: Sales call\n')).toBe(true)
    expect(s).toContain('Never invent pricing')
    expect(modeSection({ name: 'Blank', instructions: '  ' })).toBe('## Mode: Blank')
  })

  it('describes each tone', () => {
    expect(toneGuide('concise')).toMatch(/concise/i)
    expect(toneGuide('friendly')).toMatch(/friendly/i)
    expect(toneGuide('formal')).toMatch(/formal/i)
  })
})

describe('profileSection', () => {
  it('is omitted entirely when the profile is empty', () => {
    expect(profileSection({ name: '', role: '', company: '', about: '' })).toBe('')
    expect(profileSection({ name: '  ', role: '\n', company: '', about: ' ' })).toBe('')
  })

  it('omits empty fields', () => {
    const s = profileSection({ name: 'Ada', role: '', company: 'Acme', about: '' })
    expect(s).toBe('## About me\nName: Ada\nCompany: Acme')
    expect(s).not.toContain('Role')
  })

  it('includes every filled field', () => {
    const s = profileSection({
      name: 'Ada',
      role: 'Founder',
      company: 'Acme',
      about: 'Closing our seed round.',
    })
    expect(s).toContain('Role: Founder')
    expect(s).toContain('About me & goals: Closing our seed round.')
  })
})

describe('answerLanguageRule', () => {
  it('has a variant per setting', () => {
    expect(answerLanguageRule('conversation')).toMatch(/same language the other person/)
    expect(answerLanguageRule('en')).toMatch(/always reply in English/)
    expect(answerLanguageRule('bn')).toMatch(/always reply in Bangla/)
    expect(answerLanguageRule('bn')).toContain('বাংলা')
  })

  it('has a post-call variant for written output', () => {
    expect(postLanguageRule('conversation')).toMatch(/main language of the conversation/)
    expect(postLanguageRule('en')).toMatch(/in English/)
    expect(postLanguageRule('bn')).toMatch(/in Bangla/)
  })
})

describe('actionInstruction', () => {
  it('has an instruction for every kind', () => {
    for (const kind of ALL_KINDS) {
      expect(actionInstruction(kind, GENERAL).length).toBeGreaterThan(40)
    }
  })

  it('say / auto: 1–2 replies, ≤ 45 words, first person, clarifying fallback', () => {
    for (const kind of ['say', 'auto'] as const) {
      const p = actionInstruction(kind, GENERAL)
      expect(p).toContain('1–2')
      expect(p).toContain('≤ 45 words')
      expect(p).toMatch(/first-person/)
      expect(p).toMatch(/tone/)
      expect(p).toMatch(/never invent facts/)
      expect(p).toMatch(/clarifying question/)
    }
    expect(actionInstruction('auto', GENERAL)).toMatch(/just asked a question/)
  })

  it('followups: 3 ranked questions, each ≤ 20 words', () => {
    const p = actionInstruction('followups', GENERAL)
    expect(p).toContain('3 sharp follow-up questions')
    expect(p).toMatch(/ranked/)
    expect(p).toContain('≤ 20 words')
  })

  it('factcheck: ✅ / ⚠️ / ❌ verdicts and the offline caveat', () => {
    const p = actionInstruction('factcheck', GENERAL)
    expect(p).toContain('✅ consistent')
    expect(p).toContain('⚠️ unclear')
    expect(p).toContain('❌ contradicts')
    expect(p).toMatch(/one-line why/)
    expect(p).toMatch(/last ~60 s/)
    expect(p).toMatch(/can’t be verified offline/)
    expect(p).toMatch(/no web search/)
  })

  it('who: inferred from the conversation only', () => {
    const p = actionInstruction('who', GENERAL)
    expect(p).toContain('inferred from the conversation only')
    expect(p).toMatch(/names, roles, company, priorities, concerns and open questions/)
  })

  it('recap: 3–6 bullets plus open items', () => {
    const p = actionInstruction('recap', GENERAL)
    expect(p).toContain('3–6 bullets')
    expect(p).toMatch(/Open items/)
  })

  it('assist uses the screen; summary is ≤ 150 words; search cites titles and dates', () => {
    expect(actionInstruction('assist', GENERAL)).toMatch(/screen/)
    expect(actionInstruction('assist', GENERAL)).toMatch(/this exact moment/)
    expect(actionInstruction('summary', GENERAL)).toContain('≤ 150 words')
    expect(actionInstruction('summary', GENERAL)).toMatch(/running summary/)
    expect(actionInstruction('search_ask', GENERAL)).toMatch(/title and date/)
    expect(actionInstruction('meeting_chat', GENERAL)).toMatch(/past meeting/)
  })

  it('interview guardrail replaces say/auto/assist only in builtin-interview', () => {
    for (const kind of ['say', 'auto', 'assist'] as const) {
      const coached = actionInstruction(kind, INTERVIEW)
      expect(coached).toContain(GUARDRAIL)
      expect(coached).toContain('STAR')
      expect(coached).toMatch(/my own (background|words)/)
      expect(coached).not.toContain('replies I can say out loud')
      expect(actionInstruction(kind, GENERAL)).not.toContain(GUARDRAIL)
      expect(actionInstruction(kind, { modeId: 'custom-123' })).not.toContain(GUARDRAIL)
    }
    // Other actions are unchanged in interview mode.
    for (const kind of ['followups', 'factcheck', 'who', 'recap', 'ask'] as const) {
      expect(actionInstruction(kind, INTERVIEW)).toBe(actionInstruction(kind, GENERAL))
      expect(actionInstruction(kind, INTERVIEW)).not.toContain(GUARDRAIL)
    }
  })
})

describe('post-call prompts', () => {
  it('notes: JSON only with the exact shape keys', () => {
    const p = postNotesPrompt()
    expect(p).toContain('Respond with only a JSON object')
    for (const key of ['"title"', '"summary"', '"keyPoints"', '"decisions"']) {
      expect(p).toContain(key)
    }
    expect(p).toContain('≤ 8 words')
    expect(p).toContain('2–4 sentences')
  })

  it('actions: JSON only with items/text/owner/due and "only if mentioned"', () => {
    const p = postActionsPrompt()
    expect(p).toContain('Respond with only a JSON object')
    for (const key of ['"items"', '"text"', '"owner"', '"due"']) expect(p).toContain(key)
    expect(p).toContain('string | null')
    expect(p.match(/only if/g)?.length).toBe(2)
    expect(p).toContain('"Me"')
    expect(p).toContain('"Them"')
  })

  it('email: JSON only with subject/body, the tone and the sign-off name', () => {
    const p = postEmailPrompt('friendly', 'Ada Lovelace')
    expect(p).toContain('Respond with only a JSON object')
    expect(p).toContain('"subject"')
    expect(p).toContain('"body"')
    expect(p).toContain('warm, friendly')
    expect(p).toContain('Ada Lovelace')
    expect(postEmailPrompt('formal', '')).toContain('formal, professional')
    expect(postEmailPrompt('formal', '  ')).toMatch(/no name/)
  })

  it('keeps the words the dev mock server routes on inside the right prompt', () => {
    const notes = postNotesPrompt().toLowerCase()
    const actions = postActionsPrompt().toLowerCase()
    const email = postEmailPrompt('concise', 'Ada').toLowerCase()
    const shared = `${postSystemPrompt()}\n${postModeContext(SALES)}`.toLowerCase()
    expect(actions).toContain('action item')
    expect(email).toContain('email')
    expect(notes).toMatch(/notes|summary|title/)
    // The mock checks "action item" first, then "email": they must not leak elsewhere.
    expect(notes).not.toContain('action item')
    expect(notes).not.toContain('email')
    expect(email).not.toContain('action item')
    expect(shared).not.toContain('action item')
    expect(shared).not.toContain('email')
  })

  it('chunk prompt names the part', () => {
    expect(postChunkPrompt(2, 5)).toContain('part 2 of 5')
    expect(postModeContext({ name: '', instructions: '' })).toBe('')
    expect(postModeContext(SALES)).toContain('Meeting type: Sales call.')
  })
})
