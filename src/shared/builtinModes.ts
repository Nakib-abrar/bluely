import type { Mode } from './types'

/** Starter Modes seeded on first run. Users can edit them; "Reset" restores these. */
export const BUILTIN_MODES: Mode[] = [
  {
    id: 'builtin-general',
    name: 'General meeting',
    icon: '💬',
    tone: 'concise',
    autoSuggest: true,
    modelOverrides: {},
    isBuiltin: true,
    sort: 0,
    instructions:
      'Help me take part in a general meeting. Keep suggestions short and natural. Track decisions, owners and open questions. When I seem unsure, suggest a clarifying question.',
  },
  {
    id: 'builtin-sales',
    name: 'Sales call',
    icon: '📈',
    tone: 'friendly',
    autoSuggest: true,
    modelOverrides: {},
    isBuiltin: true,
    sort: 1,
    instructions:
      'I am selling. Help me understand the prospect’s pain, budget, authority, need and timeline. Handle objections honestly using my uploaded product material. Never invent pricing, features or customer names. Suggest a clear next step near the end.',
  },
  {
    id: 'builtin-discovery',
    name: 'Client discovery',
    icon: '🔎',
    tone: 'friendly',
    autoSuggest: true,
    modelOverrides: {},
    isBuiltin: true,
    sort: 2,
    instructions:
      'This is a discovery call with a client. Help me ask open questions that uncover goals, current process, constraints, stakeholders and success criteria. Summarize what we learned and what is still unknown.',
  },
  {
    id: 'builtin-interview',
    name: 'Job interview (prep & practice)',
    icon: '🎯',
    tone: 'formal',
    autoSuggest: false,
    modelOverrides: {},
    isBuiltin: true,
    sort: 3,
    instructions:
      'Help me prepare for and reflect on job interviews: practice rounds, mock questions and post-interview notes. Coach me with frameworks (e.g. STAR) and point out gaps in my answers. Do not write answers for me to read out during a real interview; encourage me to answer in my own words.',
  },
  {
    id: 'builtin-standup',
    name: 'Team standup',
    icon: '🧩',
    tone: 'concise',
    autoSuggest: false,
    modelOverrides: {},
    isBuiltin: true,
    sort: 4,
    instructions:
      'This is a short team standup. Track what each person did, what they will do next and any blockers. Keep everything very brief. Highlight blockers and owners.',
  },
  {
    id: 'builtin-investor',
    name: 'Investor pitch',
    icon: '🚀',
    tone: 'formal',
    autoSuggest: true,
    modelOverrides: {},
    isBuiltin: true,
    sort: 5,
    instructions:
      'I am pitching to investors. Help me answer questions about the market, traction, business model, competition, team and the raise, using only facts from my uploaded material. Flag questions I should follow up on in writing.',
  },
]

export const DEFAULT_MODE_ID = 'builtin-general'
